// Replay acceptance checks use local saved output and a stub provider, never a model endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {after,test} from 'node:test';
import {runReplay} from './tool-output-replay.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-output-replay-test-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const out=path.join(root,'report.json');
const script=new URL('./tool-output-replay.mjs',import.meta.url);
async function createReport(output, options={}) {
  if(process.env.PI_REPLAY_IN_PROCESS==='1') {
    fs.writeFileSync(output,JSON.stringify(await runReplay(options)),{mode:0o600});
    return JSON.parse(fs.readFileSync(output,'utf8'));
  }
  const args=['--max-old-space-size=512',script.pathname,'--out',output];
  for(const file of options.corpora??[])args.push('--corpus',file);
  if(options.limit!==undefined)args.push('--limit',String(options.limit));
  if(options.includeSynthetic===false)args.push('--no-synthetic');
  const run=spawnSync(process.execPath,args,{
    encoding:'utf8',maxBuffer:2*1024*1024,timeout:120_000,killSignal:'SIGTERM',
    env:{...process.env,PI_CONTEXT_RESULT_REFERENCES:'1',PI_CONTEXT_READ_DELTAS:'0',PI_TOOL_VAULT:undefined},
  });
  assert.ifError(run.error);
  assert.equal(run.signal,null,`probe terminated by ${run.signal}`);
  assert.equal(run.status,0,run.stderr.slice(-6000));
  assert.ok(run.stdout.trim().length>0,'probe must emit its measured results');
  return JSON.parse(fs.readFileSync(output,'utf8'));
}
const report=await createReport(out);
const row=(name,variant)=>{
  const result=report.results.find(result=>result.name===name)?.rows.find(row=>row.variant===variant);
  assert.ok(result,`missing ${name}/${variant}`);
  return result;
};

test('every shared request is an assistant boundary, including autonomous tool rounds',()=>{
  for(const result of report.results) {
    assert.equal(result.requestBoundaries,19);
    for(const entry of result.rows) assert.equal(entry.requests,23+entry.retrievalRequests);
  }
  assert.equal(report.providerCalls,0);
  assert.equal(report.externalFetches,0);
  assert.deepEqual(report.toolNames,['read','bash','edit','write','grep','find','ls']);
});

test('small, failed and unmarked outputs are unchanged with no recall/schema overhead',()=>{
  for(const name of ['small-results','nonzero-failure','legacy-unmarked']) {
    const baseline=row(name,'baseline');
    for(const variant of ['archive','compact','both']) {
      const entry=row(name,variant);
      assert.equal(entry.totalBytes,baseline.totalBytes,`${name}/${variant}`);
      assert.equal(entry.references,0);
      assert.equal(entry.vaultRecords,0);
    }
  }
});

test('shell compaction saves bytes after recall and retransmission costs',()=>{
  for(const name of ['repetitive-success','scattered-warnings','carriage-return-progress']) {
    const compact=row(name,'compact');
    assert.ok(compact.compactResults>0,name);
    assert.ok(compact.totalBytes<row(name,'baseline').totalBytes,name);
    assert.equal(compact.retrievalRequests,1);
    assert.equal(compact.recallExact,true);
    assert.ok(compact.retrievalBytes>0 && compact.laterBytes>0);
  }
});

test('unique and long-line output stays intact in compact-only mode',()=>{
  for(const name of ['unique-success','unicode-long-line']) {
    assert.equal(row(name,'compact').totalBytes,row(name,'baseline').totalBytes,name);
    assert.equal(row(name,'compact').vaultRecords,0,name);
  }
});

test('retirement works within a single user turn and exact recall remains possible',()=>{
  const archive=row('unique-success','archive');
  assert.ok(archive.references>0);
  assert.ok(archive.totalBytes<row('unique-success','baseline').totalBytes);
  assert.equal(archive.compactResults,0);
  assert.equal(archive.recallExact,true);
});

test('reports expose scripted overhead and aggregate independently by corpus mode',()=>{
  assert.equal(report.aggregate.length,4);
  for(const aggregate of report.aggregate) {
    assert.equal(aggregate.mode,'synthetic');
    const rows=report.results.map(result=>result.rows.find(row=>row.variant===aggregate.variant));
    assert.equal(aggregate.totalBytes,rows.reduce((sum,row)=>sum+row.totalBytes,0));
  }
  assert.ok(report.scope.some(line=>line.includes('not a measured model retrieval rate')));
});

test('explicit corpus replay selects real assistant boundaries without repairing the source',async()=>{
  const corpus=path.join(root,'session.jsonl');
  const corpusOut=path.join(root,'corpus-report.json');
  const entries=[
    {type:'session',version:3,id:'fixture-session',timestamp:'2026-01-01T00:00:00.000Z',cwd:'/fixture'},
    {type:'message',id:'user',parentId:null,message:{role:'user',content:[{type:'text',text:'Inspect the fixture.'}],timestamp:0}},
    ...['a','b','c'].map((id,index)=>({type:'message',id,parentId:index===0?'user':['a','b'][index-1],message:{role:'assistant',content:[{type:'text',text:`Observed ${id}`}],api:'openai-completions',provider:'study',model:'replay',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:index+1}})),
  ];
  // No trailing newline: Pi's normal loader may repair this; replay must be read-only.
  const original=entries.map(entry=>JSON.stringify(entry)).join('\n');
  fs.writeFileSync(corpus,original);
  const corpusReport=await createReport(corpusOut,{corpora:[corpus],limit:2,includeSynthetic:false});
  assert.equal(fs.readFileSync(corpus,'utf8'),original);
  assert.deepEqual(corpusReport.sources[0].boundaryIds,['b','c']);
  assert.deepEqual(corpusReport.results.map(result=>result.mode),['historical','prospective']);
  for(const result of corpusReport.results) {
    assert.equal(result.requestBoundaries,2);
    for(const entry of result.rows) {
      assert.equal(entry.requests,6);
      assert.equal(entry.retrievalRequests,0);
      assert.equal(entry.totalBytes,result.rows[0].totalBytes);
    }
  }
});
