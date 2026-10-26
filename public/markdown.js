// 小型 Markdown 渲染器：标题、列表、任务、代码、引用、表格、图片、链接、粗体、斜体
// 先把所有 HTML 转义，再拼出安全的标签。
(function () {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function safeUrl(u) {
    u = u.trim();
    if (/^(https?:|mailto:|\/|\.\/|#)/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '#';
  }

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    // 此时 s 已经转义过，URL 里不会再有引号或尖括号
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => `<img src="${safeUrl(u)}" alt="${alt}" loading="lazy">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const url = safeUrl(u);
      let plain = url;
      try { plain = decodeURI(url); } catch {}
      const ext = /^https?:/i.test(url) || plain.startsWith('/记忆区/资料/');
      return `<a href="${url}"${ext ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`;
    });
    // 裸网址自动变成链接（跳过已经在链接里的）
    s = s.replace(/(^|[^"'=\w/>])(https?:\/\/[^\s<，。；！？、）】」]+)/g, (_, pre, u) => {
      const tail = /[.,;:!?)]+$/.exec(u);
      const url = tail ? u.slice(0, -tail[0].length) : u;
      return `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>${tail ? tail[0] : ''}`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
    return s;
  }

  function table(rows) {
    const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    return '<div class="table-wrap"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') +
      '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  // 列表，支持缩进的多层列表（缩进 2 个空格以上就算下一层）
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/;
  const indentOf = l => l.replace(/\t/g, '    ').match(/^\s*/)[0].length;

  function itemHtml(text, children) {
    const task = /^\[( |x|X)\]\s+/.exec(text);
    if (task) {
      return `<li class="task"><span class="box${task[1] === ' ' ? '' : ' done'}" aria-hidden="true"></span><span>${inline(text.slice(task[0].length))}${children}</span></li>`;
    }
    return `<li>${inline(text)}${children}</li>`;
  }

  function parseList(lines, i) {
    const first = lines[i];
    const base = indentOf(first);
    const ordered = /^\s*\d/.test(first);
    const startNum = ordered ? parseInt(first, 10) : 1;
    const items = [];
    let cur = null;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) {
        // 空行后面如果还是这个列表（或更深的缩进），就接着读
        let j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= base && (LIST_RE.test(lines[j]) ? true : indentOf(lines[j]) > base)) { i = j; continue; }
        break;
      }
      const ind = indentOf(l);
      const m = LIST_RE.exec(l);
      if (m && ind === base) {
        if (/^\d/.test(m[2]) !== ordered) break;
        cur = { text: l.slice(m[0].length), children: '' };
        items.push(cur);
        i++;
      } else if (m && ind > base && cur) {
        const sub = parseList(lines, i);
        cur.children += sub.html;
        i = sub.next;
      } else if (!m && ind > base && cur) {
        cur.text += ' ' + l.trim();
        i++;
      } else break;
    }
    const lis = items.map(it => itemHtml(it.text, it.children)).join('');
    return {
      html: ordered ? `<ol${startNum > 1 ? ` start="${startNum}"` : ''}>${lis}</ol>` : `<ul>${lis}</ul>`,
      next: i,
    };
  }

  function render(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^\s*$/.test(line)) { i++; continue; }

      if ((m = /^```\s*(\S*)/.exec(line))) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<div class="code"><button class="copy" type="button">复制</button><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
        continue;
      }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        const lv = m[1].length;
        out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
        i++;
        continue;
      }
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const buf = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) buf.push(lines[i++]);
        out.push(table(buf));
        continue;
      }
      if (LIST_RE.test(line)) {
        const r = parseList(lines, i);
        out.push(r.html);
        i = r.next;
        continue;
      }
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) { buf.push(lines[i++]); }
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
    return out.join('\n');
  }

  window.renderMarkdown = render;
})();
