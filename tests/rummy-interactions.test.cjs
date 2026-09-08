'use strict';
// Exercise the actual inline handlers with deterministic DOM, clock and Firebase adapters.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(process.env.RUMMY_HTML_PATH || require('node:path').join(__dirname, '../index.html'), 'utf8');
const tile = id => ({id, val: 7, color: 'red'});
function gesture({rack = [tile('a'), null, tile('b')], board = [], source = 'rack', target = null, group = false, turn = 10} = {}) {
  const listeners = new Map(), frames = new Map();
  let frameId = 0, hits = 0;
  const updates = [], errors = [];
  const dragged = source === 'rack' ? rack[0] : board[0].tiles[0];
  const drag = {type: group ? 'group' : 'single', tile: dragged, tiles: board[0]?.tiles,
    source, tileIndex: 0, groupId: board[0]?.id, turnStartedAt: turn, startX: 0, startY: 0};
  const ctx = {
    rack, board, dragData: drag, dragDataRef: {current: drag}, dragPosRef: {current: {}}, hoverRef: {current:null}, hintRef: {current:null},
    longPressTimer: {current:null}, tableState: {id:'test', currentTurn:'me', turnStartedAt:10, phase:'playing'},
    user:{uid:'me'}, hasDropped:true, srvAuth:true, startIdsSet:new Set(), startRackIds:new Set(board.flatMap(g => g.tiles.map(t=>t.id))),
    startTurnRack:rack, startTurnBoard:board, boardScale:1, hoverTarget:null, settleTmRef:{current:null},
    liveRef:{current:null}, FIRST_MELD_MIN:30,
    setRack: v=>{ctx.rack=v; updates.push('rack');}, setBoard:v=>{ctx.board=v; updates.push('board');},
    setDragData:v=>{ctx.dragData=v;}, setHoverTarget:v=>{ctx.hoverTarget=v;}, setInsertHint:()=>{},
    setSettleGid:()=>{}, flashError:m=>errors.push(m), showToast:()=>{}, playSnd:()=>{}, navigator:{},
    setTimeout:()=>1, clearTimeout:()=>{},
    requestAnimationFrame:f=>{frames.set(++frameId,f); return frameId;}, cancelAnimationFrame:id=>frames.delete(id),
    mapInsertAfterSelf:v=>v, boardInsertBeforeId:()=>null, autoSortRun:v=>v,
    newBoardGroup:tiles=>({id:'new-group',tiles}), spliceBefore:(b,_,g)=>b.push(g),
    window:{addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)},
    document:{getElementById:()=>null,elementFromPoint:()=>{hits++;return target ? {closest:()=>({getAttribute:()=>target})} : null;}},
    useEffect:f=>{ctx.cleanup=f();}
  };
  const start=html.indexOf('            useEffect(() => {',html.indexOf('/* ---------- מנוע גרירה'));
  const end=html.indexOf('\n\n',html.indexOf('}, [dragData,',start));
  vm.runInNewContext(html.slice(start,end),ctx);
  return {ctx, listeners, frames, updates, errors, hits:()=>hits,
    emit:async(n,e={clientX:5,clientY:5})=>{await listeners.get(n)?.(e);},
    frame:()=>{const pending=[...frames.values()];frames.clear();pending.forEach(f=>f());}};
}
test('dropping outside a destination preserves exact rack slots',async()=>{
  const g=gesture({rack:[null,tile('a'),tile('b')]});
  g.ctx.dragDataRef.current.tile= g.ctx.rack[1];g.ctx.dragDataRef.current.tileIndex=1;
  const before=JSON.stringify(g.ctx.rack);await g.emit('pointerup');
  assert.equal(JSON.stringify(g.ctx.rack),before);assert.equal(g.updates.length,0);
});
test('pointer cancellation cleans drag state without moving any tiles',async()=>{
  const g=gesture();await g.emit('pointermove');await g.emit('pointercancel');
  assert.equal(g.ctx.dragData,null);assert.equal(g.ctx.dragDataRef.current,null);
  assert.equal(g.frames.size,0);assert.equal(g.updates.length,0);
});
test('window blur cancels a drag',async()=>{const g=gesture();await g.emit('blur');assert.equal(g.ctx.dragDataRef.current,null);});
test('120 pointer events perform one hit test in a frame',async()=>{
  const g=gesture({target:'board-new'});
  for(let i=0;i<120;i++)await g.emit('pointermove',{clientX:i,clientY:i});
  assert.equal(g.hits(),0);assert.equal(g.frames.size,1);g.frame();assert.equal(g.hits(),1);
  assert.equal(g.ctx.dragPosRef.current.x,119);
});
test('full rack rejects a returning board tile without losing it',async()=>{
  const g=gesture({rack:[tile('a'),tile('b')],board:[{id:'g',tiles:[tile('c')]}],source:'board',target:'rack-slot-0'});
  const before=JSON.stringify([g.ctx.rack,g.ctx.board]);await g.emit('pointerup');
  assert.equal(JSON.stringify([g.ctx.rack,g.ctx.board]),before);assert.equal(g.errors.length,1);
});
test('partial capacity rejects a whole returning group atomically',async()=>{
  const g=gesture({rack:[tile('a'),null],board:[{id:'g',tiles:[tile('c'),tile('d')]}],source:'board',group:true,target:'rack-slot-1'});
  const before=JSON.stringify([g.ctx.rack,g.ctx.board]);await g.emit('pointerup');assert.equal(JSON.stringify([g.ctx.rack,g.ctx.board]),before);
});
test('rack swap keeps both tiles',async()=>{
  const g=gesture({target:'rack-slot-2'});await g.emit('pointerup');
  assert.equal(g.ctx.rack[0].id,'b');assert.equal(g.ctx.rack[2].id,'a');
});
test('valid rack-to-board drop conserves tiles and ignores duplicate pointerup',async()=>{
  const g=gesture({target:'board-new'});await g.emit('pointerup');await g.emit('pointerup');
  assert.equal(g.ctx.board.length,1);assert.equal(g.ctx.board[0].tiles[0].id,'a');assert.equal(g.ctx.rack[0],null);
  assert.equal(g.updates.length,2);
});
test('turn change during a drag cancels the stale move',async()=>{
  const g=gesture({target:'board-new',turn:9});await g.emit('pointerup');assert.equal(g.updates.length,0);
});
test('observer attaches once the loading screen is replaced by the board',()=>{
  let node=null, observed=0, deps;
  const ctx={loading:true,document:{getElementById:()=>node},ResizeObserver:class{observe(){observed++;}disconnect(){}},setFeltSize:()=>{},useEffect:(fn,d)=>{deps=d;fn();}};
  const from=html.lastIndexOf('            useEffect(() => {',html.indexOf('const ro = new ResizeObserver'));
  const to=html.indexOf('\n\n',from);
  const code=html.slice(from,to);vm.runInNewContext(code,ctx);const first=deps.slice();node={};ctx.loading=false;
  // React reruns an effect only when its declared dependencies change.
  ctx.useEffect=(fn,d)=>{if(d.some((v,i)=>!Object.is(v,first[i])))fn();};vm.runInNewContext(code,ctx);
  assert.equal(observed,1);
});
