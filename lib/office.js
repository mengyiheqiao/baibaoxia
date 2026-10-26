// 读 Word（.docx）、Excel（.xlsx）、PPT（.pptx）：取出文字用来搜索，转成网页用来在百宝匣里看，
// 也能转成 Markdown 变成一篇可以编辑的说明。这几种文件其实都是 zip 包，里面是 XML。
// 老的 .doc / .xls / .ppt 是另一种格式，读不了。
'use strict';
const path = require('path');
const { readZip } = require('./docs');

const OFFICE_EXT = /\.(docx|xlsx|pptx)$/i;
const OLD_OFFICE_EXT = /\.(doc|xls|ppt)$/i;

function dec(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') { try { return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)); } catch { return ''; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = (tag, name) => { const m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(tag); return m ? dec(m[1]) : ''; };
const text = (zip, name) => { const b = zip.get(name); return b ? b.toString('utf8') : ''; };

function rels(zip, relsPath, baseDir) {
  const map = {};
  for (const tag of text(zip, relsPath).match(/<Relationship\b[^>]*>/g) || []) {
    const target = attr(tag, 'Target');
    map[attr(tag, 'Id')] = /^\//.test(target) ? target.slice(1) : path.posix.normalize(path.posix.join(baseDir, target));
  }
  return map;
}

// 把一段 XML 里最外层的某几种元素按顺序取出来（会数嵌套层数）
function topLevel(xml, names) {
  const re = new RegExp('<(/?)(' + names.join('|') + ')(?=[\\s>/])[^>]*?(/?)>', 'g');
  const out = [];
  let depth = 0, start = -1, cur = '';
  let m;
  while ((m = re.exec(xml))) {
    const closing = m[1] === '/', self = m[3] === '/';
    if (!closing) {
      if (depth === 0) { start = m.index; cur = m[2]; }
      if (self) { if (depth === 0) out.push({ tag: cur, xml: m[0] }); }
      else depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) { out.push({ tag: cur, xml: xml.slice(start, re.lastIndex) }); start = -1; }
    }
  }
  return out;
}

// ================================================================ Word

function docxStyles(zip) {
  const map = {};
  for (const s of text(zip, 'word/styles.xml').match(/<w:style\b[\s\S]*?<\/w:style>/g) || []) {
    const id = attr(s.match(/<w:style\b[^>]*>/)[0], 'w:styleId');
    const nm = /<w:name\s+w:val="([^"]*)"/.exec(s);
    if (id) map[id] = (nm ? nm[1] : id).toLowerCase();
  }
  return map;
}

function headingLevel(styleId, styles) {
  if (!styleId) return 0;
  const name = styles[styleId] || styleId.toLowerCase();
  if (name === 'title' || name === '标题') return 1;
  let m = /heading\s*(\d)/.exec(name) || /标题\s*(\d)/.exec(name);
  if (m) return Math.min(5, Number(m[1]) + 1);
  if (/^\d$/.test(styleId) && styles[styleId] === undefined) return Math.min(5, Number(styleId) + 1);
  return 0;
}

// 一个段落：文字 + 加粗斜体 + 图片
function docxRuns(pXml, imgRel, imgUrl) {
  const parts = [];
  for (const r of pXml.match(/<w:r\b[\s\S]*?<\/w:r>|<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g) || []) {
    if (r.startsWith('<w:hyperlink')) { parts.push(...docxRuns(r.replace(/^<w:hyperlink[^>]*>|<\/w:hyperlink>$/g, ''), imgRel, imgUrl)); continue; }
    const pr = (/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r) || [])[1] || '';
    const bold = /<w:b(\s+w:val="(1|true)")?\s*\/>/.test(pr);
    const ital = /<w:i(\s+w:val="(1|true)")?\s*\/>/.test(pr);
    let t = '';
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
    let m;
    while ((m = re.exec(r))) t += m[1] !== undefined ? dec(m[1]) : m[0].startsWith('<w:tab') ? '\t' : '\n';
    if (t) parts.push({ t, bold, ital });
    for (const b of r.match(/<a:blip\b[^>]*>/g) || []) {
      const target = imgRel[attr(b, 'r:embed')];
      if (target && /^word\/media\//.test(target) && imgUrl) parts.push({ img: imgUrl(target) });
    }
  }
  return parts;
}

function paraInfo(pXml, styles) {
  const pPr = (/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(pXml) || [])[1] || '';
  const sid = (/<w:pStyle\s+w:val="([^"]*)"/.exec(pPr) || [])[1] || '';
  return { level: headingLevel(sid, styles), list: /<w:numPr>/.test(pPr) || /list/.test(styles[sid] || ''), center: /<w:jc\s+w:val="center"/.test(pPr) };
}

// 按顺序走遍正文：段落和表格；回调里拿到每个段落（表格里的段落也算，编号连续）
function walkDocx(zip, onPara, onTable) {
  const doc = text(zip, 'word/document.xml');
  const body = (/<w:body>([\s\S]*)<\/w:body>/.exec(doc) || [])[1] || '';
  let n = 0;
  for (const el of topLevel(body, ['w:p', 'w:tbl', 'w:sdt'])) {
    if (el.tag === 'w:p') onPara(el.xml, n++);
    else if (el.tag === 'w:sdt') {
      const inner = (/<w:sdtContent>([\s\S]*)<\/w:sdtContent>/.exec(el.xml) || [])[1] || '';
      for (const p of topLevel(inner, ['w:p'])) onPara(p.xml, n++);
    } else {
      const rows = [];
      for (const tr of topLevel(el.xml.replace(/^<w:tbl[^>]*>|<\/w:tbl>$/g, ''), ['w:tr'])) {
        const cells = [];
        for (const tc of topLevel(tr.xml.replace(/^<w:tr[^>]*>|<\/w:tr>$/g, ''), ['w:tc'])) {
          const ps = topLevel(tc.xml.replace(/^<w:tc[^>]*>|<\/w:tc>$/g, ''), ['w:p']).map(p => ({ xml: p.xml, n: n++ }));
          cells.push(ps);
        }
        rows.push(cells);
      }
      onTable(rows);
    }
  }
}

const plainOf = runs => runs.map(r => r.t || '').join('');

function docxParts(file) {
  const zip = readZip(file);
  const paras = [];
  walkDocx(zip, (xml, n) => paras.push({ n, t: plainOf(docxRuns(xml, {}, null)).trim() }), rows => {
    for (const cells of rows) {
      const line = cells.map(ps => ps.map(p => plainOf(docxRuns(p.xml, {}, null)).trim()).join(' ')).join(' | ');
      paras.push({ n: cells[0] && cells[0][0] ? cells[0][0].n : 0, t: line });
    }
  });
  // 每 1200 个字左右分一段，方便搜索时告诉你在哪儿
  const parts = [];
  let buf = '', startN = 0, idx = 1;
  for (const p of paras) {
    if (!p.t) continue;
    if (!buf) startN = p.n;
    buf += p.t + '\n';
    if (buf.length > 1200) { parts.push({ label: `第 ${idx++} 部分`, para: startN, text: buf }); buf = ''; }
  }
  if (buf) parts.push({ label: parts.length ? `第 ${idx} 部分` : '', para: startN, text: buf });
  return parts;
}

function runsHtml(runs) {
  return runs.map(r => {
    if (r.img) return `<img src="${esc(r.img)}" alt="">`;
    let h = esc(r.t).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;');
    if (r.bold) h = `<strong>${h}</strong>`;
    if (r.ital) h = `<em>${h}</em>`;
    return h;
  }).join('');
}

function docxHtml(file, imgUrl) {
  const zip = readZip(file);
  const styles = docxStyles(zip);
  const imgRel = rels(zip, 'word/_rels/document.xml.rels', 'word');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  walkDocx(zip, (xml, n) => {
    const info = paraInfo(xml, styles);
    const inner = runsHtml(docxRuns(xml, imgRel, imgUrl));
    if (info.list && !info.level) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li id="p${n}">${inner}</li>`);
      return;
    }
    closeList();
    if (info.level) out.push(`<h${info.level + 1} id="p${n}">${inner}</h${info.level + 1}>`);
    else if (inner.trim()) out.push(`<p id="p${n}"${info.center ? ' style="text-align:center"' : ''}>${inner}</p>`);
    else out.push(`<p id="p${n}" class="empty"></p>`);
  }, rows => {
    closeList();
    out.push('<div class="table-wrap"><table>');
    rows.forEach((cells, ri) => {
      out.push('<tr>' + cells.map(ps => {
        const tag = ri === 0 ? 'th' : 'td';
        return `<${tag}>` + ps.map(p => `<span id="p${p.n}">${runsHtml(docxRuns(p.xml, imgRel, imgUrl))}</span>`).join('<br>') + `</${tag}>`;
      }).join('') + '</tr>');
    });
    out.push('</table></div>');
  });
  closeList();
  return out.join('\n');
}

function docxMarkdown(file) {
  const zip = readZip(file);
  const styles = docxStyles(zip);
  const out = [];
  const md = runs => runs.map(r => {
    if (!r.t) return '';
    let t = r.t.replace(/\t/g, ' ');
    if (r.bold && t.trim()) t = `**${t.trim()}**`;
    return t;
  }).join('').trim();
  walkDocx(zip, xml => {
    const info = paraInfo(xml, styles);
    const t = md(docxRuns(xml, {}, null));
    if (!t) { out.push(''); return; }
    if (info.level) out.push('', '#'.repeat(Math.min(6, info.level + 1)) + ' ' + t.replace(/\*\*/g, ''), '');
    else if (info.list) out.push('- ' + t);
    else out.push(t, '');
  }, rows => {
    const lines = rows.map(cells => '| ' + cells.map(ps => ps.map(p => md(docxRuns(p.xml, {}, null))).join(' ').replace(/\|/g, '/')).join(' | ') + ' |');
    if (lines.length) {
      const cols = rows[0].length || 1;
      lines.splice(1, 0, '|' + ' --- |'.repeat(cols));
      out.push('', ...lines, '');
    }
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ================================================================ Excel

function colIndex(ref) {
  const letters = (/^[A-Z]+/.exec(ref) || ['A'])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function xlsxSheets(file, maxRows = 300, maxCols = 30) {
  const zip = readZip(file);
  const shared = (text(zip, 'xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || [])
    .map(si => (si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => dec(t.replace(/<[^>]+>/g, ''))).join(''));
  const wbRels = rels(zip, 'xl/_rels/workbook.xml.rels', 'xl');
  const sheets = [];
  for (const tag of text(zip, 'xl/workbook.xml').match(/<sheet\b[^>]*>/g) || []) {
    const target = wbRels[attr(tag, 'r:id')];
    const xml = target ? text(zip, target) : '';
    const rows = [];
    let more = false;
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || []) {
      if (rows.length >= maxRows) { more = true; break; }
      const cells = [];
      for (const c of row.match(/<c\b[^>]*\/>|<c\b[\s\S]*?<\/c>/g) || []) {
        const open = c.match(/<c\b[^>]*>/)[0];
        const ci = colIndex(attr(open, 'r'));
        if (ci >= maxCols) continue;
        const t = attr(open, 't');
        let v = (/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1];
        if (t === 's') v = shared[Number(v)] || '';
        else if (t === 'inlineStr') v = (c.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map(x => dec(x.replace(/<[^>]+>/g, ''))).join('');
        else if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else v = v !== undefined ? dec(v) : '';
        if (/^-?\d+\.\d{6,}$/.test(v)) v = String(Math.round(Number(v) * 1e6) / 1e6);
        cells[ci] = v;
      }
      rows.push(Array.from(cells, x => x || ''));
    }
    while (rows.length && !rows[rows.length - 1].some(Boolean)) rows.pop();
    sheets.push({ name: attr(tag, 'name') || `表 ${sheets.length + 1}`, rows, more });
  }
  return sheets;
}

function xlsxParts(file) {
  return xlsxSheets(file, 5000, 60).map((s, i) => ({ label: s.name, sheet: i, text: s.rows.map(r => r.filter(Boolean).join(' ')).filter(Boolean).join('\n') })).filter(p => p.text);
}

function xlsxHtml(file) {
  const sheets = xlsxSheets(file);
  if (!sheets.length) return '<p class="empty-note">这个表格是空的。</p>';
  return sheets.map((s, i) => {
    const width = Math.max(1, ...s.rows.map(r => r.length));
    const body = s.rows.map((r, ri) => '<tr>' + Array.from({ length: width }, (_, ci) => {
      const tag = ri === 0 ? 'th' : 'td';
      return `<${tag}>${esc(r[ci] || '')}</${tag}>`;
    }).join('') + '</tr>').join('');
    return `<h2 id="s${i}">${esc(s.name)}</h2><div class="table-wrap"><table class="sheet">${body}</table></div>${s.more ? '<p class="empty-note">表格太长了，只显示前 300 行。用 Excel 打开能看到全部。</p>' : ''}`;
  }).join('\n');
}

function xlsxMarkdown(file) {
  return xlsxSheets(file, 200, 20).map(s => {
    if (!s.rows.length) return '';
    const width = Math.max(1, ...s.rows.map(r => r.length));
    const line = r => '| ' + Array.from({ length: width }, (_, i) => String(r[i] || '').replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ') + ' |';
    return [`## ${s.name}`, '', line(s.rows[0]), '|' + ' --- |'.repeat(width), ...s.rows.slice(1).map(line), ''].join('\n');
  }).filter(Boolean).join('\n');
}

// ================================================================ PPT

function pptxSlides(file) {
  const zip = readZip(file);
  const names = zip.names().filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  return names.map(n => {
    const xml = text(zip, n);
    const paras = (xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || [])
      .map(p => (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map(t => dec(t.replace(/<[^>]+>/g, ''))).join(''))
      .map(s => s.trim()).filter(Boolean);
    return { paras };
  });
}

function pptxParts(file) {
  return pptxSlides(file).map((s, i) => ({ label: `第 ${i + 1} 页`, page: i + 1, text: s.paras.join('\n') })).filter(p => p.text);
}

function pptxHtml(file) {
  const slides = pptxSlides(file);
  if (!slides.length) return '<p class="empty-note">这个 PPT 里没有找到页面。</p>';
  return slides.map((s, i) => `<section class="slide" id="s${i + 1}"><div class="slide-no">第 ${i + 1} 页</div>${
    s.paras.length ? `<h3>${esc(s.paras[0])}</h3>${s.paras.slice(1).map(p => `<p>${esc(p)}</p>`).join('')}` : '<p class="empty-note">（这一页没有文字）</p>'
  }</section>`).join('\n');
}

function pptxMarkdown(file) {
  return pptxSlides(file).map((s, i) => [`## 第 ${i + 1} 页${s.paras[0] ? '：' + s.paras[0] : ''}`, '', ...s.paras.slice(1).map(p => '- ' + p), ''].join('\n')).join('\n');
}

// ================================================================ 对外

function officeParts(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return docxParts(file);
  if (ext === '.xlsx') return xlsxParts(file);
  if (ext === '.pptx') return pptxParts(file);
  return null;
}

function officeHtml(file, imgUrl) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return docxHtml(file, imgUrl);
  if (ext === '.xlsx') return xlsxHtml(file);
  if (ext === '.pptx') return pptxHtml(file);
  return '';
}

function officeMarkdown(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return docxMarkdown(file);
  if (ext === '.xlsx') return xlsxMarkdown(file);
  if (ext === '.pptx') return pptxMarkdown(file);
  return '';
}

module.exports = { OFFICE_EXT, OLD_OFFICE_EXT, officeParts, officeHtml, officeMarkdown };
