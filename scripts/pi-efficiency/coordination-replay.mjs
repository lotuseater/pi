// Replay coordination policies using saved contexts and complete worker-run accounting.
// No provider call, historical command, or active-session mutation is performed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {stream} from '../../packages/ai/src/api/openai-completions.ts';
import {normalizeContext} from '../../packages/ai/src/utils/transcript.ts';
import {buildSessionContext} from '../../packages/coding-agent/src/core/session-manager.ts';
import {convertToLlm} from '../../packages/coding-agent/src/core/messages.ts';
import {createAllToolDefinitions} from '../../packages/coding-agent/src/core/tools/index.ts';
import {loadCorpus} from './tool-output-replay.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const model = {id:'coordination-replay',name:'Replay',provider:'study',api:'openai-completions',baseUrl:'https://replay.invalid/v1',reasoning:true,input:['text'],contextWindow:262144,maxTokens:64,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const tools = Object.values(createAllToolDefinitions('/replay/project')).filter(t=>['read','bash','edit','write','grep','find','ls'].includes(t.name)).map(t=>({name:t.name,description:t.description,parameters:structuredClone(t.parameters)}));
const text = value => [{type:'text',text:value}];
const call = (id,command) => ({role:'assistant',content:[{type:'toolCall',id,name:'bash',arguments:{command}}],api:model.api,provider:model.provider,model:model.id,usage,stopReason:'toolUse',timestamp:0});
const result = (id,value) => ({role:'toolResult',toolCallId:id,toolName:'bash',content:text(JSON.stringify(value)),isError:false,timestamp:0});

async function requestBytes(history) {
  const messages=convertToLlm(history).map(message=>{
    if(message.role!=='system')return message;
    const projected={...message};
    delete projected.toolsAdded;
    delete projected.toolsRemoved;
    return projected;
  });
  let bytes=0,requests=0;
  const response=await stream(model,normalizeContext({messages,tools}),{
    apiKey:'offline-stub',maxTokens:64,maxRetries:0,cacheRetention:'none',
    fetch:async(_url,init)=>{
      requests++;
      bytes=Buffer.byteLength(init.body);
      const wire=JSON.parse(init.body);
      assert.deepEqual(wire.tools.map(t=>t.function.name).sort(),tools.map(t=>t.name).sort());
      return new Response(`data: ${JSON.stringify({id:'stub',object:'chat.completion.chunk',created:0,model:model.id,choices:[{index:0,delta:{content:''},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    },
  }).result();
  assert.equal(requests,1);
  assert.notEqual(response.stopReason,'error',response.errorMessage);
  return bytes;
}

function workerContexts(worker) {
  const raw=fs.readFileSync(worker.snapshotPath);
  assert.equal(hash(raw),worker.sourceSha256,'worker snapshot changed');
  const records=raw.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  const entries=records.slice(1);
  const byId=new Map(entries.map(entry=>[entry.id,entry]));
  const selected=entries.filter(entry=>entry.type==='message' && entry.message.role==='assistant' &&
    Date.parse(entry.timestamp)>=worker.runStart*1000 && Date.parse(entry.timestamp)<=worker.runEnd*1000);
  assert.equal(selected.length,worker.observedResponses,`complete worker request accounting: ${worker.name}`);
  return selected.map(entry=>buildSessionContext(entries,entry.parentId,byId).messages);
}

export async function replayCoordination(input, parentFiles) {
  assert.equal(input.snapshotStateUnchanged,true);
  assert.equal(input.newModelInvocations,0);
  assert.ok(input.workers.length>1 && input.workers.length<=32);
  assert.equal(new Set(input.workers.map(w=>w.name)).size,input.workers.length);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('unexpected external request');};
  try {
    const workerUsage={};
    for(const field of ['input','output','total']){
      const values=input.workers.map(w=>w.reportedUsage[field]);
      workerUsage[field]=values.every(v=>typeof v==='number')?values.reduce((a,b)=>a+b,0):null;
    }
    let workerBytes=0,workerRequests=0;
    for(const worker of input.workers)for(const context of workerContexts(worker)){
      workerBytes+=await requestBytes(context);
      workerRequests++;
    }
    const results=[];
    const sources=[];
    for(const file of parentFiles){
      const parent=loadCorpus(file,1);
      sources.push(parent.source);
      const common=[...parent.contexts[0].messages,{role:'user',content:text('Collect the specified completed worker messages and decide what needs attention. Do not launch new work.'),timestamp:0}];
      const rows=[];
      for(const variant of ['individual-full','batched-full','grouped-compact','grouped-read-all']){
        const history=common.slice();
        let parentBytes=await requestBytes(history),parentRequests=1;
        if(variant==='individual-full'){
          for(const [index,worker] of input.workers.entries()){
            const id=`wait-${index}`;
            history.push(call(id,`pi-task wait ${worker.name} --json`),result(id,worker.baseline));
            parentBytes+=await requestBytes(history);
            parentRequests++;
          }
        } else {
          const value=variant==='batched-full'?input.workers.map(w=>w.baseline):input.grouped;
          const command=variant==='batched-full'?'Collect all specified pi-task wait JSON results in one local Bash invocation.':`pi-task wait-many ${input.workers.map(w=>w.name).join(' ')} --json --output /results/full.json`;
          history.push(call('wait-group',command),result('wait-group',value));
          parentBytes+=await requestBytes(history);
          parentRequests++;
          if(variant==='grouped-read-all'){
            history.push(call('read-full','cat /results/full.json'),result('read-full',input.fullGrouped));
            parentBytes+=await requestBytes(history);
            parentRequests++;
          }
        }
        rows.push({variant,parentBytes,parentRequests,workerBytes,workerRequests,totalBytes:parentBytes+workerBytes,totalRequests:parentRequests+workerRequests});
      }
      const baseline=rows[0];
      const strong=rows[1];
      for(const row of rows){
        row.totalBytesSavedPercent=100*(baseline.totalBytes-row.totalBytes)/baseline.totalBytes;
        row.totalRequestsSavedPercent=100*(baseline.totalRequests-row.totalRequests)/baseline.totalRequests;
        row.bytesSavedAgainstAlreadyBatchedPercent=100*(strong.totalBytes-row.totalBytes)/strong.totalBytes;
      }
      results.push({parentSha256:parent.source.sha256,rows});
    }
    return {formatVersion:1,results,sources,workerSourceHashes:input.workers.map(w=>w.sourceSha256),workerReportedUsage:workerUsage,workerRequests,workerBytes,newProviderCalls:0,
      scope:[
        'Four scripted coordination policies on identical saved contexts. Recorded worker work is identical and included in every policy, with its complete selected run reconstructed and counted once per scenario.',
        'The recorded worker responses must match transcript assistant boundaries exactly; missing accounting fails the benchmark. Provider-internal retries or unrecorded failed attempts are unavailable.',
        'Actual OpenAI-completions serialization with a stub fetch, fixed seven-tool declarations and current Pi reference projection. Historic configuration/tool registries are not fully reconstructable.',
        'Individual-full assumes one model turn between each final worker wait. Batched-full is the stronger existing single-call Bash baseline. Grouped-read-all charges an extra call and full artifact retransmission when summaries are insufficient.',
        'Worker input/output/total are provider-reported values. Cache categories absent from old logs remain unspecified. Byte counts are replay request bodies, not live token rate, compressed network bytes, model-choice frequency or task-quality evidence.',
        'No benefit is attributed to shorter briefs or changing worker behavior; worker traffic is held fixed. This experiment does not estimate the prevalence of avoidable polling in production.',
      ]};
  } finally {globalThis.fetch=originalFetch;}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const inputPath=args[args.indexOf('--input')+1],out=args[args.indexOf('--out')+1];
  assert.ok(args.includes('--input') && args.includes('--out'),'--input FILE --out FILE --parent SESSION...');
  const parents=args.flatMap((arg,index)=>arg==='--parent'?[args[index+1]]:[]);
  assert.ok(parents.length>=1 && parents.length<=8);
  const report=await replayCoordination(JSON.parse(fs.readFileSync(inputPath,'utf8')),parents);
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({scenarios:report.results.length,workerRequests:report.workerRequests,workerBytes:report.workerBytes,workerReportedUsage:report.workerReportedUsage,results:report.results}));
}
