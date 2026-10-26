// 自己写的"删文件 / 删文件夹"。
// 不用 fs.rmSync：Node 23 以后它在 Windows 上遇到中文文件名会让整个程序直接崩掉
// （https://github.com/nodejs/node/issues/56049），百宝匣里几乎都是中文名字。
'use strict';
const fs = require('fs');
const path = require('path');

function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }
const RETRY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

function retry(fn, tries) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (e.code === 'ENOENT') return;
      if (!RETRY.has(e.code) || i >= tries) throw e;
      sleepMs(80 * (i + 1));
    }
  }
}

// 删掉一个文件或整个文件夹（里面的东西一起删）；不存在就算删好了
function removeTree(p, tries = 4) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) removeTree(path.join(p, n), tries);
    retry(() => fs.rmdirSync(p), tries);
    return;
  }
  retry(() => {
    try { fs.unlinkSync(p); } catch (e) {
      // Windows 上只读文件删不掉：先去掉只读再删
      if (e.code === 'EPERM' || e.code === 'EACCES') { try { fs.chmodSync(p, 0o666); } catch {} fs.unlinkSync(p); }
      else throw e;
    }
  }, tries);
}

module.exports = { removeTree, sleepMs };
