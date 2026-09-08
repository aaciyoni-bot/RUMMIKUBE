'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const B=require('../functions/ramiBrain');
let id=0;const t=(v,c)=>({id:'tile'+id++,val:v,color:c});
const winningHand=()=>{const h=[];for(let v=1;v<=5;v++)for(const c of B.COLORS.slice(0,3))h.push(t(v,c));return h;};
const brain=()=>B.create({maxRounds:1,maxSimTurns:1,rnd:()=>0.5});
test('five triples can be rearranged into a winning 14-tile hand',()=>{
 const h=winningHand();assert.equal(B.bestPartition(h).melds.length,5);
 const drop=B.goOutTile(h);assert.ok(drop);assert.ok(B.bestPartition(h.filter(t=>t!==drop)).complete);
});
test('discard decision declares the rearranged win immediately',()=>{
 const h=winningHand();const d=brain().decideDiscard({hand:h,discard:[],players:{},me:'bot'},h);
 assert.equal(d.goOut,true);assert.equal(d.rest.length,14);assert.ok(B.bestPartition(d.rest).complete);
});
test('draw decision takes the exposed tile that completes the rearranged win',()=>{
 const h=winningHand(),top=h.pop();const d=brain().decideDraw({hand:h,discard:[top],players:{},me:'bot'});
 assert.equal(d.take,'discard');assert.ok(d.goOut);
});
test('ordinary one-leftover wins remain valid',()=>{
 const h=winningHand().slice(1);const junk=t(13,B.COLORS[3]);h.push(junk);
 const drop=B.goOutTile(h);assert.ok(drop);assert.ok(B.bestPartition(h.filter(t=>t!==drop)).complete);
});
test('returned winning discards agree with exhaustive checks on seeded near-complete hands',()=>{
 let seed=91;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let n=0;n<60;n++){
  const h=winningHand();for(let k=0;k<n%4;k++)h[Math.floor(rand()*15)]=t(1+Math.floor(rand()*13),B.COLORS[Math.floor(rand()*4)]);
  const expected=h.some((_,i)=>B.bestPartition(h.filter((_,j)=>i!==j)).complete);
  const drop=B.goOutTile(h);assert.equal(!!drop,expected,'fixture '+n);
  if(drop)assert.ok(B.bestPartition(h.filter(x=>x!==drop)).complete);
 }
});
