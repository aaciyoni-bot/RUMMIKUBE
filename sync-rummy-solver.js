#!/usr/bin/env node
/* Copies functions/rummySolver.js into index.html between the RUMMY-SOLVER markers.
 *   node sync-rummy-solver.js          — sync
 *   node sync-rummy-solver.js --check  — exit 1 if the inline copy differs (pre-deploy) */
const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const src = fs.readFileSync(path.join(__dirname, 'functions', 'rummySolver.js'), 'utf8').replace(/\s+$/, '');
const re = /(<script id="rummy-solver">\n)([\s\S]*?)(\n?[ \t]*<\/script>\n[ \t]*<!-- RUMMY-SOLVER-END -->)/;
const m = html.match(re);
if (!m) { console.error('rummy-solver markers not found in index.html'); process.exit(1); }
if (process.argv.includes('--check')) {
  const same = m[2].replace(/\s+$/, '') === src;
  console.log(same ? 'rummy-solver: inline copy is in sync' : 'rummy-solver: inline copy DIFFERS — run `node sync-rummy-solver.js`');
  process.exit(same ? 0 : 1);
}
const out = html.replace(re, (all, a) => a + src + '\n    </script>\n    <!-- RUMMY-SOLVER-END -->');
if (out !== html) { fs.writeFileSync(htmlPath, out); console.log('index.html: rummy-solver block synced (' + src.length + ' chars)'); }
else console.log('index.html: rummy-solver block already in sync');
