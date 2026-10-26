// 检查所有 .js 和 .json 有没有语法错误：npm run check
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SRC = path.resolve(__dirname, '..');
let bad = 0, n = 0;
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    const rel = path.relative(SRC, p);
    try {
      if (/\.json$/i.test(f)) { JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); n++; }
      else if (/\.(js|mjs|cjs)$/i.test(f)) { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); n++; }
    } catch (e) { bad++; console.log('✗', rel, '\n ', String(e.stderr || e.message).trim().split('\n').slice(0, 4).join('\n  ')); }
  }
}
walk(SRC);
console.log(bad ? `\n${bad} 个文件有问题` : `${n} 个文件都没问题`);
process.exit(bad ? 1 : 0);
