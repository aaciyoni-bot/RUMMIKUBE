#!/usr/bin/env node
/* Copies functions/ramiBrain.js into index.html between the RAMI-BRAIN markers so
 * the client bot driver and the server bot engine run the SAME brain.
 *   node sync-rami-brain.js          — sync
 *   node sync-rami-brain.js --check  — exit 1 if the inline copy differs (pre-deploy) */
const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const brain = fs.readFileSync(path.join(__dirname, 'functions', 'ramiBrain.js'), 'utf8').replace(/\s+$/, '');
const re = /(<script id="rami-brain">\n)([\s\S]*?)(\n?[ \t]*<\/script>\n[ \t]*<!-- RAMI-BRAIN-END -->)/;
const m = html.match(re);
if (!m) { console.error('rami-brain markers not found in index.html'); process.exit(1); }
if (process.argv.includes('--check')) {
  const same = m[2].replace(/\s+$/, '') === brain;
  console.log(same ? 'rami-brain: inline copy is in sync' : 'rami-brain: inline copy DIFFERS — run `node sync-rami-brain.js`');
  process.exit(same ? 0 : 1);
}
const out = html.replace(re, (all, a, b, c) => a + brain + '\n    </script>\n    <!-- RAMI-BRAIN-END -->');
if (out !== html) { fs.writeFileSync(htmlPath, out); console.log('index.html: rami-brain block synced (' + brain.length + ' chars)'); }
else console.log('index.html: rami-brain block already in sync');
