import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeJobEvent {
  type: 'output' | 'completed';
  value: Record<string, unknown>;
}

const mock = vi.hoisted(() => ({
  contexts: [] as Array<Record<string, unknown>>,
  activeCreates: 0,
  maxActiveCreates: 0,
  created: [] as Array<Record<string, unknown>>,
  sandboxes: new Map<string, any>(),
  listPages: [] as Array<{ sandboxes: any[]; nextCursor?: string }>,
  execCalls: [] as Array<{ contextKind: string; cmd: string; options: Record<string, unknown> }>,
  execTimeout: false,
  execEvents: [] as Array<Record<string, unknown>>,
  execEventDelayMs: 0,
  execKilled: false,
  detachedDies: false,
  detachedNeverDone: false,
  detachedNeverStarted: false,
  detachedLaunchDrops: false,
  detachedLateClaim: false,
  detachedLaunches: 0,
  detachedCommandRuns: 0,
  truncateFirstRead: false,
  destroyError: null as Error | null,
  destroyFailures: 0,
  destroyAttempts: 0,
  stopFailures: 0,
  stopAttempts: 0,
  ensureRunningCalls: 0,
  createError: null as Error | null,
  createdStatus: 'running',
  skipSandboxOnError: false,
  liveSnapshotUnsupported: true,
  checkpoints: new Map<string, any>(),
  removedCheckpoints: [] as string[],
  volumes: new Map<string, any>(),
  volumeGetError: null as Error | null,
  removedVolumes: [] as string[],
  lastJob: null as any,
}));

vi.mock('microsandbox', () => {
  class ExecBuilder {
    options: Record<string, unknown> = {};
    args(value: string[]) {
      this.options.args = value;
      return this;
    }
    cwd(value: string) {
      this.options.cwd = value;
      return this;
    }
    envs(value: Record<string, string>) {
      this.options.env = value;
      return this;
    }
    timeoutMilliseconds(value: number) {
      this.options.timeoutMilliseconds = value;
      return this;
    }
    stdinNull() {
      this.options.stdin = 'null';
      return this;
    }
  }

  class MountBuilder {
    spec: Record<string, unknown> = {};
    named(name: string) {
      this.spec.named = name;
      return this;
    }
    readonly() {
      this.spec.readonly = true;
      return this;
    }
  }

  class FakeFs {
    files = new Map<string, string>();
    directories = new Set<string>(['/', '/tmp']);
    writes: Array<{ path: string; bytes: number }> = [];
    readCounts = new Map<string, number>();

    async readToString(path: string) {
      const value = this.files.get(path);
      if (value == null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      const count = (this.readCounts.get(path) ?? 0) + 1;
      this.readCounts.set(path, count);
      if (mock.truncateFirstRead && count === 1 && path.endsWith('.out') && value.length > 2) {
        return value.slice(0, 2);
      }
      return value;
    }
    async write(path: string, value: string | Uint8Array) {
      this.writes.push({
        path,
        bytes: typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength,
      });
      this.files.set(path, typeof value === 'string' ? value : new TextDecoder().decode(value));
    }
    async writeStream(path: string) {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk: Uint8Array) => {
          this.writes.push({ path, bytes: chunk.byteLength });
          chunks.push(chunk);
        },
        close: async () => {
          this.files.set(path, Buffer.concat(chunks).toString('utf8'));
        },
      };
    }
    async readStream(path: string) {
      const value = this.files.get(path);
      if (value == null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return { collect: async () => new TextEncoder().encode(value) };
    }
    async list(path: string) {
      return [...this.files.keys()]
        .filter((entry) => entry.startsWith(`${path}/`))
        .map((entry) => ({
          path: entry,
          kind: 'file',
          size: BigInt(this.files.get(entry)?.length ?? 0),
          modified: new Date(0),
        }));
    }
    async mkdir(path: string) {
      this.directories.add(path);
    }
    async exists(path: string) {
      return this.files.has(path) || this.directories.has(path);
    }
    async stat(path: string) {
      if (this.directories.has(path)) return { kind: 'directory' };
      if (this.files.has(path)) return { kind: 'file' };
      throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' });
    }
    async remove(path: string) {
      if (!this.files.has(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      this.files.delete(path);
    }
    async removeDir(path: string) {
      if (!this.directories.has(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      this.directories.delete(path);
    }
  }

  class FakeJob {
    readonly id = 'job-42';
    state = 'running';
    pid: number | null = 4242;
    exitCode: number | null = null;
    timedOut = false;
    stdinChunks: Uint8Array[] = [];
    signals: number[] = [];
    eofClosed = false;
    readonly execOptions: Record<string, unknown>;
    private queue: FakeJobEvent[] = [];
    private waiters: Array<() => void> = [];
    private closed = false;

    constructor(execOptions: Record<string, unknown>) {
      this.execOptions = execOptions;
    }

    pushEvent(event: FakeJobEvent) {
      if (event.type === 'completed') {
        this.state = 'exited';
        this.exitCode = (event.value.exitCode as number | null) ?? 0;
        this.timedOut = Boolean(event.value.timedOut);
      }
      this.queue.push(event);
      this.wake();
    }

    finishStream() {
      this.closed = true;
      this.wake();
    }

    private wake() {
      const current = this.waiters;
      this.waiters = [];
      for (const resolve of current) resolve();
    }

    async inspect() {
      return {
        id: this.id,
        state: this.state,
        pid: this.pid,
        exitCode: this.exitCode,
        timedOut: this.timedOut,
      };
    }

    async attach() {
      const job = this;
      return {
        async writeStdin(chunk: Uint8Array) {
          job.stdinChunks.push(new Uint8Array(chunk));
        },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (job.queue.length > 0) {
              const event = job.queue.shift()!;
              yield event;
              if (event.type === 'completed') return;
            }
            if (job.closed) return;
            await new Promise<void>((resolve) => job.waiters.push(resolve));
          }
        },
      };
    }

    async signal(sig: number) {
      this.signals.push(sig);
    }

    async eof() {
      this.eofClosed = true;
    }

    async wait() {
      return { code: this.exitCode ?? 0, timedOut: this.timedOut };
    }
  }

  class FakeSandbox {
    readonly id: string;
    readonly fsOps = new FakeFs();
    statusValue = 'running';
    configSpec: Record<string, unknown>;
    createdAt = '2026-08-15T00:00:00Z';

    constructor(
      readonly name: string,
      readonly contextKind: 'local' | 'remote',
      configSpec: Record<string, unknown> = {},
    ) {
      this.id = `id-${name}`;
      this.configSpec = configSpec;
    }

    async info() {
      return {
        id: this.id,
        name: this.name,
        status: this.statusValue,
        lastFailureMessage: null,
        createdAt: this.createdAt,
        updatedAt: this.createdAt,
      };
    }

    async config() {
      return {
        kind: this.contextKind,
        spec: this.configSpec,
      };
    }

    async ensureRunning() {
      mock.ensureRunningCalls++;
      this.statusValue = 'running';
    }

    async pause() {
      this.statusValue = 'paused';
    }

    async resume() {
      this.statusValue = 'running';
    }

    async stopWithTimeout() {
      mock.stopAttempts++;
      if (mock.stopAttempts <= mock.stopFailures) throw new Error('temporary stop failure');
      this.statusValue = 'stopped';
    }

    async waitUntilStopped() {
      return { name: this.name, status: this.statusValue };
    }

    async destroy() {
      mock.destroyAttempts++;
      if (mock.destroyAttempts <= mock.destroyFailures) throw new Error('temporary destroy failure');
      if (mock.destroyError) throw mock.destroyError;
      this.statusValue = 'stopped';
      mock.sandboxes.delete(this.name);
    }

    async execWith(cmd: string, configure: (builder: ExecBuilder) => ExecBuilder) {
      const builder = configure(new ExecBuilder());
      mock.execCalls.push({ contextKind: this.contextKind, cmd, options: builder.options });
      const script = (builder.options.args as string[])[1];

      const base = script.match(/\/tmp\/\.csdk-exec-[a-z0-9]+/)?.[0];
      if (base) {
        const [pid, out, err, outLen, errLen, code] = [
          `${base}.pid`,
          `${base}.out`,
          `${base}.err`,
          `${base}.outlen`,
          `${base}.errlen`,
          `${base}.code`,
        ];
        const rm = script.match(/^rm -f ([^;]+);/);
        if (rm) for (const path of rm[1].trim().split(/\s+/)) this.fsOps.files.delete(path);
        if (script.includes('setsid ')) {
          mock.detachedLaunches++;
          const firstLaunch = mock.detachedLaunches === 1;
          const dropped = mock.detachedLaunchDrops && firstLaunch;
          if (mock.detachedLateClaim && !firstLaunch && !this.fsOps.files.has(pid)) {
            this.fsOps.files.set(pid, '9999');
            this.fsOps.files.set(out, 'late-worker\n');
            this.fsOps.files.set(outLen, String(Buffer.byteLength('late-worker\n')));
            this.fsOps.files.set(err, '');
            this.fsOps.files.set(errLen, '0');
            this.fsOps.files.set(code, '0');
            mock.detachedCommandRuns++;
          }
          if (
            !this.fsOps.files.has(pid) &&
            !mock.detachedNeverStarted &&
            !(dropped && !mock.detachedDies)
          ) {
            this.fsOps.files.set(pid, '4242');
            const failed = script.includes('missing-command');
            const outText = script.includes('echo hello') ? 'hello\n' : '';
            const errText = failed ? 'not found\n' : '';
            this.fsOps.files.set(out, outText);
            this.fsOps.files.set(outLen, String(Buffer.byteLength(outText)));
            this.fsOps.files.set(err, errText);
            this.fsOps.files.set(errLen, String(Buffer.byteLength(errText)));
            if (!mock.detachedNeverDone) this.fsOps.files.set(code, failed ? '127' : '0');
            if (mock.detachedDies && firstLaunch) this.fsOps.files.delete(code);
            mock.detachedCommandRuns++;
          }
          if (dropped) throw new Error('exec session ended without exit event');
          return { code: 0, stdout: () => '', stderr: () => '' };
        }
        if (script.includes('test -f')) {
          if (this.fsOps.files.has(code)) return { code: 0, stdout: () => '', stderr: () => '' };
          if (!this.fsOps.files.has(pid)) return { code: 3, stdout: () => '', stderr: () => '' };
          if (mock.detachedDies) return { code: 2, stdout: () => '', stderr: () => '' };
          return { code: 1, stdout: () => '', stderr: () => '' };
        }
        if (script.startsWith('cat ')) {
          const target = script.match(/'([^']+)'/)?.[1] ?? '';
          return { code: 0, stdout: () => this.fsOps.files.get(target) ?? '', stderr: () => '' };
        }
        if (script.startsWith('rm -f') || script.includes('kill')) {
          for (const path of [pid, out, err, outLen, errLen, code]) this.fsOps.files.delete(path);
          return { code: 0, stdout: () => '', stderr: () => '' };
        }
      }

      if (mock.execTimeout) {
        throw Object.assign(new Error('exec timed out'), { code: 'execTimeout' });
      }
      return {
        code: script.includes('missing-command') ? 127 : 0,
        stdout: () => (script.includes('echo hello') ? 'hello\n' : ''),
        stderr: () => (script.includes('missing-command') ? 'not found\n' : ''),
      };
    }

    async execStreamWith(_cmd: string, configure: (builder: ExecBuilder) => ExecBuilder) {
      configure(new ExecBuilder());
      const events = mock.execEvents;
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            if (mock.execEventDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, mock.execEventDelayMs));
            }
            yield event;
          }
        },
        async kill() {
          mock.execKilled = true;
        },
      };
    }

    async execDetachedWith(_cmd: string, configure: (builder: ExecBuilder) => ExecBuilder) {
      const builder = configure(new ExecBuilder());
      const job = new FakeJob(builder.options);
      mock.lastJob = job;
      return job;
    }

    fs() {
      return this.fsOps;
    }
  }

  class FakeCheckpoint {
    readonly digest: string;
    readonly reference: string;
    readonly createdAt = '2026-08-15T00:00:00Z';
    readonly imageRef = 'alpine:3.21';
    readonly sizeBytes = 4096n;

    constructor(
      readonly name: string,
      readonly scope: 'disk' | 'full',
      private readonly sandboxName: string | null,
      private readonly labelEntries: Array<[string, string]>,
    ) {
      this.digest = `sha256:${name}`;
      this.reference = `ref:${name}`;
    }

    async labels() {
      return this.labelEntries;
    }

    async sourceSandbox() {
      return this.sandboxName;
    }
  }

  class SandboxListBuilder {
    cursorValue?: string;
    limit() {
      return this;
    }
    label() {
      return this;
    }
    cursor(value: string) {
      this.cursorValue = value;
      return this;
    }
  }

  class FakeSandboxBuilder {
    config: Record<string, unknown>;
    constructor(
      readonly name: string,
      readonly contextKind: 'local' | 'remote',
      readonly contextMeta: Record<string, unknown>,
    ) {
      this.config = { name, ports: [], volumes: [], contextKind, contextMeta };
    }
    image(value: string) {
      this.config.image = value;
      return this;
    }
    rootDisk(value: number) {
      this.config.rootDisk = value;
      return this;
    }
    cpus(value: number) {
      this.config.cpus = value;
      return this;
    }
    memory(value: number) {
      this.config.memory = value;
      return this;
    }
    detached(value: boolean) {
      this.config.detached = value;
      return this;
    }
    ephemeral(value: boolean) {
      this.config.ephemeral = value;
      return this;
    }
    idleTimeoutSeconds(value: number) {
      this.config.idleTimeoutSeconds = value;
      return this;
    }
    labels(value: Record<string, string>) {
      this.config.labels = value;
      return this;
    }
    workdir(value: string) {
      this.config.workdir = value;
      return this;
    }
    envs(value: Record<string, string>) {
      this.config.envs = value;
      return this;
    }
    pullPolicy(value: string) {
      this.config.pullPolicy = value;
      return this;
    }
    disableNetwork() {
      this.config.networkDisabled = true;
      return this;
    }
    port(host: number, guest: number) {
      (this.config.ports as unknown[]).push({ host, guest });
      return this;
    }
    portBind(bind: string, host: number, guest: number) {
      (this.config.ports as unknown[]).push({ bind, host, guest });
      return this;
    }
    volume(mountPath: string, configure: (b: MountBuilder) => MountBuilder) {
      const mount = configure(new MountBuilder());
      (this.config.volumes as unknown[]).push({ mountPath, ...mount.spec });
      return this;
    }
    async create() {
      mock.activeCreates++;
      mock.maxActiveCreates = Math.max(mock.maxActiveCreates, mock.activeCreates);
      await new Promise((resolve) => setTimeout(resolve, 10));
      mock.activeCreates--;
      mock.created.push({ ...this.config });
      const sandbox = new FakeSandbox(this.name, this.contextKind, {
        labels: this.config.labels,
        network: { ports: this.config.ports },
        lifecycle: {
          ephemeral: this.config.ephemeral,
          idleTimeoutSecs: this.config.idleTimeoutSeconds,
        },
      });
      sandbox.statusValue = mock.createdStatus;
      if (mock.createError && mock.skipSandboxOnError) throw mock.createError;
      mock.sandboxes.set(this.name, sandbox);
      if (mock.createError) throw mock.createError;
      return sandbox;
    }
  }

  class FakeContext {
    readonly sandboxes;
    readonly checkpoints;
    readonly volumes;

    constructor(
      readonly kind: 'local' | 'remote',
      readonly options: Record<string, unknown>,
    ) {
      mock.contexts.push({ kind, ...options });
      const ctx = this;

      this.sandboxes = {
        builder: (name: string) => new FakeSandboxBuilder(name, ctx.kind, ctx.options),
        restore: (snapshot: string) => {
          const restoreConfig: Record<string, unknown> = {
            snapshot,
            ports: [],
            volumes: [],
            contextKind: ctx.kind,
          };
          const builder = {
            name(value: string) {
              restoreConfig.name = value;
              return builder;
            },
            idleTimeoutSeconds(value: number) {
              restoreConfig.idleTimeoutSeconds = value;
              return builder;
            },
            labels(value: Record<string, string>) {
              restoreConfig.labels = value;
              return builder;
            },
            workdir(value: string) {
              restoreConfig.workdir = value;
              return builder;
            },
            envs(value: Record<string, string>) {
              restoreConfig.envs = value;
              return builder;
            },
            cowMemory() {
              restoreConfig.cowMemory = true;
              return builder;
            },
            disableNetwork() {
              restoreConfig.networkDisabled = true;
              return builder;
            },
            port(host: number, guest: number) {
              (restoreConfig.ports as unknown[]).push({ host, guest });
              return builder;
            },
            portBind(bind: string, host: number, guest: number) {
              (restoreConfig.ports as unknown[]).push({ bind, host, guest });
              return builder;
            },
            volume(mountPath: string, configure: (b: MountBuilder) => MountBuilder) {
              const mount = configure(new MountBuilder());
              (restoreConfig.volumes as unknown[]).push({ mountPath, ...mount.spec });
              return builder;
            },
            async restore() {
              const fake = new FakeSandboxBuilder(
                String(restoreConfig.name ?? ''),
                ctx.kind,
                ctx.options,
              );
              Object.assign(fake.config, restoreConfig);
              return fake.create();
            },
          };
          return builder;
        },
        get: async (name: string) => {
          const sandbox = mock.sandboxes.get(name);
          if (!sandbox) throw Object.assign(new Error('not found'), { code: 'sandboxNotFound' });
          return sandbox;
        },
        listWith: async (configure: (builder: SandboxListBuilder) => SandboxListBuilder) => {
          const builder = configure(new SandboxListBuilder());
          const index = builder.cursorValue ? Number(builder.cursorValue) : 0;
          return mock.listPages[index] ?? { sandboxes: [], nextCursor: undefined };
        },
      };

      this.checkpoints = {
        builder: (name = '') => {
          let sourceSandbox: string | null = null;
          let scope: 'disk' | 'full' = 'disk';
          let flushMode: string | undefined;
          const labelEntries: Array<[string, string]> = [];
          const builder = {
            fromSandbox(sandboxName: string) {
              sourceSandbox = sandboxName;
              return builder;
            },
            full() {
              scope = 'full';
              return builder;
            },
            guestFlush(mode: string) {
              flushMode = mode;
              return builder;
            },
            label(key: string, value: string) {
              labelEntries.push([key, value]);
              return builder;
            },
            async create() {
              if (scope === 'full' && mock.liveSnapshotUnsupported) {
                throw Object.assign(new Error('unsupported: live full snapshot'), {
                  code: 'unsupported',
                });
              }
              const cp = new FakeCheckpoint(name, scope, sourceSandbox, [
                ...labelEntries,
                ...(flushMode ? [['_flush', flushMode] as [string, string]] : []),
              ]);
              mock.checkpoints.set(cp.reference, cp);
              return cp;
            },
          };
          return builder;
        },
        get: async (ref: string) => {
          const cp = mock.checkpoints.get(ref);
          if (!cp) throw Object.assign(new Error('snapshot not found'), { code: 'snapshotNotFound' });
          return cp;
        },
        list: async () => [...mock.checkpoints.values()],
        remove: async (ref: string) => {
          mock.removedCheckpoints.push(ref);
          mock.checkpoints.delete(ref);
        },
      };

      this.volumes = {
        builder: (name: string) => {
          let sizeMib: number | undefined;
          const builder = {
            size(mib: number) {
              sizeMib = mib;
              return builder;
            },
            async create() {
              const vol = { id: `vol-${name}`, name, sizeMib };
              mock.volumes.set(name, vol);
              return vol;
            },
          };
          return builder;
        },
        get: async (name: string) => {
          if (mock.volumeGetError) throw mock.volumeGetError;
          const vol = mock.volumes.get(name);
          if (!vol) throw Object.assign(new Error('volume not found'), { code: 'volumeNotFound' });
          return vol;
        },
        list: async () => [...mock.volumes.values()],
        remove: async (name: string) => {
          mock.removedVolumes.push(name);
          mock.volumes.delete(name);
        },
      };
    }
  }

  class LocalContext extends FakeContext {
    constructor(options: Record<string, unknown> = {}) {
      super('local', options);
    }
  }

  class RemoteContext extends FakeContext {
    constructor(options: Record<string, unknown> = {}) {
      super('remote', options);
    }
    toBuilder() {
      const derived: Record<string, unknown> = { ...this.options };
      const builder = {
        computeType(value: string) {
          derived.computeType = value;
          return builder;
        },
        requestTimeoutMs(value: number) {
          derived.requestTimeoutMs = value;
          return builder;
        },
        build() {
          return new RemoteContext(derived);
        },
      };
      return builder;
    }
    static fromProfile(profile: string) {
      return new RemoteContext({ profile });
    }
  }

  return { LocalContext, RemoteContext };
});

let microsandbox: typeof import('../index.js').microsandbox;

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  for (const name of ['MSB_API_KEY', 'MSB_API_URL', 'MSB_BACKEND', 'MSB_PROFILE']) {
    vi.stubEnv(name, '');
  }
  vi.resetModules();
  ({ microsandbox } = await import('../index.js'));
  mock.contexts.length = 0;
  mock.activeCreates = 0;
  mock.maxActiveCreates = 0;
  mock.created.length = 0;
  mock.sandboxes.clear();
  mock.listPages.length = 0;
  mock.execCalls.length = 0;
  mock.execTimeout = false;
  mock.execEvents.length = 0;
  mock.execEventDelayMs = 0;
  mock.execKilled = false;
  mock.detachedDies = false;
  mock.detachedNeverDone = false;
  mock.detachedNeverStarted = false;
  mock.detachedLaunchDrops = false;
  mock.detachedLateClaim = false;
  mock.detachedLaunches = 0;
  mock.detachedCommandRuns = 0;
  mock.truncateFirstRead = false;
  mock.destroyError = null;
  mock.destroyFailures = 0;
  mock.destroyAttempts = 0;
  mock.stopFailures = 0;
  mock.stopAttempts = 0;
  mock.ensureRunningCalls = 0;
  mock.createError = null;
  mock.createdStatus = 'running';
  mock.skipSandboxOnError = false;
  mock.liveSnapshotUnsupported = true;
  mock.checkpoints.clear();
  mock.removedCheckpoints.length = 0;
  mock.volumes.clear();
  mock.volumeGetError = null;
  mock.removedVolumes.length = 0;
  mock.lastJob = null;
});

describe('microsandbox provider', () => {
  it('maps ComputeSDK create options to LocalContext, ports, runtime images, and read-only volumes', async () => {
    const provider = microsandbox({
      backend: 'local',
      home: '/custom/home',
      configPath: '/custom/config.toml',
      workdir: '/workspace',
      ports: [{ bind: '127.0.0.1', host: 4300, guest: 3000 }],
    });
    const sandbox = await provider.instances.create({
      name: 'local-box',
      runtime: 'node',
      cpus: 2,
      memoryMiB: 1024,
      timeout: 60_000,
      envs: { MODE: 'test' },
      metadata: { requestId: 42 },
      volumes: [
        { volume: { name: 'data-vol' }, mountPath: '/data', readOnly: true },
        { volume: { name: 'rw-vol' }, mountPath: '/rw' },
      ],
    });

    expect(mock.contexts[0]).toEqual({
      kind: 'local',
      home: '/custom/home',
      configPath: '/custom/config.toml',
    });
    expect(mock.created[0]).toMatchObject({
      name: 'local-box',
      contextKind: 'local',
      image: 'node:22-alpine',
      cpus: 2,
      memory: 1024,
      idleTimeoutSeconds: 60,
      workdir: '/workspace',
      envs: { MODE: 'test' },
      ports: [{ bind: '127.0.0.1', host: 4300, guest: 3000 }],
      volumes: [
        { mountPath: '/data', named: 'data-vol', readonly: true },
        { mountPath: '/rw', named: 'rw-vol' },
      ],
    });
    expect(await sandbox.getUrl({ port: 3000 })).toBe('http://127.0.0.1:4300');
    expect((await sandbox.getInfo()).metadata).toMatchObject({ backend: 'local', requestId: 42 });
  });

  it('lets a per-sandbox directory override the provider workdir', async () => {
    const provider = microsandbox({ backend: 'local', workdir: '/provider-default' });

    await provider.instances.create({ name: 'custom-workdir', directory: '/per-sandbox' });
    await provider.instances.create({ name: 'default-workdir' });

    expect(mock.created[0]).toMatchObject({ workdir: '/per-sandbox' });
    expect(mock.created[1]).toMatchObject({ workdir: '/provider-default' });
  });

  it('builds local URLs from explicit and wildcard bind addresses', async () => {
    const provider = microsandbox({
      backend: 'local',
      ports: [
        { bind: '192.0.2.10', host: 4301, guest: 3001 },
        { bind: '0.0.0.0', host: 4302, guest: 3002 },
        { bind: '::1', host: 4303, guest: 3003 },
        { bind: '::', host: 4304, guest: 3004 },
      ],
    });
    const sandbox = await provider.instances.create({ name: 'bound-ports' });

    expect(await sandbox.getUrl({ port: 3001 })).toBe('http://192.0.2.10:4301');
    expect(await sandbox.getUrl({ port: 3002 })).toBe('http://127.0.0.1:4302');
    expect(await sandbox.getUrl({ port: 3003, protocol: 'https' })).toBe('https://[::1]:4303');
    expect(await sandbox.getUrl({ port: 3004 })).toBe('http://[::1]:4304');
    await expect(sandbox.getUrl({ port: 9999 })).rejects.toThrow(/Guest port 9999 was not published/);
  });

  it('configures RemoteContext, returns native Sandbox, and omits local-only pause/resume on cloud', async () => {
    const provider = microsandbox({
      apiKey: 'secret',
      apiUrl: 'https://cloud.example.test',
      computeType: 'standard',
      requestTimeoutMs: 15_000,
      ports: [3000],
    });
    const sandbox = await provider.instances.create({ name: 'cloud-box' });
    const instance = sandbox.getInstance();

    expect(mock.contexts[0]).toEqual({
      kind: 'remote',
      apiKey: 'secret',
      url: 'https://cloud.example.test',
      computeType: 'standard',
      requestTimeoutMs: 15_000,
    });
    expect(mock.created[0]).toMatchObject({ contextKind: 'remote', ports: [] });
    expect(instance).toBe(mock.sandboxes.get('cloud-box'));
    expect(instance.contextKind).toBe('remote');
    expect(instance).not.toHaveProperty('apiKey');
    expect(await sandbox.getInfo()).toMatchObject({
      id: 'cloud-box',
      status: 'running',
      metadata: { backend: 'cloud', isolation: 'microvm' },
    });
    await expect(sandbox.getUrl({ port: 3000 })).rejects.toThrow(
      /cloud does not currently support published ports/,
    );
    expect(provider.instances.pause).toBeUndefined();
    expect(sandbox.pause).toBeUndefined();
    expect(sandbox.resume).toBeUndefined();
    await expect(provider.snapshot?.list()).resolves.toEqual([]);
  });

  it('resolves MSB_API_KEY + MSB_API_URL and MSB_PROFILE from the environment', async () => {
    vi.stubEnv('MSB_API_KEY', 'env-key');
    vi.stubEnv('MSB_API_URL', 'https://env.example.test');
    await microsandbox().instances.create({ name: 'env-cloud' });

    expect(mock.contexts[0]).toEqual({
      kind: 'remote',
      apiKey: 'env-key',
      url: 'https://env.example.test',
    });

    vi.stubEnv('MSB_API_KEY', '');
    vi.stubEnv('MSB_API_URL', '');
    vi.stubEnv('MSB_PROFILE', 'staging');
    await microsandbox({ computeType: 'shared', requestTimeoutMs: 5_000 }).instances.create({
      name: 'env-profile',
    });

    expect(mock.contexts[mock.contexts.length - 1]).toEqual({
      kind: 'remote',
      profile: 'staging',
      computeType: 'shared',
      requestTimeoutMs: 5_000,
    });
  });

  it('does not silently fall back to local when cloud credentials are missing', async () => {
    await expect(microsandbox().instances.create({ name: 'missing-cloud' })).rejects.toThrow(
      /cloud is the default.*MSB_API_KEY.*backend: 'local'/,
    );
    expect(mock.created).toEqual([]);
  });

  it('selects named cloud profiles and rejects conflicting backend options', async () => {
    await microsandbox({ profile: 'production' }).instances.create({ name: 'profile-cloud' });
    expect(mock.contexts[0]).toEqual({ kind: 'remote', profile: 'production' });

    await expect(
      microsandbox({ backend: 'local', apiKey: 'secret' }).instances.create({ name: 'invalid-local' }),
    ).rejects.toThrow(/cloud credentials cannot be used with backend: 'local'/);
    await expect(
      microsandbox({ profile: 'production', apiKey: 'secret' }).instances.create({
        name: 'invalid-profile',
      }),
    ).rejects.toThrow(/'profile' cannot be combined with 'apiKey' or 'apiUrl'/);
    await expect(
      microsandbox({ apiUrl: 'https://cloud.example.test' }).instances.create({ name: 'invalid-url' }),
    ).rejects.toThrow(/'apiUrl' requires 'apiKey'/);
  });

  it('runs multiple tenants and local+cloud providers concurrently in one process', async () => {
    const local = microsandbox({ backend: 'local' });
    const tenantA = microsandbox({ apiKey: 'key-a' });
    const tenantB = microsandbox({ apiKey: 'key-b', apiUrl: 'https://b.example.test' });
    const profileC = microsandbox({ profile: 'prod' });

    await Promise.all([
      local.instances.create({ name: 'local-1' }),
      tenantA.instances.create({ name: 'cloud-a' }),
      tenantB.instances.create({ name: 'cloud-b' }),
      profileC.instances.create({ name: 'cloud-c' }),
    ]);

    expect(mock.maxActiveCreates).toBe(4);
    expect(mock.created).toHaveLength(4);
    expect(mock.created.find((c) => c.name === 'local-1')?.contextKind).toBe('local');
    expect(mock.created.find((c) => c.name === 'cloud-a')?.contextMeta).toMatchObject({
      apiKey: 'key-a',
    });
    expect(mock.created.find((c) => c.name === 'cloud-b')?.contextMeta).toMatchObject({
      apiKey: 'key-b',
      url: 'https://b.example.test',
    });
    expect(mock.created.find((c) => c.name === 'cloud-c')?.contextMeta).toMatchObject({
      profile: 'prod',
    });
  });

  it('accepts memoryMib and per-create root disk overrides', async () => {
    const provider = microsandbox({ apiKey: 'key', memoryMib: 512, rootDiskMib: 4096 });
    await provider.instances.create({ name: 'dax', cpus: 8, memoryMib: 16384, rootDiskMib: 8192 } as any);
    expect(mock.created[0]).toMatchObject({ cpus: 8, memory: 16384, rootDisk: 8192 });
    await provider.instances.create({ name: 'canonical', memoryMib: 1024, memoryMiB: 2048 } as any);
    expect(mock.created[1]).toMatchObject({ memory: 2048, rootDisk: 4096 });
  });

  it('defaults to ephemeral sandboxes with a 15-minute idle timeout and supports overrides', async () => {
    await microsandbox({ apiKey: 'key' }).instances.create({ name: 'default' });
    await microsandbox({ apiKey: 'key' }).instances.create({
      name: 'temporary',
      ephemeral: true,
      timeout: 900_000,
    });
    await microsandbox({ apiKey: 'key', ephemeral: false }).instances.create({ name: 'configured' });
    await microsandbox({ apiKey: 'key', ephemeral: true }).instances.create({
      name: 'persistent',
      ephemeral: false,
    });
    expect(mock.created.map((sandbox) => sandbox.ephemeral)).toEqual([true, true, false, false]);
    expect(mock.created[0].idleTimeoutSeconds).toBe(900);
    expect(mock.created[1].idleTimeoutSeconds).toBe(900);
  });

  it('retries destroy on transient failures and ignores already-removed sandboxes', async () => {
    const provider = microsandbox({ apiKey: 'key' });
    await provider.instances.create({ name: 'retry-destroy' });
    mock.destroyFailures = 2;

    await provider.instances.destroy('retry-destroy');
    expect(mock.destroyAttempts).toBe(3);
    expect(mock.sandboxes.has('retry-destroy')).toBe(false);

    // Destroying a missing sandbox is idempotent.
    await expect(provider.instances.destroy('retry-destroy')).resolves.toBeUndefined();
  });

  it('surfaces exhausted destroy retries', async () => {
    const provider = microsandbox({ apiKey: 'key' });
    await provider.instances.create({ name: 'destroy-failed' });
    mock.destroyFailures = 3;

    await expect(provider.instances.destroy('destroy-failed')).rejects.toThrow(
      'temporary destroy failure',
    );
    expect(mock.destroyAttempts).toBe(3);
  });

  it('never creates a sandbox for an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    await expect(
      microsandbox({ apiKey: 'key' }).instances.create({ signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(mock.created).toEqual([]);
  });

  it('destroys a sandbox when the request aborts during native creation', async () => {
    const controller = new AbortController();
    const creation = microsandbox({ apiKey: 'key' }).instances.create({
      name: 'late',
      signal: controller.signal,
    });
    const rejected = expect(creation).rejects.toThrow(/aborted/i);
    await vi.waitFor(() => expect(mock.activeCreates).toBe(1), { interval: 1 });
    controller.abort(new Error('deadline'));
    await rejected;
    await vi.waitFor(() => expect(mock.destroyAttempts).toBe(1));
    expect(mock.created).toHaveLength(1);
    expect(mock.sandboxes.has('late')).toBe(false);
  });

  it('retries cleanup after a transient aborted-create failure', async () => {
    mock.destroyFailures = 1;
    const controller = new AbortController();
    const creation = microsandbox({ apiKey: 'key' }).instances.create({
      name: 'retry-cleanup',
      signal: controller.signal,
    });
    const rejected = expect(creation).rejects.toThrow(/aborted/i);
    await vi.waitFor(() => expect(mock.activeCreates).toBe(1), { interval: 1 });
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(mock.destroyAttempts).toBe(2));
    expect(mock.sandboxes.has('retry-cleanup')).toBe(false);
  });

  it('removes the named sandbox when native creation fails after it exists', async () => {
    mock.createError = new Error(
      'cloud sandbox "readiness" did not reach running before the readiness wait expired',
    );
    mock.createdStatus = 'starting';
    await expect(
      microsandbox({ apiKey: 'key' }).instances.create({ name: 'readiness' }),
    ).rejects.toThrow(/readiness wait expired/);
    expect(mock.destroyAttempts).toBe(1);
    expect(mock.sandboxes.has('readiness')).toBe(false);
  });

  it('does not remove an existing same-name sandbox when create fails', async () => {
    const provider = microsandbox({ apiKey: 'key' });
    await provider.instances.create({ name: 'worker-1' });
    const existing = mock.sandboxes.get('worker-1');
    mock.createError = new Error('sandbox already exists');
    mock.skipSandboxOnError = true;

    await expect(provider.instances.create({ name: 'worker-1' })).rejects.toThrow('already exists');
    expect(mock.destroyAttempts).toBe(0);
    expect(mock.sandboxes.get('worker-1')).toBe(existing);
  });

  it('keeps the create error when failed-create cleanup also fails without leaking SDK details', async () => {
    mock.createError = new Error('readiness wait expired');
    mock.destroyError = new Error('permission denied: sensitive SDK details');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        microsandbox({ apiKey: 'key' }).instances.create({ name: 'leaky' }),
      ).rejects.toThrow('readiness wait expired');
      expect(mock.destroyAttempts).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('leaky');
      expect(warn.mock.calls[0][0]).not.toContain('sensitive SDK details');
    } finally {
      warn.mockRestore();
    }
  });

  it('reports failed aborted-create cleanup without exposing SDK error details', async () => {
    mock.destroyError = new Error('permission denied: sensitive SDK details');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const controller = new AbortController();
      const creation = microsandbox({ apiKey: 'key' }).instances.create({
        name: 'cleanup-failed',
        signal: controller.signal,
      });
      const rejected = expect(creation).rejects.toThrow(/aborted/i);
      await vi.waitFor(() => expect(mock.activeCreates).toBe(1), { interval: 1 });
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(mock.sandboxes.has('cleanup-failed')).toBe(true);
      expect(mock.destroyAttempts).toBe(3);
      expect(warn.mock.calls[0][0]).toContain('cleanup-failed');
      expect(warn.mock.calls[0][0]).not.toContain('sensitive SDK details');
    } finally {
      warn.mockRestore();
    }
  });

  it('drains paginated sandbox listings and restores metadata and ports via config()', async () => {
    const makeListed = (name: string, hostPort: number, hostBind: string) => ({
      id: `id-${name}`,
      name,
      contextKind: 'local' as const,
      info: async () => ({
        id: `id-${name}`,
        name,
        status: 'running',
        lastFailureMessage: null,
        createdAt: '2026-08-15T00:00:00Z',
        updatedAt: '2026-08-15T00:00:00Z',
      }),
      config: async () => ({
        kind: 'local' as const,
        spec: {
          labels: { 'computesdk.metadata.owner': JSON.stringify('test') },
          network: { ports: [{ hostPort, guestPort: 3000, hostBind }] },
          lifecycle: { idleTimeoutSecs: 300 },
        },
      }),
    });
    mock.listPages.push(
      { sandboxes: [makeListed('one', 4101, '127.0.0.1')], nextCursor: '1' },
      { sandboxes: [makeListed('two', 4102, '192.0.2.20')] },
    );

    const sandboxes = await microsandbox({ backend: 'local' }).instances.list();

    expect(sandboxes.map((sandbox) => sandbox.instanceId)).toEqual(['one', 'two']);
    expect(await sandboxes[1].getUrl({ port: 3000 })).toBe('http://192.0.2.20:4102');
    expect(await sandboxes[0].getInfo()).toMatchObject({
      timeout: 300_000,
      metadata: { owner: 'test', backend: 'local' },
    });
  });

  it('runs local commands directly via execWith without detached polling and maps execTimeout to 124', async () => {
    const sandbox = await microsandbox({ backend: 'local' }).instances.create({ name: 'local-exec' });

    expect(await sandbox.runCommand('echo hello', { timeout: 5_000 })).toMatchObject({
      stdout: 'hello\n',
      exitCode: 0,
    });
    expect(mock.detachedLaunches).toBe(0);
    expect(mock.execCalls[0].options).toMatchObject({
      args: ['-c', 'echo hello'],
      timeoutMilliseconds: 5_000,
    });

    expect((await sandbox.runCommand('missing-command')).exitCode).toBe(127);

    mock.execTimeout = true;
    expect(await sandbox.runCommand('sleep 60', { timeout: 100 })).toMatchObject({
      stdout: '',
      stderr: '',
      exitCode: 124,
    });
  });

  it('streams stdout and stderr through native execStreamWith events and kills on timeout', async () => {
    const sandbox = await microsandbox({ backend: 'local' }).instances.create({ name: 'stream-box' });

    mock.execEvents.push(
      { kind: 'started', pid: 1 },
      { kind: 'stdout', data: new TextEncoder().encode('out\n') },
      { kind: 'stderr', data: new TextEncoder().encode('err\n') },
      { kind: 'exited', code: 3 },
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await sandbox.runCommand('stream', {
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });

    expect(result).toMatchObject({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 });
    expect(stdout).toEqual(['out\n']);
    expect(stderr).toEqual(['err\n']);

    mock.execEvents.length = 0;
    mock.execEvents.push({ kind: 'exited', code: 0 });
    mock.execEventDelayMs = 20;

    const timedOut = await sandbox.runCommand('sleep 60', { timeout: 5, onStdout: () => {} });
    expect(mock.execKilled).toBe(true);
    expect(timedOut.exitCode).toBe(124);
  });

  it('uses cloud-relay-safe detached execution and retries truncated reads via cat', async () => {
    const sandbox = await microsandbox({ apiKey: 'key' }).instances.create({ name: 'cloud-exec' });
    mock.truncateFirstRead = true;

    const result = await sandbox.runCommand('echo hello');
    expect(mock.detachedLaunches).toBe(1);
    expect(result).toMatchObject({ stdout: 'hello\n', exitCode: 0 });
  });

  it('fails fast on cloud when the provider reaps the detached worker', async () => {
    const sandbox = await microsandbox({ apiKey: 'key' }).instances.create({ name: 'reaped-box' });
    mock.detachedDies = true;

    await expect(sandbox.runCommand('echo hello')).rejects.toThrow(/detached command died/);
  });

  it('fails fast on cloud when the detached worker never starts', async () => {
    const sandbox = await microsandbox({ apiKey: 'key' }).instances.create({ name: 'never-box' });
    mock.detachedNeverStarted = true;

    vi.useFakeTimers();
    try {
      const pending = sandbox.runCommand('echo hello');
      const assertion = expect(pending).rejects.toThrow(/never started/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the cloud command once when a late first worker races the relaunch', async () => {
    const sandbox = await microsandbox({ apiKey: 'key' }).instances.create({ name: 'racy-box' });
    mock.detachedLaunchDrops = true;
    mock.detachedLateClaim = true;

    vi.useFakeTimers();
    try {
      const pending = sandbox.runCommand('echo hello');
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.stdout).toBe('late-worker\n');
      expect(result.exitCode).toBe(0);
      expect(mock.detachedLaunches).toBe(2);
      expect(mock.detachedCommandRuns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the stale pid claim before relaunching a dead cloud worker', async () => {
    const sandbox = await microsandbox({ apiKey: 'key' }).instances.create({
      name: 'dead-worker-box',
    });
    mock.detachedLaunchDrops = true;
    mock.detachedDies = true;

    vi.useFakeTimers();
    try {
      const pending = sandbox.runCommand('echo hello');
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.stdout).toBe('hello\n');
      expect(result.exitCode).toBe(0);
      expect(mock.detachedLaunches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out cloud detached commands with partial output and exit 124', async () => {
    const sandbox = await microsandbox({ apiKey: 'key' }).instances.create({ name: 'slow-box' });
    mock.detachedNeverDone = true;

    const result = await sandbox.runCommand('sleep 60', { timeout: 5 });
    expect(result.exitCode).toBe(124);
  });

  it('runs local startProcess over the native Job API with chunked stdin, signals, and status', async () => {
    const sandbox = await microsandbox({ backend: 'local' }).instances.create({ name: 'job-box' });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exited: { exitCode: number | null; signal: string | null } | undefined;

    const proc = await sandbox.startProcess('cat', {
      stdin: true,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
      onExit: (info) => {
        exited = info;
      },
    });

    expect(proc.runtime).toBe('native');
    expect(proc.pid).toBe(4242);
    expect(await proc.status()).toMatchObject({ status: 'running', exitCode: null });

    // > 16 KiB payload must be split into <= 16 KiB writeStdin chunks.
    const bigInput = 'a'.repeat(40_000);
    await proc.write(bigInput);
    expect(mock.lastJob.stdinChunks.length).toBe(3);
    expect(Math.max(...mock.lastJob.stdinChunks.map((c: Uint8Array) => c.byteLength))).toBeLessThanOrEqual(
      16 * 1024,
    );

    await proc.closeStdin();
    expect(mock.lastJob.eofClosed).toBe(true);

    await proc.kill('SIGTERM');
    expect(mock.lastJob.signals).toEqual([15]);

    mock.lastJob.pushEvent({
      type: 'output',
      value: { source: 'stdout', data: new TextEncoder().encode('ok\n') },
    });
    mock.lastJob.pushEvent({
      type: 'output',
      value: { source: 'stderr', data: new TextEncoder().encode('warn\n') },
    });
    mock.lastJob.pushEvent({
      type: 'completed',
      value: { pid: 4242, exitCode: 0, timedOut: false },
    });

    const result = await proc.wait();
    expect(result).toMatchObject({ stdout: 'ok\n', stderr: 'warn\n', exitCode: 0, signal: 'SIGTERM' });
    expect(stdout).toEqual(['ok\n']);
    expect(stderr).toEqual(['warn\n']);
    expect(exited).toEqual({ exitCode: 0, signal: 'SIGTERM' });
    expect(await proc.status()).toMatchObject({ status: 'exited', exitCode: 0, signal: 'SIGTERM' });
  });

  it('rejects stdin writes when stdin is disabled and times out wait()', async () => {
    const sandbox = await microsandbox({ backend: 'local' }).instances.create({ name: 'job-ro' });
    const proc = await sandbox.startProcess('sleep 60');

    expect(mock.lastJob.execOptions.stdin).toBe('null');
    await expect(proc.write('nope')).rejects.toThrow(/not started with stdin: true/);
    await expect(proc.wait({ timeout: 10 })).rejects.toThrow(/did not exit within 10ms/);

    mock.lastJob.pushEvent({
      type: 'completed',
      value: { pid: 4242, exitCode: 0, timedOut: false },
    });
    await proc.wait();
  });

  it('pauses and resumes a local sandbox through the unified lifecycle', async () => {
    const provider = microsandbox({ backend: 'local' });
    const sandbox = await provider.instances.create({ name: 'pause-box' });

    expect(provider.instances.pause).toEqual({ memory: true });
    await sandbox.pause!();
    expect(mock.sandboxes.get('pause-box')!.statusValue).toBe('paused');
    await sandbox.resume!();
    expect(mock.sandboxes.get('pause-box')!.statusValue).toBe('running');
  });

  it('captures live full checkpoints when supported and restores with cowMemory, labels, envs, workdir, and volumes', async () => {
    mock.liveSnapshotUnsupported = false;
    const provider = microsandbox({ backend: 'local', ports: [{ host: 4400, guest: 3000 }] });
    const sandbox = await provider.instances.create({ name: 'live-src', ephemeral: false });

    const snap = await provider.snapshot!.create(sandbox.instanceId, {
      name: 'live-snap',
      metadata: { stage: 'warm' },
    });

    expect(snap.id).toBe('ref:live-snap');
    expect(snap.metadata).toMatchObject({
      name: 'live-snap',
      sandboxId: 'live-src',
      scope: 'full',
    });
    expect(mock.stopAttempts).toBe(0);

    await provider.instances.create({
      name: 'restored-live',
      snapshotId: snap.id,
      directory: '/app',
      envs: { RESTORED: '1' },
      metadata: { run: 2 },
      volumes: [{ volume: { name: 'cache' }, mountPath: '/cache', readOnly: true }],
    });

    expect(mock.created[1]).toMatchObject({
      name: 'restored-live',
      snapshot: 'ref:live-snap',
      cowMemory: true,
      workdir: '/app',
      envs: { RESTORED: '1' },
      ports: [{ host: 4400, guest: 3000 }],
      volumes: [{ mountPath: '/cache', named: 'cache', readonly: true }],
    });
    expect(mock.created[1].labels).toMatchObject({
      'computesdk.sandbox': 'true',
      'computesdk.metadata.run': '2',
    });

    const listed = await provider.snapshot!.list({ instanceId: 'live-src' });
    expect(listed.map((s) => s.id)).toEqual(['ref:live-snap']);

    await provider.snapshot!.delete(snap.id);
    expect(mock.removedCheckpoints).toEqual(['ref:live-snap']);
  });

  it('falls back to stop, disk capture, and ensureRunning when live full capture is unsupported', async () => {
    const provider = microsandbox({ backend: 'local' });
    expect(provider.snapshot?.capabilities).toEqual({
      scope: 'rootfs',
      memory: false,
      destroysSource: false,
      createOptions: { ephemeral: false },
    });

    const sandbox = await provider.instances.create({ name: 'disk-src', ephemeral: false });
    const snap = await provider.snapshot!.create(sandbox.instanceId, { name: 'disk-snap' });

    expect(snap.id).toBe('ref:disk-snap');
    expect(snap.metadata.scope).toBe('disk');
    expect(mock.stopAttempts).toBe(1);
    expect(mock.ensureRunningCalls).toBe(1);
    expect(mock.sandboxes.get('disk-src')!.statusValue).toBe('running');
  });

  it('refuses to snapshot a running ephemeral sandbox instead of stopping it away', async () => {
    const provider = microsandbox({ backend: 'local' });
    const sandbox = await provider.instances.create({ name: 'ephemeral-box' });

    await expect(provider.snapshot!.create(sandbox.instanceId)).rejects.toThrow(
      /ephemeral.*ephemeral: false/,
    );
    expect(mock.sandboxes.get('ephemeral-box')!.statusValue).toBe('running');
    expect(mock.stopAttempts).toBe(0);
  });

  it('manages volumes through ctx.volumes and returns null on volumeNotFound', async () => {
    const provider = microsandbox({ backend: 'local' });
    const created = await provider.volume!.create({ name: 'models', sizeBytes: 1500 * 1024 });
    expect(created).toMatchObject({ id: 'vol-models', name: 'models' });
    expect(mock.volumes.get('models')?.sizeMib).toBe(2);

    expect(await provider.volume!.get('models')).toMatchObject({ id: 'vol-models', name: 'models' });
    expect(await provider.volume!.get('missing')).toBeNull();
    expect(await provider.volume!.list()).toHaveLength(1);

    mock.volumeGetError = new Error('boom');
    await expect(provider.volume!.get('models')).rejects.toThrow('boom');
    mock.volumeGetError = null;

    await provider.volume!.delete('models');
    expect(mock.removedVolumes).toEqual(['models']);
  });

  it('uses the native filesystem surface with parent creation, chunked writes, and idempotent remove', async () => {
    const sandbox = await microsandbox({ backend: 'local' }).instances.create({ name: 'fs-box' });
    await sandbox.filesystem.writeFile('/workspace/hello.txt', 'hello');

    expect(await sandbox.filesystem.readFile('/workspace/hello.txt')).toBe('hello');
    expect(await sandbox.filesystem.exists('/workspace/hello.txt')).toBe(true);
    expect(await sandbox.filesystem.readdir('/workspace')).toEqual([
      { name: 'hello.txt', type: 'file', size: 5, modified: new Date(0) },
    ]);

    await sandbox.filesystem.remove('/workspace/hello.txt');
    expect(await sandbox.filesystem.exists('/workspace/hello.txt')).toBe(false);
    // Removing a missing path succeeds idempotently.
    await expect(sandbox.filesystem.remove('/workspace/hello.txt')).resolves.toBeUndefined();

    // Large writes stream in chunks <= 256 KiB.
    const content = 'x'.repeat(1024 * 1024 + 7);
    await sandbox.filesystem.writeFile('/large.txt', content);
    const fsOps = (sandbox.getInstance() as any).fsOps;
    const writes = fsOps.writes.filter((w: { path: string }) => w.path === '/large.txt');
    expect(writes.length).toBe(5);
    expect(Math.max(...writes.map((w: { bytes: number }) => w.bytes))).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(await sandbox.filesystem.readFile('/large.txt')).toBe(content);
  });
});
