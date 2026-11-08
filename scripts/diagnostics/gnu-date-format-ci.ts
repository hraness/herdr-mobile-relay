import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';

export const FORMAT = '+%s|%N|%3N|%s%N|%s%3N';
export const CURRENT_SAMPLES = 2048;
export const TOTAL_MS = 60_000;
export const TRANSPORT_SHA256 = '26a4574bae6e8d9e797a0b1b2a1a7f8eefa551883c5f998bedafceccb2d87b2c';
export const ORIGINAL_SHA256 = '8b93d1644262f180cf2b211c0e099b1a16e2b09f3bcdb4ee7af4124ccd121789';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const SECONDS = '1700000000';
export const FIXED_NANOSECONDS = [
  '000000000', '000000001', '000999999', '001000000', '007831000',
  '009999999', '010000000', '014400000', '099000000', '099999999',
  '100000000', '999000000', '999999999',
] as const;
export type Fields = { seconds: string; nanoseconds: string; widthThree: string; epochNanoseconds: string; epochWidthThree: string };

export function ubuntuIdentity(raw: string): { id: 'ubuntu'; version: '24.04' | '26.04' } {
  const read = (key: string) => {
    const lines = raw.split('\n').filter(line => line.startsWith(`${key}=`));
    assert.equal(lines.length, 1, 'one OS identity field');
    return lines[0]!.slice(key.length + 1).replace(/^"(.*)"$/u, '$1');
  };
  assert.equal(read('ID'), 'ubuntu', 'Ubuntu required');
  const version = read('VERSION_ID');
  assert.ok(version === '24.04' || version === '26.04', 'reviewed Ubuntu image family');
  return { id: 'ubuntu', version };
}

export function parseFormats(raw: Buffer): Fields {
  assert.ok(raw.length > 0 && raw.length <= 128, 'formatter record size');
  const text = raw.toString();
  assert.ok(text.endsWith('\n') && !text.slice(0, -1).includes('\n') && !text.includes('\r'), 'one formatter line');
  const parts = text.slice(0, -1).split('|');
  assert.equal(parts.length, 5, 'formatter fields');
  for (let index = 0; index < parts.length; index++) {
    const max = index === 0 ? 12 : index < 3 ? 9 : 21;
    assert.match(parts[index]!, new RegExp(`^[0-9]{1,${max}}$`, 'u'), 'numeric formatter field');
  }
  return { seconds: parts[0]!, nanoseconds: parts[1]!, widthThree: parts[2]!, epochNanoseconds: parts[3]!, epochWidthThree: parts[4]! };
}

const safeInteger = (text: string): number | null => {
  const value = BigInt(text);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
};

export function compareFormats(fields: Fields) {
  const fullJoinMatches = fields.epochNanoseconds === fields.seconds + fields.nanoseconds;
  const narrowJoinMatches = fields.epochWidthThree === fields.seconds + fields.widthThree;
  const fullWidthIsNine = fields.nanoseconds.length === 9;
  // Truncate the string before Number conversion; full epoch nanoseconds exceed JS safe precision.
  const candidateMilliseconds = fullJoinMatches && fullWidthIsNine
    ? safeInteger(fields.epochNanoseconds.slice(0, -6)) : null;
  const narrowMilliseconds = narrowJoinMatches ? safeInteger(fields.epochWidthThree) : null;
  return {
    fullJoinMatches, narrowJoinMatches, fullWidthIsNine,
    widthThreeMatchesFullPrefix: fullWidthIsNine && fields.widthThree === fields.nanoseconds.slice(0, 3),
    narrowMilliseconds, candidateMilliseconds,
    narrowEqualsCandidate: candidateMilliseconds !== null && narrowMilliseconds === candidateMilliseconds,
  };
}

export function deterministicRecord(nanoseconds: string, raw: Buffer) {
  assert.ok((FIXED_NANOSECONDS as readonly string[]).includes(nanoseconds), 'fixed matrix member');
  const fields = parseFormats(raw);
  const comparison = compareFormats(fields);
  const expectedMilliseconds = Number(BigInt(SECONDS) * 1000n + BigInt(nanoseconds) / 1_000_000n);
  return {
    input: `@${SECONDS}.${nanoseconds}`, fields, comparison, expectedMilliseconds,
    secondsMatchInput: fields.seconds === SECONDS,
    fullNanosecondsMatchInput: fields.nanoseconds === nanoseconds,
    candidateMatchesInput: comparison.candidateMilliseconds === expectedMilliseconds,
    narrowMatchesInput: comparison.narrowMilliseconds === expectedMilliseconds,
  };
}

export class CurrentCounts {
  private value = {
    count: 0, fullWidthNine: 0, fullJoinMismatch: 0, narrowJoinMismatch: 0,
    widthThreePrefixMismatch: 0, narrowCandidateMismatch: 0, candidateUnavailable: 0,
    narrowFuture: 0, candidateFuture: 0, narrowFutureAfterClose: 0, candidateFutureAfterClose: 0,
    minNarrowDeltaMs: null as number | null, maxNarrowDeltaMs: null as number | null,
    minCandidateDeltaMs: null as number | null, maxCandidateDeltaMs: null as number | null,
  };
  private examples: Array<{ fields: Fields; comparison: ReturnType<typeof compareFormats>; observedAt: number; closedAt: number }> = [];

  add(fields: Fields, observedAt: number, closedAt: number): void {
    for (const value of [observedAt, closedAt]) assert.ok(Number.isSafeInteger(value) && value > 0);
    const compared = compareFormats(fields);
    const value = this.value;
    value.count++;
    if (compared.fullWidthIsNine) value.fullWidthNine++;
    if (!compared.fullJoinMatches) value.fullJoinMismatch++;
    if (!compared.narrowJoinMatches) value.narrowJoinMismatch++;
    if (!compared.widthThreeMatchesFullPrefix) value.widthThreePrefixMismatch++;
    if (!compared.narrowEqualsCandidate) value.narrowCandidateMismatch++;
    for (const [name, timestamp] of [['Narrow', compared.narrowMilliseconds], ['Candidate', compared.candidateMilliseconds]] as const) {
      if (timestamp === null) { if (name === 'Candidate') value.candidateUnavailable++; continue; }
      const delta = timestamp - observedAt;
      const low = `min${name}DeltaMs` as 'minNarrowDeltaMs' | 'minCandidateDeltaMs';
      const high = `max${name}DeltaMs` as 'maxNarrowDeltaMs' | 'maxCandidateDeltaMs';
      value[low] = value[low] === null ? delta : Math.min(value[low]!, delta);
      value[high] = value[high] === null ? delta : Math.max(value[high]!, delta);
      if (timestamp > observedAt) value[name === 'Narrow' ? 'narrowFuture' : 'candidateFuture']++;
      if (timestamp > closedAt) value[name === 'Narrow' ? 'narrowFutureAfterClose' : 'candidateFutureAfterClose']++;
    }
    if ((!compared.narrowEqualsCandidate || compared.candidateMilliseconds === null || compared.candidateMilliseconds > observedAt) && this.examples.length < 32) {
      this.examples.push({ fields: { ...fields }, comparison: compared, observedAt, closedAt });
    }
  }

  result() { return { counts: { ...this.value }, examples: structuredClone(this.examples) }; }
}

export async function sampleCurrent(
  sample: (remainingMs: number) => Promise<{ raw: Buffer; observedAt: number; closedAt: number }>,
  counts = new CurrentCounts(), now = () => performance.now(), iterations = CURRENT_SAMPLES, deadlineMs = TOTAL_MS,
) {
  assert.ok(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= CURRENT_SAMPLES);
  assert.ok(deadlineMs > 0 && deadlineMs <= TOTAL_MS);
  const deadline = now() + deadlineMs;
  for (let index = 0; index < iterations; index++) {
    const remaining = deadline - now();
    assert.ok(remaining > 0, 'formatter sampling deadline');
    const read = await sample(Math.min(2000, remaining));
    assert.ok(now() < deadline, 'formatter sampling deadline');
    counts.add(parseFormats(read.raw), read.observedAt, read.closedAt);
  }
  return counts.result();
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'linux', 'CI Linux only');
  assert.equal(Bun.version, '1.4.4');
  assert.deepEqual(process.argv.slice(2), ['--output', 'diagnostics/gnu-date-format-ci.json']);
  const transportFile = new URL('./bun-clock-ci.ts', import.meta.url);
  assert.equal(hash(await readFile(transportFile)), TRANSPORT_SHA256, 'reviewed command transport pin');
  assert.equal(hash(await readFile('tests/mobile/unit/xctest-owner.ts')), ORIGINAL_SHA256, 'original test pin');
  const osRelease = ubuntuIdentity(readFileSync('/etc/os-release', 'utf8'));
  const { ownedCommand } = await import('./bun-clock-ci');
  const output = 'diagnostics/gnu-date-format-ci.json';
  assert.equal(existsSync(output), false, 'new output only');
  await mkdir('diagnostics', { recursive: true });
  const start = performance.now();
  const startedAt = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TOTAL_MS);
  const cancel = () => abort.abort();
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  const matrix: ReturnType<typeof deterministicRecord>[] = [];
  const current = new CurrentCounts();
  let version: string | null = null;
  let complete = false;
  let category: string | null = null;
  const command = async (args: string[]) => {
    const remaining = TOTAL_MS - (performance.now() - start);
    assert.ok(remaining > 0, 'formatter sampling deadline');
    return ownedCommand('/bin/date', args, async child => { child.stdin?.end(); }, abort.signal, Math.min(2000, remaining));
  };
  try {
    const versionOutput = await command(['--version']);
    const first = versionOutput.stdout.toString().split('\n')[0]!;
    assert.match(first, /^date \(GNU coreutils\) [0-9][0-9.a-zA-Z-]{0,40}$/u);
    version = first;
    for (const nanoseconds of FIXED_NANOSECONDS) {
      const read = await command([`--date=@${SECONDS}.${nanoseconds}`, FORMAT]);
      matrix.push(deterministicRecord(nanoseconds, read.stdout));
    }
    await sampleCurrent(async () => {
      const read = await command([FORMAT]);
      assert.notEqual(read.firstOutputAt, null);
      return { raw: read.stdout, observedAt: read.firstOutputAt!, closedAt: read.closedAt };
    }, current, () => performance.now(), CURRENT_SAMPLES, Math.max(1, TOTAL_MS - (performance.now() - start)));
    complete = true;
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    category = ['owned command cleanup uncertain', 'owned command refused', 'formatter sampling deadline', 'cancelled before spawn', 'spawn refused'].includes(text) ? text : 'formatter experiment refused';
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
  const report = {
    format: 1, kind: 'herdr-isolated-gnu-date-formatter-diagnostic-v1', experimentComplete: complete, category,
    source: { base: 'fad4d975ee482e95860ff56a250d4c318a9f1835', originalTestSha256: ORIGINAL_SHA256, commandTransportSha256: TRANSPORT_SHA256, diagnosticSha256: hash(await readFile(import.meta.filename)), dateBinarySha256: hash(await readFile('/bin/date')) },
    priorExperiment: { run: '42524344956', reportSha256: 'c2742eb13c09bb234327f607056987bcae62675d0dc8d60e4ff16d613a64a27b', reexecuted: false },
    runtime: { bun: Bun.version, platform: process.platform, os: { ...osRelease, kernel: release(), arch: arch() }, date: version },
    configured: { sameCallFormat: FORMAT, fixedCases: FIXED_NANOSECONDS.length, currentSamples: CURRENT_SAMPLES, samplingMs: TOTAL_MS, commandMs: 2000, refusalCleanupMs: 1000, exampleLimit: 32 },
    startedAt, endedAt: Date.now(), durationMs: performance.now() - start,
    deterministic: matrix, current: current.result(),
    claims: { productFixApplied: false, originalAssertionsChanged: false, witnessesReexecuted: false, causeOfPriorPositiveWitnessKnown: false, productionQualification: false },
  };
  const bytes = JSON.stringify(report, null, 2) + '\n';
  assert.ok(Buffer.byteLength(bytes) < 65_536, 'bounded diagnostic artifact');
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  // Success means the experiment completed. Observed formatter/clock differences remain explicit data.
  if (!complete) process.exitCode = 1;
}

if (import.meta.main) await main();
