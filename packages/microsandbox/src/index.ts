/**
 * Microsandbox Provider - local Linux microVMs via the microsandbox SDK (libkrun).
 *
 * Unlike cloud providers there are no credentials: sandboxes boot as hardware-isolated
 * microVMs on the local machine (KVM on Linux, Hypervisor.framework on macOS). The
 * sandbox name doubles as the computesdk sandboxId, and every sandbox this provider
 * creates is tagged with a marker label so `list()` only ever sees its own.
 */

import { randomUUID } from 'node:crypto';
import { posix as posixPath } from 'node:path';
import {
  Sandbox as MsbSandbox,
  Snapshot as MsbSnapshot,
  SandboxNotFoundError,
} from 'microsandbox';
import type { SandboxHandle as MsbSandboxHandle } from 'microsandbox';
import { defineProvider } from '@computesdk/provider';

import type {
  CommandResult,
  SandboxInfo,
  CreateSandboxOptions,
  FileEntry,
  RunCommandOptions,
} from '@computesdk/provider';

/** Marker label identifying sandboxes created by this provider. */
const LABEL_MARKER = 'computesdk.sandbox';
/** Label prefix under which CreateSandboxOptions.metadata entries are persisted. */
const LABEL_META_PREFIX = 'computesdk.meta.';

export interface MicrosandboxConfig {
  /** OCI image to boot when create() receives no templateId. Default: 'alpine:3.21'. */
  image?: string;
  /** Guest vCPUs. Default: 1. */
  cpus?: number;
  /** Guest memory in MiB. Default: 512. */
  memoryMib?: number;
  /** Writable root disk size in MiB (OCI images only). Omit for the runtime default. */
  rootDiskMib?: number;
  /** Working directory inside the guest. */
  workdir?: string;
  /** Prefix for generated sandbox names (the computesdk sandboxId). Default: 'csdk-'. */
  namePrefix?: string;
  /**
   * TCP port maps applied to every sandbox (microsandbox port maps are declared at
   * boot). Required for getUrl() and therefore for streaming callbacks.
   */
  ports?: Array<{ host: number; guest: number }>;
  /** Reported sandbox timeout in ms (informational; local sandboxes do not expire). Default: 300000. */
  timeout?: number;
  /** Image pull policy passed to the builder (e.g. 'if-not-present'). */
  pullPolicy?: string;
}

/** The TSandbox handle threaded through the provider methods. */
export interface MicrosandboxHandle {
  /** Sandbox name — also the computesdk sandboxId. */
  name: string;
  /** Live connection; connected lazily for handles recovered via getById/list. */
  sandbox: MsbSandbox | null;
  createdAt: Date;
  timeoutMs: number;
  metadata: Record<string, unknown>;
  /** guestPort -> hostPort maps declared at create time. */
  ports: Map<number, number>;
}

const DEFAULTS = {
  image: 'alpine:3.21',
  cpus: 1,
  memoryMib: 512,
  namePrefix: 'csdk-',
  timeout: 300000,
} as const;

/** POSIX single-quote shell escaping. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof SandboxNotFoundError;
}

/** Map a microsandbox status onto the universal SandboxInfo status vocabulary. */
function mapStatus(status: string): SandboxInfo['status'] {
  switch (status) {
    case 'running':
    case 'draining':
      return 'running';
    case 'stopped':
      return 'stopped';
    default:
      return 'error';
  }
}

/** Parse labels / metadata / ports back out of a recovered handle's raw config JSON. */
function recoverFromConfig(configJson: string): {
  labels: Record<string, string>;
  metadata: Record<string, unknown>;
  ports: Map<number, number>;
} {
  const labels: Record<string, string> = {};
  const metadata: Record<string, unknown> = {};
  const ports = new Map<number, number>();
  try {
    const config = JSON.parse(configJson) as Record<string, unknown>;
    const rawLabels = config.labels;
    if (rawLabels && typeof rawLabels === 'object') {
      for (const [key, value] of Object.entries(rawLabels as Record<string, unknown>)) {
        labels[key] = String(value);
        if (key.startsWith(LABEL_META_PREFIX)) {
          metadata[key.slice(LABEL_META_PREFIX.length)] = String(value);
        }
      }
    }
    // Port maps appear under the network config; shapes differ across versions, so
    // parse defensively and fall back to an empty map.
    const network = config.network as { ports?: unknown } | undefined;
    if (Array.isArray(network?.ports)) {
      for (const entry of network.ports as Array<Record<string, unknown>>) {
        const host = Number(entry.host ?? entry.hostPort);
        const guest = Number(entry.guest ?? entry.guestPort);
        if (Number.isFinite(host) && Number.isFinite(guest)) ports.set(guest, host);
      }
    }
  } catch {
    // Unparseable config — treat as label-less; list() falls back to the name prefix.
  }
  return { labels, metadata, ports };
}

function handleFromMsb(
  msbHandle: MsbSandboxHandle,
  timeoutMs: number,
): MicrosandboxHandle {
  const { metadata, ports } = recoverFromConfig(msbHandle.configJson);
  return {
    name: msbHandle.name,
    sandbox: null,
    createdAt: msbHandle.createdAt ?? new Date(),
    timeoutMs,
    metadata,
    ports,
  };
}

/** True when this provider created the sandbox (marker label, or name-prefix fallback). */
function isOurs(msbHandle: MsbSandboxHandle, namePrefix: string): boolean {
  const { labels } = recoverFromConfig(msbHandle.configJson);
  if (labels[LABEL_MARKER] === 'true') return true;
  return msbHandle.name.startsWith(namePrefix);
}

/** Connect lazily: create() populates .sandbox; recovered handles connect on first use. */
async function ensureConnected(handle: MicrosandboxHandle): Promise<MsbSandbox> {
  if (handle.sandbox) return handle.sandbox;
  const msbHandle = await MsbSandbox.get(handle.name);
  const sandbox =
    msbHandle.status === 'running' ? await msbHandle.connect() : await msbHandle.start();
  handle.sandbox = sandbox;
  return sandbox;
}

async function execOnce(
  sandbox: MsbSandbox,
  command: string,
  options?: RunCommandOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = options?.background
    ? `nohup sh -c ${shq(command)} >/dev/null 2>&1 &`
    : command;
  const output = await sandbox.execWith('/bin/sh', (b) => {
    let builder = b.args(['-c', script]);
    if (options?.cwd) builder = builder.cwd(options.cwd);
    if (options?.env && Object.keys(options.env).length > 0) builder = builder.envs(options.env);
    if (options?.timeout) builder = builder.timeout(options.timeout);
    return builder;
  });
  return { stdout: output.stdout(), stderr: output.stderr(), exitCode: output.code };
}

async function runShell(
  handle: MicrosandboxHandle,
  command: string,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const hadCachedConnection = handle.sandbox !== null;
  try {
    const sandbox = await ensureConnected(handle);
    try {
      const result = await execOnce(sandbox, command, options);
      return { ...result, durationMs: Date.now() - started };
    } catch (error) {
      // A cached connection can go stale when the sandbox was stopped and restarted
      // behind our back (e.g. the snapshot quiesce). Reconnect once and retry.
      if (!hadCachedConnection) throw error;
      handle.sandbox = null;
      const fresh = await ensureConnected(handle);
      const result = await execOnce(fresh, command, options);
      return { ...result, durationMs: Date.now() - started };
    }
  } catch (error) {
    return {
      stdout: '',
      stderr: errMsg(error),
      exitCode: 127,
      durationMs: Date.now() - started,
    };
  }
}

export const microsandbox = defineProvider<MicrosandboxHandle, MicrosandboxConfig>({
  name: 'microsandbox',
  methods: {
    sandbox: {
      create: async (config: MicrosandboxConfig, options?: CreateSandboxOptions) => {
        const name = options?.name ?? `${config.namePrefix ?? DEFAULTS.namePrefix}${randomUUID()}`;
        const timeoutMs = options?.timeout ?? config.timeout ?? DEFAULTS.timeout;
        const metadata: Record<string, unknown> = options?.metadata ?? {};
        const portList: Array<{ host: number; guest: number }> = [
          ...(config.ports ?? []),
          ...((options?.ports as Array<{ host: number; guest: number }> | undefined) ?? []),
        ];

        try {
          let builder = MsbSandbox.builder(name);

          // snapshotId is a genuine state restore; the snapshot pins the image, so
          // image()/rootDisk() apply only on the fresh-boot path.
          if (options?.snapshotId) {
            builder = builder.fromSnapshot(options.snapshotId);
          } else {
            const image = options?.templateId ?? config.image ?? DEFAULTS.image;
            builder = config.rootDiskMib
              ? builder.imageWith((i) => i.oci(image).upperSize(config.rootDiskMib as number))
              : builder.image(image);
          }

          builder = builder
            .cpus(config.cpus ?? DEFAULTS.cpus)
            .memory(config.memoryMib ?? DEFAULTS.memoryMib)
            .detached(true)
            .label(LABEL_MARKER, 'true');

          for (const [key, value] of Object.entries(metadata)) {
            builder = builder.label(`${LABEL_META_PREFIX}${key}`, String(value));
          }
          if (options?.envs && Object.keys(options.envs).length > 0) {
            builder = builder.envs(options.envs);
          }
          if (config.workdir) builder = builder.workdir(config.workdir);
          if (config.pullPolicy) builder = builder.pullPolicy(config.pullPolicy);
          for (const { host, guest } of portList) builder = builder.port(host, guest);

          const sandbox = await builder.create();
          const handle: MicrosandboxHandle = {
            name,
            sandbox,
            createdAt: new Date(),
            timeoutMs,
            metadata,
            ports: new Map(portList.map(({ host, guest }) => [guest, host])),
          };
          return { sandbox: handle, sandboxId: name };
        } catch (error) {
          throw new Error(
            `Failed to create microsandbox sandbox "${name}": ${errMsg(error)}. ` +
              `Microsandbox boots local microVMs and needs virtualization support ` +
              `(KVM on Linux, Hypervisor.framework on macOS).`,
          );
        }
      },

      getById: async (config: MicrosandboxConfig, sandboxId: string) => {
        try {
          const msbHandle = await MsbSandbox.get(sandboxId);
          return {
            sandbox: handleFromMsb(msbHandle, config.timeout ?? DEFAULTS.timeout),
            sandboxId,
          };
        } catch (error) {
          // Only a genuinely missing sandbox is the contract's null; anything else
          // (a runtime failure) should propagate rather than masquerade as absence.
          if (isNotFound(error)) return null;
          throw error;
        }
      },

      list: async (config: MicrosandboxConfig) => {
        const namePrefix = config.namePrefix ?? DEFAULTS.namePrefix;
        const handles = await MsbSandbox.list();
        return handles
          .filter((msbHandle) => isOurs(msbHandle, namePrefix))
          .map((msbHandle) => ({
            sandbox: handleFromMsb(msbHandle, config.timeout ?? DEFAULTS.timeout),
            sandboxId: msbHandle.name,
          }));
      },

      destroy: async (_config: MicrosandboxConfig, sandboxId: string) => {
        try {
          const msbHandle = await MsbSandbox.get(sandboxId);
          if (msbHandle.status === 'running' || msbHandle.status === 'draining') {
            try {
              const sandbox = await msbHandle.connect();
              await sandbox.stopWithTimeout(5000);
            } catch {
              // Best effort — a sandbox that raced to stopped is fine; removal is the gate.
            }
          }
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        await MsbSandbox.remove(sandboxId);
      },

      runCommand: runShell,

      getInfo: async (handle: MicrosandboxHandle): Promise<SandboxInfo> => {
        let status: SandboxInfo['status'] = 'running';
        let createdAt = handle.createdAt;
        try {
          const msbHandle = await MsbSandbox.get(handle.name);
          status = mapStatus(msbHandle.status);
          createdAt = msbHandle.createdAt ?? createdAt;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          status = 'stopped';
        }
        return {
          id: handle.name,
          provider: 'microsandbox',
          status,
          createdAt,
          timeout: handle.timeoutMs,
          metadata: {
            ...handle.metadata,
            isolation: 'microVM (libkrun)',
            local: true,
          },
        };
      },

      getUrl: async (
        handle: MicrosandboxHandle,
        options: { port: number; protocol?: string },
      ): Promise<string> => {
        const hostPort = handle.ports.get(options.port);
        if (!hostPort) {
          throw new Error(
            `No host port mapped for guest port ${options.port}. Microsandbox port maps ` +
              `are declared at boot: pass microsandbox({ ports: [{ host, guest: ${options.port} }] }) ` +
              `(or ports on create options) before creating the sandbox.`,
          );
        }
        return `${options.protocol ?? 'http'}://127.0.0.1:${hostPort}`;
      },

      filesystem: {
        readFile: async (handle: MicrosandboxHandle, path: string): Promise<string> => {
          const sandbox = await ensureConnected(handle);
          return sandbox.fs().readToString(path);
        },
        writeFile: async (
          handle: MicrosandboxHandle,
          path: string,
          content: string,
          runCommand,
        ): Promise<void> => {
          const parent = posixPath.dirname(path);
          if (parent && parent !== '/' && parent !== '.') {
            await runCommand(handle, `mkdir -p ${shq(parent)}`);
          }
          const sandbox = await ensureConnected(handle);
          await sandbox.fs().write(path, content);
        },
        mkdir: async (handle, path, runCommand): Promise<void> => {
          const result = await runCommand(handle, `mkdir -p ${shq(path)}`);
          if (result.exitCode !== 0) {
            throw new Error(`mkdir failed for ${path}: ${result.stderr}`);
          }
        },
        readdir: async (handle, path, runCommand): Promise<FileEntry[]> => {
          // `-p` marks directories with a trailing slash — enough for name + type
          // (sizes/mtimes are optional in FileEntry and busybox `ls` output is not
          // stable enough to parse them reliably).
          const result = await runCommand(handle, `ls -1Ap ${shq(path)}`);
          if (result.exitCode !== 0) {
            throw new Error(`readdir failed for ${path}: ${result.stderr}`);
          }
          return result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => ({
              name: line.endsWith('/') ? line.slice(0, -1) : line,
              type: line.endsWith('/') ? ('directory' as const) : ('file' as const),
            }));
        },
        exists: async (handle: MicrosandboxHandle, path: string): Promise<boolean> => {
          const sandbox = await ensureConnected(handle);
          return sandbox.fs().exists(path);
        },
        remove: async (handle, path, runCommand): Promise<void> => {
          const result = await runCommand(handle, `rm -rf ${shq(path)}`);
          if (result.exitCode !== 0) {
            throw new Error(`remove failed for ${path}: ${result.stderr}`);
          }
        },
      },
    },

    snapshot: {
      create: async (
        _config: MicrosandboxConfig,
        sandboxId: string,
        options?: { name?: string; metadata?: Record<string, string> },
      ) => {
        const name = options?.name ?? `${sandboxId}-snap-${Date.now().toString(36)}`;

        // INTERIM: the runtime currently only snapshots stopped sandboxes (disk-consistent
        // capture), while the computesdk contract snapshots running ones — so quiesce
        // transparently: stop, capture, boot back up. Disk state survives; in-guest processes
        // do not. Microsandbox is adding pause/resume and resumable snapshotting; once that
        // lands this block becomes a pause-based capture that preserves running state.
        const msbHandle = await MsbSandbox.get(sandboxId);
        const wasRunning = msbHandle.status === 'running' || msbHandle.status === 'draining';
        if (wasRunning) {
          const sandbox = await msbHandle.connect();
          await sandbox.stopWithTimeout(10000);
        }

        let snapshotError: unknown;
        try {
          let builder = MsbSnapshot.builder(sandboxId).name(name);
          for (const [key, value] of Object.entries(options?.metadata ?? {})) {
            builder = builder.label(key, String(value));
          }
          await builder.create();
        } catch (error) {
          snapshotError = error;
        }

        if (wasRunning) {
          try {
            const stopped = await MsbSandbox.get(sandboxId);
            await stopped.start();
          } catch (restartError) {
            // Only surface the restart failure when the capture itself succeeded —
            // otherwise the original snapshot error is the one that matters.
            if (!snapshotError) {
              throw new Error(
                `Snapshot "${name}" captured, but restarting sandbox "${sandboxId}" failed: ` +
                  errMsg(restartError),
              );
            }
          }
        }
        if (snapshotError) throw snapshotError;

        return {
          snapshotId: name,
          sandboxId,
          name,
          createdAt: new Date(),
          metadata: options?.metadata,
        };
      },
      list: async (_config: MicrosandboxConfig) => {
        const handles = await MsbSnapshot.list();
        return handles.map((snapshot) => ({
          snapshotId: snapshot.name ?? snapshot.digest,
          name: snapshot.name ?? undefined,
          createdAt: snapshot.createdAt,
          imageRef: snapshot.imageRef,
        }));
      },
      delete: async (_config: MicrosandboxConfig, snapshotId: string) => {
        await MsbSnapshot.remove(snapshotId);
      },
    },
  },
});

export default microsandbox;
