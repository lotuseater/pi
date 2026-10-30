// Synthetic wire probe using the actual SDK normalizer/serializer; no provider calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { referenceReadOnlyResults } from '../../packages/coding-agent/src/core/context-references.ts';
import { stream } from '../../packages/ai/src/api/openai-completions.ts';
import { serializeConversation } from '../../packages/coding-agent/src/core/compaction/utils.ts';
import { normalizeContext } from '../../packages/ai/src/utils/transcript.ts';
const hash = text => createHash('sha256').update(text).digest('hex');
const fixture = Array.from({length: 450}, (_, i) => `export const item${String(i).padStart(4, '0')} = { enabled: true, weight: ${i}, label: "synthetic" };\n`).join('');
const source = readFileSync(new URL('../../packages/coding-agent/src/core/context-references.ts', import.meta.url), 'utf8');
const cases = [
  ['small-edit', [fixture, fixture.replace('weight: 300,', 'weight: 301,')]],
  ['successive-edits', [fixture, fixture.replace('weight: 300,', 'weight: 301,'), fixture.replace('weight: 300,', 'weight: 301,').replace('weight: 310,', 'weight: 311,')]],
  ['revert', [fixture, fixture.replace('weight: 300,', 'weight: 301,'), fixture]],
  ['public-source', [source, source.replace('maxEntries ?? 32', 'maxEntries ?? 24')]],
  ['complete-change', [fixture, fixture.replaceAll('true', 'false')]],
  ['long-line', ['a'.repeat(42000), 'a'.repeat(21000) + 'b' + 'a'.repeat(20999)]],
  ['tiny', ['hello\n', 'world\n']],
  ['CRLF', [fixture.replaceAll('\n', '\r\n'), fixture.replace('weight: 300,', 'weight: 301,').replaceAll('\n', '\r\n')]],
  ['no-final-LF', [fixture.trimEnd(), fixture.trimEnd().replace('weight: 300,', 'weight: 301,')]],
  ['compacted', [fixture.replace('weight: 300,', 'weight: 301,')]],
  ['force-full', [fixture, fixture.replace('weight: 300,', 'weight: 301,')]],
];
const model = {id: 'synthetic', name: 'Local wire fixture', provider: 'study-local', api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 4096, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
function history(texts, force) {
  return texts.flatMap((text, i) => [{role: 'assistant', content: [{type: 'toolCall', id: `synthetic-${i}`, name: 'read', arguments: {path: 'synthetic.ts', ...(force && i > 0 ? {force: true} : {})}}], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: 0},
    {role: 'toolResult', toolCallId: `synthetic-${i}`, toolName: 'read', content: [{type: 'text', text}], details: {piReadOnlySnapshot: {version: 1, tool: 'read', identity: '/synthetic/synthetic.ts'}}, isError: false, timestamp: 0}]);
}
function verifyWire(body, messages) {
  const anchors = new Map();
  const tools = body.messages.filter(m => m.role === 'tool');
  assert.equal(tools.length, messages.length / 2);
  for (const [i, tool] of tools.entries()) {
    const text = tool.content;
    assert.equal(typeof text, 'string');
    const anchor = text.match(/^\[Pi snapshot ([a-f0-9]{64}): full read result\]\n/);
    if (anchor) anchors.set(anchor[1], text.slice(anchor[0].length));
    if (!text.startsWith('[Pi read delta v1:')) continue;
    const id = text.match(/Exact full base snapshot ([a-f0-9]{64})/)[1];
    assert.ok(anchors.has(id), 'full base must survive actual normalization and serialization');
    const base = anchors.get(id), patch = JSON.parse(text.slice(text.indexOf('\n') + 1));
    const lines = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const rebuilt = lines.slice(0, patch.startLine - 1).join('') + patch.insertText + lines.slice(patch.startLine - 1 + patch.deleteLineCount).join('');
    assert.equal(hash(base), text.match(/Base SHA256=([a-f0-9]{64})/)[1]);
    assert.equal(rebuilt, messages[i * 2 + 1].content[0].text);
    assert.equal(hash(rebuilt), text.match(/current SHA256=([a-f0-9]{64})/)[1]);
  }
}
let network = 0;
globalThis.fetch = async () => { network++; throw Error('External network forbidden'); };
export async function run(variant = 'candidate', testCases = cases) {
  const rows = [];
  for (const [name, texts] of testCases) {
    const input = history(texts, name === 'force-full'), saved = JSON.stringify(input);
    const start = performance.now(), cpu = process.cpuUsage();
    const messages = referenceReadOnlyResults(input, {readDeltas: variant === 'candidate'});
    assert.equal(serializeConversation(messages), serializeConversation(input), 'summary must restore originals before its own independent truncation');
    let body, stubs = 0;
    const result = await stream(model, normalizeContext({systemPrompt: 'Synthetic read-only evidence.', messages}), {apiKey: 'synthetic-not-secret', maxTokens: 32, maxRetries: 0, cacheRetention: 'none', fetch: async (_url, init) => {
      stubs++; body = init.body;
      return new Response('data: ' + JSON.stringify({id: 'stub', object: 'chat.completion.chunk', created: 0, model: model.id, choices: [{index: 0, delta: {content: ''}, finish_reason: 'stop'}]}) + '\n\ndata: [DONE]\n\n', {headers: {'Content-Type': 'text/event-stream'}});
    }}).result();
    const used = process.cpuUsage(cpu);
    assert.equal(stubs, 1); assert.notEqual(result.stopReason, 'error', result.errorMessage);
    verifyWire(JSON.parse(body), input);
    assert.equal(JSON.stringify(input), saved);
    rows.push({name, variant, requestBytes: Buffer.byteLength(body), sha256: hash(body), wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, deltas: messages.filter(m => m.role === 'toolResult' && m.content[0]?.text?.startsWith('[Pi read delta v1:')).length});
  }
  assert.equal(network, 0);
  let pssKiB;
  try { pssKiB = Number(readFileSync('/proc/self/smaps_rollup', 'utf8').match(/^Pss:\s+(\d+)/m)?.[1]); } catch {}
  return {variant, rows, peakRssMiB: process.resourceUsage().maxRSS / 1024, pssKiB, processCpu: process.cpuUsage(), externalNetworkAttempts: network, modelCalls: 0, claims: 'Serialized bytes and local costs only; no billed-token/server speed/model-comprehension equivalence claim.'};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await run(process.argv[2]), null, 2));
}
