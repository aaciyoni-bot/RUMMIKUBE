/* Row-local meld recognition. Layout changes never change the player's hand. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeldLayout = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function partition(ids, tiles, validate) {
    const dp = Array(ids.length + 1);
    dp[ids.length] = {covered: 0, count: 0, groups: []};
    for (let i = ids.length - 1; i >= 0; i--) {
      const tail = dp[i + 1];
      let best = {covered: tail.covered, count: tail.count, groups: [{start:i,end:i+1,valid:false}, ...tail.groups]};
      for (let end = i + 3; end <= Math.min(ids.length, i + 13); end++) {
        const group = ids.slice(i, end).map(id => tiles[id]);
        if (group.some(t => !t) || !validate(group)) continue;
        const next = dp[end], covered = end - i + next.covered, count = next.count + 1;
        // Cover the most tiles; keep a valid long run intact on ties.
        if (covered > best.covered || (covered === best.covered && count <= best.count))
          best = {covered, count, groups:[{start:i,end,valid:true}, ...next.groups]};
      }
      dp[i] = best;
    }
    return dp[0].groups;
  }
  function recognize(slots, cols, tiles, validate) {
    const valid = Array(slots.length).fill(false), boundaries = Array(slots.length).fill(false), groups = [], combos = [];
    for (let base = 0; base < slots.length; base += cols) {
      const limit = Math.min(base + cols, slots.length);
      for (let start = base; start < limit;) {
        if (slots[start] == null) { start++; continue; }
        let end = start + 1;
        while (end < limit && slots[end] != null) end++;
        const parts = partition(slots.slice(start,end), tiles, validate);
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p], from = start + part.start, to = start + part.end;
          const ids = slots.slice(from, to);
          groups.push({start:from,end:to,ids,valid:part.valid});
          if (p > 0 && (part.valid || parts[p-1].valid)) boundaries[from] = true;
          if (part.valid) {
            for (let k = from; k < to; k++) valid[k] = true;
            const numbers = ids.map(id => tiles[id].val).filter(v => v !== '☻');
            const set = numbers.length > 0 && numbers.every(v => v === numbers[0]);
            combos.push({label:set ? (ids.length === 4 ? 'רביעייה' : 'שלישייה') : 'רצף', n:ids.length});
          }
        }
        start = end;
      }
    }
    return {valid,boundaries,groups,combos};
  }
  function separate(slots, cols, tiles, validate) {
    const out = slots.slice(), rec = recognize(slots,cols,tiles,validate);
    // Right-to-left insertion preserves earlier indices and existing spacing.
    for (let i = slots.length - 1; i > 0; i--) {
      if (!rec.boundaries[i]) continue;
      const limit = Math.min((Math.floor(i / cols) + 1) * cols, out.length);
      let gap = limit - 1;
      while (gap > i && out[gap] != null) gap--;
      if (gap <= i) continue; // A full row gets a visible boundary instead.
      out.splice(gap,1); out.splice(i,0,null);
    }
    return out.every((id,i) => id === slots[i]) ? slots : out;
  }
  return {recognize,separate};
});
