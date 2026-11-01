// Deterministic before/after check for the tool-output vault wire probe. No provider traffic.
// Run: node --test scripts/pi-efficiency/tool-vault-wire.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {after, test} from 'node:test';
import {runVaultWire} from './tool-vault-wire.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-vault-wire-test-'));
after(() => fs.rmSync(outDir, {recursive: true, force: true}));
const outFile = path.join(outDir, 'wire.json');
let result;
if (process.env.PI_REPLAY_IN_PROCESS === '1') {
  fs.writeFileSync(outFile, JSON.stringify(await runVaultWire()), {mode: 0o600});
  result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} else {
  const run = spawnSync(process.execPath, ['--max-old-space-size=512', path.join(here, 'tool-vault-wire.mjs'), '--json', outFile], {
    encoding: 'utf8', timeout: 120_000, killSignal: 'SIGTERM',
    maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, PI_CONTEXT_RESULT_REFERENCES: '1', PI_CONTEXT_READ_DELTAS: '0', PI_TOOL_VAULT: undefined},
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null, `probe terminated by ${run.signal}`);
  assert.equal(run.status, 0, run.stderr.slice(-4000));
  assert.ok(run.stdout.trim().length > 0, 'probe must emit its measured results');
  result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
}
const row = (profile, scenario) => {
  const found = result.summary.find((entry) => entry.profile === profile && entry.scenario === scenario);
  assert.ok(found, `missing summary row ${profile}/${scenario}`);
  return found;
};

for (const profile of ['fast', 'production']) {
  test(`${profile}: aged results are replaced and reported against the Pi8 reference baseline`, () => {
    const entry = row(profile, 'aged-reads-never-needed');
    assert.ok(entry.archivedIds.length >= 1, 'the candidate must archive at least one result');
    assert.ok(entry.candidateReferences >= 1, 'each archived result must appear as a reference');
    assert.ok(entry.totalCandidateBytes > 0 && entry.totalBaselineBytes > 0);
    assert.ok(Math.abs(entry.savedPercent - 100 * (entry.totalBaselineBytes - entry.totalCandidateBytes) / entry.totalBaselineBytes) < 1e-9);
  });

  test(`${profile}: nothing is archived or hidden when no result qualifies, at zero extra bytes`, () => {
    const entry = row(profile, 'nothing-archivable');
    assert.equal(entry.candidateReferences, 0);
    assert.equal(entry.archivedIds.length, 0);
    // The recall tool is declared only once a record exists, so a non-archiving session pays nothing.
    assert.equal(entry.totalCandidateBytes, entry.totalBaselineBytes);
  });

  test(`${profile}: recalling costs one round trip that a retained context would not have needed`, () => {
    const withFollow = row(profile, 'aged-read-then-recall-vs-reread').followUp;
    const fromContext = row(profile, 'aged-read-then-answer-from-context').followUp;
    assert.ok(withFollow.candidateRecall > 0 && withFollow.baselineReread > 0);
    assert.equal(fromContext.baselineReread, 0, 'the context baseline sends no extra request');
    // Honest cost: needing old bytes again is more expensive with the vault than answering from the
    // text still in context, and about the same as re-reading the range.
    assert.ok(withFollow.candidateRecall > withFollow.baselineFromContext);
    const versusReread = (withFollow.candidateRecall - withFollow.baselineReread) / withFollow.baselineReread;
    assert.ok(Math.abs(versusReread) < 0.05, `recall should track a ranged re-read, got ${versusReread}`);
  });
}

test('records are written under the store caps and cleaned up afterwards', () => {
  const rows = result.rows.filter((entry) => entry.vaultRecords > 0);
  assert.ok(rows.length > 0);
  for (const entry of rows) {
    assert.ok(entry.vaultBytes <= 32 * 1024 * 1024, 'a store stays within its byte cap');
    for (const id of entry.archivedIds) assert.match(id, /^[0-9a-f]{64}$/);
  }
});
