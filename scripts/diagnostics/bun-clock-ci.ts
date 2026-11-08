import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, release, tmpdir } from 'node:os';
import { join } from 'node:path';

export const ORIGINAL_SHA256 = '8b93d1644262f180cf2b211c0e099b1a16e2b09f3bcdb4ee7af4124ccd121789';
export const ORIGINAL_FILE = 'tests/mobile/unit/xctest-owner.ts';
export const BASE_SHA = '753038b0d54633d1e2647b8bd474bcb5de005ea9';
export const SAMPLE_PAIRS = 2048;
export const TOTAL_MS = 90_000;
const COMMAND_MS = 2000;
const OUTPUT_BYTES = 8192;
const NONCE = '0'.repeat(32);
const PREVIOUS = '0'.repeat(64);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type Mode = 'file' | 'pipe';
export type Sample = { mode: Mode; startedAt: number; observedAt: number; closedAt: number };
export type Spawn = typeof spawn;

export function clockSource(source: string): { functions: string; publisher: string } {
  assert.equal(hash(source), ORIGINAL_SHA256, 'original source pin');
  const begin = 'const terminalShellWait = String.raw`';
  const end = '\n`;\nconst terminalShim =';
  assert.equal(source.split(begin).length, 2);
  const functions = source.slice(source.indexOf(begin) + begin.length, source.indexOf(end, source.indexOf(begin)));
  assert.ok(functions.includes('terminal_now=$(date +%s%3N)'));
  assert.ok(functions.includes("case \"$terminal_now\" in ''|*[!0-9]*) terminal_now=$(date +%s)000 ;; esac"));
  const first = '      terminal_check || exit 2\n      [ "$pid" = "$(cat "$root/witness-target")" ] || exit 2';
  const last = '      mv "$root/ps-blocked.json.next" "$root/ps-blocked.json" || exit 2';
  assert.equal(source.split(first).length, 2);
  assert.equal(source.split(last).length, 3); // The second copy is the existing source-integrity test.
  const start = source.indexOf(first);
  const finish = source.indexOf(last, start) + last.length;
  const publisher = source.slice(start, finish);
  assert.ok(publisher.length < 2048 && functions.length < 2048);
  return { functions, publisher };
}

export function fileTimestamp(raw: Buffer, expectedParent: number): number {
  assert.ok(raw.length > 0 && raw.length <= OUTPUT_BYTES, 'file record size');
  const value = JSON.parse(raw.toString());
  assert.equal(raw.toString(), JSON.stringify(value) + '\n', 'canonical file record');
  assert.deepEqual(Object.keys(value), ['Schema', 'Phase', 'Nonce', 'TargetPID', 'Previous', 'Data']);
  assert.deepEqual(Object.keys(value.Data), ['shellPID', 'parentPID', 'startedAt']);
  assert.equal(value.Schema, 1);
  assert.equal(value.Phase, 'ps-blocked');
  assert.equal(value.Nonce, NONCE);
  assert.equal(value.TargetPID, 1);
  assert.equal(value.Previous, PREVIOUS);
  assert.ok(Number.isSafeInteger(value.Data.shellPID) && value.Data.shellPID > 0);
  assert.equal(value.Data.parentPID, expectedParent);
  assert.ok(Number.isSafeInteger(value.Data.startedAt) && value.Data.startedAt > 0, 'integer timestamp');
  return value.Data.startedAt;
}

export function pipeTimestamp(raw: Buffer): number {
  assert.ok(raw.length > 0 && raw.length <= 32, 'pipe record size');
  assert.match(raw.toString(), /^[1-9]\d{12}\n$/u, 'GNU date milliseconds');
  const timestamp = Number(raw.toString());
  assert.ok(Number.isSafeInteger(timestamp), 'integer pipe timestamp');
  return timestamp;
}

export class Counts {
  private values: Record<Mode, { count: number; future: number; equal: number; past: number; minDeltaMs: number | null; maxDeltaMs: number | null; futureAfterClose: number }> = {
    file: { count: 0, future: 0, equal: 0, past: 0, minDeltaMs: null, maxDeltaMs: null, futureAfterClose: 0 },
    pipe: { count: 0, future: 0, equal: 0, past: 0, minDeltaMs: null, maxDeltaMs: null, futureAfterClose: 0 },
  };
  private outliers: Array<Sample & { deltaMs: number }> = [];

  add(sample: Sample): void {
    assert.ok(sample.mode === 'file' || sample.mode === 'pipe');
    for (const value of [sample.startedAt, sample.observedAt, sample.closedAt]) assert.ok(Number.isSafeInteger(value) && value > 0);
    const deltaMs = sample.startedAt - sample.observedAt;
    const value = this.values[sample.mode];
    value.count++;
    if (deltaMs > 0) value.future++;
    else if (deltaMs === 0) value.equal++;
    else value.past++;
    value.minDeltaMs = value.minDeltaMs === null ? deltaMs : Math.min(value.minDeltaMs, deltaMs);
    value.maxDeltaMs = value.maxDeltaMs === null ? deltaMs : Math.max(value.maxDeltaMs, deltaMs);
    if (sample.startedAt > sample.closedAt) value.futureAfterClose++;
    if (deltaMs > 0 && this.outliers.length < 32) this.outliers.push({ ...sample, deltaMs });
  }

  result() { return { modes: structuredClone(this.values), outliers: structuredClone(this.outliers) }; }
}

const bounded = async <T>(promise: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      aborted = () => reject(new Error('cancelled'));
      if (signal?.aborted) { aborted(); return; }
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => reject(new Error('command deadline')), Math.max(0, milliseconds));
    })]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal?.removeEventListener('abort', aborted);
  }
};

// Only the exact returned child handle is signalled. No PID/group scan or descendant-closure claim.
export async function ownedCommand(
  command: string, args: string[], operation: (child: ChildProcess, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal, milliseconds: number, launch: Spawn = spawn,
): Promise<{ stdout: Buffer; firstOutputAt: number | null; closedAt: number }> {
  if (signal.aborted || milliseconds <= 0) throw new Error('cancelled before spawn');
  const local = new AbortController();
  const cancel = () => local.abort();
  signal.addEventListener('abort', cancel, { once: true });
  let child: ChildProcess;
  try { child = launch(command, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { signal.removeEventListener('abort', cancel); throw new Error('spawn refused'); }
  let closed = false;
  let exited = false;
  let firstOutputAt: number | null = null;
  let closedAt = 0;
  let output = Buffer.alloc(0);
  let bytes = 0;
  let processError = false;
  const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('close', (code, childSignal) => { closed = true; closedAt = Date.now(); resolve({ code, signal: childSignal }); });
  });
  child.once('exit', () => { exited = true; });
  const liveOwnedLeader = () => !exited && !closed && Number.isSafeInteger(child.pid) && child.pid! > 0 && child.exitCode === null && child.signalCode === null;
  const signalLeader = (value: NodeJS.Signals) => { if (liveOwnedLeader()) { try { child.kill(value); } catch { processError = true; } } };
  child.on('error', () => { processError = true; });
  child.stdout?.on('data', (chunk: Buffer) => {
    firstOutputAt ??= Date.now();
    bytes += chunk.length;
    if (bytes <= OUTPUT_BYTES) output = Buffer.concat([output, chunk]);
  });
  child.stderr?.on('data', (chunk: Buffer) => { bytes += chunk.length; });
  try {
    const outcome = await bounded(Promise.all([operation(child, local.signal), settled]), milliseconds, signal);
    assert.ok(!processError && bytes <= OUTPUT_BYTES, 'command transport');
    assert.deepEqual(outcome[1], { code: 0, signal: null }, 'command exit');
    return { stdout: output, firstOutputAt, closedAt };
  } catch {
    local.abort();
    child.stdin?.destroy();
    if (!closed) {
      signalLeader('SIGTERM');
      try { await bounded(settled, 500); } catch { /* A bounded second signal is limited to this owned handle. */ }
    }
    if (!closed) {
      signalLeader('SIGKILL');
      try { await bounded(settled, 500); } catch { /* Keep uncertainty explicit; never retry. */ }
    }
    if (!closed) { child.stdout?.destroy(); child.stderr?.destroy(); }
    throw new Error(closed ? 'owned command refused' : 'owned command cleanup uncertain');
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function collect(
  sample: (mode: Mode, index: number, remainingMs: number) => Promise<Sample>,
  now: () => number = () => performance.now(), pairs = SAMPLE_PAIRS, milliseconds = TOTAL_MS,
  counts = new Counts(),
) {
  assert.ok(Number.isSafeInteger(pairs) && pairs > 0 && pairs <= SAMPLE_PAIRS);
  assert.ok(milliseconds > 0 && milliseconds <= TOTAL_MS);
  const deadline = now() + milliseconds;
  for (let index = 0; index < pairs; index++) {
    for (const mode of ['file', 'pipe'] as const) {
      const remaining = deadline - now();
      assert.ok(remaining > 0, 'experiment deadline');
      const value = await sample(mode, index, Math.min(COMMAND_MS, remaining));
      assert.equal(value.mode, mode);
      assert.ok(now() < deadline, 'experiment deadline');
      counts.add(value);
    }
  }
  return counts.result();
}

function osIdentity(raw: string) {
  const get = (key: string) => raw.match(new RegExp(`^${key}="?([a-zA-Z0-9._-]+)"?$`, 'mu'))?.[1];
  assert.equal(get('ID'), 'ubuntu', 'Ubuntu required');
  assert.equal(get('VERSION_ID'), '26.04', 'Ubuntu 26.04 required');
  return { id: get('ID'), version: get('VERSION_ID'), kernel: release(), arch: arch() };
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'linux', 'CI Linux only');
  assert.equal(Bun.version, '1.4.4', 'pinned Bun');
  assert.deepEqual(process.argv.slice(2), ['--output', 'diagnostics/bun-clock-ci.json']);
  const source = await readFile(ORIGINAL_FILE, 'utf8');
  const parts = clockSource(source);
  const os = osIdentity(await readFile('/etc/os-release', 'utf8'));
  const output = 'diagnostics/bun-clock-ci.json';
  assert.equal(existsSync(output), false, 'new output only');
  await mkdir('diagnostics', { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'herdr-bun-clock-ci-'));
  const startedAt = Date.now();
  const startMono = performance.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TOTAL_MS);
  const cancel = () => abort.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  const counts = new Counts();
  let complete = false;
  let category: string | null = null;
  let cleanup = 'owned temporary files retained after refusal';
  try {
    await collect(async (mode, index, remaining) => {
      if (abort.signal.aborted) throw new Error('cancelled');
      if (mode === 'pipe') {
        const read = await ownedCommand('/bin/date', ['+%s%3N'], async child => { child.stdin?.end(); }, abort.signal, remaining);
        assert.notEqual(read.firstOutputAt, null);
        return { mode, startedAt: pipeTimestamp(read.stdout), observedAt: read.firstOutputAt!, closedAt: read.closedAt };
      }
      const directory = join(root, String(index));
      await mkdir(join(directory, 'state'), { recursive: true, mode: 0o700 });
      const fileDeadline = Date.now() + remaining;
      for (const [name, value] of Object.entries({ 'witness-target': '1', 'witness-shell-parent': String(process.pid), 'witness-nonce': NONCE, 'witness-live-hash': PREVIOUS, 'state/deadline': String(fileDeadline) })) {
        await writeFile(join(directory, name), value, { flag: 'wx', mode: 0o600 });
      }
      const command = `root=$1\npid=1\n${parts.functions}\n${parts.publisher}\nIFS= read -r acknowledgement\n[ "$acknowledgement" = continue ]\n`;
      let observedAt = 0;
      let timestamp = 0;
      const read = await ownedCommand('/bin/sh', ['-c', command, 'clock-publisher', directory], async (child, commandSignal) => {
        const record = join(directory, 'ps-blocked.json');
        const check = () => {
          if (commandSignal.aborted) throw new Error('cancelled');
          for (const name of ['cancel', 'observer-error.json', 'target-error', 'child-exit-probe-error', 'state/stop']) assert.equal(existsSync(join(directory, name)), false);
          assert.ok(Date.now() < fileDeadline, 'terminal deadline');
        };
        // Preserve terminalWait's Date.now checks, synchronous reads and async return boundary.
        const wait = async () => {
          for (;;) {
            check();
            for (const early of ['continue.json', 'terminal.json', 'complete.json']) assert.equal(existsSync(join(directory, early)), false);
            if (existsSync(record)) {
              const stat = statSync(record);
              assert.ok(stat.isFile() && stat.size > 0 && stat.size <= OUTPUT_BYTES);
              const bytes = readFileSync(record);
              assert.equal(bytes.length, stat.size);
              check();
              return bytes;
            }
            await new Promise(resolve => setTimeout(resolve, 1));
          }
        };
        const bytes = await wait();
        timestamp = fileTimestamp(bytes, process.pid);
        observedAt = Date.now();
        child.stdin?.end('continue\n');
      }, abort.signal, remaining);
      return { mode, startedAt: timestamp, observedAt, closedAt: read.closedAt };
    }, () => performance.now(), SAMPLE_PAIRS, TOTAL_MS, counts);
    complete = true;
    await rm(root, { recursive: true });
    cleanup = 'normally exited owned commands; owned temporary files removed';
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    category = ['owned command cleanup uncertain', 'owned command refused', 'experiment deadline', 'cancelled'].includes(text) ? text : 'experiment refused';
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
  const report = {
    format: 1, kind: 'herdr-isolated-bun-clock-diagnostic-v1', experimentComplete: complete, category,
    source: { base: BASE_SHA, file: ORIGINAL_FILE, sha256: ORIGINAL_SHA256, shellFunctionsSha256: hash(parts.functions), shellPublisherSha256: hash(parts.publisher), diagnosticSha256: hash(await readFile(import.meta.filename)) },
    runtime: { bun: Bun.version, platform: process.platform, os },
    startedAt, endedAt: Date.now(), durationMs: performance.now() - startMono,
    configured: { pairs: SAMPLE_PAIRS, samplingMs: TOTAL_MS, commandMs: COMMAND_MS, refusalCleanupMs: 1000, samples: SAMPLE_PAIRS * 2, outlierLimit: 32 },
    assertion: 'Number.isSafeInteger(startedAt) && startedAt <= observedAt', result: counts.result(),
    cleanup: { result: cleanup, descendantCensusPerformed: false, retry: false },
    claims: { explainsAttempt1: false, explainsAttempt2: false, productionQualification: false },
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 16_384, 'bounded public diagnostic');
  const result = counts.result();
  if (!complete || result.modes.file.future + result.modes.pipe.future > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
