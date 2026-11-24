import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  CommandResult,
  ProcessHandle,
  ProcessStatus,
  RunCommandOptions,
  StartProcessOptions,
} from '@computesdk/provider';
import type { Job, JobAttachment, Sandbox } from 'microsandbox';

const TIMEOUT_EXIT_CODE = 124;

/** How many consecutive never-started polls the cloud detached wait tolerates (~2s per poll). */
const DETACHED_NEVER_STARTED_POLL_LIMIT = 15;

/** JobAttachment.writeStdin admits at most 16 KiB per call. */
const JOB_STDIN_CHUNK_BYTES = 16 * 1024;

const SIGNAL_NUMBERS: Record<string, number> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  ABRT: 6,
  KILL: 9,
  USR1: 10,
  USR2: 12,
  PIPE: 13,
  TERM: 15,
};

interface ExecBuilderLike {
  args(args: string[]): this;
  cwd(cwd: string): this;
  envs(env: Record<string, string>): this;
  timeoutMilliseconds(ms: number): this;
  stdinNull?(): this;
}

interface DetachedPaths {
  pid: string;
  out: string;
  err: string;
  outLen: string;
  errLen: string;
  code: string;
}

function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function backgroundScript(command: string): string {
  return `nohup /bin/sh -c ${shellSingleQuote(command)} >/dev/null 2>&1 &`;
}

function configureExec<T extends ExecBuilderLike>(
  builder: T,
  script: string,
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  includeTimeout = true,
): T {
  let configured = builder.args(['-c', script]);
  if (options?.cwd) configured = configured.cwd(options.cwd);
  if (options?.env && Object.keys(options.env).length > 0) configured = configured.envs(options.env);
  if (includeTimeout && options?.timeout) configured = configured.timeoutMilliseconds(options.timeout);
  return configured;
}

function parseSignal(signal: string): { name: string; num: number } {
  const short = signal.replace(/^SIG/i, '').toUpperCase();
  const num = SIGNAL_NUMBERS[short];
  if (!num) throw new Error(`microsandbox: invalid signal ${signal}`);
  return { name: `SIG${short}`, num };
}

function isExecTimeout(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'execTimeout';
}

/**
 * The agent's exec stream closed before sending an exit event — a channel-level
 * flake, not a command outcome. Worth one transparent retry on cloud launch.
 */
function isExecSessionDrop(error: unknown): boolean {
  return error instanceof Error && /exec session ended without exit event/i.test(error.message);
}

function detachedPaths(id: string): DetachedPaths {
  const base = `/tmp/.csdk-exec-${id}`;
  return {
    pid: `${base}.pid`,
    out: `${base}.out`,
    err: `${base}.err`,
    outLen: `${base}.outlen`,
    errLen: `${base}.errlen`,
    code: `${base}.code`,
  };
}

/**
 * Worker for cloud-relay-safe detached execution: claim the run atomically via
 * noclobber pid write, execute the command capturing stdout/stderr, record byte
 * counts before writing the exit sentinel, and run under setsid so relay session
 * cleanup cannot reap it.
 */
function detachedLaunchScript(command: string, paths: DetachedPaths): string {
  const inner =
    `( set -C; echo $$ > ${paths.pid} 2>/dev/null ) || exit 0;` +
    ` ( ${command}\n) > ${paths.out} 2> ${paths.err};` +
    ` C=$?;` +
    ` wc -c < ${paths.out} > ${paths.outLen} 2>/dev/null;` +
    ` wc -c < ${paths.err} > ${paths.errLen} 2>/dev/null;` +
    ` printf '%s' "$C" > ${paths.code}`;
  return `setsid /bin/sh -c ${shellSingleQuote(inner)} </dev/null >/dev/null 2>&1 &`;
}

/**
 * Short status probe for the cloud detached worker.
 * exit 0 = done, 1 = running, 2 = died before exit sentinel, 3 = never started.
 */
function detachedStatusScript(paths: DetachedPaths): string {
  return (
    `test -f ${paths.code} && exit 0;` +
    ` test -f ${paths.pid} || exit 3;` +
    ` P=$(cat ${paths.pid});` +
    ` [ -n "$P" ] && ! kill -0 "$P" 2>/dev/null && { test -f ${paths.code} && exit 0; exit 2; };` +
    ` exit 1`
  );
}

function detachedKillScript(paths: DetachedPaths): string {
  return (
    `P=$(cat ${paths.pid} 2>/dev/null);` +
    ` [ -n "$P" ] && { kill -TERM -"$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null; };` +
    ` sleep 1;` +
    ` [ -n "$P" ] && { kill -KILL -"$P" 2>/dev/null || kill -KILL "$P" 2>/dev/null; };` +
    ` true`
  );
}

function detachedCleanupScript(paths: DetachedPaths): string {
  return `rm -f ${paths.pid} ${paths.out} ${paths.err} ${paths.outLen} ${paths.errLen} ${paths.code}`;
}

async function execShort(sandbox: Sandbox, script: string) {
  return sandbox.execWith('/bin/sh', (builder) => builder.args(['-c', script]));
}

async function readGuestFile(sandbox: Sandbox, path: string): Promise<string> {
  try {
    return await sandbox.fs().readToString(path);
  } catch {
    const output = await execShort(sandbox, `cat ${shellSingleQuote(path)} 2>/dev/null`);
    return output.stdout();
  }
}

/**
 * The cloud relay can drop a chunk mid-read on either transport (fs API and exec
 * stdout alike). Compare against the byte count written by the worker and retry
 * once over the alternate transport on mismatch.
 */
async function readGuestFileChecked(
  sandbox: Sandbox,
  path: string,
  lenPath: string,
): Promise<string> {
  const lenText = await readGuestFile(sandbox, lenPath).catch(() => '');
  const expected = Number.parseInt(lenText.trim(), 10);
  const first = await readGuestFile(sandbox, path);
  if (Number.isNaN(expected) || Buffer.byteLength(first) === expected) return first;
  const output = await execShort(sandbox, `cat ${shellSingleQuote(path)} 2>/dev/null`);
  const second = output.stdout();
  return Buffer.byteLength(second) >= Buffer.byteLength(first) ? second : first;
}

/**
 * Cloud relay drops long-lived exec sessions (~2 min observed) and can drop
 * output chunks mid-stream. Detached execution keeps every exec short-lived
 * while preserving exit code, stdout/stderr, timeout (exit 124), and fast
 * failure if the worker is reaped.
 */
async function runCloudRelaySafeCommand(
  sandbox: Sandbox,
  command: string,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const startedAt = performance.now();
  const paths = detachedPaths(randomUUID().slice(0, 8));
  const launch = detachedLaunchScript(command, paths);

  let launched = false;
  let staleClaim = false;
  for (let attempt = 0; attempt < 2 && !launched; attempt++) {
    try {
      const script = staleClaim ? `rm -f ${paths.pid}; ${launch}` : launch;
      await sandbox.execWith('/bin/sh', (builder) => configureExec(builder, script, options, false));
      launched = true;
    } catch (error) {
      if (!isExecSessionDrop(error) || attempt === 1) throw error;
      for (let probe = 0; probe < 3 && !launched; probe++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const status = await execShort(sandbox, detachedStatusScript(paths)).catch(() => null);
        if (status && (status.code === 0 || status.code === 1)) launched = true;
        else if (status?.code === 2) {
          staleClaim = true;
          break;
        }
      }
    }
  }

  const deadline =
    options?.timeout != null ? startedAt + options.timeout : Number.POSITIVE_INFINITY;
  let pollErrors = 0;
  let neverStartedPolls = 0;
  for (;;) {
    let status;
    try {
      status = await execShort(sandbox, detachedStatusScript(paths));
      pollErrors = 0;
    } catch (error) {
      if (++pollErrors >= 3) throw error;
      status = null;
    }
    if (status?.code === 0) break;
    if (status?.code === 2) {
      throw new Error(
        `microsandbox detached command died before completing (pid ${paths.pid} gone, no exit sentinel)`,
      );
    }
    if (status?.code === 3) {
      if (++neverStartedPolls >= DETACHED_NEVER_STARTED_POLL_LIMIT) {
        throw new Error(
          `microsandbox detached command never started (no sentinel files after ~${Math.round((neverStartedPolls * 2_000) / 1000)}s)`,
        );
      }
    } else {
      neverStartedPolls = 0;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      await execShort(sandbox, detachedKillScript(paths)).catch(() => undefined);
      const [stdout, stderr] = await Promise.all([
        readGuestFileChecked(sandbox, paths.out, paths.outLen).catch(() => ''),
        readGuestFileChecked(sandbox, paths.err, paths.errLen).catch(() => ''),
      ]);
      await execShort(sandbox, detachedCleanupScript(paths)).catch(() => undefined);
      return {
        stdout,
        stderr,
        exitCode: TIMEOUT_EXIT_CODE,
        durationMs: performance.now() - startedAt,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(remaining, 1))));
  }

  try {
    const [stdout, stderr, codeText] = await Promise.all([
      readGuestFileChecked(sandbox, paths.out, paths.outLen),
      readGuestFileChecked(sandbox, paths.err, paths.errLen),
      readGuestFile(sandbox, paths.code),
    ]);
    const exitCode = Number.parseInt(codeText.trim(), 10);
    return {
      stdout,
      stderr,
      exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
      durationMs: performance.now() - startedAt,
    };
  } finally {
    await execShort(sandbox, detachedCleanupScript(paths)).catch(() => undefined);
  }
}

/**
 * Execute a shell command. Local sandboxes run directly through `execWith`
 * without polling overhead; cloud sandboxes use detached file-backed capture
 * to survive relay session limits.
 */
export async function runMicrosandboxCommand(
  sandbox: Sandbox,
  command: string,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  if (sandbox.contextKind === 'remote' && !options?.background) {
    return runCloudRelaySafeCommand(sandbox, command, options);
  }

  const startedAt = performance.now();
  const script = options?.background ? backgroundScript(command) : command;
  try {
    const output = await sandbox.execWith('/bin/sh', (builder) =>
      configureExec(builder, script, options, true),
    );
    return {
      stdout: output.stdout(),
      stderr: output.stderr(),
      exitCode: output.code,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (isExecTimeout(error)) {
      return {
        stdout: '',
        stderr: '',
        exitCode: TIMEOUT_EXIT_CODE,
        durationMs: performance.now() - startedAt,
      };
    }
    throw error;
  }
}

/**
 * Stream stdout/stderr live over `execStreamWith`.
 */
export async function streamMicrosandboxCommand(
  sandbox: Sandbox,
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  if (options.background) return runMicrosandboxCommand(sandbox, command, options);

  const startedAt = performance.now();
  const execution = await sandbox.execStreamWith('/bin/sh', (builder) =>
    configureExec(builder, command, options, false),
  );
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let stdout = '';
  let stderr = '';
  let exitCode = 1;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  if (options.timeout) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void execution.kill().catch(() => {});
    }, options.timeout);
  }

  try {
    for await (const event of execution) {
      if (event.kind === 'stdout') {
        const chunk = stdoutDecoder.decode(event.data, { stream: true });
        stdout += chunk;
        if (chunk) options.onStdout?.(chunk);
      } else if (event.kind === 'stderr') {
        const chunk = stderrDecoder.decode(event.data, { stream: true });
        stderr += chunk;
        if (chunk) options.onStderr?.(chunk);
      } else if (event.kind === 'exited') {
        exitCode = event.code;
      }
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const stdoutTail = stdoutDecoder.decode();
  const stderrTail = stderrDecoder.decode();
  stdout += stdoutTail;
  stderr += stderrTail;
  if (stdoutTail) options.onStdout?.(stdoutTail);
  if (stderrTail) options.onStderr?.(stderrTail);

  return {
    stdout,
    stderr,
    exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
    durationMs: performance.now() - startedAt,
  };
}

class MicrosandboxJobHandle implements ProcessHandle {
  readonly runtime = 'native' as const;
  readonly jobId: string;
  private currentPid: number | null;
  private stdout = '';
  private stderr = '';
  private sentSignal: string | null = null;
  private exitResult?: { exitCode: number; signal: string | null };
  private readonly startedAt = performance.now();
  private readonly settled: Promise<{ exitCode: number; signal: string | null }>;

  constructor(
    private readonly job: Job,
    private readonly attachment: JobAttachment | null,
    private readonly options: StartProcessOptions,
    initialPid: number | null,
  ) {
    this.jobId = job.id;
    this.currentPid = initialPid;
    this.settled = this.pump();
  }

  get pid(): number | null {
    return this.currentPid;
  }

  private async pump(): Promise<{ exitCode: number; signal: string | null }> {
    const outDecoder = new TextDecoder();
    const errDecoder = new TextDecoder();
    let exitCode: number | null = null;

    try {
      if (this.attachment) {
        for await (const event of this.attachment) {
          if (event.type === 'output') {
            const { source, data } = event.value;
            if (source === 'stdout' || source === 'output') {
              const text = outDecoder.decode(data, { stream: true });
              this.stdout += text;
              if (text) this.options.onStdout?.(text);
            } else if (source === 'stderr') {
              const text = errDecoder.decode(data, { stream: true });
              this.stderr += text;
              if (text) this.options.onStderr?.(text);
            }
          } else if (event.type === 'completed') {
            this.currentPid = event.value.pid ?? this.currentPid;
            exitCode = event.value.timedOut ? TIMEOUT_EXIT_CODE : (event.value.exitCode ?? -1);
            break;
          }
        }
      } else {
        for (const entry of await this.job.logs()) {
          if (entry.source === 'stdout' || entry.source === 'output') {
            const text = outDecoder.decode(entry.data, { stream: true });
            this.stdout += text;
            if (text) this.options.onStdout?.(text);
          } else if (entry.source === 'stderr') {
            const text = errDecoder.decode(entry.data, { stream: true });
            this.stderr += text;
            if (text) this.options.onStderr?.(text);
          }
        }
      }
    } catch {
      // Fall back to job.wait() below to obtain the final outcome if the attachment ended early.
    } finally {
      const outTail = outDecoder.decode();
      const errTail = errDecoder.decode();
      if (outTail) {
        this.stdout += outTail;
        this.options.onStdout?.(outTail);
      }
      if (errTail) {
        this.stderr += errTail;
        this.options.onStderr?.(errTail);
      }
    }

    if (exitCode === null) {
      try {
        const exit = await this.job.wait();
        exitCode = exit.timedOut ? TIMEOUT_EXIT_CODE : exit.code;
      } catch {
        exitCode = -1;
      }
    }

    const result = { exitCode, signal: this.sentSignal };
    this.exitResult = result;
    try {
      this.options.onExit?.(result);
    } catch {
      // A throwing callback must not alter the process outcome.
    }
    return result;
  }

  async write(data: string | Uint8Array): Promise<void> {
    if (!this.options.stdin) {
      throw new Error(`microsandbox: process ${this.jobId} was not started with stdin: true`);
    }
    if (this.exitResult || !this.attachment) {
      throw new Error(`microsandbox: process ${this.jobId} has exited`);
    }
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    for (let offset = 0; offset < bytes.byteLength; offset += JOB_STDIN_CHUNK_BYTES) {
      await this.attachment.writeStdin(bytes.subarray(offset, offset + JOB_STDIN_CHUNK_BYTES));
    }
  }

  async closeStdin(): Promise<void> {
    if (!this.options.stdin || this.exitResult) return;
    await this.job.eof();
  }

  async status(): Promise<ProcessStatus> {
    if (this.exitResult) {
      return {
        status: 'exited',
        exitCode: this.exitResult.exitCode,
        signal: this.exitResult.signal,
        stdout: this.stdout,
        stderr: this.stderr,
      };
    }
    const info = await this.job.inspect();
    this.currentPid = info.pid ?? this.currentPid;
    const exited = info.state !== 'running' && info.state !== 'starting';
    return {
      status: exited ? 'exited' : 'running',
      exitCode: exited ? (info.timedOut ? TIMEOUT_EXIT_CODE : info.exitCode) : null,
      signal: exited ? this.sentSignal : null,
      stdout: this.stdout,
      stderr: this.stderr,
    };
  }

  async wait(options?: { timeout?: number }): Promise<CommandResult & { signal: string | null }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await (options?.timeout === undefined
        ? this.settled
        : Promise.race([
            this.settled,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(`microsandbox: process ${this.jobId} did not exit within ${options.timeout}ms`),
                  ),
                options.timeout,
              );
            }),
          ]));
      return {
        stdout: this.stdout,
        stderr: this.stderr,
        exitCode: exit.exitCode,
        signal: exit.signal,
        durationMs: performance.now() - this.startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async kill(signal = 'SIGTERM'): Promise<void> {
    if (this.exitResult) return;
    const { name, num } = parseSignal(signal);
    this.sentSignal = name;
    await this.job.signal(num);
  }
}

/** Max bytes replayed when attaching to a newly launched Job so early output is not missed. */
const JOB_REPLAY_BYTES = 1024 * 1024;

/**
 * Start a runtime-owned detached process over the 0.8.x Job + JobAttachment API
 * (supported on local sandboxes).
 */
export async function startMicrosandboxProcess(
  sandbox: Sandbox,
  command: string,
  options: StartProcessOptions = {},
): Promise<ProcessHandle> {
  const job = await sandbox.execDetachedWith('/bin/sh', (builder) => {
    let configured = configureExec(builder, command, options, false);
    if (!options.stdin && typeof configured.stdinNull === 'function') {
      configured = configured.stdinNull();
    }
    return configured;
  });
  const [info, attachment] = await Promise.all([
    job.inspect(),
    job
      .attachWith((builder) => {
        let configured = builder.replayRecent(JOB_REPLAY_BYTES);
        if (!options.stdin) configured = configured.readOnly(true);
        return configured;
      })
      .catch(async (error: unknown) => {
        // A very fast command can exit before attachWith subscribes.
        const current = await job.inspect().catch(() => null);
        if (current && current.state !== 'running' && current.state !== 'starting') {
          return null;
        }
        throw error;
      }),
  ]);
  return new MicrosandboxJobHandle(job, attachment, options, info.pid);
}
