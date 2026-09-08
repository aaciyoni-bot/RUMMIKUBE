/* Small, dependency-free game cues. Audio never participates in game state. */
(function (w) {
  'use strict';
  let context, unlocked = false, volume = .45, muted = false;
  const active = new Set(), last = new Map(), subscribers = new Set();
  try {
    const saved = JSON.parse(w.localStorage.getItem('rummiAudio') || 'null');
    if (saved) { muted = saved.muted === true; if (Number.isFinite(saved.volume)) volume = Math.max(0, Math.min(1, saved.volume)); }
  } catch (_) {}
  const settings = () => ({volume, muted});
  function syncLegacy() {
    try {
      if (w.Tone?.Destination) {
        w.Tone.Destination.mute = muted || volume === 0 || w.document.hidden;
        w.Tone.Destination.volume.value = volume > 0 ? 20 * Math.log10(volume) : -60;
      }
    } catch (_) {}
  }
  function setSettings(next) {
    if (typeof next.muted === 'boolean') muted = next.muted;
    if (Number.isFinite(next.volume)) volume = Math.max(0, Math.min(1, next.volume));
    if (muted || volume === 0) for (const source of active) { try { source.stop(); } catch (_) {} }
    try { w.localStorage.setItem('rummiAudio', JSON.stringify(settings())); } catch (_) {}
    syncLegacy();
    subscribers.forEach(fn => fn(settings()));
  }
  function unlock() {
    try {
      const Audio = w.AudioContext || w.webkitAudioContext;
      if (!Audio) return;
      if (!context) context = new Audio();
      unlocked = true;
      if (context.state === 'suspended') context.resume().catch(() => {});
    } catch (_) {}
  }
  w.addEventListener('pointerdown', unlock, {passive:true});
  w.addEventListener('keydown', unlock, {passive:true});
  const cues = {
    tile: [[320,0,.065]], check: [[320,0,.065],[280,.1,.06]], deal: [[600,0,.045],[420,.08,.055]], draw: [[600,0,.045],[420,.045,.055]],
    turn: [[660,0,.10],[880,.13,.14]], warning: [[660,0,.09]],
    win: [[523,0,.13],[659,.13,.13],[784,.26,.20]]
  };
  function play(name) {
    if (!unlocked || !context || context.state !== 'running' || muted || volume === 0 || w.document.hidden || !cues[name]) return;
    const now = context.currentTime;
    if (now - (last.get(name) ?? -Infinity) < .12 || active.size >= 12) return;
    last.set(name, now);
    for (const [hz, delay, duration] of cues[name]) {
      try {
        const osc = context.createOscillator(), gain = context.createGain();
        osc.type = name === 'tile' ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(hz, now + delay);
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(volume * .12, now + delay + .006);
        gain.gain.exponentialRampToValueAtTime(.0001, now + delay + duration);
        osc.connect(gain); gain.connect(context.destination); active.add(osc);
        osc.onended = () => {active.delete(osc); osc.disconnect(); gain.disconnect();};
        osc.start(now + delay); osc.stop(now + delay + duration + .01);
      } catch (_) {}
    }
  }
  w.document.addEventListener('visibilitychange', () => {
    syncLegacy();
    if (w.document.hidden) for (const source of active) { try {source.stop();} catch (_) {} }
  });
  syncLegacy();
  w.GameAudio = {play, supports: name => Object.prototype.hasOwnProperty.call(cues,name), settings, setSettings, subscribe(fn) {subscribers.add(fn); return () => subscribers.delete(fn);}};
})(window);
