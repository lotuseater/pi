// Native-tool and actual SDK wire comparison. Existing Node probe workflow; no provider traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const repo=new URL('../../',import.meta.url).pathname;
const root=fs.mkdtempSync('/tmp/pi-listrefs-wire-');
const current=repo+'/packages/coding-agent/src';
const {stream}=await import(repo+'/packages/ai/src/api/openai-completions.ts');
const {normalizeContext}=await import(repo+'/packages/ai/src/utils/transcript.ts');
// Pi7 bypasses these two tool names completely. This exact-output-only baseline does the same.
const baseProjection=messages=>messages;
const candidateProjection=(await import(current+'/core/context-references.ts')).referenceReadOnlyResults;
const fixture=root+'/tree';fs.mkdirSync(fixture,{recursive:true});
for(let i=0;i<1600;i++){let p=fixture+`/file_${String(i).padStart(5,'0')}_synthetic_configuration_record.ts`;if(!fs.existsSync(p))fs.writeFileSync(p,'export const synthetic = true;\n');}
const model={id:'synthetic',name:'Synthetic',provider:'study',api:'openai-completions',baseUrl:'https://synthetic.invalid/v1',reasoning:false,input:['text'],contextWindow:131072,maxTokens:32,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const clean=r=>{const x=structuredClone(r);if(x.details){delete x.details.piReadOnlySnapshot;if(!Object.keys(x.details).length)x.details=undefined;}return x;};
const hash=s=>createHash('sha256').update(s).digest('hex');
globalThis.fetch=async()=>{throw Error('External network forbidden');};
const cases=[['ls-repeat','ls',[{},{},{}]],['find-narrow-repeat','find',[{pattern:'file_000*.ts'},{pattern:'file_000*.ts'},{pattern:'file_000*.ts'}]],['find-repeat','find',[{pattern:'*.ts'},{pattern:'*.ts'},{pattern:'*.ts'}]],['find-byte-limit','find',[{pattern:'*.ts',limit:2000},{pattern:'*.ts',limit:2000},{pattern:'*.ts',limit:2000}]],['mixed-limits','ls',[{limit:100},{limit:500},{limit:100},{limit:200}]],['forced-full','ls',[{},{force:true},{}]],['different-query','find',[{pattern:'*.ts'},{pattern:'*.json'},{pattern:'*.ts'}]]];
const rows=[], captures=[];
const toolsByVariant={};
for(const variant of ['baseline','candidate']){const dir=current,ext='ts',tools={};for(const name of ['ls','find']){const m=await import(`${dir}/core/tools/${name}.${ext}`);tools[name]=m[name==='ls'?'createLsTool':'createFindTool'](fixture);}toolsByVariant[variant]=tools;}
for(let round=0;round<3;round++) for(const [name,tool,args] of cases){
 const captureStart=performance.now(),messages=[];
 for(const [i,a] of args.entries()){const result=await toolsByVariant.candidate[tool].execute(`case-${i}`,a,undefined);messages.push({role:'assistant',content:[{type:'toolCall',id:`case-${i}`,name:tool,arguments:a}],api:model.api,provider:model.provider,model:model.id,usage,stopReason:'toolUse',timestamp:0},{role:'toolResult',toolCallId:`case-${i}`,toolName:tool,...result,isError:false,timestamp:0});}
 captures.push({round,name,wallMs:performance.now()-captureStart,actualSearches:args.length,outputHashes:messages.filter(m=>m.role==='toolResult').map(m=>hash(m.content[0].text))});
 for(const variant of round%2?['candidate','baseline']:['baseline','candidate']){
  const projection=variant==='baseline'?baseProjection:candidateProjection;
  const declarations=Object.values(toolsByVariant[variant]).map(({name,description,parameters})=>{const schema=structuredClone(parameters);if(variant==='baseline')delete schema.properties.force;return {name,description,parameters:schema};});
  const start=performance.now(),cpu=process.cpuUsage(),raw=JSON.stringify(messages),projected=projection(messages,{readDeltas:false});assert.equal(JSON.stringify(messages),raw);
  let body,fetches=0;const result=await stream(model,normalizeContext({systemPrompt:'Synthetic directory evidence.',messages:projected,tools:declarations}),{apiKey:'not-secret-synthetic',maxTokens:32,maxRetries:0,cacheRetention:'none',fetch:async(_url,init)=>{fetches++;body=init.body;return new Response('data: '+JSON.stringify({id:'stub',object:'chat.completion.chunk',created:0,model:model.id,choices:[{index:0,delta:{content:''},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}}).result();assert.equal(fetches,1);assert.notEqual(result.stopReason,'error',result.errorMessage);
  const wire=JSON.parse(body),anchors=new Map();let references=0;
  for(const [i,m] of wire.messages.filter(m=>m.role==='tool').entries()){const a=m.content.match(/^\[Pi snapshot ([a-f0-9]{64}): full [^\n]*\]\n/);if(a){anchors.set(a[1],m.content.slice(a[0].length));assert.equal(anchors.get(a[1]),messages[i*2+1].content[0].text);}if(m.content.startsWith('[Unchanged ')){const id=m.content.match(/full Pi snapshot ([a-f0-9]{64})/)[1];assert.equal(anchors.get(id),messages[i*2+1].content[0].text);references++;}}
  const used=process.cpuUsage(cpu);rows.push({round,variant,name,requestBytes:Buffer.byteLength(body),requestHash:hash(body),references,wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000});
 }
}
const pss=Number(fs.readFileSync('/proc/self/smaps_rollup','utf8').match(/^Pss:\s+(\d+)/m)[1]);
const summary=cases.map(([name])=>{const b=rows.filter(x=>x.name===name&&x.variant==='baseline'),c=rows.filter(x=>x.name===name&&x.variant==='candidate');return {name,rounds:b.map((x,i)=>({baselineBytes:x.requestBytes,candidateBytes:c[i].requestBytes,savedPercent:100*(x.requestBytes-c[i].requestBytes)/x.requestBytes,candidateReferences:c[i].references}))};});
const out={fixture:{files:1600,fileBytes:1600*30,path:fixture},rows,summary,captures,peakRssMiB:process.resourceUsage().maxRSS/1024,pssKiB:pss,externalNetwork:0,modelCalls:0,scope:'Each actual candidate-tool execution is captured once, then identical emitted text+metadata is compared under Pi7 ls/find-bypass equivalent versus candidate8 projections in three interleaved same-process rounds; actual optional native ls/find tool declarations included, SDK normalizer/serializer with stub SSE. Process startup and setup outside per-case wall time; /usr/bin/time log includes them. Local timings under shared load, cache warm, not a performance claim. Default four coding tools do not include ls/find => zero direct gain for that tool set.'};
fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(out,null,2));
