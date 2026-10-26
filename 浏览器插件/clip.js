// 百宝匣剪藏：从网页里找出正文，转成 Markdown。
// 这个文件会被注入到当前网页里运行，只读取页面内容，不修改页面。
/* eslint-disable no-unused-vars */
function baibaoxiaExtract(selectionOnly) {
  const abs = u => { try { return new URL(u, location.href).href; } catch { return ''; } };

  // ---- 找正文所在的元素：哪里的段落文字最多就是哪里
  function findMain() {
    const scores = new Map();
    const add = (el, n) => { if (el && el !== document.body && el !== document.documentElement) scores.set(el, (scores.get(el) || 0) + n); };
    for (const p of document.querySelectorAll('p, pre, li, h2, h3, blockquote, td')) {
      const len = (p.innerText || '').trim().length;
      if (len < 20) continue;
      add(p.parentElement, len);
      if (p.parentElement) add(p.parentElement.parentElement, len / 2);
    }
    let best = null, bestScore = 0;
    for (const [el, sc] of scores) {
      // 链接太多的是导航栏、推荐列表，不是正文
      const text = (el.innerText || '').length || 1;
      const linkText = [...el.querySelectorAll('a')].reduce((n, a) => n + (a.innerText || '').length, 0);
      const s = sc * (1 - Math.min(0.9, linkText / text));
      if (s > bestScore) { best = el; bestScore = s; }
    }
    if (!best) return document.querySelector('article, main, [role=main]') || document.body;
    const art = best.closest('article, main, [role=main]');
    if (art && (art.innerText || '').length < (best.innerText || '').length * 3) return art;
    return best;
  }

  const DROP = 'script, style, noscript, iframe, form, button, input, select, textarea, nav, aside, footer, svg, canvas, video, audio, '
    + '[aria-hidden="true"], [hidden], .comment, .comments, [id*="comment"], [class*="comment-"], [class*="share"], [class*="recommend"], '
    + '[class*="related"], [class*="advert"], [class*="sidebar"], [class*="toolbar"], [class*="breadcrumb"], .ad, .ads';

  // ---- HTML 转 Markdown
  function inline(node) {
    let out = '';
    for (const c of node.childNodes) out += conv(c, 0, true);
    return out.replace(/[ \t\n]+/g, ' ').trim();
  }

  function imgSrc(img) {
    const cand = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-actualsrc')
      || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
    if (cand && !cand.startsWith('data:')) return abs(cand);
    const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (ss) return abs(ss.split(',').pop().trim().split(/\s+/)[0]);
    return '';
  }

  function table(t) {
    const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(td => inline(td).replace(/\|/g, '\\|') || ' '));
    if (!rows.length) return '';
    const n = Math.max(...rows.map(r => r.length));
    const line = r => '| ' + Array.from({ length: n }, (_, i) => r[i] || ' ').join(' | ') + ' |';
    return '\n\n' + line(rows[0]) + '\n|' + ' --- |'.repeat(n) + '\n' + rows.slice(1).map(line).join('\n') + '\n\n';
  }

  function conv(node, depth, inInline) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const kids = () => { let s = ''; for (const c of node.childNodes) s += conv(c, depth, inInline); return s; };
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const t = inline(node);
        return t ? `\n\n${'#'.repeat(Math.min(4, Number(tag[1]) + 1))} ${t}\n\n` : '';
      }
      case 'p': case 'section': case 'div': case 'article': case 'main': case 'header': case 'figure': {
        const s = kids();
        return s.trim() ? `\n\n${s.trim()}\n\n` : '';
      }
      case 'figcaption': { const t = inline(node); return t ? `\n\n*${t}*\n\n` : ''; }
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': { const t = inline(node); return t ? `**${t}**` : ''; }
      case 'em': case 'i': { const t = inline(node); return t ? `*${t}*` : ''; }
      case 'del': case 's': { const t = inline(node); return t ? `~~${t}~~` : ''; }
      case 'code': return node.closest('pre') ? node.textContent : '`' + node.textContent.replace(/`/g, '') + '`';
      case 'pre': return '\n\n```\n' + node.innerText.replace(/\n+$/, '') + '\n```\n\n';
      case 'a': {
        const t = inline(node);
        const href = node.getAttribute('href') || '';
        if (!t) return kids();
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return t;
        return `[${t}](${abs(href)})`;
      }
      case 'img': {
        const src = imgSrc(node);
        if (!src) return '';
        const w = Number(node.getAttribute('width')) || node.naturalWidth || 100;
        if (w && w < 24) return ''; // 小图标、表情
        return `\n\n![${(node.getAttribute('alt') || '').replace(/[\[\]]/g, '')}](${src})\n\n`;
      }
      case 'picture': { const img = node.querySelector('img'); return img ? conv(img, depth) : ''; }
      case 'blockquote': {
        const s = kids().trim().split('\n').map(l => '> ' + l).join('\n');
        return `\n\n${s}\n\n`;
      }
      case 'ul': case 'ol': {
        let i = 0, s = '\n';
        for (const li of node.children) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          i++;
          const mark = tag === 'ol' ? `${i}. ` : '- ';
          let body = '';
          for (const c of li.childNodes) {
            const t = c.nodeType === 1 ? c.tagName.toLowerCase() : '';
            body += (t === 'ul' || t === 'ol') ? conv(c, depth + 1) : conv(c, depth + 1, true);
          }
          const lines = body.replace(/\n{3,}/g, '\n\n').trim().split('\n');
          s += '  '.repeat(depth) + mark + lines[0].trim() + '\n' + lines.slice(1).filter(l => l.trim()).map(l => (/^\s*([-*]|\d+\.)\s/.test(l) ? l : '  '.repeat(depth + 1) + l.trim())).join('\n') + (lines.length > 1 ? '\n' : '');
        }
        return depth ? s : s + '\n';
      }
      case 'table': return table(node);
      default: return kids();
    }
  }

  let root;
  const sel = window.getSelection();
  if (selectionOnly && sel && sel.rangeCount && sel.toString().trim()) {
    root = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) root.appendChild(sel.getRangeAt(i).cloneContents());
  } else {
    root = findMain().cloneNode(true);
    root.querySelectorAll(DROP).forEach(el => el.remove());
  }
  // 懒加载图片：把真实地址先拿出来
  root.querySelectorAll('img').forEach(img => { const s = imgSrc(img); if (s) img.setAttribute('src', s); });

  let md = conv(root, 0).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const meta = n => (document.querySelector(`meta[property="${n}"], meta[name="${n}"]`) || {}).content;
  let title = meta('og:title') || (document.querySelector('h1') || {}).innerText || document.title || location.hostname;
  title = String(title).replace(/\s+/g, ' ').trim().slice(0, 80);
  // 正文开头就是标题时去掉，免得重复
  md = md.replace(new RegExp('^#+\\s*' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n+'), '');
  return { title, url: location.href, site: location.hostname.replace(/^www\./, ''), markdown: md, chars: md.length };
}
