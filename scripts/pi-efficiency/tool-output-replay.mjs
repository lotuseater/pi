// Offline request-body replay of output retirement and shell compaction. No historical commands run.
// PI_CONTEXT_RESULT_REFERENCES=1 node scripts/pi-efficiency/tool-output-replay.mjs --out report.json
// Add explicit --corpus SESSION.jsonl arguments; their paths and hashes stay in the private report.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stream} from '../../packages/ai/src/api/openai-completions.ts';
import {normalizeContext} from '../../packages/ai/src/utils/transcript.ts';
import {CONTEXT_REFERENCES_ENABLED} from '../../packages/coding-agent/src/core/context-references.ts';
import {convertToLlm} from '../../packages/coding-agent/src/core/messages.ts';
import {buildSessionContext} from '../../packages/coding-agent/src/core/session-manager.ts';
import {vaultReadOnlyResults} from '../../packages/coding-agent/src/core/tool-vault-projection.ts';
import {openToolVault, resolveToolVaultConfig} from '../../packages/coding-agent/src/core/tool-vault.ts';
import {createBashTool} from '../../packages/coding-agent/src/core/tools/bash.ts';
import {createAllToolDefinitions} from '../../packages/coding-agent/src/core/tools/index.ts';
import {createRecallTool} from '../../packages/coding-agent/src/core/tools/recall.ts';

const hash = text => createHash('sha256').update(text).digest('hex');
const baseModel = {id:'replay', name:'Replay', provider:'study', api:'openai-completions', baseUrl:'https://replay.invalid/v1', reasoning:true, input:['text'], contextWindow:262144, maxTokens:64, cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const variants = {
  baseline: {enabled:false, retireOldResults:false, compactShellOutput:false},
  archive: {enabled:true, retireOldResults:true, compactShellOutput:false},
  compact: {enabled:true, retireOldResults:false, compactShellOutput:true},
  both: {enabled:true, retireOldResults:true, compactShellOutput:true},
};
const textContent = text => [{type:'text',text}];
const user = text => ({role:'user',content:textContent(text),timestamp:0});
const assistant = (content, model = baseModel) => ({role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:content.some(b=>b.type==='toolCall')?'toolUse':'stop',timestamp:0});
const toolCall = (id, name, args, model) => assistant([{type:'toolCall',id,name,arguments:args}], model);
const resultMessage = (id, name, result) => ({role:'toolResult',toolCallId:id,toolName:name,isError:false,timestamp:0,...result});

/** Read an immutable snapshot; unlike the session loader, this never repairs a source file. */
export function loadCorpus(file, limit) {
  const bytes = fs.statSync(file).size;
  if (bytes > 64 * 1024 * 1024) throw Error(`Corpus exceeds the 64 MiB replay bound: ${file}`);
  const raw = fs.readFileSync(file);
  const records = raw.toString('utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(records[0]?.type, 'session', 'expected a Pi JSONL session');
  const entries = records.slice(1);
  const byId = new Map(entries.map(entry => [entry.id,entry]));
  const boundaries = entries.filter(e => e.type==='message' && e.message.role==='assistant').slice(-limit);
  assert.ok(boundaries.length>0,'corpus must contain at least one recorded assistant boundary');
  const contexts = boundaries.map(entry => ({
    messages:buildSessionContext(entries, entry.parentId, byId).messages,
    boundary:entry.id,
    model:{...baseModel,id:entry.message.model??'replay',provider:entry.message.provider??'study'},
  }));
  return {
    name:`corpus-${hash(raw).slice(0,12)}`, contexts,
    source:{path:path.resolve(file),sha256:hash(raw),bytes,boundaryIds:boundaries.map(e=>e.id)},
  };
}

async function savedBashResult(id, command, text, cwd, exitCode = 0) {
  // Operations replace command execution completely. The command is provenance, never executable.
  const tool = createBashTool(cwd, {operations:{exec:async (_command,_cwd,{onData})=>{
    onData(Buffer.from(text));
    return {exitCode};
  }}});
  const result = await tool.execute(id,{command},undefined);
  if (result.details?.fullOutputPath) fs.rmSync(result.details.fullOutputPath,{force:true});
  return resultMessage(id,'bash',result);
}

/** Mark only complete successful saved Bash output as a prospective new result, keeping text exact. */
async function prospectiveContexts(contexts, cwd) {
  const replacements = new Map();
  let marked = 0;
  const transformed = [];
  for (const context of contexts) {
    const calls = new Map();
    const messages = [];
    for (const message of context.messages) {
      if (message.role==='assistant') for (const block of message.content) {
        if (block.type==='toolCall') calls.set(block.id,block);
      }
      let next = message;
      const call = calls.get(message.toolCallId);
      if (message.role==='toolResult' && message.toolName==='bash' && !message.isError &&
          message.content.length===1 && message.content[0].type==='text' && call?.name==='bash' &&
          typeof call.arguments?.command==='string' && !message.details?.truncation?.truncated &&
          !message.details?.fullOutputPath && !message.content[0].text.includes('\0')) {
        const key = `${message.toolCallId}:${hash(message.content[0].text)}`;
        if (!replacements.has(key)) {
          const stamped = await savedBashResult(message.toolCallId,call.arguments.command,message.content[0].text,cwd);
          // Do not represent an already truncated saved output as a complete new command result.
          if (stamped.content[0].text===message.content[0].text && stamped.details?.piShellSnapshot?.complete) {
            replacements.set(key,{...message,details:stamped.details});
            marked++;
          } else replacements.set(key,message);
        }
        next = replacements.get(key);
      }
      messages.push(next);
    }
    transformed.push({...context,messages});
  }
  return {contexts:transformed,marked};
}

async function syntheticCases(cwd) {
  const repeated = 'worker waiting for local result\n'.repeat(420);
  const unique = Array.from({length:320},(_,i)=>`row=${i} evidence=${hash(String(i)).slice(0,32)}\n`).join('');
  const warnings = `${repeated}warning: keep this exact diagnostic αβ\n${repeated}`;
  const progress = `${Array.from({length:750},(_,i)=>`progress ${Math.floor(i/7.5)}%\r`).join('')}progress 100%\nwarning: preserve final evidence\n`;
  const specs = [
    ['repetitive-success',repeated,0],
    ['unique-success',unique,0],
    ['scattered-warnings',warnings,0],
    ['carriage-return-progress',progress,0],
    ['nonzero-failure',warnings,7],
    ['unicode-long-line','🙂漢字é'.repeat(900)+'\nkeep final line\n',0],
    ['small-results','one small result\n',0],
    ['legacy-unmarked',repeated,0],
  ];
  const cases = [];
  for (const [name,text,exitCode] of specs) {
    const messages = [user('Inspect these saved command outputs.')];
    const contexts = [{messages:messages.slice(),boundary:'initial',model:baseModel}];
    // A long autonomous run: one user instruction, eighteen completed tool rounds.
    for (let i=0;i<18;i++) {
      const id=`synthetic-${i}`;
      const command=`saved-fixture-${i}`;
      const result=await savedBashResult(id,command,text,cwd,exitCode);
      if (name==='legacy-unmarked') delete result.details?.piShellSnapshot;
      messages.push(toolCall(id,'bash',{command}),result);
      contexts.push({messages:messages.slice(),boundary:`after-${i}`,model:baseModel});
    }
    cases.push({name,mode:'synthetic',contexts,marked:0,source:null});
  }
  return cases;
}

function declarations(cwd) {
  const defs=createAllToolDefinitions(cwd);
  return ['read','bash','edit','write','grep','find','ls'].map(name=>{
    const tool=defs[name];
    return {name:tool.name,description:tool.description,parameters:structuredClone(tool.parameters)};
  });
}

async function serialize(messages, tools, model) {
  let body;
  let fetches=0;
  // Historic system messages can carry tool-registration deltas. The controlled baseline fixes
  // today's seven declarations, so retain all instruction text but exclude those registry edits.
  const normalizedMessages=convertToLlm(messages).map(message=>{
    if(message.role!=='system')return message;
    const withoutToolChanges={...message};
    delete withoutToolChanges.toolsAdded;
    delete withoutToolChanges.toolsRemoved;
    return withoutToolChanges;
  });
  const answer=await stream(model,normalizeContext({messages:normalizedMessages,tools}),{
    apiKey:'offline-stub',maxTokens:64,maxRetries:0,cacheRetention:'none',
    fetch:async(_url,init)=>{
      fetches++;
      body=init.body;
      return new Response(`data: ${JSON.stringify({id:'stub',object:'chat.completion.chunk',created:0,model:model.id,choices:[{index:0,delta:{content:''},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    },
  }).result();
  assert.equal(fetches,1);
  assert.notEqual(answer.stopReason,'error',answer.errorMessage);
  const wire=JSON.parse(body);
  assert.deepEqual(wire.tools.map(tool=>tool.function.name).sort(),tools.map(tool=>tool.name).sort(),'serializer must use exactly the controlled tool declarations');
  return Buffer.byteLength(body);
}

async function replayCase(dataset, variant, root, cwd, baseTools) {
  const started=performance.now();
  const cpuStart=process.cpuUsage();
  const dir=path.join(root,`${dataset.name}-${dataset.mode}-${variant}`);
  const config=resolveToolVaultConfig({...variants[variant],dir,minBytes:8192,keepRecentResults:10,minUserTurnsOld:0,minAssistantTurnsOld:2},{},dir);
  const vault=openToolVault({config,identity:()=>`${dataset.name}-${dataset.mode}`});
  const recall=createRecallTool(cwd,{vault});
  const stats={variant,sharedBytes:0,verificationBytes:0,retrievalBytes:0,laterBytes:0,requests:0,retrievalRequests:0,references:0,compactResults:0,referenceBearingRequests:0};
  const project=messages=>{
    const recallAvailable=config.enabled && vault.hasStoredRecords();
    const projected=vaultReadOnlyResults(messages,{vault,recallAvailable,archiveAllowed:true,sessionId:dataset.name});
    const tools=recallAvailable?[...baseTools,{name:recall.name,description:recall.description,parameters:structuredClone(recall.parameters)}]:baseTools;
    let references=0;
    for (const message of projected) if(message.role==='toolResult' && message.details?.piToolVaultRecord) {
      references++;
      assert.ok(tools.some(tool=>tool.name==='recall_tool_output'),'a reference requires retrieval in the same request');
      if (message.details.piToolVaultRecord.projection==='shell') stats.compactResults++;
    }
    stats.references+=references;
    if(references)stats.referenceBearingRequests++;
    return {projected,tools};
  };
  for (const context of dataset.contexts) {
    const {projected,tools}=project(context.messages);
    stats.sharedBytes+=await serialize(projected,tools,context.model);
    stats.requests++;
  }
  const last=dataset.contexts.at(-1);
  if (!last) return {...stats,totalBytes:0,vaultRecords:0,recallExact:false};
  const history=last.messages.slice();
  // Pick the same requested evidence in every variant, before considering what each projection hid.
  const successfulText=last.messages.filter(message=>message.role==='toolResult' && !message.isError && message.content.length===1 && message.content[0].type==='text');
  const large=successfulText.filter(message=>Buffer.byteLength(message.content[0].text)>=8192 && !message.details?.truncation?.truncated && !message.details?.fullOutputPath);
  const target=large.find(message=>message.toolName==='bash')??large[0]??successfulText[0];
  history.push(assistant(textContent('Completed the recorded replay segment.'),last.model),user(
    target?`Quote historical lines 1-20 from tool result ${target.toolCallId}; preserve its exact diagnostic text.`:'Continue reviewing the saved evidence.',
  ));
  const verification=project(history);
  stats.verificationBytes+=await serialize(verification.projected,verification.tools,last.model);
  stats.requests++;
  const hidden=verification.projected.find(message=>message.role==='toolResult' && message.toolCallId===target?.toolCallId && message.details?.piToolVaultRecord);
  let recalledId;
  if(hidden) {
    recalledId=hidden.details.piToolVaultRecord.id;
    const args={id:recalledId,offset:1,limit:20};
    const answer=await recall.execute('replay-recall',args,undefined);
    assert.ok(!answer.isError,'archived evidence must be retrievable');
    const lookup=vault.lookup(recalledId);
    assert.ok(lookup.ok);
    const expected=lookup.record.text.split('\n').slice(0,20).join('\n');
    assert.ok(answer.content[0].text.endsWith(expected),'recalled lines must exactly match durable output');
    history.push(toolCall('replay-recall','recall_tool_output',args,last.model),resultMessage('replay-recall','recall_tool_output',answer));
    const {projected,tools}=project(history);
    stats.retrievalBytes+=await serialize(projected,tools,last.model);
    stats.requests++;
    stats.retrievalRequests++;
  }
  // Both variants receive the same question and answer; recall is charged only if its target is hidden.
  // Three later requests count retransmission of the recalled content and its call/schema.
  for(let i=0;i<3;i++) {
    const answer=i===0 && target?`Requested historical lines:\n${target.content[0].text.split('\n').slice(0,20).join('\n')}`:'Recorded the historical evidence.';
    history.push(assistant(textContent(answer),last.model),user(`Continue the evidence review, step ${i+1}.`));
    const {projected,tools}=project(history);
    stats.laterBytes+=await serialize(projected,tools,last.model);
    stats.requests++;
  }
  const cpu=process.cpuUsage(cpuStart);
  return {...stats,totalBytes:stats.sharedBytes+stats.verificationBytes+stats.retrievalBytes+stats.laterBytes,vaultRecords:vault.usage().records,recallExact:hidden?true:null,recalledId,localWallMs:performance.now()-started,localCpuMs:(cpu.user+cpu.system)/1000};
}

/** Run bounded replay and write only hashes and measurements, never captured conversation text. */
export async function runReplay({corpora=[],limit=30,includeSynthetic=true}={}) {
  assert.ok(CONTEXT_REFERENCES_ENABLED,'Run with PI_CONTEXT_RESULT_REFERENCES=1 to match installed Pi8');
  assert.notEqual(process.env.PI_CONTEXT_READ_DELTAS,'1','The installed baseline has changed-read deltas disabled');
  assert.equal(process.env.PI_TOOL_VAULT,undefined,'Unset PI_TOOL_VAULT: variants control the master switch');
  assert.ok(Number.isInteger(limit) && limit>=1 && limit<=200,'limit must be 1..200 request boundaries');
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('External network forbidden by offline replay');};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-output-replay-'));
  const cwd='/replay/project';
  const baseTools=declarations(cwd);
  const results=[];
  const sources=[];
  try {
    const consume=async(dataset)=>{
      const rows=[];
      for(const variant of Object.keys(variants)) rows.push(await replayCase(dataset,variant,root,cwd,baseTools));
      const baseline=rows[0].totalBytes;
      for(const row of rows) row.savedPercent=baseline?100*(baseline-row.totalBytes)/baseline:0;
      results.push({name:dataset.name,mode:dataset.mode,marked:dataset.marked,requestBoundaries:dataset.contexts.length,rows});
    };
    if(includeSynthetic) for(const dataset of await syntheticCases(cwd)) await consume(dataset);
    for(const file of corpora) {
      const dataset=loadCorpus(file,limit);
      sources.push(dataset.source);
      await consume({...dataset,mode:'historical',marked:0});
      const prospective=await prospectiveContexts(dataset.contexts,cwd);
      await consume({...dataset,...prospective,mode:'prospective'});
    }
    const aggregate=[];
    for(const mode of ['synthetic','historical','prospective']) {
      const cases=results.filter(result=>result.mode===mode);
      if(!cases.length)continue;
      for(const variant of Object.keys(variants)) {
        const selected=cases.map(c=>c.rows.find(row=>row.variant===variant));
        const totalBytes=selected.reduce((sum,row)=>sum+row.totalBytes,0);
        const baselineBytes=cases.reduce((sum,c)=>sum+c.rows[0].totalBytes,0);
        aggregate.push({mode,variant,cases:cases.length,totalBytes,baselineBytes,savedPercent:100*(baselineBytes-totalBytes)/baselineBytes,requests:selected.reduce((sum,row)=>sum+row.requests,0),retrievalRequests:selected.reduce((sum,row)=>sum+row.retrievalRequests,0)});
      }
    }
    return {
      formatVersion:1,variants,config:{minBytes:8192,keepRecentResults:10,minAssistantTurnsOld:2,minUserTurnsOld:0},
      toolNames:baseTools.map(tool=>tool.name),toolDeclarationsSha256:hash(JSON.stringify(baseTools)),sources,results,aggregate,
      peakRssMiB:process.resourceUsage().maxRSS/1024,providerCalls:0,externalFetches:0,
      scope:[
        'Actual pi-ai OpenAI-completions serializer, installed Pi8 reference projection and seven tool declarations; vault disabled is baseline.',
        'Each corpus is an immutable read, latest N recorded assistant request boundaries; buildSessionContext reconstructs branches and compactions. Provider retries and compaction-generation requests are unavailable and not invented.',
        'Historical mode never fabricates metadata. Prospective mode simulates eligible saved Bash text arriving from new built-in results with fake operations; commands are never run. Existing unmarked results do not gain retirement after install.',
        'Historic model/tool choices and outputs remain fixed. Seven-tool availability is held fixed: system-message toolsAdded/toolsRemoved registry deltas are excluded, instruction text is retained, and actual serialized declaration names are asserted. This does not reconstruct the full historical extension/configuration state.',
        'After recorded boundaries, every variant gets the same scripted verification question about one selected successful result (prefer first large complete Bash output). Only a variant hiding that result pays a 20-line recall request. Three later common requests contain the same scripted answer and any recalled output. This is a retrieval stress scenario, not a measured model retrieval rate.',
        'Counts are complete JSON request-body bytes, not provider tokens, transport bytes including HTTP framing, live rate, useful-work throughput, or task quality. Synthetic and real-corpus totals stay separate.',
        'Local wall/CPU times include projection, archive integrity I/O, and stub serialization; variants run in fixed order on a shared host. They are diagnostic resource measurements, not a controlled speed comparison.',
      ],
    };
  } finally {
    globalThis.fetch=previousFetch;
    fs.rmSync(root,{recursive:true,force:true});
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const corpora=[];
  let out,limit=30,includeSynthetic=true;
  for(let i=2;i<process.argv.length;i++) {
    const arg=process.argv[i];
    if(arg==='--corpus')corpora.push(process.argv[++i]);
    else if(arg==='--out'||arg==='--json')out=process.argv[++i];
    else if(arg==='--limit')limit=Number(process.argv[++i]);
    else if(arg==='--no-synthetic')includeSynthetic=false;
    else throw Error(`Unknown argument: ${arg}`);
  }
  const report=await runReplay({corpora,limit,includeSynthetic});
  if(out)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  for(const row of report.aggregate)console.log(`${row.mode} ${row.variant}: ${row.totalBytes} bytes, ${row.requests} requests, ${row.savedPercent.toFixed(2)}% saved`);
  if(!out)console.log(JSON.stringify(report,null,2));
}
