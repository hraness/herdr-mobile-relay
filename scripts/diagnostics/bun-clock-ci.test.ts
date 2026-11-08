import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, test } from 'bun:test';
import { clockSource, collect, Counts, fileTimestamp, ORIGINAL_FILE, ownedCommand, pipeTimestamp, type Spawn } from './bun-clock-ci';

const raw = (timestamp = 1_700_000_000_001) => Buffer.from(JSON.stringify({ Schema: 1, Phase: 'ps-blocked', Nonce: '0'.repeat(32), TargetPID: 1, Previous: '0'.repeat(64), Data: { shellPID: 123, parentPID: 456, startedAt: timestamp } }) + '\n');
class FakeChild extends EventEmitter {
  pid = 123;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  close(code: number | null = 0, signal: string | null = null) { this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal); this.emit('close', code, signal); }
  kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.close(null, signal)); return true; }
}
const injected = (child: FakeChild, action: () => void = () => {}) => (() => { queueMicrotask(action); return child; }) as unknown as Spawn;

describe('isolated clock diagnostic (all child boundaries injected)', () => {
  test('extracts the exact hash-pinned existing shell phase', () => {
    const source = readFileSync(ORIGINAL_FILE, 'utf8');
    const parts = clockSource(source);
    assert.ok(parts.functions.includes('terminal_now=$(date +%s%3N)'));
    assert.ok(parts.publisher.includes('"$$" "$PPID" "$terminal_now"'));
    assert.ok(parts.publisher.includes('witness_nonce=$(cat "$root/witness-nonce")'));
    assert.ok(parts.publisher.endsWith('mv "$root/ps-blocked.json.next" "$root/ps-blocked.json" || exit 2'));
    assert.throws(() => clockSource(source + '\n'), /original source pin/u);
  });

  test('accepts canonical file phase and keeps its actual timestamp', () => {
    assert.equal(fileTimestamp(raw(), 456), 1_700_000_000_001);
  });

  test('refuses foreign phase, parent, extra fields and noncanonical bytes', () => {
    for (const value of [raw().toString().replace('ps-blocked', 'live'), raw().toString().replace('"startedAt":', '"extra":0,"startedAt":'), raw().toString() + ' ', raw().toString().replace('1700000000001', '1700000000001.5')]) {
      assert.throws(() => fileTimestamp(Buffer.from(value), 456));
    }
    assert.throws(() => fileTimestamp(raw(), 789));
  });

  test('accepts only integer GNU date milliseconds from direct pipe', () => {
    assert.equal(pipeTimestamp(Buffer.from('1700000000001\n')), 1_700_000_000_001);
    for (const value of ['1700000000001', '1700000000001\nsecret', '1700000000001.5\n', 'NaN\n', '01700000000001\n']) assert.throws(() => pipeTimestamp(Buffer.from(value)));
  });

  test('records future comparisons as failures with bounded outliers', () => {
    const counts = new Counts();
    for (let index = 0; index < 100; index++) counts.add({ mode: 'file', startedAt: 101, observedAt: 100, closedAt: 102 });
    counts.add({ mode: 'pipe', startedAt: 100, observedAt: 100, closedAt: 99 });
    counts.add({ mode: 'pipe', startedAt: 99, observedAt: 100, closedAt: 101 });
    const result = counts.result();
    assert.equal(result.modes.file.future, 100);
    assert.equal(result.modes.pipe.equal, 1);
    assert.equal(result.modes.pipe.past, 1);
    assert.equal(result.modes.pipe.futureAfterClose, 1);
    assert.equal(result.outliers.length, 32);
    assert.equal(result.outliers[0]!.deltaMs, 1);
    result.modes.file.future = 0;
    assert.equal(counts.result().modes.file.future, 100);
  });

  test('alternates exact file/pipe pairs without retrying a future sample', async () => {
    const seen: string[] = [];
    let clock = 0;
    const result = await collect(async (mode, index, remaining) => {
      seen.push(`${mode}-${index}`);
      assert.ok(remaining > 0 && remaining <= 2000);
      return { mode, startedAt: 101, observedAt: 100, closedAt: 102 };
    }, () => clock++, 2, 100);
    assert.deepEqual(seen, ['file-0', 'pipe-0', 'file-1', 'pipe-1']);
    assert.equal(result.modes.file.future, 2);
    assert.equal(result.modes.pipe.future, 2);
  });

  test('refuses expired total budget before any new child boundary', async () => {
    let called = 0;
    let clock = 0;
    await assert.rejects(collect(async mode => { called++; return { mode, startedAt: 1, observedAt: 1, closedAt: 1 }; }, () => clock++ * 100, 1, 50), /experiment deadline/u);
    assert.equal(called, 0);
  });

  test('retains completed counts when a later injected sample refuses', async () => {
    const counts = new Counts();
    await assert.rejects(collect(async mode => {
      if (mode === 'pipe') throw new Error('injected refusal');
      return { mode, startedAt: 101, observedAt: 100, closedAt: 102 };
    }, () => 0, 1, 50, counts), /injected refusal/u);
    assert.equal(counts.result().modes.file.future, 1);
    assert.equal(counts.result().modes.pipe.count, 0);
  });

  test('normal owned command observes close and signals nobody', async () => {
    const child = new FakeChild();
    const read = await ownedCommand('/bin/date', ['+%s%3N'], async () => {}, new AbortController().signal, 100, injected(child, () => { child.stdout.emit('data', Buffer.from('1700000000001\n')); child.close(); }));
    assert.equal(read.stdout.toString(), '1700000000001\n');
    assert.ok(Number.isSafeInteger(read.firstOutputAt));
    assert.ok(Number.isSafeInteger(read.closedAt));
    assert.deepEqual(child.signals, []);
  });

  test('cancelled entry refuses before spawn', async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    await assert.rejects(ownedCommand('/bin/date', [], async () => {}, abort.signal, 100, (() => { calls++; throw new Error('not allowed'); }) as unknown as Spawn), /before spawn/u);
    assert.equal(calls, 0);
  });

  test('cancellation stops only the returned child and aborts its operation', async () => {
    const abort = new AbortController();
    const child = new FakeChild();
    let operationAborted = false;
    const result = ownedCommand('/bin/sh', [], async (_child, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { operationAborted = true; resolve(); }, { once: true }));
    }, abort.signal, 100, injected(child, () => abort.abort()));
    await assert.rejects(result, /owned command refused/u);
    assert.equal(operationAborted, true);
    assert.deepEqual(child.signals, ['SIGTERM']);
  });

  test('command deadline aborts polling instead of leaving an unbounded wait', async () => {
    const child = new FakeChild();
    let operationAborted = false;
    await assert.rejects(ownedCommand('/bin/sh', [], async (_child, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { operationAborted = true; resolve(); }, { once: true }));
    }, new AbortController().signal, 5, injected(child)), /owned command refused/u);
    assert.equal(operationAborted, true);
    assert.deepEqual(child.signals, ['SIGTERM']);
  });

  test('uncertain cleanup is explicit and never retries another spawn', async () => {
    const child = new FakeChild();
    child.kill = signal => { child.signals.push(signal); return true; };
    let calls = 0;
    await assert.rejects(ownedCommand('/bin/date', [], async () => {}, new AbortController().signal, 5, (() => { calls++; return child; }) as unknown as Spawn), /cleanup uncertain/u);
    assert.equal(calls, 1);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  });

  test('an exited leader with inherited open pipes is never signalled', async () => {
    const child = new FakeChild();
    await assert.rejects(ownedCommand('/bin/sh', [], async () => {}, new AbortController().signal, 5, injected(child, () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    })), /cleanup uncertain/u);
    assert.deepEqual(child.signals, []);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });

  test('output overflow and failed normal exit refuse without new signals', async () => {
    for (const overflow of [true, false]) {
      const child = new FakeChild();
      await assert.rejects(ownedCommand('/bin/date', [], async () => {}, new AbortController().signal, 100, injected(child, () => { child.stdout.emit('data', Buffer.alloc(overflow ? 8193 : 1)); child.close(overflow ? 0 : 2); })), /owned command refused/u);
      assert.deepEqual(child.signals, []);
    }
  });

  test('workflow is exact-branch push only, read-only and pinned', () => {
    const workflow = Bun.YAML.parse(readFileSync('.github/workflows/herdr-clock-ci-diag-20261109.yml', 'utf8')) as any;
    assert.deepEqual(workflow.on, { push: { branches: ['codex/herdr-clock-ci-diag-20261109'] } });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(workflow.jobs['clock-only']['timeout-minutes'], 5);
    assert.equal(workflow.jobs['unchanged-witnesses-once']['timeout-minutes'], 15);
    for (const job of Object.values(workflow.jobs) as any[]) {
      assert.equal(job['runs-on'], 'ubuntu-latest');
      const checkout = job.steps[0];
      assert.equal(checkout.with.ref, '${{ github.sha }}');
      assert.equal(checkout.with['fetch-depth'], 1);
      assert.equal(checkout.with['persist-credentials'], false);
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/u);
        if (step.uses?.startsWith('actions/upload-artifact@')) assert.equal(step.with['retention-days'], 1);
      }
    }
  });

  test('replay admits exact unchanged source, invokes two selected cases once and keeps raw logs off stdout', () => {
    const workflow = Bun.YAML.parse(readFileSync('.github/workflows/herdr-clock-ci-diag-20261109.yml', 'utf8')) as any;
    const steps = workflow.jobs['unchanged-witnesses-once'].steps;
    const sourceCheck = steps.find((step: any) => step.name === 'Verify exact source, runtimes and Ubuntu image family');
    assert.ok(sourceCheck.run.includes('8b93d1644262f180cf2b211c0e099b1a16e2b09f3bcdb4ee7af4124ccd121789'));
    const replay = steps.find((step: any) => step.name === 'Replay each original case once with existing protocol export');
    assert.equal(replay.env.MOBILE_UNIT_FILTER, '^Native startup actual XCTest supervisor listener-concurrent-exit-before-close$|^Native startup XCTest owned terminal witness$');
    assert.equal(replay.run.match(/bun --no-env-file run --cwd tests\/mobile test:unit/gu)?.length, 1);
    assert.ok(replay.run.includes('>"$RUNNER_TEMP/isolated-xctest-raw-log/unit.stdout" 2>"$RUNNER_TEMP/isolated-xctest-raw-log/unit.stderr"'));
    assert.ok(!replay.run.includes('cat '));
    assert.ok(!JSON.stringify(workflow).includes('secrets.'));
    const script = readFileSync('scripts/diagnostics/bun-clock-ci.ts', 'utf8');
    assert.ok(!script.includes('process.kill('));
    assert.ok(!script.includes('process.env'));
    assert.ok(!script.includes("from '../../tests/mobile"));
  });
});
