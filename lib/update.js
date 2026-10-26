// 小更新包（.bbupdate）：只换程序文件，不碰你的工具、说明、资料、设置。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readZip } = require('./docs');
const { makeZip } = require('./zipw');

// 只有这些位置的文件可以被更新包替换。你的数据（tools.json、记忆区、私密区、皮肤、设置……）永远不在里面。
const ALLOWED = /^(server\.js|package\.json|lib\/[^]+|public\/[^]+|desktop\/[^]+|defaults\/[^]+)$/;
const MAX_FILES = 400;

function cmpVer(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function safeRel(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some(s => s === '..' || s === '.' || s === '')) return null;
  return ALLOWED.test(n) ? n : null;
}

// 检查 .js / .json 有没有写坏，免得装完百宝匣打不开
function syntaxError(name, data) {
  const src = data.toString('utf8');
  try {
    if (/\.json$/i.test(name)) JSON.parse(src);
    else if (/\.(js|cjs)$/i.test(name)) new vm.Script('(function (exports, require, module, __filename, __dirname) {' + src.replace(/^#!.*/, '') + '\n})', { filename: name });
    return null;
  } catch (e) { return e.message; }
}

// 读更新包并检查。不写任何文件。
function inspect(buf, current, env = {}) {
  let zip, man;
  try {
    zip = readZip(buf);
    man = JSON.parse(zip.get('manifest.json').toString('utf8'));
  } catch { return { ok: false, message: '这不是百宝匣的更新包。' }; }
  if (!man || man.app !== '百宝匣' || man.kind !== '更新') return { ok: false, message: '这不是百宝匣的更新包。' };
  const version = String(man.version || '');
  if (!/^\d+(\.\d+)*$/.test(version)) return { ok: false, message: '更新包里没写清楚版本号。' };
  const files = [];
  for (const n of zip.names()) {
    if (n === 'manifest.json' || n.endsWith('/')) continue;
    const rel = safeRel(n);
    if (!rel) return { ok: false, message: `更新包里有不该有的东西（${n}），为了安全没有安装。` };
    files.push(rel);
  }
  const remove = (Array.isArray(man.remove) ? man.remove : []).map(safeRel);
  if (remove.includes(null)) return { ok: false, message: '更新包想删掉不该删的文件，为了安全没有安装。' };
  if (!files.length && !remove.length) return { ok: false, message: '更新包是空的。' };
  if (files.length + remove.length > MAX_FILES) return { ok: false, message: '更新包里的文件太多了，请下载完整版。' };
  if (man.from && cmpVer(current, man.from) < 0) {
    return { ok: false, message: `这个更新包要从 ${man.from} 或更新的版本升级，你现在是 ${current}。请下载完整版。` };
  }
  if (man.electron && env.electron && String(env.electron).split('.')[0] !== String(man.electron).split('.')[0]) {
    return { ok: false, message: '这次更新换了桌面版的内核，小更新包装不了，请下载完整版。' };
  }
  for (const f of files) {
    const err = syntaxError(f, zip.get(f));
    if (err) return { ok: false, message: `更新包里的 ${f} 坏了（${err}），没有安装。` };
  }
  const cmp = cmpVer(version, current);
  return {
    ok: true, version, current, newer: cmp > 0, same: cmp === 0,
    notes: String(man.notes || '').slice(0, 2000), files, remove, zip,
  };
}

// 装更新：先把要换掉的旧文件存一份，再一个个替换
function apply(info, codeRoot, backupRoot) {
  const stamp = `更新前-${info.current}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
  const backup = path.join(backupRoot, stamp);
  const touched = [...info.files, ...info.remove];
  for (const rel of touched) {
    const src = path.join(codeRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(backup, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  const done = [];
  try {
    for (const rel of info.files) {
      const dst = path.join(codeRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = dst + '.bbnew';
      fs.writeFileSync(tmp, info.zip.get(rel));
      fs.renameSync(tmp, dst);
      done.push(rel);
    }
    for (const rel of info.remove) {
      try { fs.unlinkSync(path.join(codeRoot, rel)); } catch {}
    }
  } catch (e) {
    // 装到一半失败了：把已经换掉的改回去
    for (const rel of done) {
      const old = path.join(backup, rel);
      try { if (fs.existsSync(old)) fs.copyFileSync(old, path.join(codeRoot, rel)); else fs.unlinkSync(path.join(codeRoot, rel)); } catch {}
    }
    const msg = e.code === 'EPERM' || e.code === 'EACCES'
      ? '没有权限写入百宝匣所在的文件夹。如果放在了 C:\\Program Files 里，请把整个百宝匣文件夹挪到别处（比如 D:\\百宝匣）再试。'
      : e.message;
    return { ok: false, message: '更新没装上，已经恢复原样：' + msg };
  }
  return { ok: true, backup: stamp, count: info.files.length };
}

// 做更新包（给作者用）：把 codeRoot 里的程序文件打包
function build(codeRoot, { version, notes, from, electron, only } = {}) {
  const list = [];
  const walk = rel => {
    const abs = path.join(codeRoot, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) { for (const n of fs.readdirSync(abs)) walk(rel ? rel + '/' + n : n); return; }
    if (safeRel(rel)) list.push(rel);
  };
  for (const top of only && only.length ? only : ['server.js', 'package.json', 'lib', 'public', 'desktop', 'defaults']) {
    if (fs.existsSync(path.join(codeRoot, top))) walk(top);
  }
  const entries = [{ name: 'manifest.json', data: JSON.stringify({ app: '百宝匣', kind: '更新', version, from, electron, notes }, null, 2) }];
  for (const rel of list) entries.push({ name: rel, data: fs.readFileSync(path.join(codeRoot, rel)) });
  return makeZip(entries);
}

module.exports = { inspect, apply, build, cmpVer, safeRel };
