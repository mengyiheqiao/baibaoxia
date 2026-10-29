// 皮肤：像游戏 mod 一样，一个 .bbskin 文件（其实是 zip）就是一套皮肤。
// 里面至少有 skin.json（名字、作者等）和 skin.css（样式），可以再带图片、字体、preview.png。
// 皮肤只能改样子，不能带程序：只收下面这些类型的文件，CSS 里的外部网址也会被去掉。
'use strict';
const fs = require('fs');
const path = require('path');
const { readZip } = require('./docs');
const { removeTree } = require('./fsx');

const ALLOWED = new Set(['.css', '.json', '.moc3', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.otf', '.txt', '.md']);
const MAX_ZIP = 30 * 1024 * 1024;
const MAX_TOTAL = 60 * 1024 * 1024;
const MAX_FILES = 600;

const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };

function readMeta(dir) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8').replace(/^﻿/, '')) || {}; } catch { return null; }
  if (!fs.existsSync(path.join(dir, 'skin.css'))) return null;
  const colors = pick(j, '色板', 'colors');
  return {
    name: String(pick(j, '名字', 'name') || path.basename(dir)).slice(0, 40),
    author: String(pick(j, '作者', 'author') || '').slice(0, 40),
    version: String(pick(j, '版本', 'version') || '').slice(0, 20),
    fit: String(pick(j, '适配', 'fit', 'app') || '').slice(0, 20),
    desc: String(pick(j, '说明', 'description') || '').slice(0, 200),
    colors: Array.isArray(colors) ? colors.filter(c => /^#[0-9a-f]{3,8}$/i.test(String(c))).slice(0, 6) : [],
    hasPrivate: !!pick(j, '私密', 'private'),
    preview: fs.existsSync(path.join(dir, 'preview.png')) ? 'preview.png' : null,
    mascot: readMascot(dir, pick(j, '看板娘', 'mascot')),
  };
}

// 看板娘：皮肤自带的一套立绘，每个表情一张图。只认皮肤文件夹里的图片。
const MASCOT_MOODS = ['待机', '待机-闭眼', '思考', '说话', '找到了', '开心', '惊讶', '困', '玩游戏'];
function readMascot(dir, m) {
  if (!m || typeof m !== 'object') return null;
  const imgs = m['图片'] || m.images || {};
  const images = {};
  for (const mood of MASCOT_MOODS) {
    const rel = String(imgs[mood] || '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || !/\.(png|webp|gif|jpe?g)$/i.test(rel)) continue;
    if (fs.existsSync(path.join(dir, rel))) images[mood] = rel;
  }
  // Live2D 模型：指向皮肤里的 .model3.json；每种心情可以配动作、表情、参数
  let live2d = null;
  const l2 = String(m.live2d || m['Live2D'] || m['模型'] || '').replace(/\\/g, '/');
  if (l2 && !l2.startsWith('/') && !l2.split('/').includes('..') && /\.model3\.json$/i.test(l2) && fs.existsSync(path.join(dir, l2))) {
    const src = m['心情'] || m.moods || {};
    const moods = {};
    const str = v => (typeof v === 'string' ? v.slice(0, 60) : '');
    for (const mood of MASCOT_MOODS) {
      const v = src[mood];
      if (!v || typeof v !== 'object') continue;
      const params = {};
      const ps = v['参数'] || v.params || {};
      for (const [k, val] of Object.entries(ps)) if (/^[A-Za-z0-9_]{1,40}$/.test(k) && Number.isFinite(Number(val))) params[k] = Number(val);
      moods[mood] = { motion: str(v['动作'] || v.motion), expression: str(v['表情'] || v.expression), params };
    }
    const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
    live2d = {
      model: l2, moods,
      scale: num(m['缩放'] ?? m.scale, 1, 0.2, 6),
      x: num(m['左右'] ?? m.x, 0, -1, 1),
      y: num(m['上下'] ?? m.y, 0, -1, 1),
      mouth: str(m['张嘴参数']) || 'ParamMouthOpenY',
    };
  }
  if (!images['待机'] && !live2d) return null;
  return { name: String(m['名字'] || m.name || '').slice(0, 20), images, live2d, private: !!(m['私密区'] || m.private) };
}

// roots: [{ dir, prefix, builtin }]
function listSkins(roots) {
  const out = [];
  for (const r of roots) {
    if (!fs.existsSync(r.dir)) continue;
    let names = [];
    try { names = fs.readdirSync(r.dir); } catch { continue; }
    for (const n of names.sort()) {
      if (n.startsWith('.')) continue;
      const d = path.join(r.dir, n);
      try { if (!fs.statSync(d).isDirectory()) continue; } catch { continue; }
      const meta = readMeta(d);
      if (!meta) continue;
      out.push({ id: r.prefix + n, builtin: !!r.builtin, ...meta });
    }
  }
  return out;
}

// 去掉 CSS 里会去外网拿东西的写法（@import、外部网址），皮肤只能用自己带的文件
function sanitizeCss(css) {
  return String(css)
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?:https?:|\/\/|javascript:|file:)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(/gi, '');
}

function slugOf(s) {
  const t = String(s || '').replace(/\.(bbskin|zip)$/i, '').replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return t || 'skin';
}

function importSkin(buf, fileName, destRoot) {
  if (!buf || !buf.length) return { ok: false, message: '文件是空的。' };
  if (buf.length > MAX_ZIP) return { ok: false, message: '皮肤文件太大了（超过 30MB）。' };
  let zip;
  try { zip = readZip(buf); } catch { return { ok: false, message: '这不是皮肤文件：皮肤应该是 .bbskin（zip 格式）。' }; }
  const names = zip.names().filter(n => !n.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(n));
  if (names.length > MAX_FILES) return { ok: false, message: '皮肤里的文件太多了。' };
  // 允许整个皮肤套在一个文件夹里
  const jsonPath = names.find(n => /(^|\/)skin\.json$/.test(n) && n.split('/').length <= 2);
  if (!jsonPath) return { ok: false, message: '皮肤里没有 skin.json，不是有效的皮肤。' };
  const base = jsonPath.slice(0, -'skin.json'.length);
  if (!names.includes(base + 'skin.css')) return { ok: false, message: '皮肤里没有 skin.css，不是有效的皮肤。' };

  let meta = {};
  try { meta = JSON.parse(zip.get(jsonPath).toString('utf8').replace(/^﻿/, '')) || {}; } catch { return { ok: false, message: 'skin.json 格式不对。' }; }
  const display = pick(meta, '名字', 'name') || fileName;
  let slug = slugOf(display);
  fs.mkdirSync(destRoot, { recursive: true });
  // 同名皮肤：如果是同一套（名字一样）就覆盖成新版，否则加后缀
  const target = path.join(destRoot, slug);
  const tmp = path.join(destRoot, '.导入中-' + Date.now());
  let total = 0, skipped = 0;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const n of names) {
      if (!n.startsWith(base)) continue;
      const rel = path.posix.normalize(n.slice(base.length));
      if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel) || rel.split('/').some(p => p.startsWith('.'))) { skipped++; continue; }
      const ext = path.extname(rel).toLowerCase();
      if (!ALLOWED.has(ext)) { skipped++; continue; }
      let data = zip.get(n);
      if (!data) continue;
      total += data.length;
      if (total > MAX_TOTAL) throw new Error('皮肤解开以后太大了（超过 60MB）。');
      if (ext === '.css') data = Buffer.from(sanitizeCss(data.toString('utf8')), 'utf8');
      const out = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
    }
    if (!readMeta(tmp)) throw new Error('皮肤内容不完整。');
    const replaced = fs.existsSync(target);
    if (replaced) removeTree(target);
    fs.renameSync(tmp, target);
    return { ok: true, slug, replaced, skipped, meta: readMeta(target) };
  } catch (e) {
    try { removeTree(tmp); } catch {}
    return { ok: false, message: e.message || '导入失败' };
  }
}

module.exports = { listSkins, importSkin, sanitizeCss, readMeta };
