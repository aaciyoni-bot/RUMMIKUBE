(function (root) {
  'use strict';
  // The same inline brain runs in a disposable worker. Never run its 650ms
  // search on the rendering thread; constrained browsers get two short rollouts.
  function fallback(method, context, hand, signal) {
    if (signal && signal.aborted || !root.RamiBotBrain) return null;
    try {
      const brain = root.RamiBotBrain.create({ maxRounds: 2, maxSimTurns: 6 });
      return brain[method](Object.assign({}, context, { budgetMs: 40 }), hand);
    } catch (_) { return null; }
  }
  function decide(method, context, hand, signal) {
    if (!['decideDraw', 'decideDiscard'].includes(method)) return Promise.resolve(null);
    return new Promise(resolve => {
      let worker, url, timer, done = false;
      const finish = (result, useFallback) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abort);
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        resolve(useFallback ? fallback(method, context, hand, signal) : result);
      };
      const abort = () => finish(null, false);
      if (signal && signal.aborted) return abort();
      if (signal) signal.addEventListener('abort', abort, { once: true });
      try {
        const source = document.getElementById('rami-brain');
        if (typeof Worker === 'undefined' || !source) return finish(null, true);
        const code = source.textContent + '\nself.onmessage = function(e) { try { var d=e.data; var b=self.RamiBotBrain.create({}); self.postMessage({result:b[d.method](d.context,d.hand)}); } catch(err) { self.postMessage({error:true}); } };';
        url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        worker = new Worker(url);
        worker.onmessage = e => finish(e.data && e.data.result, !!(e.data && e.data.error));
        worker.onerror = () => finish(null, true);
        timer = setTimeout(() => finish(null, true), 2000);
        worker.postMessage({ method, context, hand });
      } catch (_) { finish(null, true); }
    });
  }
  root.RamiBotWorker = { decide };
})(window);
