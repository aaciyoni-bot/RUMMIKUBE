'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const start=html.indexOf('        const solveRummyOffThread =');
const end=html.indexOf('        const botFindMelds',start);
function setup(mode='ok') {
  let worker, timer, terminated=0, revoked=0, cleared=0;
  const ctx={AbortController,Blob,document:{getElementById:()=>({textContent:'/* solver */'})},
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>revoked++},
    setTimeout:f=>{timer=f;return 1;},clearTimeout:()=>cleared++,
    Worker:class{constructor(){if(mode==='throw')throw Error('Worker blocked');worker=this;}postMessage(data){this.sent=data;}terminate(){terminated++;}}};
  if(mode==='unsupported')ctx.Worker=undefined;
  vm.runInNewContext(html.slice(start,end)+'\nthis.solve = solveRummyOffThread;',ctx);
  return {ctx,worker:()=>worker,timeout:()=>timer(),counts:()=>({terminated,revoked,cleared})};
}
test('worker returns result and releases resources',async()=>{
  const s=setup();const p=s.ctx.solve([{id:'b'}],[{id:'r'}]);
  assert.equal(s.worker().sent.board[0].id,'b');const result={groups:[],placed:[]};
  s.worker().onmessage({data:result});assert.equal(await p,result);assert.deepEqual(s.counts(),{terminated:1,revoked:1,cleared:1});
});
test('slow solver terminates and falls back without a synchronous solve',async()=>{
  const s=setup();const p=s.ctx.solve([],[]);s.timeout();assert.equal(await p,null);assert.equal(s.counts().terminated,1);
});
test('turn cleanup aborts pending work and ignores late results',async()=>{
  const s=setup();const c=new AbortController();const p=s.ctx.solve([],[],c.signal);c.abort();s.worker().onmessage({data:{placed:['late']}});
  assert.equal(await p,null);assert.equal(s.counts().terminated,1);
});
test('worker errors fall back',async()=>{const s=setup();const p=s.ctx.solve([],[]);s.worker().onerror();assert.equal(await p,null);});
test('unsupported workers retain the heuristic fallback',async()=>{const s=setup('unsupported');assert.equal(await s.ctx.solve([],[]),null);});
test('construction failures revoke the blob URL',async()=>{const s=setup('throw');assert.equal(await s.ctx.solve([],[]),null);assert.equal(s.counts().revoked,1);});
