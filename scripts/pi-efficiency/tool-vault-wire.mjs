// Wire comparison for the Phase A tool-output vault. Identical captured tool results and the same
// stored conversation, replayed at assistant request boundaries under each variant, serialized by the real
// pi-ai normalizer/serializer with a stubbed SSE fetch. No provider traffic, no LLM.
// Run: PI_CONTEXT_RESULT_REFERENCES=1 node scripts/pi-efficiency/tool-vault-wire.mjs [--json out.json]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stream} from '../../packages/ai/src/api/openai-completions.ts';
import {normalizeContext} from '../../packages/ai/src/utils/transcript.ts';
import {createReadTool, createAllToolDefinitions} from '../../packages/coding-agent/src/core/tools/index.ts';
import {createRecallTool} from '../../packages/coding-agent/src/core/tools/recall.ts';
import {vaultReadOnlyResults, TOOL_VAULT_RECALL_TOOL_NAME} from '../../packages/coding-agent/src/core/tool-vault-projection.ts';
import {convertToLlm} from '../../packages/coding-agent/src/core/messages.ts';
import {openToolVault, resolveToolVaultConfig, TOOL_VAULT_DEFAULTS} from '../../packages/coding-agent/src/core/tool-vault.ts';
import {enableReadOnlySnapshots} from '../../packages/coding-agent/src/core/context-references.ts';

/** Run the native-read probe in the caller's process, without invoking another Node process. */
export async function runVaultWire() {
// The installed study build runs Pi8 with reference mode ON, and that flag is what decides whether
// the read/grep/find/ls schemas declare `force`. Match it before the tool modules load.
assert.equal(process.env.PI_CONTEXT_RESULT_REFERENCES, '1', 'Run with PI_CONTEXT_RESULT_REFERENCES=1');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-vault-wire-'));
const fixture = path.join(root, 'project');
fs.mkdirSync(fixture, {recursive: true});
const previousFetch = globalThis.fetch;
try {

const model = {id:'synthetic',name:'Synthetic',provider:'study',api:'openai-completions',baseUrl:'https://synthetic.invalid/v1',reasoning:false,input:['text'],contextWindow:131072,maxTokens:64,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
globalThis.fetch = async () => { throw Error('External network forbidden'); };

// The builtin tools stamp exact-result provenance when snapshot marking is on, which is what the
// installed study build does; the vault reads that marker and nothing else.
enableReadOnlySnapshots();

/** Settings under test: a small one that archives early, and the shipped production defaults. */
const profiles = {
  fast: {minBytes: 2048, keepRecentResults: 2, minUserTurnsOld: 0, minAssistantTurnsOld: 1},
  production: {minBytes: TOOL_VAULT_DEFAULTS.minBytes, keepRecentResults: TOOL_VAULT_DEFAULTS.keepRecentResults, minUserTurnsOld: 0, minAssistantTurnsOld: TOOL_VAULT_DEFAULTS.minAssistantTurnsOld},
};

function writeFixture(name, lines) {
  const text = Array.from({length: lines}, (_, i) => `${name} line ${i + 1}: ${'synthetic source text '.repeat(2)}${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(fixture, name), text);
  return name;
}
const files = [writeFixture('alpha.ts', 220), writeFixture('beta.ts', 220), writeFixture('gamma.ts', 220), writeFixture('delta.ts', 220)];

const readTool = createReadTool(fixture);

const toolCall = (id, name, args) => ({role:'assistant', content:[{type:'toolCall', id, name, arguments: args}], api: model.api, provider: model.provider, model: model.id, usage, stopReason:'toolUse', timestamp:0});
const plain = (text) => ({role:'assistant', content:[{type:'text', text}], api: model.api, provider: model.provider, model: model.id, usage, stopReason:'stop', timestamp:0});
const userTurn = (text) => ({role:'user', content:[{type:'text', text}], timestamp:0});
const toolResult = (id, name, result) => ({role:'toolResult', toolCallId: id, toolName: name, ...result, isError: false, timestamp:0});

/**
 * Scenarios. `reads` is the number of big reads; each is followed by an answered user turn, so the
 * oldest results age out of recent context the way they do in a long session.
 */
const scenarios = [
  {name:'aged-reads-never-needed', reads:4, followUp:'none'},
  {name:'aged-read-then-recall-vs-reread', reads:4, followUp:'reread'},
  {name:'aged-read-then-answer-from-context', reads:4, followUp:'context'},
  {name:'nothing-archivable', reads:3, small:true, followUp:'none'},
];

async function requestBytes({projected, declarations}) {
  const messages = convertToLlm(projected ?? []);
  let body, fetches = 0;
  const result = await stream(model, normalizeContext({systemPrompt: 'Synthetic source evidence.', messages, tools: declarations}), {
    apiKey:'not-secret-synthetic', maxTokens:64, maxRetries:0, cacheRetention:'none',
    fetch: async (_url, init) => { fetches++; body = init.body; return new Response('data: ' + JSON.stringify({id:'stub',object:'chat.completion.chunk',created:0,model:model.id,choices:[{index:0,delta:{content:''},finish_reason:'stop'}]}) + '\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}}); },
  }).result();
  assert.equal(fetches, 1);
  assert.notEqual(result.stopReason, 'error', result.errorMessage);
  return {bytes: Buffer.byteLength(body), wire: JSON.parse(body)};
}

// The seven default tools exactly as this build declares them with reference mode ON, so baseline
// and candidate differ only by the recall declaration the candidate adds once records exist.
const DEFAULT_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const baseDeclarations = createAllToolDefinitions(fixture);
const baseTools = DEFAULT_TOOL_NAMES.map((name) => {
  const {name: toolName, description, parameters} = baseDeclarations[name];
  return {name: toolName, description, parameters: structuredClone(parameters)};
});
function declarationsFor(withRecall, recallTool) {
  if (!withRecall) return baseTools;
  const {name, description, parameters} = recallTool;
  return [...baseTools, {name, description, parameters: structuredClone(parameters)}];
}

const rows = [];
for (let round = 0; round < 3; round++) {
  for (const profile of Object.keys(profiles)) {
    for (const scenario of scenarios) {
      const vaultDir = path.join(root, `vault-${profile}-${scenario.name}`);
      const config = resolveToolVaultConfig({enabled: true, dir: vaultDir, ...profiles[profile]}, {}, vaultDir);
      const vault = openToolVault({config, identity: () => `wire:${profile}:${scenario.name}`});
      const recallTool = createRecallTool(fixture, {vault});
      const order = round % 2 ? ['candidate','baseline'] : ['baseline','candidate'];

      // One stored conversation, shared by both variants.
      const messages = [userTurn('Investigate the synthetic project.')];
      const executed = new Map();
      let callIndex = 0;
      const big = scenario.small ? {offset: 0, limit: 4} : undefined;
      // The production profile keeps ten results recent, so it needs a longer conversation before
      // anything ages out. Both profiles must therefore reach the same follow-up situation.
      const reads = scenario.reads + (profile === 'production' ? profiles.production.keepRecentResults : 0);
      for (let r = 0; r < reads; r++) {
        const id = `call-${callIndex++}`;
        const args = {path: files[r % files.length], ...big};
        if (!executed.has(id)) executed.set(id, toolResult(id, 'read', await readTool.execute(id, args, undefined)));
        messages.push(toolCall(id, 'read', args), executed.get(id), userTurn('Note that.'), plain('Noted.'));
      }
      messages.push(userTurn('Summarize what you found.'), plain('Done.'));

      const per = {baseline: {bytes: 0, requests: 0, references: 0}, candidate: {bytes: 0, requests: 0, references: 0}};
      for (const variant of order) {
        const entry = per[variant];
        // A request precedes an assistant response. Tool-call and partial-result prefixes are not
        // additional requests; counting them would artificially magnify context savings.
        for (let prefix = 1; prefix < messages.length; prefix++) {
          if (messages[prefix].role !== 'assistant') continue;
          // The recall declaration appears only from the run after the store first holds a record,
          // which is what AgentSession does; the archiving request itself still sends full text.
          const recallDeclared = variant === 'candidate' && vault.hasStoredRecords();
          const projected = variant === 'candidate'
            ? vaultReadOnlyResults(messages.slice(0, prefix), {vault, recallAvailable: recallDeclared, archiveAllowed: true, sessionId: 'wire:session'})
            : messages.slice(0, prefix);
          const {bytes, wire} = await requestBytes({projected, declarations: declarationsFor(recallDeclared, recallTool)});
          entry.bytes += bytes;
          entry.requests++;
          for (const m of wire.messages.filter((e) => e.role === 'tool')) {
            if (typeof m.content === 'string' && m.content.startsWith('[Pi vault record ')) entry.references++;
          }
        }
      }

      // The follow-up that needs old lines, three ways.
      const follow = {candidateRecall: 0, baselineReread: 0, baselineFromContext: 0};
      if (scenario.followUp !== 'none') {
        const archived = [];
        for (const message of vaultReadOnlyResults(messages, {vault, recallAvailable: true, archiveAllowed: true, sessionId: 'wire:session'})) {
          const marker = message.details?.piToolVaultRecord;
          if (marker) archived.push(marker.id);
        }
        assert.ok(archived.length > 0, `expected archived results in ${profile}/${scenario.name}`);
        if (scenario.followUp === 'reread' || scenario.followUp === 'context') {
          // Candidate: one extra round trip that recalls lines 40-59 from the vault.
          const id = archived[0];
          const recallArgs = {id, offset: 40, limit: 20};
          const recallResult = await recallTool.execute('recall-1', recallArgs, undefined);
          const withRecall = [...messages, toolCall('recall-1', TOOL_VAULT_RECALL_TOOL_NAME, recallArgs), toolResult('recall-1', TOOL_VAULT_RECALL_TOOL_NAME, recallResult)];
          // Exactness: the recalled body is the archived text, byte for byte.
          const original = executed.get('call-0').content[0].text.split('\n').slice(39, 59).join('\n');
          assert.ok(
            recallResult.content[0].text.endsWith(original),
            'recall must return the exact archived lines, byte for byte',
          );
          follow.candidateRecall = (await requestBytes({projected: withRecall, declarations: declarationsFor(true, recallTool)})).bytes;
        }
        if (scenario.followUp === 'reread') {
          // Baseline alternative the model can pick: re-read the same range with a ranged read call.
          const reread = await readTool.execute('reread-1', {path: files[0], offset: 39, limit: 20}, undefined);
          const withReread = [...messages, toolCall('reread-1', 'read', {path: files[0], offset: 39, limit: 20}), toolResult('reread-1', 'read', reread)];
          follow.baselineReread = (await requestBytes({projected: withReread, declarations: declarationsFor(false, recallTool)})).bytes;
        }
        // Baseline that needs no extra request at all: the old text is still in its own context.
        follow.baselineFromContext = (await requestBytes({projected: messages, declarations: declarationsFor(false, recallTool)})).bytes;
      }

      const archivedIds = [];
      for (const message of vaultReadOnlyResults(messages, {vault, recallAvailable: true, archiveAllowed: true, sessionId: 'wire:session'})) {
        if (message.details?.piToolVaultRecord) archivedIds.push(message.details.piToolVaultRecord.id);
      }
      // End-to-end totals add the follow-up request each variant actually needs: the candidate issues
      // one recall request; a baseline either re-reads the range or answers from the text it still
      // carries (that case sends no extra request). Replay totals count only the shared prefixes.
      // The baseline follow-up is the ranged re-read where one is plausible, and zero where the model
      // answers from the text it still carries; the candidate always pays a recall request.
      const followBaseline = scenario.followUp === 'reread' ? follow.baselineReread : 0;
      const followCandidate = scenario.followUp === 'none' ? 0 : follow.candidateRecall;
      assert.ok(followCandidate > 0 || scenario.followUp === 'none', 'a follow-up scenario must measure its recall request');
      const totalBaseline = per.baseline.bytes + followBaseline;
      const totalCandidate = per.candidate.bytes + followCandidate;
      rows.push({
        round, profile, scenario: scenario.name,
        replayBaselineBytes: per.baseline.bytes, replayCandidateBytes: per.candidate.bytes,
        followBaselineBytes: followBaseline, followCandidateBytes: followCandidate,
        baselineBytes: totalBaseline, candidateBytes: totalCandidate,
        baselineRequests: per.baseline.requests + (followBaseline > 0 ? 1 : 0),
        candidateRequests: per.candidate.requests + (followCandidate > 0 ? 1 : 0),
        replaySavedPercent: 100 * (per.baseline.bytes - per.candidate.bytes) / per.baseline.bytes,
        savedPercent: 100 * (totalBaseline - totalCandidate) / totalBaseline,
        candidateReferences: per.candidate.references, archivedIds,
        followUp: scenario.followUp === 'none' ? null : follow,
        vaultBytes: vault.usage().bytes, vaultRecords: vault.usage().records,
        config: {minBytes: config.minBytes, keepRecentResults: config.keepRecentResults, minUserTurnsOld: config.minUserTurnsOld, maxStores: config.maxStores},
      });
      fs.rmSync(vaultDir, {recursive: true, force: true});
    }
  }
}

const mean = (items, key) => items.reduce((sum, r) => sum + (r[key] ?? 0), 0) / items.length;
const summary = [];
for (const profile of Object.keys(profiles)) for (const scenario of scenarios) {
  const items = rows.filter((r) => r.profile === profile && r.scenario === scenario.name);
  summary.push({
    profile, scenario: scenario.name,
    replayBaselineBytes: mean(items, 'replayBaselineBytes'), replayCandidateBytes: mean(items, 'replayCandidateBytes'),
    followBaselineBytes: mean(items, 'followBaselineBytes'), followCandidateBytes: mean(items, 'followCandidateBytes'),
    totalBaselineBytes: mean(items, 'baselineBytes'), totalCandidateBytes: mean(items, 'candidateBytes'),
    savedPercent: mean(items, 'savedPercent'), replaySavedPercent: mean(items, 'replaySavedPercent'),
    candidateReferences: mean(items, 'candidateReferences'),
    archivedIds: items[0].archivedIds,
    followUp: scenario.followUp === 'none' ? null : {
      baselineFromContext: items.reduce((sum, r) => sum + (r.followUp?.baselineFromContext ?? 0), 0) / items.length,
      baselineReread: items.reduce((sum, r) => sum + (r.followUp?.baselineReread ?? 0), 0) / items.length,
      candidateRecall: items.reduce((sum, r) => sum + (r.followUp?.candidateRecall ?? 0), 0) / items.length,
    },
  });
}
const out = {
  fixture: {files: files.map((f) => ({path: path.join(fixture, f), bytes: fs.statSync(path.join(fixture, f)).size}))},
  profiles, rows, summary,
  referenceMode: process.env.PI_CONTEXT_RESULT_REFERENCES,
  declaredTools: baseTools.map((tool) => tool.name),
  scope: 'Legacy synthetic native-read probe; the four-variant tool-output-replay.mjs is the rollout benchmark. End-to-end totals add a scripted follow-up request: candidate = replay + recall request/response; baseline = replay + ranged re-read, or replay alone when it answers from retained context. Shared requests occur only immediately before assistant messages, with Pi8 reference projection and actual tool declarations in both variants. Candidate declares recall_tool_output only after the store first holds a record. Three interleaved rounds, two profiles. Bytes are serialized request bodies, not billed tokens or live performance.',
};
return out;
} finally {
  globalThis.fetch = previousFetch;
  fs.rmSync(root, {recursive: true, force: true});
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const out = await runVaultWire();
const json = JSON.stringify(out, null, 2);
const flag = process.argv.indexOf('--json');
if (flag >= 0) fs.writeFileSync(process.argv[flag + 1], json);
for (const row of out.summary) {
  console.log(
    `${row.profile.padEnd(11)} ${row.scenario.padEnd(42)}` +
    ` replay ${Math.round(row.replayBaselineBytes)}->${Math.round(row.replayCandidateBytes)} (${row.replaySavedPercent.toFixed(1)}%)` +
    ` follow ${Math.round(row.followBaselineBytes)}->${Math.round(row.followCandidateBytes)}` +
    ` | END-TO-END ${Math.round(row.totalBaselineBytes)}->${Math.round(row.totalCandidateBytes)} (${row.savedPercent.toFixed(1)}%)`,
  );
}
console.log(json);
}
