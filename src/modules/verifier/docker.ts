/**
 * The container half of the verifier: ONE disposable container per CHECK.
 *
 * Three rules hold this file together:
 *
 *  1. argv is an ARRAY handed to `spawn`/`execFile`. There is no shell, no
 *     template string, and no row value is ever concatenated into a command.
 *     `buildCheckArgv` is pure and exported so a test can assert the absence of
 *     `sh -c`, `$(`, backticks and `;` in every element, and the absence of the
 *     project host path, `data/`, `.env`, `docker.sock`, `/workspace` and
 *     `groups/`.
 *  2. The command text NEVER appears in argv or env. It is written to the
 *     child's stdin — a per-container nonce line, then one command, the i-th
 *     entry of the host's frozen list — and stdin is then ended.
 *     `/gate/run-check.sh` reads the nonce with `read -r` and the command with
 *     `cmd=$(cat)`. The nonce comes back on stdout as the startup handshake and
 *     is stripped from the stored output here, before the cap applies, so a
 *     check's recorded bytes are its own and only its own.
 *  3. Isolation between CHECKS comes from the kernel, not from a sweep inside
 *     the container. `removeContainerConfirmed` does not return until docker
 *     has said, in its own words, that the container does not exist; when it
 *     cannot say that, the caller fails closed and runs nothing further.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';

export interface CheckArgvParams {
  containerName: string;
  uid: number;
  gid: number;
  cpus: string;
  memory: string;
  pids: number;
  /** Host path of the single gate file. Only this FILE is mounted, not its directory. */
  gateRunCheckPath: string;
  /**
   * Host path of the `git archive` tar of the checkpoint. This is the ONLY
   * source the container sees: the repository itself is never mounted, so no
   * untracked file, no dirty working-tree edit and no other commit is reachable
   * from inside. The SAME tar is mounted into every check's container.
   */
  archiveTarPath: string;
  imageRef: string;
}

/**
 * The exact `docker run` argv for one CHECK. Flag order is fixed so the
 * recorded argv is diffable across runs and across checks.
 *
 * Nothing agent-controlled is here. The command is on stdin; the checkpoint is
 * a tar; the repository host path, the evidence directory, the docker socket
 * and the group directories do not appear at all.
 */
export function buildCheckArgv(p: CheckArgvParams): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    p.containerName,
    '--network',
    'none',
    '--user',
    `${p.uid}:${p.gid}`,
    '--read-only',
    '--tmpfs',
    '/work:rw,size=1g,mode=1777',
    '--tmpfs',
    '/tmp:rw,size=256m',
    '--cpus',
    p.cpus,
    '--memory',
    p.memory,
    '--memory-swap',
    p.memory,
    '--pids-limit',
    String(p.pids),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-v',
    `${p.gateRunCheckPath}:/gate/run-check.sh:ro`,
    '-v',
    `${p.archiveTarPath}:/archive/checkpoint.tar:ro`,
    '-e',
    'HOME=/work',
    '-e',
    'COREPACK_ENABLE_NETWORK=0',
    '--entrypoint',
    'bash',
    p.imageRef,
    '/gate/run-check.sh',
  ];
}

/**
 * A per-run suffix: millisecond clock in base36 plus four random hex digits.
 *
 * The clock alone would collide for two runs started in the same millisecond,
 * and randomness alone would be unordered in `docker ps`; together they are
 * unique AND sortable.
 */
export function newRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

/**
 * `ncl-verify-<first 8 of the reviewer group id>-<handoff id>-<run id>-c<i>`.
 *
 * The run id makes the name unique per run; the `-c<i>` suffix makes it unique
 * per CHECK, so the removal of check i names exactly one container and can
 * never destroy check i+1's.
 */
export function containerNameFor(groupId: string, handoffId: string, runId: string, index: number): string {
  return `ncl-verify-${groupId.slice(0, 8)}-${handoffId}-${runId}-c${index}`;
}

// ---------------------------------------------------------------------------
// The startup handshake.
//
// Without it, `exit 125` from a container means two incompatible things: the
// CHECK said 125, or the daemon refused to start anything at all. The verifier
// must not report a CHECK_FAILED for a container that never ran the check.
//
// So the host generates a fresh 128-bit nonce per container and writes it as
// the FIRST line of stdin. `run-check.sh` consumes that line, does its setup,
// and — only if every setup step succeeded — echoes `RUN_CHECK_READY <nonce>`
// as the first bytes on stdout, before `exec`ing the command. A CHECK cannot
// forge the line: it cannot print before it runs, and the nonce is not in its
// environment, its argv or its stdin (the gate script consumed it).
//
// The nonce travels on stdin and nowhere else, so the argv stays byte-identical
// to the argv the argv tests assert.
// ---------------------------------------------------------------------------

/** A fresh 128-bit hex nonce, one per container. */
export function newCheckNonce(): string {
  return randomBytes(16).toString('hex');
}

/** The one handshake token. The line is exactly `${PREFIX}${nonce}`. */
export const HANDSHAKE_PREFIX = 'RUN_CHECK_READY ';

/**
 * How far into stdout the host will look for the handshake's newline.
 *
 * A container that never emits a newline must not make the host buffer without
 * bound, so past this many bytes the host gives up, declares the handshake
 * absent and hands everything it was holding to the ordinary output sink. The
 * real line is 16 + 32 + 1 bytes, so this is ~20x the room it needs.
 */
export const HANDSHAKE_MAX_BYTES = 1024;

export type HandshakeStatus = 'ok' | 'missing' | 'mismatch';

/**
 * Classify the first stdout line against THIS container's nonce.
 *
 *  - `ok`       the line is exactly `RUN_CHECK_READY <our nonce>`
 *  - `mismatch` it is shaped like a handshake but carries another nonce; the
 *               only ways to produce that are a replayed line from an earlier
 *               run or a guess, and both mean we cannot trust the exit code
 *  - `missing`  no first line at all, or a first line that is ordinary output,
 *               which means the gate script never reached its `printf`
 */
export function classifyHandshake(line: string | null, nonce: string): HandshakeStatus {
  if (line === null) return 'missing';
  if (line === `${HANDSHAKE_PREFIX}${nonce}`) return 'ok';
  return line.startsWith(HANDSHAKE_PREFIX) ? 'mismatch' : 'missing';
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** False when the call failed for any reason, including its own timeout. */
  ok: boolean;
  /** The bounded call was killed by its own timeout; its result says nothing. */
  timedOut: boolean;
  /** Present only when `ok` is false. */
  error?: string;
}

/** Auxiliary docker/git calls. Never a shell; errors are values, not throws. */
export type ExecRunner = (file: string, argv: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Every auxiliary docker call is bounded by this unless the caller says otherwise. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
/** `git archive` of a large repository is legitimately slower than a docker RPC. */
export const GIT_EXEC_TIMEOUT_MS = 120_000;

/**
 * ONE bounded helper behind every auxiliary call (`image inspect`, `kill`,
 * `rm -f`, `inspect`, and the host's git calls).
 *
 * `execFile`'s own `timeout` plus `killSignal: 'SIGKILL'` is what makes this
 * bounded: a docker CLI wedged on an unresponsive daemon is killed outright
 * rather than left holding the verifier's cleanup path open forever. A failure
 * — including that kill — comes back as `{ok:false, timedOut, error}`; it never
 * throws, because every caller is either a cleanup step or a precondition check
 * and neither may turn a docker hiccup into an unhandled rejection.
 *
 * `timedOut` is reported separately from `ok` because the verifier treats them
 * differently: a call that FAILED told us something, a call that was KILLED
 * told us nothing, and "nothing" is what `docker_uncertain` means.
 */
export const execFileBounded: ExecRunner = (file, argv, options) =>
  new Promise((resolve) => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    execFile(
      file,
      argv,
      { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const killed = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code ?? 1)
            : err
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ok: !err,
          timedOut: killed,
          ...(err ? { error: err.message } : {}),
        });
      },
    );
  });

/** The default `ExecRunner`: bounded, with a longer allowance for `git`. */
export const execNoShell: ExecRunner = (file, argv, options) =>
  execFileBounded(file, argv, {
    timeoutMs: options?.timeoutMs ?? (file === 'git' ? GIT_EXEC_TIMEOUT_MS : DEFAULT_EXEC_TIMEOUT_MS),
  });

/**
 * Docker's exact words when a container does not exist. This string, on a
 * NON-ZERO exit, is the only thing that counts as a confirmed removal.
 *
 * Anything else — a zero exit (it is still there), a daemon error, an empty
 * stderr, a killed call — is not confirmation, and the verifier stops.
 */
export const NO_SUCH_CONTAINER_RE = /No such container/;

export type RemovalOutcome = 'confirmed' | 'unconfirmed' | 'uncertain';

export interface RemovalResult {
  outcome: RemovalOutcome;
  confirmed: boolean;
  attempts: number;
  /** One line per attempt, for the record and the host log. Never a verdict. */
  detail: string[];
}

export const REMOVAL_ATTEMPTS = 3;

/**
 * Force-remove a container and then PROVE it is gone.
 *
 * `docker rm -f` returning zero is not proof: the daemon can accept the request
 * and fail to complete it, and a `--rm` container that exited on its own makes
 * `rm` fail for a reason that has nothing to do with whether anything survived.
 * The proof is the follow-up `docker inspect --type container`, which must exit
 * non-zero AND say "No such container".
 *
 * Both calls are bounded (10 s). Up to three rounds; the LAST round's
 * classification is what the caller records, so three killed inspects report
 * `uncertain` and three "it is still running" inspects report `unconfirmed`.
 */
export async function removeContainerConfirmed(
  containerName: string,
  exec: ExecRunner,
  options: { attempts?: number; timeoutMs?: number } = {},
): Promise<RemovalResult> {
  const maxAttempts = options.attempts ?? REMOVAL_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const detail: string[] = [];
  let outcome: RemovalOutcome = 'unconfirmed';
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;

    const removed = await exec('docker', ['rm', '-f', containerName], { timeoutMs });
    detail.push(`attempt ${attempt}: rm -f exit=${removed.code} timedOut=${removed.timedOut}`);

    const inspected = await exec('docker', ['inspect', '--type', 'container', containerName], { timeoutMs });
    if (inspected.timedOut) {
      outcome = 'uncertain';
      detail.push(`attempt ${attempt}: inspect call was killed by its own bound; docker said nothing`);
      continue;
    }
    if (inspected.code === 0) {
      outcome = 'unconfirmed';
      detail.push(`attempt ${attempt}: inspect exit=0; the container still exists`);
      continue;
    }
    if (NO_SUCH_CONTAINER_RE.test(inspected.stderr)) {
      outcome = 'confirmed';
      detail.push(`attempt ${attempt}: inspect exit=${inspected.code} "No such container"`);
      break;
    }
    outcome = 'unconfirmed';
    detail.push(
      `attempt ${attempt}: inspect exit=${inspected.code} with unrecognised stderr; not a removal confirmation`,
    );
  }

  return { outcome, confirmed: outcome === 'confirmed', attempts, detail };
}

export interface DockerRunOptions {
  /** The one command text for this CHECK. Written to stdin, then stdin is ended. */
  stdin: string;
  /**
   * This container's handshake nonce. Written as the FIRST stdin line, ahead of
   * `stdin`, and expected back as the first stdout line. Kept separate from
   * `stdin` so that the recorded command text stays exactly the frozen command.
   */
  nonce: string;
  /** This CHECK's cap: `min(perCommandSeconds, remainingOverall)`. */
  wallSeconds: number;
  outputBytes: number;
  containerName: string;
  /**
   * Bound on this check's own `docker kill`, so the overall deadline reaches
   * the cleanup call too. Falls back to the runner's default.
   */
  killTimeoutMs?: number;
}

export interface DockerRunResult {
  exitCode: number;
  timedOut: boolean;
  /** The docker client could not be spawned at all. A stop condition. */
  spawnFailed: boolean;
  /**
   * The first line of stdout, verbatim and WITHOUT its newline, or null when
   * the container produced no line within `HANDSHAKE_MAX_BYTES`.
   *
   * Taken off the stream before anything reaches the output sink, so it is
   * excluded from `stdout`, from `stdoutBytes` and from the output cap. The
   * runner does not judge it — `classifyHandshake` on the host does.
   */
  handshakeLine: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  finishedAt: string;
  wallSeconds: number;
}

/** `(file, argv, options)` — tests assert the shape of what they are handed. */
export type DockerRunner = (file: string, argv: string[], options: DockerRunOptions) => Promise<DockerRunResult>;

/**
 * A stream sink that never holds more than `cap` bytes.
 *
 * `push` is called from an `on('data')` handler and returns immediately. Past
 * the cap it keeps COUNTING (so `total` is the true size the check produced)
 * and keeps DRAINING (the stream is never paused, so the container is never
 * blocked on a full pipe) while storing nothing more. `bufferedBytes` is
 * exported so a test can assert the ceiling during streaming rather than only
 * after it.
 */
export class CappedSink {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.size >= this.cap) {
      this.truncated = true;
      return;
    }
    const room = this.cap - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.cap;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  /** Bytes currently held in memory. Never exceeds the cap, at any moment. */
  bufferedBytes(): number {
    return this.size;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Takes the FIRST line off a stdout stream and passes everything after it
 * through to a `CappedSink`.
 *
 * It sits in front of the sink rather than after it for two reasons. The
 * handshake must not consume any of the check's output budget — P12 asserts
 * that a 5 MB check is counted as exactly 5 MB and stored at exactly the cap —
 * and a handshake that is not the first bytes on stdout is not a handshake at
 * all, which is only decidable at the head of the stream.
 *
 * The held bytes are bounded: past `HANDSHAKE_MAX_BYTES` with no newline in
 * sight, it gives up, reports no line, and releases what it held as ordinary
 * output. Nothing is ever dropped.
 */
export class HandshakeSplitter {
  private head: Buffer[] = [];
  private headBytes = 0;
  private done = false;
  /** The first line without its newline, or null until (and unless) one lands. */
  line: string | null = null;

  constructor(private readonly sink: CappedSink) {}

  push(chunk: Buffer): void {
    if (this.done) {
      this.sink.push(chunk);
      return;
    }
    this.head.push(chunk);
    this.headBytes += chunk.length;
    const held = this.head.length === 1 ? this.head[0]! : Buffer.concat(this.head);
    const newline = held.indexOf(0x0a);
    if (newline !== -1) {
      this.line = held.subarray(0, newline).toString('utf8');
      this.done = true;
      this.head = [];
      const rest = held.subarray(newline + 1);
      if (rest.length > 0) this.sink.push(rest);
      return;
    }
    if (this.headBytes > HANDSHAKE_MAX_BYTES) this.release(held);
  }

  /** EOF. Anything still held was never a line, so it is ordinary output. */
  end(): void {
    if (this.done) return;
    this.release(this.head.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.head));
  }

  private release(held: Buffer): void {
    this.done = true;
    this.head = [];
    this.headBytes = 0;
    if (held.length > 0) this.sink.push(held);
  }
}

/** Injection seams. Production passes none of these. */
export interface DockerRunnerOptions {
  spawnFn?: (file: string, argv: string[], opts: { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;
  exec?: ExecRunner;
  /** Wait after `docker kill` before SIGKILLing the attached client. */
  graceMs?: number;
  /** Bound on the `docker kill` call itself. */
  killTimeoutMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Run ONE check's container.
 *
 * Two independent guarantees, because the failure this guards against is a
 * docker daemon that answers nothing:
 *
 *  1. The per-check cap is enforced on the HOST. On expiry we ask docker to
 *     kill the container by name — bounded, so an unresponsive daemon cannot
 *     wedge the cap — and then, REGARDLESS of whether that call succeeded,
 *     failed or timed out, we give the container a 5 s grace period and SIGKILL
 *     the attached `docker run` client ourselves.
 *  2. Exactly ONE completion. Every path — clean exit, spawn error, forced
 *     kill — goes through `settle`, which is guarded by a flag, so the promise
 *     resolves once and the caller's removal-and-confirm step runs once.
 */
export function createDockerRunner(runnerOptions: DockerRunnerOptions = {}): DockerRunner {
  const spawnFn = runnerOptions.spawnFn ?? ((file, argv, opts) => spawn(file, argv, opts));
  const exec = runnerOptions.exec ?? execFileBounded;
  const graceMs = runnerOptions.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const killTimeoutMs = runnerOptions.killTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  return (file, argv, options) =>
    new Promise((resolve) => {
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const out = new CappedSink(options.outputBytes);
      const handshake = new HandshakeSplitter(out);
      const errSink = new CappedSink(options.outputBytes);
      let timedOut = false;
      let spawnFailed = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;

      const child = spawnFn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'] });

      const closeStdin = (): void => {
        try {
          child.stdin?.end();
          child.stdin?.destroy();
          // eslint-disable-next-line no-catch-all/no-catch-all -- a stdin already gone is the normal case here
        } catch {
          // Nothing to close. EPIPE on an exited container is expected.
        }
      };

      /** The single completion path. */
      const settle = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        closeStdin();
        // Whatever the splitter is still holding was never a first line; it is
        // released here so no byte the container produced is lost.
        handshake.end();
        const finishedAtMs = Date.now();
        resolve({
          exitCode,
          timedOut,
          spawnFailed,
          handshakeLine: handshake.line,
          stdout: out.text(),
          stderr: errSink.text(),
          stdoutBytes: out.total,
          stderrBytes: errSink.total,
          stdoutTruncated: out.truncated,
          stderrTruncated: errSink.truncated,
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          wallSeconds: (finishedAtMs - startedAtMs) / 1000,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        // (a) Ask docker to stop the container. Bounded, and its result is a
        //     value we record, never something the next step waits on.
        void exec('docker', ['kill', options.containerName], {
          timeoutMs: options.killTimeoutMs ?? killTimeoutMs,
        }).then(
          (result) => {
            if (!result.ok) {
              errSink.push(Buffer.from(`host: docker kill ${options.containerName} failed: ${result.error}\n`));
            }
          },
          (err: unknown) => {
            errSink.push(Buffer.from(`host: docker kill ${options.containerName} threw: ${String(err)}\n`));
          },
        );
        // (b) ...and independently of (a), SIGKILL the client after the grace.
        //     This is the step that actually bounds the check: it needs nothing
        //     from the daemon.
        graceTimer = setTimeout(() => {
          errSink.push(Buffer.from('host: per-check cap exceeded; SIGKILL of the docker client\n'));
          closeStdin();
          try {
            child.kill('SIGKILL');
            // eslint-disable-next-line no-catch-all/no-catch-all -- killing an already-dead child is not a failure
          } catch {
            // Already gone.
          }
          // A SIGKILLed client normally emits `close` immediately, but this
          // promise must not depend on that: settle now, and `close` becomes a
          // no-op through the `settled` guard.
          settle(-1);
        }, graceMs);
      }, options.wallSeconds * 1000);

      // Stream-bounded: the handler appends only while under the cap, keeps
      // counting past it, and never pauses the stream. stdout goes through the
      // handshake splitter first, which removes the gate script's ready line —
      // and ONLY the first line, so a check that prints its own
      // `RUN_CHECK_READY ...` afterwards has it stored as the ordinary output
      // it is.
      child.stdout?.on('data', (chunk: Buffer) => handshake.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => errSink.push(chunk));
      child.stdout?.on('error', () => {
        // A pipe torn down by the kill is not a result.
      });
      child.stderr?.on('error', () => {
        // Same.
      });
      child.stdin?.on('error', () => {
        // A container that exits before reading stdin gives us EPIPE. The exit
        // code is the signal that matters; swallow the write failure.
      });
      try {
        // The nonce line, then the command text, then EOF. `read -r nonce`
        // takes the first line and `cmd=$(cat)` takes the rest, so the command
        // reaches the gate byte-for-byte as the host froze it.
        child.stdin?.end(`${options.nonce}\n${options.stdin}`);
        // eslint-disable-next-line no-catch-all/no-catch-all -- a failed spawn surfaces through the error event
      } catch {
        // The `error` event below is what reports this.
      }

      child.on('error', (err: Error) => {
        spawnFailed = true;
        errSink.push(Buffer.from(`docker spawn failed: ${err.message}\n`));
        settle(-1);
      });
      // Exit code comes from the child process only — never from anything the
      // container printed.
      child.on('close', (code: number | null) => settle(code ?? -1));
    });
}

export const realRunDocker: DockerRunner = createDockerRunner();
