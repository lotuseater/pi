// Synthetic, dependency-free checks for the existing TypeScript implementation.
// JavaScript matches the project's native Node test tooling; no provider SDK runs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { referenceReadOnlyResults as project } from '../../packages/coding-agent/src/core/context-references.ts';
import { readGrepContextLines } from '../../packages/coding-agent/src/core/tools/grep-context-lines.ts';
import { readTextBounded } from '../../packages/coding-agent/src/core/tools/read-text-bounded.ts';
import { truncateHead } from '../../packages/coding-agent/src/core/tools/truncate.ts';

const fixture = await mkdtemp(path.join(tmpdir(), 'pi-efficiency-'));
after(() => rm(fixture, { recursive: true, force: true }));

const samples = [
  '', 'a', 'a\n', 'a\r\nb\rc\n', '\n\n', '🙂漢字é\nαβ\n',
  'x'.repeat(51200), 'x'.repeat(51200) + '\nmore\n',
  'x'.repeat(65535) + '🙂\r\nnext', '\n'.repeat(2001),
  'x'.repeat(65535) + '\r\nneedle\rtail\nlast',
  'a\r'.repeat(400) + '\nneedle\n',
  '\r'.repeat(8192) + 'x'.repeat(501) + '\r\nneedle\n',
  Buffer.from([0xff, 0xe2, 0x82, 0x0a, 0xed, 0xa0, 0x80]),
  Buffer.concat([Buffer.alloc(65535, 120), Buffer.from('🙂\n'), Buffer.from([0xe2, 0x82])]),
];
for (const [index, data] of samples.entries()) {
  test(`bounded read equals full-file truncation: fixture ${index}`, async () => {
    const file = path.join(fixture, `read-${index}`);
    await writeFile(file, data);
    const lines = (await readFile(file)).toString('utf8').split('\n');
    for (const start of new Set([0, 1, Math.max(0, lines.length - 1)])) {
      if (start >= lines.length) continue;
      for (const limit of [undefined, 0, 1, 2, 2000, 2001]) {
        const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
        assert.deepEqual(await readTextBounded(file, start, limit), {
          totalFileLines: lines.length,
          firstLineBytes: limit === 0 ? 0 : Buffer.byteLength(lines[start]),
          userLimitedLines: limit === undefined ? undefined : end - start,
          truncation: truncateHead(lines.slice(start, end).join('\n')),
        });
      }
    }
  });
}

for (const [index, data] of samples.entries()) {
  test(`grep windows equal normalized full-file lines: fixture ${index}`, async () => {
    const file = path.join(fixture, `grep-${index}`);
    await writeFile(file, data);
    const lines = (await readFile(file)).toString('utf8').replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\r/g, ''));
    for (const centers of [[1], [2], [lines.length], [2, 1, 2, lines.length]]) {
      for (const radius of [0, 1, 3]) {
        const result = await readGrepContextLines(file, centers, radius, 500);
        assert.equal(result.length, Math.min(lines.length, Math.max(...centers) + radius));
        for (let line = 1; line <= result.length; line++) {
          const wanted = centers.some(center => line >= Math.max(1, center - radius) && line <= center + radius);
          assert.equal(result[line - 1], wanted ? lines[line - 1].slice(0, 501) : undefined);
        }
      }
    }
  });
}

test('both streaming helpers reject already-cancelled work', async () => {
  const file = path.join(fixture, 'cancel');
  await writeFile(file, 'synthetic\n'.repeat(8192));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readTextBounded(file, 0, undefined, controller.signal));
  await assert.rejects(readGrepContextLines(file, [1], 0, 500, controller.signal));
});

const text = 'synthetic result\n'.repeat(200);
function pair(id, { args = { path: 'fixture.txt' }, details = {}, tool = 'read', snapshot, isError = false } = {}) {
  return [
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: tool, arguments: args }] },
    { role: 'toolResult', toolCallId: id, toolName: tool, content: [{ type: 'text', text }], isError,
      details: { piReadOnlySnapshot: snapshot ?? { version: 1, tool, identity: 'synthetic-fixture' }, ...details } },
  ];
}
const isReference = message => message.content[0].text.startsWith('[Unchanged');

test('references preserve originals, restore anchors and project idempotently', () => {
  const history = [...pair('a'), ...pair('b')];
  const saved = JSON.stringify(history);
  const projected = project(history);
  assert.equal(isReference(projected[1]), false);
  assert.equal(isReference(projected[3]), true);
  assert.ok(projected[1].content[0].text.endsWith(text));
  assert.equal(JSON.stringify(history), saved);
  assert.deepEqual(project(projected), projected);
  assert.equal(isReference(project(projected.slice(2))[1]), false);
});

test('query, metadata, force, errors and cache bounds cause full-result fallback', () => {
  for (const options of [
    { args: { path: 'other.txt' } }, { args: { path: 'fixture.txt', force: true } },
    { details: { changed: true } }, { isError: true },
  ]) assert.equal(isReference(project([...pair('a'), ...pair('b', options)])[3]), false);
  for (const options of [{ maxEntries: 0 }, { maxBytes: 1 }, { minBytes: 999999 }]) {
    const history = [...pair('a'), ...pair('b')];
    assert.deepEqual(project(history, options), history);
  }
});

test('exact partial grep results retain notices and observed-result wording', () => {
  const options = { tool: 'grep', details: { matchLimitReached: 20 },
    snapshot: { version: 2, tool: 'grep', identity: 'synthetic-root', scope: 'tool-result', partial: true } };
  const out = project([...pair('a', options), ...pair('b', options)]);
  assert.equal(isReference(out[3]), true);
  assert.match(out[1].content[0].text, /observed portion; limits\/notices retained/);
  assert.match(out[3].content[0].text, /unobserved content is not asserted unchanged/);
  assert.equal(out[3].details.matchLimitReached, 20);
  assert.equal(isReference(project([...pair('a', options), ...pair('b', {
    ...options, details: { matchLimitReached: 21 },
  })])[3]), false);
});

test('non-JSON metadata falls back without invoking an accessor', () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 1; } });
  const cycle = {}; cycle.self = cycle;
  for (const material of [new Date(0), new Map(), NaN, Infinity, undefined, () => 1, 1n, [, 1], getter, cycle]) {
    const options = { details: { material } };
    assert.equal(isReference(project([...pair('a', options), ...pair('b', options)])[3]), false);
  }
  assert.equal(getterCalls, 0);
  const material = { values: [null, true, 1, 'λ'] };
  const options = { details: { material } };
  assert.equal(isReference(project([...pair('a', options), ...pair('b', options)])[3]), true);
});
