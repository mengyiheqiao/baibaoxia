// 把百宝匣的批注写进 PDF 文件：用"增量更新"——原文件一个字节都不改，只在文件末尾追加新的对象和交叉引用表。
// 写进去的是标准 PDF 批注（高亮 Highlight、便签 Text、手写 Ink），Edge、WPS、Adobe、手机阅读器都能看到。
// 百宝匣自己写的批注都带 /NM (bbx-…)，以后再写时先把旧的拿掉，所以反复保存不会重复。
'use strict';
const zlib = require('zlib');

class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
class Name { constructor(name) { this.name = name; } }
class PStr { constructor(bytes) { this.bytes = bytes; } }   // PDF 字符串（原始字节）
class Raw { constructor(t) { this.t = t; } }                // 数字、true、false、null，保留原样
class Dict {
  constructor() { this.map = new Map(); }
  get(k) { return this.map.get(k); }
  set(k, v) { this.map.set(k, v); return this; }
  has(k) { return this.map.has(k); }
  delete(k) { this.map.delete(k); }
}
class PdfError extends Error {}

const isWS = c => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = c => c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const num = v => (v instanceof Raw ? Number(v.t) : typeof v === 'number' ? v : NaN);

// ---------------------------------------------------------------- 词法 + 语法

function skipWS(b, p) {
  for (;;) {
    while (p < b.length && isWS(b[p])) p++;
    if (b[p] === 0x25) { while (p < b.length && b[p] !== 0x0a && b[p] !== 0x0d) p++; continue; } // % 注释
    return p;
  }
}
function readToken(b, p) {
  const s = p;
  while (p < b.length && !isWS(b[p]) && !isDelim(b[p])) p++;
  return { t: b.toString('latin1', s, p), p };
}

function parseValue(b, p) {
  p = skipWS(b, p);
  const c = b[p];
  if (c === 0x2f) { // /Name
    let q = p + 1;
    while (q < b.length && !isWS(b[q]) && !isDelim(b[q])) q++;
    // 名字按原始字节（latin1）保存，写回去时原样还原
    const raw = b.toString('latin1', p + 1, q).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return { v: new Name(raw), p: q };
  }
  if (c === 0x28) { // (literal string)
    const out = [];
    let depth = 1, q = p + 1;
    while (q < b.length) {
      const ch = b[q];
      if (ch === 0x5c) { // 反斜杠转义
        const n = b[q + 1];
        const map = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (map[n] !== undefined) { out.push(map[n]); q += 2; continue; }
        if (n >= 0x30 && n <= 0x37) {
          let o = 0, k = 0;
          while (k < 3 && b[q + 1 + k] >= 0x30 && b[q + 1 + k] <= 0x37) { o = o * 8 + (b[q + 1 + k] - 0x30); k++; }
          out.push(o & 0xff); q += 1 + k; continue;
        }
        if (n === 0x0d) { q += b[q + 2] === 0x0a ? 3 : 2; continue; }
        if (n === 0x0a) { q += 2; continue; }
        q += 1; continue;
      }
      if (ch === 0x28) depth++;
      if (ch === 0x29 && --depth === 0) { q++; break; }
      out.push(ch); q++;
    }
    return { v: new PStr(Buffer.from(out)), p: q };
  }
  if (c === 0x3c && b[p + 1] === 0x3c) { // << dict >>
    const d = new Dict();
    let q = p + 2;
    for (;;) {
      q = skipWS(b, q);
      if (q >= b.length) throw new PdfError('字典没有结束');
      if (b[q] === 0x3e && b[q + 1] === 0x3e) { q += 2; break; }
      const k = parseValue(b, q);
      if (!(k.v instanceof Name)) throw new PdfError('字典的键不是名字');
      const v = parseValue(b, k.p);
      d.set(k.v.name, v.v);
      q = v.p;
    }
    return { v: d, p: q };
  }
  if (c === 0x3c) { // <hex>
    let q = p + 1, hex = '';
    while (q < b.length && b[q] !== 0x3e) { if (!isWS(b[q])) hex += String.fromCharCode(b[q]); q++; }
    if (hex.length % 2) hex += '0';
    return { v: new PStr(Buffer.from(hex, 'hex')), p: q + 1 };
  }
  if (c === 0x5b) { // [array]
    const a = [];
    let q = p + 1;
    for (;;) {
      q = skipWS(b, q);
      if (q >= b.length) throw new PdfError('数组没有结束');
      if (b[q] === 0x5d) { q++; break; }
      const v = parseValue(b, q);
      a.push(v.v); q = v.p;
    }
    return { v: a, p: q };
  }
  const tk = readToken(b, p);
  if (!tk.t) throw new PdfError(`看不懂的内容（位置 ${p}）`);
  if (/^[+-]?\d+$/.test(tk.t)) {
    // 可能是 "12 0 R"
    const q1 = skipWS(b, tk.p), t2 = readToken(b, q1);
    if (/^\d+$/.test(t2.t)) {
      const q2 = skipWS(b, t2.p);
      if (b[q2] === 0x52 && (q2 + 1 >= b.length || isWS(b[q2 + 1]) || isDelim(b[q2 + 1]))) return { v: new Ref(Number(tk.t), Number(t2.t)), p: q2 + 1 };
    }
  }
  return { v: new Raw(tk.t), p: tk.p };
}

// ---------------------------------------------------------------- 流解码（只需要 FlateDecode + PNG 预测，用来读对象流和交叉引用流）

function pngUnpredict(data, columns) {
  const row = columns, out = Buffer.alloc(Math.floor(data.length / (row + 1)) * row);
  let prev = Buffer.alloc(row);
  for (let r = 0, o = 0; r + row < data.length + 1 && o < out.length; r += row + 1, o += row) {
    const f = data[r], cur = Buffer.from(data.subarray(r + 1, r + 1 + row));
    for (let i = 0; i < row; i++) {
      const a = i > 0 ? cur[i - 1] : 0, up = prev[i], c = i > 0 ? prev[i - 1] : 0;
      if (f === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (f === 2) cur[i] = (cur[i] + up) & 0xff;
      else if (f === 3) cur[i] = (cur[i] + ((a + up) >> 1)) & 0xff;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)) & 0xff; }
    }
    cur.copy(out, o);
    prev = cur;
  }
  return out;
}

// ---------------------------------------------------------------- 打开一个 PDF

function open(buf) {
  const cache = new Map();
  const entries = new Map(); // num -> {type:1, off, gen} | {type:2, stm, idx}
  let trailer = null, lastIsStream = false;

  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  const si = tail.lastIndexOf('startxref');
  if (si < 0) throw new PdfError('找不到 startxref');
  const startxref = Number(/startxref\s+(\d+)/.exec(tail.slice(si))?.[1]);
  if (!Number.isFinite(startxref)) throw new PdfError('startxref 坏了');

  function parseIndirectAt(off, expectNum) {
    let p = skipWS(buf, off);
    const a = readToken(buf, p); p = skipWS(buf, a.p);
    const g = readToken(buf, p); p = skipWS(buf, g.p);
    const o = readToken(buf, p);
    if (o.t !== 'obj' || (expectNum !== undefined && Number(a.t) !== expectNum)) throw new PdfError(`对象 ${expectNum} 的位置不对`);
    const v = parseValue(buf, o.p);
    let q = skipWS(buf, v.p), stream = null;
    if (buf.toString('latin1', q, q + 6) === 'stream') {
      q += 6;
      if (buf[q] === 0x0d) q++;
      if (buf[q] === 0x0a) q++;
      let len = v.v.get('Length');
      if (len instanceof Ref) len = getObject(len.num);
      len = num(len);
      if (!Number.isFinite(len)) throw new PdfError('流的长度不对');
      stream = buf.subarray(q, q + len);
    }
    return { value: v.v, stream, num: Number(a.t), gen: Number(g.t) };
  }

  function decode(dict, data) {
    let filters = dict.get('Filter');
    if (!filters) return data;
    if (!Array.isArray(filters)) filters = [filters];
    let parms = dict.get('DecodeParms');
    if (!Array.isArray(parms)) parms = [parms];
    let out = data;
    filters.forEach((f, i) => {
      if (!(f instanceof Name) || f.name !== 'FlateDecode') throw new PdfError('不支持的压缩方式：' + (f && f.name));
      out = zlib.inflateSync(out, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      const pr = parms[i];
      if (pr instanceof Dict && num(pr.get('Predictor')) >= 10) out = pngUnpredict(out, num(pr.get('Columns')) || 1);
    });
    return out;
  }

  function readXrefStream(off) {
    const o = parseIndirectAt(off);
    const d = o.value;
    if (!(d instanceof Dict) || !(d.get('Type') instanceof Name) || d.get('Type').name !== 'XRef') throw new PdfError('交叉引用流不对');
    const data = decode(d, o.stream);
    const W = d.get('W').map(num);
    const size = num(d.get('Size'));
    const idx = (d.get('Index') || [new Raw('0'), new Raw(String(size))]).map(num);
    const rowLen = W[0] + W[1] + W[2];
    let pos = 0;
    const field = (w, def) => { if (!w) return def; let v = 0; for (let i = 0; i < w; i++) v = v * 256 + data[pos++]; return v; };
    for (let k = 0; k < idx.length; k += 2) {
      for (let n = idx[k], end = idx[k] + idx[k + 1]; n < end; n++) {
        if (pos + rowLen > data.length) break;
        const t = field(W[0], 1), f2 = field(W[1], 0), f3 = field(W[2], 0);
        if (entries.has(n)) continue;
        if (t === 1) entries.set(n, { type: 1, off: f2, gen: f3 });
        else if (t === 2) entries.set(n, { type: 2, stm: f2, idx: f3 });
        else entries.set(n, { type: 0 });
      }
    }
    return d;
  }

  function readXrefTable(off) {
    let p = skipWS(buf, off) + 4; // 'xref'
    for (;;) {
      p = skipWS(buf, p);
      const t = readToken(buf, p);
      if (t.t === 'trailer') { const tr = parseValue(buf, t.p); return tr.v; }
      const start = Number(t.t);
      p = skipWS(buf, t.p);
      const c = readToken(buf, p);
      const count = Number(c.t);
      if (!Number.isFinite(start) || !Number.isFinite(count)) throw new PdfError('交叉引用表坏了');
      p = c.p;
      for (let i = 0; i < count; i++) {
        p = skipWS(buf, p);
        const line = buf.toString('latin1', p, p + 18);
        const m = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
        if (!m) throw new PdfError('交叉引用表的条目坏了');
        const n = start + i;
        if (!entries.has(n)) entries.set(n, m[3] === 'n' ? { type: 1, off: Number(m[1]), gen: Number(m[2]) } : { type: 0 });
        p += 18;
      }
    }
  }

  // 从最新的交叉引用往前读
  const seen = new Set();
  let off = startxref, first = true;
  while (Number.isFinite(off) && !seen.has(off)) {
    seen.add(off);
    const p = skipWS(buf, off);
    let tr;
    if (buf.toString('latin1', p, p + 4) === 'xref') {
      tr = readXrefTable(p);
      if (tr.get('XRefStm')) { try { readXrefStream(num(tr.get('XRefStm'))); } catch {} }
      if (first) lastIsStream = false;
    } else {
      tr = readXrefStream(p);
      if (first) lastIsStream = true;
    }
    if (first) trailer = tr;
    first = false;
    off = tr.get('Prev') !== undefined ? num(tr.get('Prev')) : NaN;
  }
  if (!trailer) throw new PdfError('没有 trailer');
  if (trailer.get('Encrypt')) throw new PdfError('这个 PDF 加密了，不能写进批注');

  const stmCache = new Map();
  function getObjStm(n) {
    if (stmCache.has(n)) return stmCache.get(n);
    const e = entries.get(n);
    if (!e || e.type !== 1) throw new PdfError('对象流不见了');
    const o = parseIndirectAt(e.off, n);
    const data = decode(o.value, o.stream);
    const N = num(o.value.get('N')), firstOff = num(o.value.get('First'));
    const offs = [];
    let p = 0;
    for (let i = 0; i < N; i++) {
      const a = parseValue(data, p); const b2 = parseValue(data, a.p);
      offs.push({ num: num(a.v), off: num(b2.v) }); p = b2.p;
    }
    const r = { data, offs, first: firstOff };
    stmCache.set(n, r);
    return r;
  }

  function getObject(n) {
    if (cache.has(n)) return cache.get(n);
    const e = entries.get(n);
    let v = null;
    if (e && e.type === 1) v = parseIndirectAt(e.off, n).value;
    else if (e && e.type === 2) {
      const s = getObjStm(e.stm);
      const it = s.offs[e.idx] && s.offs[e.idx].num === n ? s.offs[e.idx] : s.offs.find(x => x.num === n);
      if (!it) throw new PdfError(`对象 ${n} 不在对象流里`);
      v = parseValue(s.data, s.first + it.off).v;
    }
    cache.set(n, v);
    return v;
  }
  const resolve = v => (v instanceof Ref ? getObject(v.num) : v);
  const genOf = n => { const e = entries.get(n); return e && e.type === 1 ? e.gen : 0; };

  // 所有页面的引用（按顺序）
  function pages() {
    const out = [];
    const root = resolve(trailer.get('Root'));
    const walk = (ref, depth) => {
      if (depth > 64) return;
      const node = resolve(ref);
      if (!(node instanceof Dict)) return;
      const kids = resolve(node.get('Kids'));
      const type = node.get('Type');
      if (Array.isArray(kids) && !(type instanceof Name && type.name === 'Page')) { for (const k of kids) walk(k, depth + 1); return; }
      if (ref instanceof Ref) out.push(ref);
    };
    walk(root.get('Pages'), 0);
    return out;
  }

  let maxNum = num(trailer.get('Size')) || 0;
  for (const n of entries.keys()) if (n + 1 > maxNum) maxNum = n + 1;
  return { buf, trailer, startxref, lastIsStream, getObject, resolve, genOf, pages, maxNum };
}

// ---------------------------------------------------------------- 写对象

function pdfString(s) {
  s = String(s);
  if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/[\\()]/g, m => '\\' + m) + ')';
  const b = Buffer.from('﻿' + s, 'utf16le');
  for (let i = 0; i < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; } // 转成 UTF-16BE
  return '<' + b.toString('hex') + '>';
}
const fmt = n => { const r = Math.round(n * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
function ser(v) {
  if (v instanceof Ref) return `${v.num} ${v.gen} R`;
  if (v instanceof Name) return '/' + v.name.replace(/[^!-~]|[#()<>\[\]{}\/%]/g, ch => '#' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
  if (v instanceof PStr) return '<' + v.bytes.toString('hex') + '>';
  if (v instanceof Raw) return v.t;
  if (typeof v === 'number') return fmt(v);
  if (typeof v === 'string') return pdfString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(ser).join(' ') + ']';
  if (v instanceof Dict) return '<<' + [...v.map].map(([k, x]) => ser(new Name(k)) + ' ' + ser(x)).join(' ') + '>>';
  throw new PdfError('写不出这个值');
}
const N = n => new Name(n);

// ---------------------------------------------------------------- 批注 -> PDF 对象

const COLORS = { yellow: [1, 0.84, 0.35], green: [0.5, 0.86, 0.65], blue: [0.56, 0.7, 1], pink: [1, 0.62, 0.76], red: [0.9, 0.28, 0.3], black: [0.14, 0.15, 0.18] };
const pdfDate = d => { const t = new Date(d || Date.now()); const p = n => String(n).padStart(2, '0'); return `D:${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}Z`; };
const colorOf = c => COLORS[c] || COLORS.yellow;

// 返回 [{ dict, stream? }]，第一个是批注本身，之后是它的外观
function annotObjects(item, pageRef, author) {
  const col = colorOf(item.color);
  const d = new Dict();
  d.set('Type', N('Annot'));
  d.set('NM', 'bbx-' + item.id);
  d.set('T', author);
  d.set('M', pdfDate(item.updated));
  d.set('CreationDate', pdfDate(item.created));
  d.set('P', pageRef);
  d.set('C', col);
  if (item.note) d.set('Contents', item.note);
  let ap = null;
  if (item.type === 'highlight' && Array.isArray(item.rects) && item.rects.length) {
    const rs = item.rects.map(r => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]);
    const rect = [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3]))];
    d.set('Subtype', N('Highlight'));
    d.set('Rect', rect);
    d.set('QuadPoints', rs.flatMap(r => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]]));
    d.set('F', new Raw('4'));
    if (!item.note && item.text) d.set('Subj', String(item.text).slice(0, 200));
    const body = ['/R0 gs', `${col.map(fmt).join(' ')} rg`, ...rs.map(r => `${fmt(r[0] - rect[0])} ${fmt(r[1] - rect[1])} ${fmt(r[2] - r[0])} ${fmt(r[3] - r[1])} re`), 'f'].join('\n');
    const sd = new Dict();
    sd.set('Type', N('XObject')).set('Subtype', N('Form')).set('FormType', new Raw('1'))
      .set('BBox', [0, 0, rect[2] - rect[0], rect[3] - rect[1]])
      .set('Resources', new Dict().set('ExtGState', new Dict().set('R0', new Dict().set('Type', N('ExtGState')).set('BM', N('Multiply')).set('ca', 0.9))));
    sd.set('Matrix', [1, 0, 0, 1, 0, 0]);
    ap = { dict: sd, data: body };
    // 外观的 BBox 从 0 开始，Rect 才是位置；按规范，阅读器会把 BBox 映射到 Rect
  } else if (item.type === 'note' && Array.isArray(item.at)) {
    const [x, y] = item.at;
    d.set('Subtype', N('Text'));
    d.set('Rect', [x, y - 20, x + 20, y]);
    d.set('Name', N('Comment'));
    d.set('F', new Raw('28'));
    d.set('Open', false);
  } else if (item.type === 'ink' && Array.isArray(item.paths) && item.paths.length) {
    const w = Math.max(0.5, Math.min(12, Number(item.width) || 2));
    const pts = item.paths.flat();
    const rect = [Math.min(...pts.map(p => p[0])) - w, Math.min(...pts.map(p => p[1])) - w, Math.max(...pts.map(p => p[0])) + w, Math.max(...pts.map(p => p[1])) + w];
    d.set('Subtype', N('Ink'));
    d.set('Rect', rect);
    d.set('InkList', item.paths.map(path => path.flatMap(p => [p[0], p[1]])));
    d.set('BS', new Dict().set('W', w));
    d.set('F', new Raw('4'));
    const body = [`${fmt(w)} w 1 J 1 j`, `${col.map(fmt).join(' ')} RG`, ...item.paths.map(path => path.map((p, i) => `${fmt(p[0] - rect[0])} ${fmt(p[1] - rect[1])} ${i ? 'l' : 'm'}`).join('\n') + (path.length === 1 ? ` ${fmt(path[0][0] - rect[0])} ${fmt(path[0][1] - rect[1])} l` : '') + '\nS')].join('\n');
    const sd = new Dict();
    sd.set('Type', N('XObject')).set('Subtype', N('Form')).set('FormType', new Raw('1')).set('BBox', [0, 0, rect[2] - rect[0], rect[3] - rect[1]]);
    ap = { dict: sd, data: body };
  } else return null;
  return { dict: d, ap };
}

// 读出某一页上的批注：哪些是百宝匣写的（/NM 以 bbx- 开头）
function isOurs(doc, ref) {
  try {
    const a = doc.resolve(ref);
    const nm = a instanceof Dict ? a.get('NM') : null;
    return nm instanceof PStr && nm.bytes.toString('latin1').startsWith('bbx-');
  } catch { return false; }
}

// 返回要追加到文件末尾的内容。items: 百宝匣现在的全部批注（空数组 = 把百宝匣写过的都拿掉）
function buildUpdate(buf, items, { author = '百宝匣' } = {}) {
  const doc = open(buf);
  const pageRefs = doc.pages();
  let next = doc.maxNum;
  const objs = []; // { num, gen, body: string | {dict, data} }
  const byPage = new Map();
  for (const it of items || []) {
    const pi = Number(it.page) - 1;
    if (!Number.isInteger(pi) || pi < 0 || pi >= pageRefs.length) continue;
    if (!byPage.has(pi)) byPage.set(pi, []);
    byPage.get(pi).push(it);
  }
  // 要改的页：有批注的页 + 之前写过百宝匣批注的页
  const touched = new Set(byPage.keys());
  pageRefs.forEach((ref, i) => {
    if (touched.has(i)) return;
    const pg = doc.resolve(ref);
    const an = pg instanceof Dict ? doc.resolve(pg.get('Annots')) : null;
    if (Array.isArray(an) && an.some(r => r instanceof Ref && isOurs(doc, r))) touched.add(i);
  });
  let written = 0;
  for (const pi of [...touched].sort((a, b) => a - b)) {
    const pref = pageRefs[pi];
    const page = doc.resolve(pref);
    if (!(page instanceof Dict)) continue;
    const annotsVal = page.get('Annots');
    const cur = doc.resolve(annotsVal);
    const keep = (Array.isArray(cur) ? cur : []).filter(r => !(r instanceof Ref && isOurs(doc, r)));
    const mine = [];
    for (const it of byPage.get(pi) || []) {
      const o = annotObjects(it, pref, author);
      if (!o) continue;
      const aNum = next++;
      if (o.ap) {
        const apNum = next++;
        o.dict.set('AP', new Dict().set('N', new Ref(apNum, 0)));
        objs.push({ num: apNum, gen: 0, stream: o.ap });
      }
      objs.push({ num: aNum, gen: 0, body: o.dict });
      mine.push(new Ref(aNum, 0));
      written++;
    }
    const arr = [...keep, ...mine];
    if (annotsVal instanceof Ref) {
      objs.push({ num: annotsVal.num, gen: annotsVal.gen, body: arr });
    } else {
      const np = new Dict();
      for (const [k, v] of page.map) np.set(k, v);
      if (arr.length) np.set('Annots', arr); else np.delete('Annots');
      objs.push({ num: pref.num, gen: pref.gen, body: np });
    }
  }
  if (!objs.length) return { appendix: Buffer.alloc(0), written: 0, pages: 0 };

  // 拼出追加的内容
  const parts = [];
  let pos = buf.length;
  const push = s => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); parts.push(b); pos += b.length; };
  if (buf[buf.length - 1] !== 0x0a && buf[buf.length - 1] !== 0x0d) push('\n');
  const offsets = new Map();
  for (const o of objs) {
    offsets.set(o.num, { off: pos, gen: o.gen });
    if (o.stream) {
      const data = Buffer.from(o.stream.data, 'latin1');
      o.stream.dict.set('Length', data.length);
      push(`${o.num} ${o.gen} obj\n${ser(o.stream.dict)}\nstream\n`);
      push(data);
      push('\nendstream\nendobj\n');
    } else {
      push(`${o.num} ${o.gen} obj\n${ser(o.body)}\nendobj\n`);
    }
  }
  const tr = doc.trailer;
  const common = d => {
    d.set('Root', tr.get('Root'));
    if (tr.get('Info')) d.set('Info', tr.get('Info'));
    if (tr.get('ID')) d.set('ID', tr.get('ID'));
    d.set('Prev', doc.startxref);
    return d;
  };
  if (doc.lastIsStream) {
    const xnum = next++;
    const xoff = pos;
    offsets.set(xnum, { off: xoff, gen: 0 });
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const index = [], rows = [];
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      index.push(nums[i], j - i + 1);
      for (let k = i; k <= j; k++) { const e = offsets.get(nums[k]); const r = Buffer.alloc(7); r[0] = 1; r.writeUInt32BE(e.off, 1); r.writeUInt16BE(e.gen, 5); rows.push(r); }
      i = j + 1;
    }
    const data = Buffer.concat(rows);
    const d = common(new Dict().set('Type', N('XRef')).set('Size', Math.max(next, doc.maxNum)).set('W', [1, 4, 2]).set('Index', index).set('Length', data.length));
    push(`${xnum} 0 obj\n${ser(d)}\nstream\n`);
    push(data);
    push(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`);
  } else {
    const xoff = pos;
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    let s = 'xref\n';
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      s += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) { const e = offsets.get(nums[k]); s += `${String(e.off).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`; }
      i = j + 1;
    }
    const d = common(new Dict().set('Size', Math.max(next, doc.maxNum)));
    s += `trailer\n${ser(d)}\nstartxref\n${xoff}\n%%EOF\n`;
    push(s);
  }
  return { appendix: Buffer.concat(parts), written, pages: touched.size };
}

// 这个文件里哪些批注是百宝匣写的（给页面用，避免和自己画的重复显示）："12R" 这种格式，和 PDF.js 的批注 id 一样
function ourAnnotIds(buf) {
  const doc = open(buf);
  const out = [];
  for (const ref of doc.pages()) {
    const pg = doc.resolve(ref);
    const an = pg instanceof Dict ? doc.resolve(pg.get('Annots')) : null;
    if (!Array.isArray(an)) continue;
    for (const r of an) if (r instanceof Ref && isOurs(doc, r)) out.push(r.gen ? `${r.num}R${r.gen}` : `${r.num}R`);
  }
  return out;
}

module.exports = { open, buildUpdate, ourAnnotIds, PdfError, COLORS };
