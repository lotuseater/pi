// Synthetic, dependency-free regression coverage for changed complete-file projections.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { referenceReadOnlyResults as project } from '../../packages/coding-agent/src/core/context-references.ts';
import { createReadSplice, formatReadSplice } from '../../packages/coding-agent/src/core/context-read-deltas.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const base = Array.from({length: 450}, (_, n) => `export const value${n} = { enabled: true, count: ${n}, name: "synthetic fixture" };\n`).join('');
let seq = 0;
function pair(text, options = {}) {
  const { args = {path: 'fixture.ts'}, identity = '/synthetic/fixture.ts', details = {}, snapshot = {version: 1, tool: 'read', identity}, tool = 'read', error = false, content } = options;
  const id = `synthetic-${++seq}`;
  return [{role: 'assistant', stopReason: 'toolUse', content: [{type: 'toolCall', id, name: tool, arguments: args}]},
    {role: 'toolResult', toolCallId: id, toolName: tool, isError: error, content: content ?? [{type: 'text', text}],
      details: {...details, ...(snapshot ? {piReadOnlySnapshot: snapshot} : {})}}];
}
function verify(messages, options = {}) {
  const saved = JSON.stringify(messages);
  const output = project(messages, {readDeltas: true, ...options});
  const anchors = new Map();
  let deltas = 0;
  for (let i = 0; i < output.length; i++) {
    const current = output[i];
    if (current.role !== 'toolResult' || current.content.length !== 1 || current.content[0].type !== 'text') continue;
    const text = current.content[0].text;
    const anchor = text.match(/^\[Pi snapshot ([a-f0-9]{64}): full read result\]\n/);
    if (anchor) anchors.set(anchor[1], text.slice(anchor[0].length));
    if (!text.startsWith('[Pi read delta v1:')) continue;
    deltas++;
    const id = text.match(/Exact full base snapshot ([a-f0-9]{64})/)[1];
    assert.ok(anchors.has(id), 'base must be a full earlier outgoing result, never another delta');
    const first = anchors.get(id);
    assert.equal(hash(first), text.match(/Base SHA256=([a-f0-9]{64})/)[1]);
    const patch = JSON.parse(text.slice(text.indexOf('\n') + 1));
    assert.ok(Number.isSafeInteger(patch.startLine) && patch.startLine >= 1);
    assert.ok(Number.isSafeInteger(patch.deleteLineCount) && patch.deleteLineCount >= 0);
    const lines = first.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const rebuilt = lines.slice(0, patch.startLine - 1).join('') + patch.insertText + lines.slice(patch.startLine - 1 + patch.deleteLineCount).join('');
    const original = messages[i].details?.piContextProjection?.originalText ?? messages[i].content[0].text;
    assert.equal(rebuilt, original);
    assert.equal(hash(rebuilt), text.match(/current SHA256=([a-f0-9]{64})/)[1]);
    assert.match(text, /NEWER complete file observation/);
    assert.match(text, /range=entire file/);
  }
  assert.equal(JSON.stringify(messages), saved, 'durable originals must not change');
  return {output, deltas};
}

test('successive small edits and repeated new values use the same full base, without chains', () => {
  const b = base.replace('count: 230,', 'count: 231,');
  const c = b.replace('count: 260,', 'count: 261,');
  const {output, deltas} = verify([...pair(base), ...pair(b), ...pair(b), ...pair(c), ...pair(base)]);
  assert.equal(deltas, 3);
  assert.match(output.at(-1).content[0].text, /^\[Unchanged read-only result/);
});

test('insertions, deletions, line shifts, CRLF, Unicode, and absent final LF reconstruct exactly', () => {
  for (const original of [base, base.replaceAll('\n', '\r\n'), base.trimEnd(), base.replace('value100', '🙂漢字é')]) {
    const lines = original.match(/[^\n]*\n|[^\n]+$/g);
    const variants = [lines.slice(0, 180).join('') + 'new line 🙂\r\n' + lines.slice(180).join(''),
      lines.filter((_, i) => i !== 190).join(''), lines.slice(0, -1).join(''), original + '\n', '\n' + original];
    for (const changed of variants) assert.equal(verify([...pair(original), ...pair(changed)]).deltas, 1);
  }
});

test('empty, newline-only, complete changes, and long single-line changes fall back', () => {
  for (const [a, b] of [['', '\n'], ['\n', ''], [base, base.replaceAll('true', 'false')], ['x'.repeat(42000), 'x'.repeat(21000) + 'y' + 'x'.repeat(20999)]]) {
    assert.equal(verify([...pair(a), ...pair(b)]).deltas, 0);
  }
});

test('missing bases after compaction or branch changes are sent full', () => {
  const changed = base.replace('count: 230,', 'count: 231,');
  const messages = [...pair(base), ...pair(changed)];
  const first = verify(messages).output;
  assert.equal(verify(messages.slice(2)).deltas, 0);
  const restored = verify(first.slice(2));
  assert.equal(restored.deltas, 0);
  assert.ok(restored.output[1].content[0].text.endsWith(changed));
  assert.deepEqual(verify(first).output, first, 'projection is idempotent');
});

test('force, ranges, path/argument changes, material metadata, errors and unsupported results bypass', () => {
  const changed = base.replace('count: 230,', 'count: 231,');
  for (const options of [
    {args: {path: 'fixture.ts', force: true}}, {args: {path: 'fixture.ts', offset: 1}}, {args: {path: 'fixture.ts', limit: 2000}},
    {args: {path: 'other.ts'}}, {identity: '/other/fixture.ts'}, {identity: 'legacy-relative'},
    {details: {truncation: {truncated: true}}}, {details: {anything: 'material'}},
    {error: true}, {snapshot: null}, {tool: 'grep', snapshot: {version: 2, tool: 'grep', identity: '/synthetic', scope: 'tool-result', partial: false}},
    {content: [{type: 'image', data: 'synthetic', mimeType: 'image/png'}]},
    {content: [{type: 'text', text: changed}, {type: 'text', text: 'extra'}]},
  ]) assert.equal(verify([...pair(base), ...pair(changed, options)]).deltas, 0);
});

test('entry/byte eviction and per-request work bounds cause safe full fallbacks', () => {
  const changed = base.replace('count: 230,', 'count: 231,');
  assert.equal(verify([...pair(base), ...pair('other\n'.repeat(1000), {identity: '/synthetic/other.ts'}), ...pair(changed)], {maxEntries: 1}).deltas, 0);
  assert.equal(verify([...pair(base), ...pair(changed)], {maxBytes: 1024}).deltas, 0);
  const many = [...pair(base), ...Array.from({length: 15}, (_, n) => pair(base.replace('count: 230,', `count: ${900 + n},`))).flat()];
  const result = verify(many);
  assert.ok(result.deltas > 0 && result.deltas < 15, 'bounded work must fall back to full results');
});

test('invalid text, excessive bytes/lines and unprofitable operations bypass', () => {
  for (const invalid of ['\0', '\u0001', '\ufffd']) {
    assert.equal(createReadSplice(base + invalid, base.replace('true', 'false') + invalid), undefined);
  }
  assert.equal(createReadSplice('x'.repeat(51201), 'new'), undefined);
  assert.equal(createReadSplice('x\n'.repeat(2001), 'new'), undefined);
  assert.equal(formatReadSplice('short\n', 'changed\n', '/synthetic', '0'.repeat(64), 1), undefined);
});

test('delta feature stays explicitly off when not requested', () => {
  const messages = [...pair(base), ...pair(base.replace('count: 230,', 'count: 231,'))];
  assert.equal(verify(messages, {readDeltas: false}).deltas, 0);
  assert.ok(project(messages, {readDeltas: false}).at(-1).content[0].text.startsWith('[Pi snapshot '));
});
