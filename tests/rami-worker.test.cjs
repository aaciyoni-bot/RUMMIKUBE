'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const B = require('../functions/ramiBrain');
const brainSource = fs.readFileSync(path.join(__dirname, '../functions/ramiBrain.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/rami-worker.js'), 'utf8');
function setup(mode) {
  let worker, blob, timer, terminated = 0, revoked = 0, fallbackCalls = 0;
  const context = {
    AbortController, Blob,
    window: { RamiBotBrain: { create(options) { fallbackCalls++; assert.equal(options.maxRounds, 2); return B.create(options); } } },
    document: { getElementById: () => ({ textContent: brainSource }) },
    URL: { createObjectURL(b) { blob = b; return 'blob:test'; }, revokeObjectURL() { revoked++; } },
    setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {},
    Worker: mode === 'unsupported' ? undefined : class {
      constructor() { worker = this; }
      postMessage(message) { this.message = structuredClone(message); }
      terminate() { terminated++; }
    }
  };
  vm.runInNewContext(source, context);
  return { decide: context.window.RamiBotWorker.decide, worker: () => worker, blob: () => blob,
    timeout: () => timer(), counts: () => ({ terminated, revoked, fallbackCalls }) };
}
function winning() {
  const hand = [];
  for (let v = 1; v <= 5; v++) for (const c of B.COLORS.slice(0, 3)) hand.push({ id: v + c, val: v, color: c });
  return hand;
}
test('actual worker source preserves the winning discard and all 15 tile IDs', async () => {
  const s = setup(), h = winning();
  const pending = s.decide('decideDiscard', { hand: h, discard: [], players: {}, me: 'bot', budgetMs: 650 }, h);
  assert.equal(s.counts().fallbackCalls, 0, 'no synchronous brain on normal path');
  const workerContext = { self: { postMessage: data => s.worker().onmessage({ data: structuredClone(data) }) } };
  vm.runInNewContext(await s.blob().text(), workerContext);
  workerContext.self.onmessage({ data: s.worker().message });
  const result = await pending;
  assert.equal(result.goOut, true);
  assert.equal(result.rest.length, 14);
  assert.ok(B.bestPartition(result.rest).complete);
  assert.deepEqual([...result.rest, result.drop].map(t => t.id).sort(), h.map(t => t.id).sort());
  assert.deepEqual(s.counts(), { terminated: 1, revoked: 1, fallbackCalls: 0 });
});
test('leaving the turn aborts the worker, ignores a late answer and never starts fallback', async () => {
  const s = setup(), controller = new AbortController();
  const p = s.decide('decideDraw', {}, undefined, controller.signal);
  controller.abort();
  s.worker().onmessage({ data: { result: { take: 'discard' } } });
  assert.equal(await p, null);
  assert.deepEqual(s.counts(), { terminated: 1, revoked: 1, fallbackCalls: 0 });
});
test('worker deadline terminates heavy search and retains a legal immediate win', async () => {
  const s = setup(), h = winning();
  const p = s.decide('decideDiscard', { hand: h, discard: [], players: {}, me: 'bot' }, h);
  s.timeout();
  assert.equal((await p).goOut, true);
  assert.deepEqual(s.counts(), { terminated: 1, revoked: 1, fallbackCalls: 1 });
});
test('unsupported workers use only the reduced fallback budget', async () => {
  const s = setup('unsupported'), h = winning(), top = h.pop();
  assert.equal((await s.decide('decideDraw', { hand: h, discard: [top], players: {}, me: 'bot' })).take, 'discard');
  assert.equal(s.counts().fallbackCalls, 1);
});
