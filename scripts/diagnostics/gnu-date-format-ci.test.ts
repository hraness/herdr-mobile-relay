import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'bun:test';
import { compareFormats, CurrentCounts, deterministicRecord, FIXED_NANOSECONDS, FORMAT, parseFormats, sampleCurrent, ubuntuIdentity } from './gnu-date-format-ci';

const seconds = '1700000000';
const tuple = (nanos: string, narrow = nanos.slice(0, 3)) => Buffer.from(`${seconds}|${nanos}|${narrow}|${seconds}${nanos}|${seconds}${narrow}\n`);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('supplemental GNU date formatter (no subprocess boundaries executed)', () => {
  test('records either explicitly reviewed Ubuntu family and refuses foreign or ambiguous identities', () => {
    assert.deepEqual(ubuntuIdentity('ID=ubuntu\nVERSION_ID="24.04"\n'), { id: 'ubuntu', version: '24.04' });
    assert.deepEqual(ubuntuIdentity('ID="ubuntu"\nVERSION_ID="26.04"\n'), { id: 'ubuntu', version: '26.04' });
    for (const raw of ['ID=debian\nVERSION_ID="24.04"\n', 'ID=ubuntu\nVERSION_ID="28.04"\n', 'ID=ubuntu\n', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_ID="26.04"\n']) assert.throws(() => ubuntuIdentity(raw));
  });

  test('same-call parser retains all leading zeros without numeric coercion', () => {
    const value = parseFormats(tuple('007831000'));
    assert.equal(value.nanoseconds, '007831000');
    assert.equal(value.widthThree, '007');
    assert.equal(value.epochNanoseconds, '1700000000007831000');
  });

  test('refuses malformed, extra, missing, oversized and nonnumeric fields', () => {
    for (const bytes of [Buffer.from(''), Buffer.alloc(129), Buffer.from(tuple('007831000').toString() + '\n'), Buffer.from(tuple('007831000').toString().replace('007831000', 'private')), Buffer.from(tuple('007831000').toString().replace('|007|', '||')), Buffer.from(tuple('007831000').toString().replace('\n', '|1\n')), Buffer.from(tuple('007831000').toString().replace('\n', ''))]) assert.throws(() => parseFormats(bytes));
  });

  test('full-nine string truncation gives exact expected milliseconds across fixed matrix', () => {
    for (const nanos of FIXED_NANOSECONDS) {
      const record = deterministicRecord(nanos, tuple(nanos));
      assert.equal(record.secondsMatchInput, true);
      assert.equal(record.fullNanosecondsMatchInput, true);
      assert.equal(record.candidateMatchesInput, true);
      assert.equal(record.narrowMatchesInput, true);
    }
    assert.ok(FIXED_NANOSECONDS.includes('000000000'));
    assert.ok(FIXED_NANOSECONDS.includes('001000000'));
    assert.ok(FIXED_NANOSECONDS.includes('007831000'));
    assert.ok(FIXED_NANOSECONDS.includes('014400000'));
    assert.ok(FIXED_NANOSECONDS.includes('099999999'));
    assert.ok(FIXED_NANOSECONDS.includes('100000000'));
    assert.ok(FIXED_NANOSECONDS.includes('999999999'));
  });

  test('synthetic leading-zero-loss hypothesis is distinguished without Bun or current clock', () => {
    const record = deterministicRecord('007831000', tuple('007831000', '783'));
    assert.equal(record.candidateMatchesInput, true);
    assert.equal(record.narrowMatchesInput, false);
    assert.equal(record.comparison.widthThreeMatchesFullPrefix, false);
    assert.equal(record.comparison.narrowMilliseconds, 1700000000783);
    assert.equal(record.expectedMilliseconds, 1700000000007);
  });

  test('never rounds full epoch nanoseconds through an unsafe JS number', () => {
    const fields = parseFormats(tuple('999999999'));
    assert.equal(compareFormats(fields).candidateMilliseconds, 1700000000999);
    assert.equal(Math.trunc(Number(fields.epochNanoseconds) / 1_000_000), 1700000001000);
  });

  test('missing full width or inconsistent same-call concatenation refuses the candidate', () => {
    const value = parseFormats(tuple('7831000', '783'));
    assert.equal(compareFormats(value).candidateMilliseconds, null);
    const wrongFull = { ...parseFormats(tuple('007831000')), epochNanoseconds: '1700000001007831000' };
    assert.equal(compareFormats(wrongFull).fullJoinMatches, false);
    assert.equal(compareFormats(wrongFull).candidateMilliseconds, null);
    const wrongNarrow = { ...parseFormats(tuple('007831000')), epochWidthThree: '1700000001783' };
    assert.equal(compareFormats(wrongNarrow).narrowMilliseconds, null);
    assert.equal(compareFormats(wrongNarrow).candidateMilliseconds, 1700000000007);
  });

  test('unsafe narrow timestamps remain unavailable rather than rounded', () => {
    const fields = parseFormats(tuple('999999999', '999999999'));
    assert.equal(compareFormats(fields).narrowMilliseconds, null);
    assert.equal(compareFormats(fields).candidateMilliseconds, 1700000000999);
  });

  test('records observed narrow/full differences and independent future counts', () => {
    const counts = new CurrentCounts();
    counts.add(parseFormats(tuple('007831000', '783')), 1700000000008, 1700000000009);
    counts.add(parseFormats(tuple('014400000')), 1700000000013, 1700000000014);
    const result = counts.result();
    assert.equal(result.counts.count, 2);
    assert.equal(result.counts.widthThreePrefixMismatch, 1);
    assert.equal(result.counts.narrowCandidateMismatch, 1);
    assert.equal(result.counts.narrowFuture, 2);
    assert.equal(result.counts.candidateFuture, 1);
    assert.equal(result.counts.narrowFutureAfterClose, 1);
    assert.equal(result.counts.candidateFutureAfterClose, 0);
    assert.equal(result.counts.maxNarrowDeltaMs, 775);
    assert.equal(result.examples.length, 2);
  });

  test('caps retained examples at32 and returns detached metadata', () => {
    const counts = new CurrentCounts();
    for (let index = 0; index < 100; index++) counts.add(parseFormats(tuple('007831000', '783')), 1700000000008, 1700000000009);
    const result = counts.result();
    assert.equal(result.examples.length, 32);
    assert.equal(result.counts.narrowFuture, 100);
    result.counts.narrowFuture = 0;
    result.examples[0]!.fields.nanoseconds = '000000000';
    assert.equal(counts.result().counts.narrowFuture, 100);
    assert.equal(counts.result().examples[0]!.fields.nanoseconds, '007831000');
  });

  test('current samples execute exactly the bounded injected count without retries', async () => {
    let calls = 0;
    let time = 0;
    const result = await sampleCurrent(async remaining => {
      calls++;
      assert.ok(remaining > 0 && remaining <= 2000);
      return { raw: tuple('007831000', '783'), observedAt: 1700000000008, closedAt: 1700000000009 };
    }, new CurrentCounts(), () => time++, 3, 100);
    assert.equal(calls, 3);
    assert.equal(result.counts.narrowFuture, 3);
  });

  test('expired monotonic budget refuses before sampling and preserves prior counts on later refusal', async () => {
    let calls = 0;
    let time = 0;
    await assert.rejects(sampleCurrent(async () => { calls++; throw new Error('must not run'); }, new CurrentCounts(), () => time++ * 100, 1, 50), /sampling deadline/u);
    assert.equal(calls, 0);
    const counts = new CurrentCounts();
    await assert.rejects(sampleCurrent(async () => {
      if (++calls > 1) throw new Error('injected refusal');
      return { raw: tuple('007831000'), observedAt: 1700000000008, closedAt: 1700000000009 };
    }, counts, () => 0, 2, 100), /injected refusal/u);
    assert.equal(counts.result().counts.count, 1);
  });

  test('all four original experiment files and mobile source remain exact', () => {
    for (const [path, expected] of [
      ['scripts/diagnostics/bun-clock-ci.ts', '26a4574bae6e8d9e797a0b1b2a1a7f8eefa551883c5f998bedafceccb2d87b2c'],
      ['scripts/diagnostics/bun-clock-ci.test.ts', '3af105f0d8e56c0f88befcb42064af3f8650e4d994b2b17a0ed2eb785b790041'],
      ['scripts/diagnostics/herdr-clock-ci-20261109.md', 'af56337b69149e40bec23b9984f1de15de88a87e9780da1bce063f4d9bb17de8'],
      ['.github/workflows/herdr-clock-ci-diag-20261109.yml', '18b8872e1173011c0776fa27b8a7303a2b224e45ad5caa20a11b644fe15270f5'],
      ['tests/mobile/unit/xctest-owner.ts', '8b93d1644262f180cf2b211c0e099b1a16e2b09f3bcdb4ee7af4124ccd121789'],
    ]) assert.equal(hash(path!), expected);
  });

  test('new exact-branch workflow cannot trigger old clock or witness jobs', () => {
    const workflow = Bun.YAML.parse(readFileSync('.github/workflows/herdr-date-format-ci-diag-20261109.yml', 'utf8')) as any;
    const old = Bun.YAML.parse(readFileSync('.github/workflows/herdr-clock-ci-diag-20261109.yml', 'utf8')) as any;
    assert.deepEqual(workflow.on, { push: { branches: ['codex/herdr-date-format-ci-diag-20261109'] } });
    assert.deepEqual(old.on, { push: { branches: ['codex/herdr-clock-ci-diag-20261109'] } });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(Object.keys(workflow.jobs).length, 1);
    const job = workflow.jobs['same-call-formatter'];
    assert.equal(job['runs-on'], '${{ matrix.os }}');
    assert.deepEqual(job.strategy, { 'fail-fast': false, matrix: { os: ['ubuntu-24.04', 'ubuntu-26.04'] } });
    assert.equal(job['timeout-minutes'], 5);
    assert.deepEqual(job.steps[0].with, { ref: '${{ github.sha }}', 'fetch-depth': 1, 'persist-credentials': false });
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/u);
    assert.equal(job.steps.at(-1).with['retention-days'], 1);
    assert.ok(job.steps.at(-1).with.name.includes('${{ matrix.os }}'));
    assert.ok(!JSON.stringify(workflow).includes('secrets.'));
    assert.ok(!JSON.stringify(workflow).includes('test:unit'));
  });

  test('source admits reviewed transport and uses only readonly fixed/current date operations', () => {
    const source = readFileSync('scripts/diagnostics/gnu-date-format-ci.ts', 'utf8');
    assert.equal(FORMAT, '+%s|%N|%3N|%s%N|%s%3N');
    assert.ok(source.includes('reviewed command transport pin'));
    assert.ok(source.includes('`--date=@${SECONDS}.${nanoseconds}`'));
    assert.ok(source.includes('command([FORMAT])'));
    assert.ok(!source.includes('--set'));
    assert.ok(!source.includes('process.kill('));
    assert.ok(!source.includes('process.env'));
    assert.ok(!source.includes('setTimeout(resolve'));
  });
});
