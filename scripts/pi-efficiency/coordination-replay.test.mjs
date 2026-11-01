import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after,test} from 'node:test';
import {replayCoordination} from './coordination-replay.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-coordination-replay-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const workers=['first','second'].map(name=>{
  const snapshotPath=path.join(root,`${name}.jsonl`);
  const entries=[
    {type:'session',version:3,id:name,timestamp:new Date(0).toISOString(),cwd:'/fixture'},
    {type:'message',id:'prior',parentId:null,timestamp:new Date(998).toISOString(),message:{role:'assistant',content:[{type:'text',text:'Prior run finished.'}],api:'openai-completions',provider:'study',model:'replay',stopReason:'stop',timestamp:998,usage:{input:50,output:5,cacheRead:0,cacheWrite:0,totalTokens:55,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}},
    {type:'message',id:'u',parentId:'prior',timestamp:new Date(1000).toISOString(),message:{role:'user',content:[{type:'text',text:'Complete the local check.'}],timestamp:1000}},
    {type:'message',id:'a',parentId:'u',timestamp:new Date(2000).toISOString(),message:{role:'assistant',content:[{type:'text',text:'Finished.'}],api:'openai-completions',provider:'study',model:'replay',stopReason:'stop',timestamp:2000,usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}},
  ];
  const raw=entries.map(e=>JSON.stringify(e)).join('\n')+'\n';
  fs.writeFileSync(snapshotPath,raw);
  return {name,snapshotPath,sourceSha256:createHash('sha256').update(raw).digest('hex'),runStart:1,runEnd:3,observedResponses:1,reportedUsage:{input:100,output:10,total:110},baseline:{session:name,status:'done',reply:'local result line\n'.repeat(200)}};
});
const input={workers,grouped:{status:'done',results:workers.map(w=>({session:w.name,status:'done',reply:'Finished.',truncated:true}))},fullGrouped:{status:'done',results:workers.map(w=>w.baseline)},snapshotStateUnchanged:true,newModelInvocations:0};

test('all worker requests and reported usage remain included in each policy',async()=>{
  const report=await replayCoordination(input,[workers[0].snapshotPath]);
  assert.equal(report.workerRequests,2);
  assert.deepEqual(report.workerReportedUsage,{input:200,output:20,total:220});
  for(const row of report.results[0].rows){
    assert.equal(row.workerRequests,2);
    assert.equal(row.totalRequests,row.parentRequests+2);
    assert.equal(row.totalBytes,row.parentBytes+report.workerBytes);
  }
  assert.deepEqual(report.results[0].rows.map(r=>r.parentRequests),[3,2,2,3]);
  assert.ok(report.results[0].rows[3].totalBytes>report.results[0].rows[2].totalBytes);
  assert.equal(report.newProviderCalls,0);
});

test('incomplete worker accounting fails instead of advertising partial savings',async()=>{
  const bad=structuredClone(input);
  bad.workers[1].observedResponses=2;
  const originalFetch=globalThis.fetch;
  await assert.rejects(()=>replayCoordination(bad,[workers[0].snapshotPath]),/complete worker request accounting/);
  assert.equal(globalThis.fetch,originalFetch);
});

test('missing reported worker usage is unknown while request bodies remain counted',async()=>{
  const unknown=structuredClone(input);
  unknown.workers[0].reportedUsage.total=null;
  const report=await replayCoordination(unknown,[workers[0].snapshotPath]);
  assert.equal(report.workerReportedUsage.total,null);
  assert.equal(report.workerRequests,2);
  assert.ok(report.workerBytes>0);
});
