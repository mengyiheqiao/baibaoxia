// 百宝匣：读取 PDF、EPUB、文本文件里的文字，用来做内容搜索和电子书阅读。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------- PDF（用 pdf.js）

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    const dir = path.join(__dirname, 'pdfjs');
    // pdf.js 加载时会提示"不能画图"之类的警告，我们只要文字，静音
    const warn = console.warn, log = console.log;
    console.warn = console.log = () => {};
    pdfjsPromise = import(pathToFileURL(path.join(dir, 'pdf.min.mjs')).href).then(m => {
      m.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, 'pdf.worker.min.mjs')).href;
      return m;
    }).finally(() => { console.warn = warn; console.log = log; });
  }
  return pdfjsPromise;
}

// 返回每一页的文字
async function pdfPages(file) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(file));
  const task = pdfjs.getDocument({
    data,
    // 中文 PDF 要靠这些 cMap 把字形转回文字；在 Node 里要用普通路径
    cMapUrl: path.join(__dirname, 'pdfjs', 'cmaps') + path.sep,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        text += it.str + (it.hasEOL ? '\n' : '');
      }
      pages.push(tidy(text, true));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

// 压缩空白；PDF 里中文之间常被插进多余的空格，去掉
function tidy(t, cjkJoin) {
  let s = t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n');
  if (cjkJoin) s = s.replace(/([⺀-鿿　-〿＀-￯]) (?=[⺀-鿿　-〿＀-￯])/g, '$1');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- ZIP（EPUB 就是一个 zip）

function readZip(file) {
  const buf = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  // 找"目录结束"标记
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip / epub 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const flags = buf.readUInt16LE(off + 8);
    const nameBuf = buf.subarray(off + 46, off + 46 + nameLen);
    const name = (flags & 0x800) ? nameBuf.toString('utf8') : decodeName(nameBuf);
    entries.set(name, { method, csize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const commentLen = buf.readUInt16LE(eocd + 20);
  return {
    comment: buf.subarray(eocd + 22, eocd + 22 + commentLen).toString('utf8'),
    names: () => [...entries.keys()],
    has: name => entries.has(name),
    get(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lnl = buf.readUInt16LE(e.local + 26);
      const lel = buf.readUInt16LE(e.local + 28);
      const start = e.local + 30 + lnl + lel;
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error('不支持的压缩方式');
    },
  };
}

function decodeName(b) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { try { return new TextDecoder('gbk').decode(b); } catch { return b.toString('latin1'); } }
}

// ---------------------------------------------------------------- EPUB

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : '';
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
  });
}

function htmlToText(html) {
  return tidy(decodeEntities(
    html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ));
}

function joinPath(base, rel) {
  const clean = decodeURIComponent(rel.split('#')[0]);
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), clean)).replace(/^\.\//, '');
}

// 读 EPUB：书名、作者、章节（阅读顺序）、目录标题
function epubInfo(file) {
  const zip = readZip(file);
  const container = zip.get('META-INF/container.xml');
  if (!container) throw new Error('这个 EPUB 缺少 container.xml');
  const opfPath = attr(/<rootfile\b[^>]*>/i.exec(container.toString('utf8'))[0], 'full-path');
  const opf = zip.get(opfPath).toString('utf8');
  const title = decodeEntities(((/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf) || [])[1] || '').trim());
  const author = decodeEntities(((/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf) || [])[1] || '').trim());

  const manifest = new Map();
  let navHref = '', ncxHref = '';
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(tag, 'id');
    const href = joinPath(opfPath, attr(tag, 'href'));
    const type = attr(tag, 'media-type');
    manifest.set(id, { href, type });
    if (/\bnav\b/.test(attr(tag, 'properties'))) navHref = href;
    if (type === 'application/x-dtbncx+xml') ncxHref = href;
  }
  const spine = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const it = manifest.get(attr(tag, 'idref'));
    if (it && zip.has(it.href)) spine.push(it.href);
  }

  // 目录标题
  const titles = new Map();
  try {
    if (navHref && zip.has(navHref)) {
      const nav = zip.get(navHref).toString('utf8');
      const tocPart = (/<nav\b[^>]*toc[^>]*>([\s\S]*?)<\/nav>/i.exec(nav) || [])[1] || nav;
      for (const m of tocPart.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = joinPath(navHref, attr(m[0], 'href'));
        const t = htmlToText(m[2]);
        if (t && !titles.has(href)) titles.set(href, t);
      }
    } else if (ncxHref && zip.has(ncxHref)) {
      const ncx = zip.get(ncxHref).toString('utf8');
      for (const m of ncx.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)\/?>/gi)) {
        const href = joinPath(ncxHref, attr(m[0].match(/<content\b[^>]*>/i)[0], 'src'));
        const t = decodeEntities(m[1].trim());
        if (t && !titles.has(href)) titles.set(href, t);
      }
    }
  } catch {}

  const chapters = spine.map((href, i) => {
    let t = titles.get(href);
    if (!t) {
      const html = zip.get(href).toString('utf8');
      const h = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html) || /<title>([\s\S]*?)<\/title>/i.exec(html);
      t = h ? htmlToText(h[1]) : '';
    }
    return { href, title: (t || `第 ${i + 1} 部分`).slice(0, 60) };
  });
  return { title: title || path.basename(file, path.extname(file)), author, chapters, zip };
}

// EPUB 每一章的文字
function epubTexts(file) {
  const info = epubInfo(file);
  return info.chapters.map(c => htmlToText(info.zip.get(c.href).toString('utf8')));
}

// ---------------------------------------------------------------- 统一入口

const TEXT_EXT = /\.(txt|md|markdown|csv|log|json)$/i;

// 返回 [{ label: '第 3 页', text }]；不支持的类型返回 null
async function extractParts(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return (await pdfPages(file)).map((text, i) => ({ label: `第 ${i + 1} 页`, page: i + 1, text }));
  if (ext === '.epub') {
    const info = epubInfo(file);
    return info.chapters.map((c, i) => ({ label: c.title, chapter: i, text: htmlToText(info.zip.get(c.href).toString('utf8')) }));
  }
  if (/^\.(docx|xlsx|pptx)$/.test(ext)) return require('./office').officeParts(file);
  if (TEXT_EXT.test(ext)) {
    const buf = fs.readFileSync(file);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('gbk').decode(buf); }
    return [{ label: '', text: text.replace(/^﻿/, '') }];
  }
  return null;
}

module.exports = { pdfPages, readZip, epubInfo, epubTexts, extractParts, htmlToText };
