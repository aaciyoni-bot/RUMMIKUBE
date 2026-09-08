'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const babel = require('@babel/core');
const root = path.resolve(__dirname, '../..');
let checked = 0;

// Parse the actual HTML, including non-JSX inline scripts and module imports.
// Scripts are never executed, and no external resource or Firebase is loaded.
for (const filename of ['index.html', 'backoffice.html']) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, filename), 'utf8'));
  for (const [index, script] of [...dom.window.document.scripts].entries()) {
    if (script.src || !script.textContent.trim()) continue;
    const type = (script.type || '').toLowerCase();
    if (!['', 'module', 'text/javascript', 'application/javascript', 'text/babel'].includes(type)) continue;
    const label = `${filename} script ${script.id || index + 1}`;
    try {
      babel.parseSync(script.textContent, {
        filename: label,
        sourceType: type === 'module' ? 'module' : 'script',
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: type === 'text/babel' ? ['jsx'] : [] }
      });
      checked++;
    } catch (error) {
      dom.window.close();
      throw new Error(`${label}: ${error.message}`);
    }
  }
  dom.window.close();
}

for (const directory of ['functions', 'assets/js']) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const filename = path.join(directory, entry.name);
    const result = spawnSync(process.execPath, ['--check', filename], { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${filename}: ${result.stderr}`);
    checked++;
  }
}
console.log(`PASS: ${checked} application scripts parse successfully`);
