'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const layout=require('../../assets/js/meld-layout');
const html=fs.readFileSync(require('node:path').join(__dirname,'../../index.html'),'utf8');
const source=html.slice(html.indexOf('        const validateGroup ='),html.indexOf('        const groupPoints ='));
const context={};vm.runInNewContext(source+';this.validate=validateGroup;',context);const validate=context.validate;
let serial=0;const tile=(val,color='blue')=>({id:String(++serial),val,color});
const run=(start,n,color='blue')=>Array.from({length:n},(_,i)=>tile(start+i,color));
const set=(val,n=3)=>['blue','red','black','orange'].slice(0,n).map(c=>tile(val,c));
const fixture=(hand,cols=13)=>({tiles:Object.fromEntries(hand.map(t=>[t.id,t])),slots:[...hand.map(t=>t.id),...Array(Math.max(0,cols-hand.length)).fill(null)]});
{
 const{tiles,slots}=fixture([...run(1,3),...set(9,4)]);
 const out=layout.separate(slots,13,tiles,validate),rec=layout.recognize(out,13,tiles,validate);
 assert.equal(out[3],null,'123 and 9999 must get an automatic gap');
 assert.deepEqual(rec.combos.map(c=>c.n),[3,4]);assert.equal(rec.valid.filter(Boolean).length,7);
 assert.deepEqual(out.filter(Boolean),slots.filter(Boolean),'no tile is lost or reordered');assert.strictEqual(layout.separate(out,13,tiles,validate),out,'normalization settles without a render loop');
}
{
 const{tiles,slots}=fixture([...run(1,3),...set(9,4),...run(5,3,'red'),...set(12)]);
 const rec=layout.recognize(slots,13,tiles,validate);assert.equal(rec.valid.filter(Boolean).length,13);
 assert.deepEqual(rec.combos.map(c=>c.n),[3,4,3,3]);assert.equal(rec.boundaries.filter(Boolean).length,3,'a full row still has visible separators');
 assert.deepEqual(layout.separate(slots,13,tiles,validate),slots);
}
{
 const{tiles,slots}=fixture(run(1,9));assert.deepEqual(layout.recognize(slots,13,tiles,validate).combos.map(c=>c.n),[9],'do not split a valid long run into three triples');
}
{
 const hand=[tile(9),tile(9),tile(9)],{tiles,slots}=fixture(hand);assert.equal(layout.recognize(slots,13,tiles,validate).valid.filter(Boolean).length,0,'duplicate colors cannot form a set');
 const joker={id:'joker',val:'☻',color:'black'},f=fixture([tile(1),joker,tile(3),...set(9,4)]);
 assert.deepEqual(layout.recognize(f.slots,13,f.tiles,validate).combos.map(c=>c.n),[3,4]);
}
{
 const hand=[...run(1,3),...set(9,4)],{tiles}=fixture(hand);const slots=[null,null,null,null,null,hand[0].id,hand[1].id,hand[2].id,...hand.slice(3).map(t=>t.id),null,null];
 const rec=layout.recognize(slots,7,tiles,validate);assert.equal(rec.valid[5],false,'a run cannot cross the shelf boundary');
}
console.log('PASS: adjacent 123 + 9999, full rows, long runs, joker rules, tile conservation, row boundaries and stable layout');
