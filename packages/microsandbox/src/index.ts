import { randomUUID } from 'node:crypto';
import { posix as posixPath } from 'node:path';
import {
  defineProvider,
  resolveVolumeRef,
  isUnifiedVolumeMounts,
  withVolumeSettle,
  InstanceSizeError,
} from '@computesdk/provider';
import type {
  CreateInstanceOptions,
  CreateSnapshotOptions,
  FileEntry,
  InstanceInfo,
  InstanceSizeManager,
  ListSnapshotsOptions,
  ProcessRuntimeOptions,
  Provider,
  Volume,
  VolumeMount,
} from '@computesdk/provider';
import type {
  Checkpoint,
  ComputeType,
  Context,
  Sandbox,
  SandboxConfigInspection,
} from 'microsandbox';
import {
  runMicrosandboxCommand,
  startMicrosandboxProcess,
  streamMicrosandboxCommand,
} from './process';

const PROVIDER = 'microsandbox' as const;
const LABEL_MARKER = 'computesdk.sandbox';
const LABEL_METADATA_PREFIX = 'computesdk.metadata.';
const LABEL_CREATE_ATTEMPT = 'computesdk.create-attempt';
const SNAPSHOT_LABEL_MARKER = 'computesdk.snapshot';
const SNAPSHOT_LABEL_SANDBOX = 'computesdk.sandbox-id';
const DEFAULT_IMAGE = 'alpine:3.21';
const DEFAULT_CPUS = 1;
const DEFAULT_MEMORY_MIB = 512;
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_NAME_PREFIX = 'csdk-';
const DEFAULT_LIST_PAGE_SIZE = 100;

/** The cloud relay closes the channel on a single fs write of ~1 MiB. */
const FS_WRITE_CHUNK_BYTES = 256 * 1024;

const RUNTIME_IMAGES: Record<string, string> = {
  node: 'node:22-alpine',
  python: 'python:3.12-slim',
};

type MicrosandboxModule = typeof import('microsandbox');

export type { Sandbox as MicrosandboxSandbox } from 'microsandbox';

export interface MicrosandboxPort {
  /** Host TCP port. Local backend only. */
  host: number;
  /** Guest TCP port. */
  guest: number;
  /** Optional local bind address. */
  bind?: string;
}

export interface MicrosandboxConfig {
  /**
   * Execution backend. Cloud is the default; pass `local` to use the runtime
   * installed on the calling machine.
   */
  backend?: 'cloud' | 'local';
  /** Cloud API key. Falls back to `MSB_API_KEY` (and `MSB_API_URL`). */
  apiKey?: string;
  /** Hosted API endpoint override. Requires `apiKey`. */
  apiUrl?: string;
  /** Named microsandbox cloud profile. Cannot be combined with `apiKey` or `apiUrl`. */
  profile?: string;
  /** Cloud compute tier (`standard` or `shared`). Cloud backend only. */
  computeType?: ComputeType;
  /** Cloud HTTP request timeout in milliseconds. Cloud backend only. */
  requestTimeoutMs?: number;
  /** Custom local home directory. Local backend only. */
  home?: string;
  /** Custom local config file path. Local backend only. */
  configPath?: string;
  /** Default OCI image. */
  image?: string;
  /** Default number of guest vCPUs. */
  cpus?: number;
  /** Default guest memory in MiB. */
  memoryMib?: number;
  /** Default writable root disk size in MiB. */
  rootDiskMib?: number;
  /** Delete the sandbox when it stops. Defaults to true. */
  ephemeral?: boolean;
  /** Default working directory inside the guest. */
  workdir?: string;
  /** Prefix for generated sandbox names. */
  namePrefix?: string;
  /** Local TCP port mappings. A number maps the same host and guest port. */
  ports?: Array<number | MicrosandboxPort>;
  /** Default sandbox idle timeout and command timeout in milliseconds (15 minutes). */
  timeout?: number;
  /** OCI pull policy. */
  pullPolicy?: 'always' | 'if-missing' | 'never';
  /** Enable guest networking. Defaults to true. */
  networkEnabled?: boolean;
}

export interface MicrosandboxSnapshot {
  id: string;
  provider: typeof PROVIDER;
  createdAt: Date;
  metadata: {
    name: string;
    sandboxId?: string;
    scope?: string;
    imageRef?: string;
    sizeBytes?: bigint;
    labels?: Record<string, string>;
  };
}

interface MicrosandboxInternalConfig extends MicrosandboxConfig {
  _getContext: () => Promise<Context>;
}

interface PortEntryLike {
  host?: number;
  guest?: number;
  hostPort?: number;
  guestPort?: number;
  bind?: string;
  hostBind?: string;
}

let sdkPromise: Promise<MicrosandboxModule> | undefined;

/**
 * Track the configured timeout per Sandbox instance so `getInfo()` reports
 * the exact timeout even when local config inspection omits `idleTimeoutSecs`.
 */
const sandboxTimeouts = new WeakMap<Sandbox, number>();

function loadSdk(): Promise<MicrosandboxModule> {
  sdkPromise ??= import('microsandbox');
  return sdkPromise;
}

function createContextGetter(config: MicrosandboxConfig): () => Promise<Context> {
  let ctxPromise: Promise<Context> | undefined;

  return () => {
    ctxPromise ??= (async () => {
      const { LocalContext, RemoteContext } = await loadSdk();
      const kind = config.backend ?? 'cloud';
      const hasApiKey = Boolean(config.apiKey);
      const hasApiUrl = Boolean(config.apiUrl);
      const hasProfile = Boolean(config.profile);

      if (kind === 'local') {
        if (hasApiKey || hasApiUrl || hasProfile) {
          throw new Error(`Microsandbox cloud credentials cannot be used with backend: 'local'.`);
        }
        return new LocalContext({
          ...(config.home ? { home: config.home } : {}),
          ...(config.configPath ? { configPath: config.configPath } : {}),
        });
      }

      if (hasProfile && (hasApiKey || hasApiUrl)) {
        throw new Error(`Microsandbox 'profile' cannot be combined with 'apiKey' or 'apiUrl'.`);
      }
      if (hasApiUrl && !hasApiKey) {
        throw new Error(`Microsandbox 'apiUrl' requires 'apiKey'.`);
      }

      const applyRemoteOptions = (base: InstanceType<typeof RemoteContext>) => {
        if (config.computeType === undefined && config.requestTimeoutMs === undefined) {
          return base;
        }
        let builder = base.toBuilder();
        if (config.computeType !== undefined) builder = builder.computeType(config.computeType);
        if (config.requestTimeoutMs !== undefined) {
          builder = builder.requestTimeoutMs(config.requestTimeoutMs);
        }
        return builder.build();
      };

      if (config.profile) {
        return applyRemoteOptions(RemoteContext.fromProfile(config.profile));
      }

      if (config.apiKey) {
        return new RemoteContext({
          apiKey: config.apiKey,
          ...(config.apiUrl ? { url: config.apiUrl } : {}),
          ...(config.computeType ? { computeType: config.computeType } : {}),
          ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
        });
      }

      const envApiKey = process.env.MSB_API_KEY?.trim() || undefined;
      if (envApiKey) {
        const envApiUrl = process.env.MSB_API_URL?.trim() || undefined;
        return new RemoteContext({
          apiKey: envApiKey,
          ...(envApiUrl ? { url: envApiUrl } : {}),
          ...(config.computeType ? { computeType: config.computeType } : {}),
          ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
        });
      }

      const envProfile = process.env.MSB_PROFILE?.trim() || undefined;
      if (envProfile) {
        return applyRemoteOptions(RemoteContext.fromProfile(envProfile));
      }

      throw new Error(
        `Microsandbox cloud is the default, but no cloud credentials or profile were resolved. ` +
          `Provide 'apiKey', set MSB_API_KEY or MSB_PROFILE, or pass backend: 'local'.`,
      );
    })().catch((error) => {
      ctxPromise = undefined;
      throw error;
    });

    return ctxPromise;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'sandboxNotFound';
}

function isVolumeNotFound(error: unknown): boolean {
  return errorCode(error) === 'volumeNotFound';
}

function isFileNotFound(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'ENOENT') return true;
  return /not found|no such file|enoent/i.test(errorMessage(error));
}

function isUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'unsupported' ||
    code === 'unsupportedOperation' ||
    /unsupported|not supported|unimplemented/i.test(errorMessage(error))
  );
}

function timeoutFor(config: MicrosandboxConfig, options?: CreateInstanceOptions): number {
  return options?.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_MS;
}

function cpusFor(config: MicrosandboxConfig, options?: CreateInstanceOptions): number {
  return options?.cpus ?? options?.vcpus ?? options?.cpu ?? config.cpus ?? DEFAULT_CPUS;
}

function memoryFor(config: MicrosandboxConfig, options?: CreateInstanceOptions): number {
  return (
    options?.memoryMiB ??
    (options as { memoryMib?: number } | undefined)?.memoryMib ??
    options?.memMiB ??
    options?.memoryMb ??
    options?.memory ??
    config.memoryMib ??
    DEFAULT_MEMORY_MIB
  );
}

function imageFor(config: MicrosandboxConfig, options?: CreateInstanceOptions): string {
  return (
    options?.image ??
    options?.templateId ??
    config.image ??
    (options?.runtime ? RUNTIME_IMAGES[options.runtime] : undefined) ??
    DEFAULT_IMAGE
  );
}

function normalizePorts(
  config: MicrosandboxConfig,
  options?: CreateInstanceOptions,
): MicrosandboxPort[] {
  const raw = [
    ...(config.ports ?? []),
    ...((options?.ports as Array<number | MicrosandboxPort> | undefined) ?? []),
  ];
  const byGuest = new Map<number, MicrosandboxPort>();
  for (const entry of raw) {
    const port = typeof entry === 'number' ? { host: entry, guest: entry } : entry;
    byGuest.set(port.guest, port);
  }
  return [...byGuest.values()];
}

function encodeMetadata(metadata: Record<string, unknown>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    try {
      labels[`${LABEL_METADATA_PREFIX}${key}`] = JSON.stringify(value);
    } catch {
      labels[`${LABEL_METADATA_PREFIX}${key}`] = String(value);
    }
  }
  return labels;
}

function decodeMetadata(labels: Record<string, string> | undefined): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!key.startsWith(LABEL_METADATA_PREFIX)) continue;
    const metadataKey = key.slice(LABEL_METADATA_PREFIX.length);
    try {
      metadata[metadataKey] = JSON.parse(value);
    } catch {
      metadata[metadataKey] = value;
    }
  }
  return metadata;
}

function extractPorts(cfg: SandboxConfigInspection): PortEntryLike[] {
  const network = (cfg.spec as { network?: { ports?: PortEntryLike[] } }).network;
  return network?.ports ?? [];
}

function extractLifecycle(cfg: SandboxConfigInspection): {
  ephemeral?: boolean;
  idleTimeoutSecs?: number | null;
} {
  const lifecycle = (
    cfg.spec as { lifecycle?: { ephemeral?: boolean; idleTimeoutSecs?: number | null } }
  ).lifecycle;
  return lifecycle ?? {};
}

function urlHostForBind(bind: string | undefined): string {
  if (!bind || bind === '0.0.0.0') return '127.0.0.1';
  if (bind === '::' || bind === '[::]') return '[::1]';
  if (bind.startsWith('[') && bind.endsWith(']')) return bind;
  return bind.includes(':') ? `[${bind}]` : bind;
}

function mapStatus(status: string): InstanceInfo['status'] {
  if (status === 'running' || status === 'draining') return 'running';
  if (status === 'stopped' || status === 'paused') return 'stopped';
  return 'error';
}

function backendLabel(sandbox: Sandbox): 'local' | 'cloud' {
  return sandbox.contextKind === 'remote' ? 'cloud' : 'local';
}

async function writeGuestFile(
  fs: ReturnType<Sandbox['fs']>,
  path: string,
  content: string,
): Promise<void> {
  const data = Buffer.from(content);
  if (data.byteLength <= FS_WRITE_CHUNK_BYTES) {
    await fs.write(path, data);
    return;
  }
  const sink = await fs.writeStream(path);
  try {
    for (let offset = 0; offset < data.byteLength; offset += FS_WRITE_CHUNK_BYTES) {
      await sink.write(data.subarray(offset, offset + FS_WRITE_CHUNK_BYTES));
    }
  } finally {
    await sink.close();
  }
}

async function readGuestFileStreamed(
  fs: ReturnType<Sandbox['fs']>,
  path: string,
): Promise<string> {
  const stream = await fs.readStream(path);
  return new TextDecoder().decode(await stream.collect());
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (isNotFound(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function retrySourceDisk<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!/snapshot_source_disk_unavailable/.test(errorMessage(error)) || attempt === 11) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

function toSnapshotInfo(
  checkpoint: Checkpoint,
  sandboxId?: string,
  labels?: Record<string, string>,
): MicrosandboxSnapshot {
  const name = checkpoint.name ?? checkpoint.digest;
  return {
    id: checkpoint.reference ?? name,
    provider: PROVIDER,
    createdAt: new Date(checkpoint.createdAt),
    metadata: {
      name,
      ...(sandboxId ? { sandboxId } : {}),
      ...(checkpoint.scope ? { scope: checkpoint.scope } : {}),
      ...(checkpoint.imageRef ? { imageRef: checkpoint.imageRef } : {}),
      ...(checkpoint.sizeBytes != null ? { sizeBytes: checkpoint.sizeBytes } : {}),
      ...(labels ? { labels } : {}),
    },
  };
}

function makeProvider(backend: 'local' | 'cloud') {
  return defineProvider<Sandbox, MicrosandboxInternalConfig, never, MicrosandboxSnapshot>({
    name: PROVIDER,
    sizes: (_config, profile, options) => {
      if ((options as { memoryMib?: unknown } | undefined)?.memoryMib !== undefined) {
        throw new InstanceSizeError(
          'conflict',
          'cannot combine sizeClass with native microsandbox memoryMib',
        );
      }
      if (options?.snapshotId !== undefined) {
        return {
          status: 'unsupported',
          reason:
            'A microsandbox snapshot restore keeps its captured shape; drop snapshotId to create a standard size.',
        };
      }
      return {
        status: 'supported',
        nativeOptions: { cpus: profile.vcpus, memoryMiB: profile.memoryMiB },
      };
    },
    methods: {
      instances: {
        create: async (config, options) => {
          options?.signal?.throwIfAborted();
          const ctx = await config._getContext();
          const name = options?.name ?? `${config.namePrefix ?? DEFAULT_NAME_PREFIX}${randomUUID()}`;
          const timeoutMs = timeoutFor(config, options);
          const idleTimeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));
          const metadata = options?.metadata ?? {};
          const ports = normalizePorts(config, options);
          const attempt = randomUUID();
          const workdir = options?.directory ?? config.workdir;
          const labels = {
            [LABEL_MARKER]: 'true',
            [LABEL_CREATE_ATTEMPT]: attempt,
            ...encodeMetadata(metadata),
          };
          const unifiedVolumes = isUnifiedVolumeMounts(options?.volumes)
            ? (options.volumes as VolumeMount[])
            : undefined;

          if (options?.snapshotId) {
            let restore = ctx.sandboxes
              .restore(options.snapshotId)
              .name(name)
              .idleTimeoutSeconds(idleTimeoutSecs)
              .labels(labels);

            try {
              const checkpoint = await ctx.checkpoints.get(options.snapshotId);
              if (checkpoint.scope === 'full') restore = restore.cowMemory();
            } catch {
              // Scope lookup failed (older backend or remote reference) — restore as-is.
            }

            if (workdir) restore = restore.workdir(workdir);
            if (options.envs && Object.keys(options.envs).length > 0) {
              restore = restore.envs(options.envs);
            }
            if (config.networkEnabled === false) restore = restore.disableNetwork();
            if (ctx.kind === 'local') {
              for (const port of ports) {
                restore = port.bind
                  ? restore.portBind(port.bind, port.host, port.guest)
                  : restore.port(port.host, port.guest);
              }
            }
            if (unifiedVolumes) {
              for (const mount of unifiedVolumes) {
                const ref = resolveVolumeRef(mount.volume);
                restore = restore.volume(mount.mountPath, (b) => {
                  const named = b.named(ref.name ?? ref.id ?? '');
                  return mount.readOnly ? named.readonly() : named;
                });
              }
            }

            const sandbox = await restore.restore();
            if (options.signal?.aborted) {
              try {
                await retry(() => sandbox.destroy({ timeoutMs: 5_000 }));
              } catch (error) {
                if (!isNotFound(error)) {
                  console.warn(
                    `[microsandbox] Aborted sandbox cleanup failed for ${JSON.stringify(name)} after 3 attempts; check and remove it manually.`,
                  );
                  throw Object.assign(new Error('Aborted sandbox cleanup failed'), { cause: error });
                }
              }
              options.signal.throwIfAborted();
            }
            sandboxTimeouts.set(sandbox, timeoutMs);
            return { instance: sandbox, instanceId: sandbox.name };
          }

          let builder = ctx.sandboxes
            .builder(name)
            .image(imageFor(config, options))
            .cpus(cpusFor(config, options))
            .memory(memoryFor(config, options))
            .detached(true)
            .ephemeral(options?.ephemeral ?? config.ephemeral ?? true)
            .idleTimeoutSeconds(idleTimeoutSecs)
            .labels(labels);

          const rootDiskMib =
            (options as { rootDiskMib?: number } | undefined)?.rootDiskMib ?? config.rootDiskMib;
          if (rootDiskMib !== undefined) builder = builder.rootDisk(rootDiskMib);
          if (workdir) builder = builder.workdir(workdir);
          if (options?.envs && Object.keys(options.envs).length > 0) {
            builder = builder.envs(options.envs);
          }
          if (config.pullPolicy) builder = builder.pullPolicy(config.pullPolicy);
          if (config.networkEnabled === false) builder = builder.disableNetwork();
          if (ctx.kind === 'local') {
            for (const port of ports) {
              builder = port.bind
                ? builder.portBind(port.bind, port.host, port.guest)
                : builder.port(port.host, port.guest);
            }
          }
          if (unifiedVolumes) {
            for (const mount of unifiedVolumes) {
              const ref = resolveVolumeRef(mount.volume);
              builder = builder.volume(mount.mountPath, (b) => {
                const named = b.named(ref.name ?? ref.id ?? '');
                return mount.readOnly ? named.readonly() : named;
              });
            }
          }

          let sandbox: Sandbox;
          try {
            sandbox = await builder.create();
          } catch (error) {
            // Cloud create can fail (e.g. readiness wait expired) after the named sandbox exists.
            // Only remove it if this attempt created it, never a same-name sandbox owned by someone else.
            try {
              const existing = await ctx.sandboxes.get(name);
              const cfg = await existing.config();
              if (cfg.spec.labels?.[LABEL_CREATE_ATTEMPT] === attempt) {
                await retry(() => existing.destroy({ timeoutMs: 10_000 }));
              }
            } catch (cleanupError) {
              if (!isNotFound(cleanupError)) {
                console.warn(
                  `[microsandbox] Failed-create cleanup failed for ${JSON.stringify(name)}; check and remove it manually.`,
                );
              }
            }
            throw error;
          }

          if (options?.signal?.aborted) {
            try {
              await retry(() => sandbox.destroy({ timeoutMs: 5_000 }));
            } catch (error) {
              if (!isNotFound(error)) {
                console.warn(
                  `[microsandbox] Aborted sandbox cleanup failed for ${JSON.stringify(name)} after 3 attempts; check and remove it manually.`,
                );
                throw Object.assign(new Error('Aborted sandbox cleanup failed'), { cause: error });
              }
            }
            options.signal.throwIfAborted();
          }

          sandboxTimeouts.set(sandbox, timeoutMs);
          return { instance: sandbox, instanceId: sandbox.name };
        },

        getById: async (config, instanceId) => {
          const ctx = await config._getContext();
          try {
            const sandbox = await ctx.sandboxes.get(instanceId);
            sandboxTimeouts.set(sandbox, config.timeout ?? DEFAULT_TIMEOUT_MS);
            return { instance: sandbox, instanceId: sandbox.name };
          } catch (error) {
            if (isNotFound(error)) return null;
            throw error;
          }
        },

        list: async (config) => {
          const ctx = await config._getContext();
          const sandboxes: Array<{ instance: Sandbox; instanceId: string }> = [];
          let cursor: string | undefined;
          do {
            const page = await ctx.sandboxes.listWith((list) => {
              let configured = list.limit(DEFAULT_LIST_PAGE_SIZE).label(LABEL_MARKER, 'true');
              if (cursor) configured = configured.cursor(cursor);
              return configured;
            });
            for (const sandbox of page.sandboxes) {
              sandboxTimeouts.set(sandbox, config.timeout ?? DEFAULT_TIMEOUT_MS);
              sandboxes.push({ instance: sandbox, instanceId: sandbox.name });
            }
            cursor = page.nextCursor;
          } while (cursor);
          return sandboxes;
        },

        destroy: async (config, instanceId) => {
          const ctx = await config._getContext();
          try {
            const sandbox = await ctx.sandboxes.get(instanceId);
            await retry(() => sandbox.destroy({ timeoutMs: 10_000 }));
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        },

        runCommand: runMicrosandboxCommand,
        streamCommand: streamMicrosandboxCommand,

        // Native Job-backed startProcess is supported on local sandboxes; cloud
        // omits it so ComputeSDK routes to its shell process runtime.
        ...(backend === 'local' ? { startProcess: startMicrosandboxProcess } : {}),

        getInfo: async (sandbox): Promise<InstanceInfo> => {
          const fallbackTimeout = sandboxTimeouts.get(sandbox) ?? DEFAULT_TIMEOUT_MS;
          const backendKind = backendLabel(sandbox);
          try {
            const [info, cfg] = await Promise.all([sandbox.info(), sandbox.config()]);
            const idleSecs = extractLifecycle(cfg).idleTimeoutSecs;
            return {
              id: info.name,
              provider: PROVIDER,
              status: mapStatus(info.status),
              createdAt: info.createdAt ? new Date(info.createdAt) : new Date(),
              timeout: idleSecs != null ? idleSecs * 1000 : fallbackTimeout,
              metadata: {
                ...decodeMetadata(cfg.spec.labels),
                backend: backendKind,
                isolation: 'microvm',
              },
            };
          } catch (error) {
            if (!isNotFound(error)) throw error;
            return {
              id: sandbox.name,
              provider: PROVIDER,
              status: 'stopped',
              createdAt: new Date(),
              timeout: fallbackTimeout,
              metadata: { backend: backendKind, isolation: 'microvm' },
            };
          }
        },

        getUrl: async (sandbox, options) => {
          if (sandbox.contextKind === 'remote') {
            throw new Error(
              'Microsandbox cloud does not currently support published ports. Use the local backend for this operation.',
            );
          }
          const cfg = await sandbox.config();
          const match = extractPorts(cfg).find(
            (port) => Number(port.guest ?? port.guestPort) === options.port,
          );
          const hostPort = match ? Number(match.host ?? match.hostPort) : NaN;
          if (!match || !Number.isInteger(hostPort)) {
            throw new Error(
              `Guest port ${options.port} was not published. Configure it before creating the microsandbox sandbox.`,
            );
          }
          const host = urlHostForBind(match.bind ?? match.hostBind);
          return `${options.protocol ?? 'http'}://${host}:${hostPort}`;
        },

        getInstance: (sandbox) => sandbox,

        // Resident VM suspend is local-only; omit pause/resume on cloud so
        // provider capability checks accurately report unsupported.
        ...(backend === 'local'
          ? {
              pause: async (sandbox: Sandbox) => {
                await sandbox.pause();
              },
              resume: async (sandbox: Sandbox) => {
                await sandbox.resume();
              },
              pauseCapabilities: { memory: true } as const,
            }
          : {}),

        filesystem: {
          readFile: async (sandbox, path) => readGuestFileStreamed(sandbox.fs(), path),
          writeFile: async (sandbox, path, content) => {
            const fs = sandbox.fs();
            const parent = posixPath.dirname(path);
            if (parent !== '.' && parent !== '/' && !(await fs.exists(parent))) {
              await fs.mkdir(parent);
            }
            await writeGuestFile(fs, path, content);
          },
          mkdir: async (sandbox, path) => sandbox.fs().mkdir(path),
          readdir: async (sandbox, path): Promise<FileEntry[]> => {
            const entries = await sandbox.fs().list(path);
            return entries.map((entry) => ({
              name: posixPath.basename(entry.path),
              type: entry.kind === 'directory' ? 'directory' : 'file',
              size: Number(entry.size),
              ...(entry.modified ? { modified: entry.modified } : {}),
            }));
          },
          exists: async (sandbox, path) => sandbox.fs().exists(path),
          remove: async (sandbox, path) => {
            const fs = sandbox.fs();
            try {
              const stat = await fs.stat(path);
              if (stat.kind === 'directory') await fs.removeDir(path);
              else await fs.remove(path);
            } catch (error) {
              if (!isFileNotFound(error)) throw error;
            }
          },
        },
      },

      snapshot: {
        // A live full-scope capture is tried first (source keeps running,
        // memory checkpointed); where the backend rejects it we fall back to
        // stopping the source for a disk-only capture, so files survive but
        // processes do not. Declared capabilities stay on the conservative
        // disk-only contract; a live capture leaves the source untouched.
        capabilities: {
          scope: 'rootfs',
          memory: false,
          destroysSource: false,
          createOptions: { ephemeral: false },
        },

        create: async (config, instanceId, options?: CreateSnapshotOptions) => {
          const ctx = await config._getContext();
          const sandbox = await ctx.sandboxes.get(instanceId);
          const info = await sandbox.info();
          const wasRunning = info.status === 'running' || info.status === 'draining';
          const name = options?.name ?? `csdk-snapshot-${Date.now().toString(36)}`;
          const labels = {
            [SNAPSHOT_LABEL_MARKER]: 'true',
            [SNAPSHOT_LABEL_SANDBOX]: instanceId,
            ...encodeMetadata(options?.metadata ?? {}),
          };

          if (wasRunning && options?.scope !== 'disk') {
            try {
              let builder = ctx.checkpoints
                .builder(name)
                .fromSandbox(instanceId)
                .full()
                .guestFlush('auto');
              for (const [key, value] of Object.entries(labels)) {
                builder = builder.label(key, value);
              }
              const checkpoint = await builder.create();
              const resolvedLabels = Object.fromEntries(await checkpoint.labels());
              return toSnapshotInfo(checkpoint, instanceId, resolvedLabels);
            } catch (liveError) {
              const fallbackAllowed =
                isUnsupported(liveError) || errorCode(liveError) === 'snapshotSandboxRunning';
              if (!fallbackAllowed || options?.scope === 'full') throw liveError;
            }
          }

          // Disk-only capture requires a stopped sandbox; stopping an ephemeral one removes it.
          const cfg = await sandbox.config();
          if (wasRunning && extractLifecycle(cfg).ephemeral) {
            throw new Error(
              `Microsandbox sandbox ${instanceId} is ephemeral and would be removed by the stop a snapshot requires. ` +
                `Create it with ephemeral: false to snapshot it.`,
            );
          }

          if (wasRunning) {
            await retry(() => sandbox.stopWithTimeout(10_000));
            await sandbox.waitUntilStopped();
          }

          const capture = () => {
            let builder = ctx.checkpoints.builder(name).fromSandbox(instanceId);
            for (const [key, value] of Object.entries(labels)) {
              builder = builder.label(key, value);
            }
            return builder.create();
          };

          let snapshotError: unknown;
          let checkpoint: Checkpoint | undefined;
          try {
            checkpoint = await retrySourceDisk(capture);
          } catch (error) {
            snapshotError = error;
          }

          if (wasRunning) {
            try {
              await sandbox.ensureRunning();
            } catch (restartError) {
              if (!snapshotError) {
                throw new Error(
                  `Snapshot ${name} was created, but restarting sandbox ${instanceId} failed: ${errorMessage(restartError)}`,
                );
              }
            }
          }
          if (snapshotError) throw snapshotError;

          const resolvedLabels = checkpoint ? Object.fromEntries(await checkpoint.labels()) : labels;
          return checkpoint
            ? toSnapshotInfo(checkpoint, instanceId, resolvedLabels)
            : {
                id: name,
                provider: PROVIDER,
                createdAt: new Date(),
                metadata: { name, sandboxId: instanceId, labels: resolvedLabels },
              };
        },

        list: async (config, options?: ListSnapshotsOptions) => {
          const ctx = await config._getContext();
          const filterInstanceId = options?.instanceId ?? options?.sandboxId;
          const snapshots: MicrosandboxSnapshot[] = [];
          for (const checkpoint of await ctx.checkpoints.list()) {
            const labels = Object.fromEntries(await checkpoint.labels());
            if (labels[SNAPSHOT_LABEL_MARKER] !== 'true') continue;
            const sandboxId =
              labels[SNAPSHOT_LABEL_SANDBOX] ?? (await checkpoint.sourceSandbox()) ?? undefined;
            if (filterInstanceId && sandboxId !== filterInstanceId) continue;
            snapshots.push(toSnapshotInfo(checkpoint, sandboxId, labels));
            if (options?.limit && snapshots.length >= options.limit) break;
          }
          return snapshots;
        },

        delete: async (config, snapshotId) => {
          const ctx = await config._getContext();
          await ctx.checkpoints.remove(snapshotId);
        },
      },

      volume: {
        create: async (config, options) => {
          const ctx = await config._getContext();
          let builder = ctx.volumes.builder(options.name);
          if (options.sizeBytes) {
            builder = builder.size(Math.ceil(options.sizeBytes / (1024 * 1024)));
          }
          const volume = await builder.create();
          return { id: volume.id, name: volume.name, native: volume };
        },
        get: async (config, name: string) => {
          const ctx = await config._getContext();
          try {
            const volume = await ctx.volumes.get(name);
            return { id: volume.id, name: volume.name, native: volume };
          } catch (error) {
            if (isVolumeNotFound(error)) return null;
            throw error;
          }
        },
        list: async (config) => {
          const ctx = await config._getContext();
          const volumes = await ctx.volumes.list();
          return volumes.map((volume) => ({ id: volume.id, name: volume.name, native: volume }));
        },
        delete: async (config, name: string) => {
          const ctx = await config._getContext();
          await withVolumeSettle(() => ctx.volumes.remove(name));
        },
      },
    },
  });
}

const cloudProvider = makeProvider('cloud');
const localProvider = makeProvider('local');

/** Create a cloud-first microsandbox provider, or opt into the local runtime explicitly. */
export function microsandbox(
  config: MicrosandboxConfig & ProcessRuntimeOptions = {},
): Provider<Sandbox, never, MicrosandboxSnapshot, Volume> & {
  readonly sizes: InstanceSizeManager;
} {
  const internal: MicrosandboxInternalConfig & ProcessRuntimeOptions = {
    ...config,
    _getContext: createContextGetter(config),
  };
  return (config.backend ?? 'cloud') === 'local'
    ? localProvider(internal)
    : cloudProvider(internal);
}

export default microsandbox;
