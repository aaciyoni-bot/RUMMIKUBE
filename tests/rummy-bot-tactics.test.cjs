'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const B=require('../functions/ramiBrain');
const E=require('../functions/rummyEngine');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const ctx={bestPartition:B.bestPartition,validateGroup:B.validateGroup,FIRST_MELD_MIN:30,groupPoints:t=>t.reduce((s,t)=>s+(t.val==='☻'?0:t.val),0)};
const source=html.slice(html.indexOf('        const botFindMelds ='),html.indexOf('        const botSkillOf ='));
vm.runInNewContext(source+'\nthis.plan=botPlanMove;this.steal=botFindSteal;',ctx);
const [red,blue,black]=B.COLORS;
let n=0;const tile=(val,color)=>({id:'t'+n++,val,color});
function applyFallback(rack,board,plan) {
  assert.ok(plan,'must find a playable plan');
  const used=new Set([...plan.melds.flat(),...plan.exts.map(e=>e.tile)].map(t=>t.id));
  let rest=rack.filter(t=>!used.has(t.id));
  const result=board.map(g=>({...g,tiles:g.tiles.slice()}));
  for(const ext of plan.exts)result.find(g=>g.id===ext.groupId).tiles.push(ext.tile);
  for(const meld of plan.melds)result.push({id:'new'+n++,tiles:meld});
  for(let i=0;i<5;i++){
    const s=ctx.steal(rest,result);if(!s)break;
    result.find(g=>g.id===s.fromGroupId).tiles=s.rest;
    result.push({id:'borrow'+n++,tiles:s.meld});
    const ids=new Set(s.meld.map(t=>t.id));rest=rest.filter(t=>!ids.has(t.id));
  }
  assert.ok(result.every(g=>B.validateGroup(g.tiles)));
  assert.ok(E.validateMove(board,rack,result,rest,{hasDropped:true}).ok);
  return rest;
}
test('borrowing the end of an existing run can be the only winning move',()=>{
  const board=[{id:'run',tiles:[4,5,6,7].map(v=>tile(v,red))}];
  const rack=[tile(4,blue),tile(4,black)];
  assert.equal(applyFallback(rack,board,ctx.plan(rack,board,true)).length,0);
});
test('a final joker can extend a group and win',()=>{
  const board=[{id:'set',tiles:[red,blue,black].map(c=>tile(7,c))}];
  const rack=[tile('☻',red)];
  assert.equal(applyFallback(rack,board,ctx.plan(rack,board,true)).length,0);
});
test('borrowing is still forbidden before the initial meld',()=>{
  const board=[{id:'run',tiles:[4,5,6,7].map(v=>tile(v,red))}];
  assert.equal(ctx.plan([tile(4,blue),tile(4,black)],board,false),null);
});
test('an unplayable rack still draws instead of manufacturing a move',()=>{
  assert.equal(ctx.plan([tile(2,red)],[],true),null);
});
