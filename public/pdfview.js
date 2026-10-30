/* 百宝匣 PDF 阅读器（0.20）
 * 选中文字 → 划线 / 贴便签；双击空白处 → 单独一张便签；手写；便签贴在书页右边，对齐到原文。
 * 批注先存在百宝匣（记忆区/批注/），再由后台写进 PDF 文件本身，别的阅读器打开也看得到。
 * 坐标一律存 PDF 自己的坐标（左下角为原点），缩放、换电脑都不会错位。
 */
(function () {
  'use strict';
  const B = () => window.bbx;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const HL = ['yellow', 'green', 'blue', 'pink'];
  const INK = ['red', 'blue', 'black', 'green'];
  const NAMES = { yellow: '黄', green: '绿', blue: '蓝', pink: '粉', red: '红', black: '黑' };
  const GAP = 18;         // 页与页之间
  const SIDE = 280;       // 便签栏宽
  const SIDE_MIN = 36;    // 收起时
  const WIDE = 420;       // 展开宽一点的便签
  const FAR = 150;        // 被挤开超过这么远就收成小标签
  let S = null;           // 当前打开的这份
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ------------------------------------------------------------ 打开 / 关闭

  async function open(name, { page = null, word = '', focus = null } = {}) {
    const b = B();
    if (S && S.name === name && b.state.view === 'pdf') {
      if (word) S.word = word;
      if (focus) return focusItem(focus);
      if (page) goPage(page, { word });
      return;
    }
    if (S) close();
    if (b.state.view !== 'pdf') b.state.pdfFrom = b.state.view;
    b.setView('pdf', { push: false });
    const view = $('#view-pdf');
    const pos = lsGet('bb-pdf-pos:' + name, null);
    S = {
      name, items: [], foreign: [], ours: new Set(), pages: [],
      scale: lsGet('bb-pdf-scale', 0) || 0, side: lsGet('bb-pdf-side', true),
      mode: 'read', inkColor: lsGet('bb-pdf-ink', 'red'), inkWidth: 2, lastColor: lsGet('bb-pdf-color', 'yellow'),
      active: null, editing: null, word, undo: [], saveTimer: null, saving: false, status: '',
      startPage: page || (pos && pos.page) || 1, startRatio: page ? 0 : (pos && pos.ratio) || 0,
      focusId: focus, seq: 0,
    };
    const me = S;
    view.innerHTML = shell();
    $('#pv-title').textContent = name;
    status('正在打开…');
    const meta = await b.api('/api/pdfnotes?name=' + enc(name));
    if (S !== me) return;
    if (!meta.ok) { b.toast(meta.message || '打不开'); return back(); }
    S.items = meta.items || [];
    S.ours = new Set(meta.ours || []);
    S.writeToFile = meta.writeToFile !== false;
    S.wrote = meta.wrote;
    S.exported = meta.exported;
    let lib;
    try {
      lib = await b.loadPdfjs();
      S.lib = lib;
      S.task = lib.getDocument({
        url: b.fileUrl(name), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, isEvalSupported: false,
        disableAutoFetch: true, rangeChunkSize: 1 << 20,
      });
      S.task.onProgress = p => { if (S === me && p.total && !S.doc) status(`正在读取 ${Math.round(p.loaded / p.total * 100)}%`); };
      S.doc = await S.task.promise;
    } catch (e) {
      if (S !== me) return;
      const pw = e && e.name === 'PasswordException';
      $('#pv-scroll').innerHTML = `<div class="pv-fail"><p>${pw ? '这份 PDF 有密码，百宝匣打不开。' : '这份 PDF 打不开：' + esc(e && e.message || e)}</p>
        <button class="btn" data-pv="system">用系统软件打开</button></div>`;
      status('');
      return;
    }
    if (S !== me) return;
    const p1 = await S.doc.getPage(1);
    const v1 = p1.getViewport({ scale: 1 });
    for (let i = 1; i <= S.doc.numPages; i++) S.pages.push({ n: i, w: v1.width, h: v1.height, page: i === 1 ? p1 : null, el: null });
    if (!S.scale) S.scale = fitScale();
    $('#pv-total').textContent = S.doc.numPages;
    buildPages();
    status(saveText());
    paintAll();
    requestAnimationFrame(() => {
      if (S !== me) return;
      if (S.focusId) return focusItem(S.focusId);
      goPage(S.startPage, { ratio: S.startRatio, word: S.word, instant: true });
    });
  }

  function close() {
    if (!S) return;
    const s = S;
    S = null;
    savePos(s);
    if (s.saveTimer) { clearTimeout(s.saveTimer); putItems(s); }
    if (s.dirtyFile) B().api('/api/pdfnotes/flush?name=' + enc(s.name), { method: 'POST' });
    if (s.io) s.io.disconnect();
    try { s.task && s.task.destroy(); } catch {}
    hideBars();
    const v = $('#view-pdf');
    if (v) v.innerHTML = '';
  }

  function back() {
    const b = B();
    const to = b.state.pdfFrom && !['search', 'pdf', 'reader'].includes(b.state.pdfFrom) ? b.state.pdfFrom : 'memory';
    b.setView(to);
  }

  function shell() {
    return `<div class="pv-bar">
      <button class="btn ghost" data-pv="back">← 返回</button>
      <div class="pv-name"><strong id="pv-title"></strong><span id="pv-status" class="pv-status"></span></div>
      <label class="pv-find"><span class="sr">在这份 PDF 里找</span><input id="pv-find" type="search" placeholder="在这份 PDF 里找  Ctrl+F" autocomplete="off"></label>
      <span class="pv-pageno"><input id="pv-page" inputmode="numeric" aria-label="第几页" value="1"> / <span id="pv-total">…</span></span>
      <button class="btn ghost small" data-pv="zoom-out" aria-label="缩小">−</button>
      <button class="btn ghost small" data-pv="fit" title="适合宽度"><span id="pv-zoom">100%</span></button>
      <button class="btn ghost small" data-pv="zoom-in" aria-label="放大">+</button>
      <button class="btn ghost" data-pv="ink" aria-pressed="false" title="手写批注">手写</button>
      <button class="btn ghost" data-pv="side" aria-pressed="true">便签贴在旁边</button>
      <button class="btn ghost" data-pv="list">全部便签 <span id="pv-count" class="pv-count"></span></button>
      <button class="btn ghost" data-pv="menu" aria-label="更多">⋯</button>
    </div>
    <div class="pv-inkbar" hidden>
      <span>笔的颜色</span>${INK.map(c => `<button class="pv-dot c-${c}" data-ink-color="${c}" aria-label="${NAMES[c]}色"></button>`).join('')}
      <span>粗细</span>${[1.2, 2, 3.5].map(w => `<button class="pv-w" data-ink-width="${w}" aria-label="粗细 ${w}"><i style="height:${w + 1}px"></i></button>`).join('')}
      <button class="btn ghost small" data-pv="eraser" aria-pressed="false">橡皮</button>
      <button class="btn ghost small" data-pv="undo">撤销</button>
      <button class="btn small" data-pv="ink">写完了</button>
    </div>
    <div id="pv-scroll" class="pv-scroll" tabindex="-1"><div id="pv-wrap" class="pv-wrap"><div id="pv-pages" class="pv-pages"></div><div id="pv-side" class="pv-side"></div><svg id="pv-links" class="pv-links" aria-hidden="true"></svg></div></div>
    <div id="pv-found" class="pv-found" hidden></div>
    <aside id="pv-list" class="pv-list" hidden></aside>
    <div id="pv-menu" class="pv-menu" hidden></div>`;
  }

  // ------------------------------------------------------------ 页面布局

  function fitScale() {
    const sc = $('#pv-scroll');
    const avail = (sc ? sc.clientWidth : 900) - (S.side ? SIDE : SIDE_MIN) - 40;
    const w = S.pages[0] ? S.pages[0].w : 600;
    return Math.max(0.5, Math.min(1.6, Math.floor(avail / w * 20) / 20));
  }

  function buildPages() {
    const box = $('#pv-pages');
    box.innerHTML = '';
    if (S.io) S.io.disconnect();
    S.io = new IntersectionObserver(es => {
      for (const e of es) {
        const pg = S && S.pages[Number(e.target.dataset.n) - 1];
        if (!pg) continue;
        pg.visible = e.isIntersecting;
        if (e.isIntersecting) renderPage(pg);
      }
      trimPages();
    }, { root: $('#pv-scroll'), rootMargin: '900px 0px' });
    const frag = document.createDocumentFragment();
    for (const pg of S.pages) {
      const el = document.createElement('div');
      el.className = 'pv-page';
      el.dataset.n = pg.n;
      el.innerHTML = `<div class="pv-num">${pg.n}</div>`;
      pg.el = el;
      pg.rendered = 0;
      frag.appendChild(el);
      S.io.observe(el);
    }
    box.appendChild(frag);
    sizePages();
  }

  function sizePages() {
    let top = 0;
    let maxW = 0;
    for (const pg of S.pages) {
      const w = Math.round(pg.w * S.scale), h = Math.round(pg.h * S.scale);
      pg.top = top;
      pg.pw = w; pg.ph = h;
      pg.el.style.width = w + 'px';
      pg.el.style.height = h + 'px';
      pg.el.style.setProperty('--scale-factor', S.scale);
      top += h + GAP;
      maxW = Math.max(maxW, w);
    }
    S.pagesW = maxW;
    const wrap = $('#pv-wrap');
    const side = S.side ? SIDE : SIDE_MIN;
    wrap.style.width = maxW + side + 24 + 'px';
    wrap.style.height = top + 'px';
    $('#pv-pages').style.width = maxW + 'px';
    $('#pv-side').style.left = maxW + 24 + 'px';
    $('#pv-side').style.width = side + 'px';
    $('#pv-zoom').textContent = Math.round(S.scale * 100) + '%';
    const sb = $('[data-pv=side]');
    sb.setAttribute('aria-pressed', String(S.side));
    sb.textContent = S.side ? '便签贴在旁边' : '便签收起了';
    $('#view-pdf').classList.toggle('pv-folded', !S.side);
  }

  // 只留视线附近的页面在内存里，几百页的书也不卡
  function trimPages() {
    if (!S) return;
    const live = S.pages.filter(p => p.rendered);
    if (live.length <= 14) return;
    const cur = curPage();
    live.sort((a, b) => Math.abs(b.n - cur) - Math.abs(a.n - cur));
    for (const pg of live.slice(0, live.length - 14)) if (!pg.visible) unrender(pg);
  }
  function unrender(pg) {
    pg.rendered = 0;
    pg.vp = null;
    if (pg.task) { try { pg.task.cancel(); } catch {} pg.task = null; }
    const c = pg.el.querySelector('canvas');
    if (c) { c.width = c.height = 0; }
    pg.el.innerHTML = `<div class="pv-num">${pg.n}</div>`;
  }

  async function renderPage(pg) {
    if (!S || pg.rendered === S.scale || pg.busy) return;
    const me = S;
    const scale = S.scale;
    pg.busy = true;
    try {
      const page = pg.page || (pg.page = await S.doc.getPage(pg.n));
      if (S !== me) return;
      const v1 = page.getViewport({ scale: 1 });
      if (Math.abs(v1.width - pg.w) > 0.5 || Math.abs(v1.height - pg.h) > 0.5) {
        pg.w = v1.width; pg.h = v1.height;
        const before = S.pages.indexOf(pg) < curPage() - 1;
        const st = $('#pv-scroll').scrollTop;
        const oldTop = before ? pg.top + pg.ph : 0;
        sizePages();
        if (before) $('#pv-scroll').scrollTop = st + (pg.top + pg.ph - oldTop);
        layoutNotes();
      }
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.className = 'pv-canvas';
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      const task = page.render({
        canvasContext: canvas.getContext('2d'), viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        annotationMode: S.lib.AnnotationMode.DISABLE,
      });
      pg.task = task;
      await task.promise;
      pg.task = null;
      if (S !== me || scale !== S.scale) return;
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      const marks = document.createElement('div');
      marks.className = 'pv-marks';
      const top = document.createElement('div');
      top.className = 'pv-top';
      const capture = document.createElement('div');
      capture.className = 'pv-capture';
      pg.el.innerHTML = '';
      pg.el.append(canvas, marks, tl, top, capture);
      pg.vp = vp;
      pg.rendered = scale;
      try {
        const layer = new S.lib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
        await layer.render();
      } catch {}
      if (S !== me) return;
      if (!pg.foreignDone) {
        pg.foreignDone = true;
        try { addForeign(pg, await page.getAnnotations({ intent: 'display' })); } catch {}
        if (S !== me) return;
        if (S.foreign.some(f => f.page === pg.n && f.note)) { layoutNotes(); updateCount(); }
      }
      paintPage(pg);
      if (S.word && pg.n === S.wordPage) markWord(pg);
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
    } finally {
      pg.busy = false;
    }
    if (S === me && pg.rendered !== S.scale && pg.visible) renderPage(pg);
  }

  // ------------------------------------------------------------ 别的软件做的批注（只看不改）

  function rgbOf(c) {
    if (!c || c.length < 3) return 'rgb(255,214,90)';
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function addForeign(pg, annots) {
    for (const a of annots || []) {
      if (S.ours.has(a.id) || /^bbx-/.test(a.annotationName || '')) continue;
      const st = a.subtype;
      if (['Link', 'Popup', 'Widget'].includes(st)) continue;
      const f = { id: 'f:' + a.id, foreign: true, page: pg.n, sub: st, css: rgbOf(a.color), author: (a.titleObj && a.titleObj.str) || '', note: (a.contentsObj && a.contentsObj.str) || '' };
      if (['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(st) && a.quadPoints) {
        const q = Array.from(a.quadPoints);
        const flat = typeof q[0] === 'object' ? q.flatMap(p => [p.x, p.y]) : q;
        f.rects = [];
        for (let i = 0; i + 7 < flat.length; i += 8) {
          const xs = [flat[i], flat[i + 2], flat[i + 4], flat[i + 6]], ys = [flat[i + 1], flat[i + 3], flat[i + 5], flat[i + 7]];
          f.rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        }
        f.type = 'highlight';
      } else if (st === 'Ink' && a.inkLists) {
        f.type = 'ink';
        f.paths = a.inkLists.map(l => {
          const arr = Array.from(l);
          return typeof arr[0] === 'object' ? arr.map(p => [p.x, p.y]) : arr.reduce((o, v, i) => (i % 2 ? o[o.length - 1].push(v) : o.push([v]), o), []);
        });
        f.width = (a.borderStyle && a.borderStyle.width) || 1.5;
      } else {
        f.type = 'note';
        f.at = [a.rect[0], a.rect[3]];
        f.box = a.rect;
      }
      if (!f.rects && f.type === 'highlight') continue;
      S.foreign.push(f);
    }
  }

  // ------------------------------------------------------------ 画批注

  const vpRect = (vp, r) => {
    const [a, b, c, d] = vp.convertToViewportRectangle(r);
    return [Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b)];
  };
  const allItems = () => S.items.concat(S.foreign);

  function paintAll() { for (const pg of S.pages) if (pg.rendered) paintPage(pg); layoutNotes(); updateCount(); }

  function paintPage(pg) {
    if (!pg.vp) return;
    const vp = pg.vp;
    const marks = pg.el.querySelector('.pv-marks');
    const top = pg.el.querySelector('.pv-top');
    if (!marks || !top) return;
    let mh = '', svg = '', icons = '';
    for (const it of allItems()) {
      if (it.page !== pg.n) continue;
      const on = S.active === it.id ? ' on' : '';
      if (it.type === 'highlight') {
        for (const r of it.rects) {
          const [x, y, w, h] = vpRect(vp, r);
          const line = it.foreign && it.sub !== 'Highlight';
          mh += `<i class="pv-hl c-${it.color || 'x'}${line ? ' line' : ''}${on}" data-id="${esc(it.id)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;${it.foreign ? '--c:' + it.css : ''}"></i>`;
        }
      } else if (it.type === 'ink') {
        const d = it.paths.map(p => p.map((pt, i) => {
          const [x, y] = vp.convertToViewportPoint(pt[0], pt[1]);
          return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        }).join('')).join('');
        svg += `<path class="pv-ink c-${it.color || 'x'}${on}" data-id="${esc(it.id)}" d="${d}" stroke-width="${(it.width || 2) * vp.scale}" ${it.foreign ? `style="stroke:${it.css}"` : ''}/>`;
      } else if (it.type === 'note') {
        const [x, y] = vp.convertToViewportPoint(it.at[0], it.at[1]);
        icons += `<button class="pv-pin c-${it.color || 'x'}${on}${it.foreign ? ' foreign' : ''}" data-id="${esc(it.id)}" style="left:${x}px;top:${y}px;${it.foreign ? '--c:' + it.css : ''}" aria-label="便签"></button>`;
      }
    }
    marks.innerHTML = mh;
    top.innerHTML = `<svg class="pv-inksvg" width="${pg.pw}" height="${pg.ph}">${svg}</svg>${icons}`;
  }

  // ------------------------------------------------------------ 便签栏

  // 每条批注在页面上的锚点（相对整个书页列）
  function anchorOf(it) {
    const pg = S.pages[it.page - 1];
    if (!pg) return null;
    const vp = pg.vp || { convertToViewportPoint: (x, y) => [x * S.scale, (pg.h - y) * S.scale], convertToViewportRectangle: r => [r[0] * S.scale, (pg.h - r[1]) * S.scale, r[2] * S.scale, (pg.h - r[3]) * S.scale] };
    let x, y;
    if (it.type === 'highlight') {
      const rs = it.rects.map(r => vpRect(vp, r));
      const first = rs.reduce((a, r) => (r[1] < a[1] - 2 || (Math.abs(r[1] - a[1]) <= 2 && r[0] + r[2] > a[0] + a[2]) ? r : a), rs[0]);
      x = first[0] + first[2]; y = first[1];
    } else if (it.type === 'note') {
      [x, y] = vp.convertToViewportPoint(it.at[0], it.at[1]);
      x += 18;
    } else {
      let maxX = -1e9, minY = 1e9;
      for (const p of it.paths) for (const pt of p) { const [a, b] = vp.convertToViewportPoint(pt[0], pt[1]); maxX = Math.max(maxX, a); minY = Math.min(minY, b); }
      x = maxX; y = minY;
    }
    const off = (S.pagesW - pg.pw) / 2;
    return { x: off + x, y: pg.top + y };
  }

  const hasCard = it => it.type === 'note' || !!it.note || S.editing === it.id;

  // 便签栏：卡片按原文的高度对齐，挤不下往下推；已有的卡片原地更新，正在打字的那张绝不重建（不然输入法打到一半会丢字）
  const dyOf = it => (it.foreign ? (S.fdy && S.fdy[it.id]) : it.dy) || 0;
  function layoutNotes() {
    if (!S || !S.pages.length) return;
    const side = $('#pv-side');
    const cards = allItems().filter(hasCard).map(it => ({ it, a: anchorOf(it) })).filter(c => c.a);
    cards.forEach(c => { c.want = c.a.y - 10 + dyOf(c.it); });
    cards.sort((p, q) => p.want - q.want || p.a.x - q.a.x);
    const keep = new Map([...side.children].map(el => [el.dataset.id, el]));
    const els = cards.map(({ it }) => {
      let el = keep.get(it.id);
      keep.delete(it.id);
      const sig = cardSig(it);
      const typing = el && el.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
      if (!el || (el.dataset.sig !== sig && !typing)) {
        const t = document.createElement('div');
        t.innerHTML = cardHtml(it);
        const n = t.firstElementChild;
        if (el) el.replaceWith(n); else side.appendChild(n);
        el = n;
      }
      el.dataset.sig = sig;
      el.className = cardClass(it);
      return el;
    });
    for (const el of keep.values()) el.remove();
    let bottom = -1e9;
    const links = [];
    // 展开宽一点：右边有空就往右伸，没空就往左压一点在书页边上
    const sc = $('#pv-scroll');
    const room = sc.clientWidth - ($('#pv-wrap').offsetLeft + S.pagesW + 24) - 16;
    const wideW = Math.max(300, Math.min(WIDE, room));
    const wideL = Math.min(0, room - wideW);
    cards.forEach((c, i) => {
      const el = els[i];
      const focus = S.active === c.it.id || S.editing === c.it.id;
      const top = Math.max(c.want, bottom + 8);
      if (!S.side && !focus) el.classList.add('tab');
      else if (S.side && top - c.want > FAR && !focus && !c.it.wide) el.classList.add('tab');
      el.style.top = top + 'px';
      if (c.it.wide && S.side) { el.style.width = wideW + 'px'; el.style.left = wideL + 'px'; } else { el.style.width = ''; el.style.left = ''; }
      const h = el.offsetHeight;
      if (S.side || !focus) bottom = top + h;
      if (S.side && !el.classList.contains('tab')) links.push({ it: c.it, a: c.a, y: top + 16, on: focus, x: c.it.wide ? wideL : 0 });
    });
    drawLinks(links);
    if (S.editing) {
      const ta = side.querySelector(`.pv-card[data-id="${CSS.escape(S.editing)}"] textarea`);
      const busy = document.activeElement && document.activeElement.closest && document.activeElement.closest('input, textarea') && document.activeElement !== ta;
      if (ta && document.activeElement !== ta && !busy) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
    side.querySelectorAll('textarea').forEach(autoGrow);
  }

  const cardSig = it => JSON.stringify([it.note || '', it.text || '', it.color, it.page, !!it.wide]);
  const cardClass = it => `pv-card c-${it.color || 'x'}${S.active === it.id || S.editing === it.id ? ' on' : ''}${it.foreign ? ' foreign' : ''}${it.wide ? ' wide' : ''}`;

  function cardHtml(it) {
    const col = it.foreign ? `style="--c:${it.css}"` : '';
    const quote = it.type === 'highlight' && it.text ? `<div class="pv-quote">${esc(it.text.length > 80 ? it.text.slice(0, 80) + '…' : it.text)}</div>` : '';
    const first = (it.note || '').split('\n')[0] || (it.type === 'note' ? '空便签' : '…');
    const body = it.foreign
      ? `<div class="pv-ro">${esc(it.note)}</div><div class="pv-by">${esc(it.author || '别的阅读器')}的批注 · 只能看</div>`
      : `<textarea rows="1" placeholder="写点什么…" aria-label="便签内容">${esc(it.note || '')}</textarea>`;
    return `<div class="${cardClass(it)}" data-id="${esc(it.id)}" ${col}>
      <div class="pv-tabtext">${esc(first.slice(0, 16))}</div>
      <div class="pv-cardin">
        <div class="pv-cardhead" title="按住这里可以上下拖动"><span class="pv-grip" aria-hidden="true"></span><span class="pv-pg">第 ${it.page} 页</span>
          <button class="pv-x" data-wide="${esc(it.id)}" aria-label="${it.wide ? '收窄' : '展开宽一点'}" title="${it.wide ? '收窄' : '展开宽一点'}">${it.wide ? '⇤' : '⇥'}</button>
          ${it.foreign ? '' : `<button class="pv-x" data-del="${esc(it.id)}" aria-label="删掉这张便签" title="删掉">×</button>`}</div>
        ${quote}${body}
      </div></div>`;
  }

  function drawLinks(links) {
    const svg = $('#pv-links');
    const wrap = $('#pv-wrap');
    svg.setAttribute('width', wrap.offsetWidth);
    svg.setAttribute('height', wrap.offsetHeight);
    const sx = S.pagesW + 24;
    svg.innerHTML = links.map(l => {
      const mx = (l.a.x + sx) / 2;
      const ex = sx + (l.x || 0);
      return `<path class="${l.on ? 'on ' : ''}c-${l.it.color || 'x'}" ${l.it.foreign ? `style="stroke:${l.it.css}"` : ''} d="M${l.a.x.toFixed(1)} ${l.a.y.toFixed(1)} C${mx} ${l.a.y.toFixed(1)}, ${mx} ${l.y}, ${ex} ${l.y}"/>`;
    }).join('');
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
    const c = ta.closest('.pv-card');
    if (c) c.classList.toggle('long', ta.scrollHeight > 165);
  }

  function updateCount() {
    const n = S.items.filter(it => it.note || it.type !== 'highlight' || it.text).length;
    const el = $('#pv-count');
    if (el) el.textContent = n ? n : '';
  }

  // ------------------------------------------------------------ 改动与保存

  function snapshot() {
    S.undo.push(JSON.stringify(S.items));
    if (S.undo.length > 60) S.undo.shift();
  }
  function changed({ repaint = [], layout = true } = {}) {
    for (const n of new Set(repaint)) { const pg = S.pages[n - 1]; if (pg && pg.rendered) paintPage(pg); }
    if (layout) layoutNotes();
    updateCount();
    S.dirtyFile = true;
    clearTimeout(S.saveTimer);
    status('正在保存…');
    S.saveTimer = setTimeout(() => putItems(S), 700);
  }
  async function putItems(s) {
    if (!s) return;
    s.saveTimer = null;
    const items = s.items.filter(it => !(it.type === 'note' && !it.note && s.editing !== it.id));
    const r = await B().api('/api/pdfnotes?name=' + enc(s.name), { method: 'PUT', json: { items } });
    if (s !== S) return;
    if (r.ok) { S.wrote = S.wrote && { ...S.wrote, rev: -1 }; status(saveText(true)); }
    else status('没保存上：' + (r.message || ''), true);
  }
  function saveText(justSaved) {
    if (!S.items.length) return '';
    if (!S.writeToFile) return justSaved ? '已保存（只存在百宝匣）' : '批注只存在百宝匣';
    if (S.wrote && S.wrote.error) return '没能写进 PDF：' + S.wrote.error;
    return justSaved ? '已保存 · 稍后写进 PDF' : '批注已写进 PDF';
  }
  function status(t, bad) {
    const el = $('#pv-status');
    if (!el) return;
    el.textContent = t || '';
    el.classList.toggle('bad', !!bad);
  }

  function addItem(it) {
    snapshot();
    it.id = it.id || uid();
    it.created = it.updated = Date.now();
    S.items.push(it);
    return it;
  }
  function removeItem(id) {
    const it = S.items.find(x => x.id === id);
    if (!it) return;
    snapshot();
    S.items = S.items.filter(x => x !== it);
    if (S.active === id) S.active = null;
    if (S.editing === id) S.editing = null;
    hideBars();
    changed({ repaint: [it.page] });
  }
  function undo() {
    const last = S.undo.pop();
    if (!last) return B().toast('没有可以撤销的了');
    const old = S.items;
    S.items = JSON.parse(last);
    S.editing = null;
    const pages = new Set([...old, ...S.items].map(x => x.page));
    changed({ repaint: [...pages] });
  }

  // ------------------------------------------------------------ 选中文字

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startPage = range.startContainer.parentElement && range.startContainer.parentElement.closest('.pv-page');
    if (!startPage || !$('#pv-pages').contains(startPage)) return null;
    const text = cleanText(sel.toString());
    if (!text) return null;
    const byPage = new Map();
    for (const r of range.getClientRects()) {
      if (r.width < 1.5 || r.height < 2) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const pg = S.pages.find(p => p.vp && (() => { const b = p.el.getBoundingClientRect(); return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom; })());
      if (!pg) continue;
      const b = pg.el.getBoundingClientRect();
      const list = byPage.get(pg) || [];
      list.push([r.left - b.left, r.top - b.top, r.width, r.height]);
      byPage.set(pg, list);
    }
    if (!byPage.size) return null;
    const out = [];
    for (const [pg, list] of byPage) {
      const rects = mergeLines(list).map(([x, y, w, h]) => {
        const p1 = pg.vp.convertToPdfPoint(x, y), p2 = pg.vp.convertToPdfPoint(x + w, y + h);
        return [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])].map(v => Math.round(v * 100) / 100);
      });
      out.push({ page: pg.n, rects });
    }
    const last = [...range.getClientRects()].filter(r => r.width > 1).pop();
    return { text, parts: out, box: last || range.getBoundingClientRect() };
  }
  // 同一行上的小方块合成一块
  function mergeLines(list) {
    list.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const out = [];
    for (const r of list) {
      const p = out[out.length - 1];
      if (p && Math.abs(p[1] - r[1]) < Math.max(p[3], r[3]) * 0.5 && r[0] <= p[0] + p[2] + Math.max(p[3], r[3]) * 1.2) {
        const x1 = Math.min(p[0], r[0]), y1 = Math.min(p[1], r[1]);
        const x2 = Math.max(p[0] + p[2], r[0] + r[2]), y2 = Math.max(p[1] + p[3], r[1] + r[3]);
        p[0] = x1; p[1] = y1; p[2] = x2 - x1; p[3] = y2 - y1;
      } else out.push(r.slice());
    }
    return out;
  }
  function cleanText(t) {
    const cjk = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;
    return String(t || '').split(/\s*\n\s*/).reduce((a, b) => {
      if (!a) return b;
      if (!b) return a;
      if (cjk.test(a.slice(-1)) || cjk.test(b[0])) return a + b;
      if (a.endsWith('-')) return a.slice(0, -1) + b;
      return a + ' ' + b;
    }, '').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 3000);
  }

  function showSelBar(info) {
    const bar = ensureBar('pv-selbar');
    bar.innerHTML = HL.map(c => `<button class="pv-dot c-${c}${c === S.lastColor ? ' cur' : ''}" data-hl="${c}" aria-label="划${NAMES[c]}色"></button>`).join('')
      + `<span class="pv-sep"></span><button data-sel="note">贴便签</button><button data-sel="ask">问${esc(B().butlerName())}</button><button data-sel="copy">复制</button>`;
    bar.hidden = false;
    S.sel = info;
    placeBar(bar, info.box);
  }
  function ensureBar(id) {
    let bar = document.getElementById(id);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = id;
      bar.className = 'pv-float';
      bar.hidden = true;
      document.body.appendChild(bar);
      bar.addEventListener('mousedown', e => e.preventDefault());
      bar.addEventListener('click', onBarClick);
    }
    return bar;
  }
  function placeBar(bar, box) {
    const w = bar.offsetWidth, h = bar.offsetHeight;
    let x = box.left + box.width / 2 - w / 2;
    let y = box.bottom + 8;
    if (y + h > innerHeight - 8) y = box.top - h - 8;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    bar.style.left = x + 'px';
    bar.style.top = Math.max(8, y) + 'px';
  }
  function hideBars() {
    for (const id of ['pv-selbar', 'pv-itembar']) { const b = document.getElementById(id); if (b) b.hidden = true; }
    if (S) S.sel = null;
  }

  function highlightFromSel(color, withNote) {
    const info = S.sel;
    if (!info) return;
    S.lastColor = color;
    lsSet('bb-pdf-color', color);
    let firstId = null;
    info.parts.forEach((p, i) => {
      const it = addItem({ type: 'highlight', page: p.page, color, rects: p.rects, text: i === 0 ? info.text : '' });
      if (i === 0) firstId = it.id;
    });
    window.getSelection().removeAllRanges();
    hideBars();
    if (withNote) { S.editing = firstId; S.active = firstId; }
    changed({ repaint: info.parts.map(p => p.page) });
  }

  async function onBarClick(e) {
    const t = e.target.closest('button');
    if (!t || !S) return;
    if (t.dataset.hl) return highlightFromSel(t.dataset.hl, false);
    if (t.dataset.sel === 'note') return highlightFromSel(S.lastColor, true);
    if (t.dataset.sel === 'copy') {
      try { await navigator.clipboard.writeText(S.sel.text); B().toast('复制好了'); } catch { document.execCommand('copy'); }
      return hideBars();
    }
    if (t.dataset.sel === 'ask') {
      const info = S.sel;
      hideBars();
      const b = B();
      await b.openChat();
      const ta = $('#chat-input');
      if (ta) { ta.value = `《${S.name}》第 ${info.parts[0].page} 页这段："${info.text.slice(0, 600)}"\n`; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    // 点了已有批注后的小工具条
    const it = S.items.find(x => x.id === S.active);
    if (!it) return hideBars();
    if (t.dataset.color) {
      snapshot();
      it.color = t.dataset.color; it.updated = Date.now();
      if (it.type === 'highlight') { S.lastColor = it.color; lsSet('bb-pdf-color', it.color); }
      changed({ repaint: [it.page] });
      return showItemBar(it, document.getElementById('pv-itembar').getBoundingClientRect());
    }
    if (t.dataset.item === 'note') { hideBars(); S.editing = it.id; return layoutNotes(); }
    if (t.dataset.item === 'copy') { try { await navigator.clipboard.writeText(it.text || it.note || ''); B().toast('复制好了'); } catch {} return hideBars(); }
    if (t.dataset.item === 'del') return removeItem(it.id);
  }

  function showItemBar(it, box) {
    const bar = ensureBar('pv-itembar');
    const cols = it.type === 'ink' ? INK : HL;
    bar.innerHTML = cols.map(c => `<button class="pv-dot c-${c}${c === it.color ? ' cur' : ''}" data-color="${c}" aria-label="改成${NAMES[c]}色"></button>`).join('')
      + `<span class="pv-sep"></span>${it.note ? '' : '<button data-item="note">写便签</button>'}${it.text ? '<button data-item="copy">复制</button>' : ''}<button data-item="del" class="danger">删掉</button>`;
    bar.hidden = false;
    placeBar(bar, { left: box.left, top: box.top, width: box.width, bottom: box.bottom });
  }

  // ------------------------------------------------------------ 点、双击、手写

  function pagePoint(e) {
    const el = e.target.closest && e.target.closest('.pv-page');
    if (!el) return null;
    const pg = S.pages[Number(el.dataset.n) - 1];
    if (!pg || !pg.vp) return null;
    const b = el.getBoundingClientRect();
    return { pg, x: e.clientX - b.left, y: e.clientY - b.top };
  }
  function hitItem(pt) {
    const { pg, x, y } = pt;
    const list = allItems().filter(it => it.page === pg.n);
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (it.type === 'highlight') {
        if (it.rects.some(r => { const [rx, ry, w, h] = vpRect(pg.vp, r); return x >= rx - 1 && x <= rx + w + 1 && y >= ry - 1 && y <= ry + h + 1; })) return it;
      } else if (it.type === 'ink') {
        if (inkHit(pg, it, x, y, 6) >= 0) return it;
      }
    }
    return null;
  }
  function inkHit(pg, it, x, y, tol) {
    for (let k = 0; k < it.paths.length; k++) {
      const pts = it.paths[k].map(p => pg.vp.convertToViewportPoint(p[0], p[1]));
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[i + 1] || a;
        if (segDist(x, y, a, b) <= tol + (it.width || 2) * S.scale / 2) return k;
      }
    }
    return -1;
  }
  function segDist(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = dx * dx + dy * dy;
    let t = l ? ((px - a[0]) * dx + (py - a[1]) * dy) / l : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }

  function setActive(id) {
    const prev = S.active;
    S.active = id;
    const pages = new Set();
    for (const it of allItems()) if (it.id === prev || it.id === id) pages.add(it.page);
    for (const n of pages) { const pg = S.pages[n - 1]; if (pg && pg.rendered) paintPage(pg); }
    layoutNotes();
  }

  function focusItem(id) {
    const it = allItems().find(x => x.id === id);
    if (!it) return;
    const a = anchorOf(it);
    $('#pv-scroll').scrollTop = Math.max(0, a.y - 140);
    setActive(id);
  }

  // 按住便签的标题栏上下拖
  let drag = null;
  function dragStart(e) {
    const head = e.target.closest('.pv-cardhead');
    if (!head || e.target.closest('button') || e.button !== 0) return false;
    const el = head.closest('.pv-card');
    if (!el || el.classList.contains('tab')) return false;
    const it = allItems().find(x => x.id === el.dataset.id);
    if (!it) return false;
    e.preventDefault();
    head.setPointerCapture && head.setPointerCapture(e.pointerId);
    drag = { it, el, y0: e.clientY, top0: parseFloat(el.style.top) || 0, moved: false };
    return true;
  }
  function dragMove(e) {
    const d = e.clientY - drag.y0;
    if (Math.abs(d) > 3) drag.moved = true;
    if (!drag.moved) return;
    drag.el.style.top = drag.top0 + d + 'px';
    drag.el.classList.add('dragging');
  }
  function dragEnd(e) {
    const g = drag;
    drag = null;
    g.el.classList.remove('dragging');
    if (!g.moved) return;
    S.dragged = true;
    setTimeout(() => { if (S) S.dragged = false; }, 50);
    const it = g.it;
    // 放在哪就记住它离原文多远；离原文太远就不让了
    const a = anchorOf(it);
    const nv = Math.max(-1500, Math.min(1500, Math.round(parseFloat(g.el.style.top) - (a.y - 10))));
    if (it.foreign) { S.fdy = S.fdy || {}; S.fdy[it.id] = nv; return layoutNotes(); }
    snapshot();
    if (Math.abs(nv) < 4) delete it.dy; else it.dy = nv;
    it.updated = Date.now();
    changed();
  }

  let ink = null;
  function onPointerDown(e) {
    if (S && dragStart(e)) return;
    if (!S || S.mode === 'read' || e.button !== 0) return;
    const pt = pagePoint(e);
    if (!pt) return;
    e.preventDefault();
    e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
    if (S.mode === 'erase') { ink = { erase: true, pg: pt.pg, snap: false }; eraseAt(pt); return; }
    ink = { pg: pt.pg, pts: [[pt.x, pt.y]] };
    const svg = pt.pg.el.querySelector('.pv-inksvg');
    ink.path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    ink.path.setAttribute('class', `pv-ink c-${S.inkColor}`);
    ink.path.setAttribute('stroke-width', S.inkWidth * S.scale);
    svg.appendChild(ink.path);
  }
  function onPointerMove(e) {
    if (drag) return dragMove(e);
    if (!ink) return;
    const b = ink.pg.el.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    if (ink.erase) return eraseAt({ pg: ink.pg, x, y });
    const l = ink.pts[ink.pts.length - 1];
    if (Math.hypot(x - l[0], y - l[1]) < 1.5) return;
    ink.pts.push([x, y]);
    ink.path.setAttribute('d', ink.pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''));
  }
  function onPointerUp(e) {
    if (drag) return dragEnd(e);
    if (!ink) return;
    const cur = ink;
    ink = null;
    if (cur.erase) { if (cur.snap) changed({ repaint: [cur.pg.n] }); return; }
    const pg = cur.pg;
    let pts = cur.pts;
    if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.5, pts[0][1] + 0.5]];
    const path = pts.map(([x, y]) => pg.vp.convertToPdfPoint(x, y).map(v => Math.round(v * 100) / 100));
    const last = S.items[S.items.length - 1];
    if (last && last.type === 'ink' && last.page === pg.n && last.color === S.inkColor && last.width === S.inkWidth && Date.now() - last.updated < 4000 && last.paths.length < 200) {
      snapshot();
      last.paths.push(path);
      last.updated = Date.now();
    } else addItem({ type: 'ink', page: pg.n, color: S.inkColor, width: S.inkWidth, paths: [path] });
    changed({ repaint: [pg.n], layout: false });
  }
  function eraseAt(pt) {
    for (const it of S.items.filter(x => x.type === 'ink' && x.page === pt.pg.n)) {
      const k = inkHit(pt.pg, it, pt.x, pt.y, 8);
      if (k < 0) continue;
      if (!ink.snap) { snapshot(); ink.snap = true; }
      it.paths.splice(k, 1);
      it.updated = Date.now();
      if (!it.paths.length) S.items = S.items.filter(x => x !== it);
      paintPage(pt.pg);
    }
  }

  function setMode(m) {
    S.mode = m;
    const v = $('#view-pdf');
    v.classList.toggle('pv-inking', m !== 'read');
    $('.pv-inkbar').hidden = m === 'read';
    $('[data-pv=ink]').setAttribute('aria-pressed', String(m !== 'read'));
    $('[data-pv=eraser]').setAttribute('aria-pressed', String(m === 'erase'));
    v.querySelectorAll('[data-ink-color]').forEach(b => b.classList.toggle('cur', b.dataset.inkColor === S.inkColor));
    v.querySelectorAll('[data-ink-width]').forEach(b => b.classList.toggle('cur', Number(b.dataset.inkWidth) === S.inkWidth));
    hideBars();
  }

  // ------------------------------------------------------------ 翻页、缩放、找字

  function curPage() {
    if (!S || !S.pages.length) return 1;
    const st = $('#pv-scroll').scrollTop + 80;
    let lo = 0, hi = S.pages.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (S.pages[mid].top <= st) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  function goPage(n, { ratio = 0, word = '', instant = false } = {}) {
    n = Math.max(1, Math.min(S.pages.length, Number(n) || 1));
    const pg = S.pages[n - 1];
    if (word) { S.word = word; S.wordPage = n; }
    $('#pv-scroll').scrollTo({ top: pg.top + pg.ph * ratio - (ratio ? 0 : 8), behavior: instant ? 'auto' : 'auto' });
    if (word && pg.rendered) markWord(pg);
    onScroll();
  }
  function markWord(pg) {
    const w = (S.word || '').toLowerCase();
    if (!w) return;
    const spans = [...pg.el.querySelectorAll('.textLayer span')];
    let first = null;
    // 词可能被拆在几个小块里：把整页文字连起来找，再标回对应的块
    let all = '', map = [];
    spans.forEach((s, i) => { const t = s.textContent.toLowerCase(); for (let k = 0; k < t.length; k++) map.push(i); all += t; });
    let at = all.indexOf(w);
    while (at >= 0) {
      for (let k = at; k < at + w.length; k++) { const s = spans[map[k]]; s.classList.add('pv-hit'); first = first || s; }
      at = all.indexOf(w, at + w.length);
    }
    if (first && S.wordPage === pg.n) {
      S.wordPage = null;
      const sc = $('#pv-scroll');
      const b = first.getBoundingClientRect(), sb = sc.getBoundingClientRect();
      sc.scrollTop += b.top - sb.top - sc.clientHeight / 3;
    }
  }

  function zoom(to) {
    const keep = curPage();
    const pg = S.pages[keep - 1];
    const ratio = ($('#pv-scroll').scrollTop - pg.top) / (pg.ph || 1);
    S.scale = Math.max(0.4, Math.min(3, Math.round(to * 100) / 100));
    lsSet('bb-pdf-scale', S.scale);
    sizePages();
    for (const p of S.pages) if (p.rendered) { p.rendered = -1; }
    $('#pv-scroll').scrollTop = pg.top + pg.ph * ratio;
    for (const p of S.pages) if (p.visible) renderPage(p);
    layoutNotes();
  }

  let lastPosSave = 0;
  function onScroll() {
    if (!S || !S.pages.length) return;
    const n = curPage();
    const inp = $('#pv-page');
    if (inp && document.activeElement !== inp) inp.value = n;
    hideBars();
    if (Date.now() - lastPosSave > 1500) { lastPosSave = Date.now(); savePos(S); }
  }
  function savePos(s) {
    if (!s || !s.pages.length) return;
    const sc = $('#pv-scroll');
    if (!sc) return;
    const n = (() => { const st = sc.scrollTop + 80; let k = 0; while (k + 1 < s.pages.length && s.pages[k + 1].top <= st) k++; return k + 1; })();
    const pg = s.pages[n - 1];
    lsSet('bb-pdf-pos:' + s.name, { page: n, ratio: Math.max(0, (sc.scrollTop - pg.top) / (pg.ph || 1)) });
  }

  async function find(q) {
    const box = $('#pv-found');
    const seq = ++S.seq;
    q = q.trim();
    if (!q) { box.hidden = true; return; }
    const lq = q.toLowerCase();
    box.hidden = false;
    box.innerHTML = '<p class="sub">正在找…</p>';
    const hits = [];
    S.texts = S.texts || [];
    for (let i = 1; i <= S.doc.numPages; i++) {
      if (seq !== S.seq) return;
      if (S.texts[i] === undefined) {
        try {
          const page = S.pages[i - 1].page || (S.pages[i - 1].page = await S.doc.getPage(i));
          const tc = await page.getTextContent();
          S.texts[i] = tc.items.map(x => x.str + (x.hasEOL ? '\n' : '')).join('');
        } catch { S.texts[i] = ''; }
      }
      const t = S.texts[i], lt = t.toLowerCase();
      let at = lt.indexOf(lq), c = 0;
      while (at >= 0 && c < 5) {
        hits.push({ page: i, snip: t.slice(Math.max(0, at - 24), at + q.length + 30).replace(/\s+/g, ' ') });
        at = lt.indexOf(lq, at + q.length); c++;
      }
      if (i % 20 === 0 || i === S.doc.numPages) renderFound(q, hits, i < S.doc.numPages);
    }
  }
  function renderFound(q, hits, more) {
    const box = $('#pv-found');
    const hl = s => esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[&<>"']/g, c => esc(c)), 'gi'), m => `<mark>${m}</mark>`);
    box.innerHTML = `<div class="pv-foundh"><span>"${esc(q)}" ${hits.length ? `找到 ${hits.length}${hits.length >= 5 * S.doc.numPages ? '+' : ''} 处` : more ? '' : '没找到'}${more ? '，还在找…' : ''}</span><button class="pv-x" data-pv="find-close" aria-label="关掉">×</button></div>`
      + hits.slice(0, 300).map(h => `<button class="pv-hitrow" data-go="${h.page}"><b>第 ${h.page} 页</b> ${hl(h.snip)}</button>`).join('')
      + (!hits.length && !more ? '<p class="sub">扫描版的 PDF 里没有文字，找不到；可以先用"文字识别"工具把它变成能搜的 PDF。</p>' : '');
  }

  // ------------------------------------------------------------ 全部便签、菜单、导出

  function openList() {
    const box = $('#pv-list');
    if (!box.hidden) { box.hidden = true; return; }
    const list = allItems().filter(it => it.note || it.text || it.type !== 'highlight').sort((a, b) => a.page - b.page || (anchorOf(a) || {}).y - (anchorOf(b) || {}).y);
    let last = 0;
    box.innerHTML = `<div class="pv-listh"><strong>全部便签和划线 · ${list.length}</strong><button class="pv-x" data-pv="list" aria-label="关掉">×</button></div>
      ${list.length ? '' : '<p class="sub">还没有批注。选中一段字就能划线或贴便签；双击空白处可以单独贴一张。</p>'}
      ${list.map(it => {
        const h = it.page !== last ? `<h4>第 ${it.page} 页</h4>` : '';
        last = it.page;
        const kind = it.type === 'ink' ? '手写' : it.type === 'note' ? '便签' : '划线';
        return h + `<button class="pv-li c-${it.color || 'x'}" data-focus="${esc(it.id)}" ${it.foreign ? `style="--c:${it.css}"` : ''}>
          <span class="k">${kind}${it.foreign ? ' · ' + esc(it.author || '别的阅读器') : ''}</span>
          ${it.text ? `<span class="q">${esc(it.text.length > 90 ? it.text.slice(0, 90) + '…' : it.text)}</span>` : ''}
          ${it.note ? `<span class="n">${esc(it.note)}</span>` : ''}</button>`;
      }).join('')}`;
    box.hidden = false;
  }

  function openMenu() {
    const m = $('#pv-menu');
    if (!m.hidden) { m.hidden = true; return; }
    const sp = B().state.space === 'private' ? '&space=private' : '';
    m.innerHTML = `<button data-pv="export">${S.exported && S.exported.note ? '更新读书笔记（补上新批注）' : '导出成读书笔记'}</button>
      <a href="/api/pdfnotes/export?name=${enc(S.name)}${sp}" download>另存一份带批注的 PDF</a>
      <label class="pv-check"><input type="checkbox" data-pv="write" ${S.writeToFile ? 'checked' : ''}> 批注写进 PDF 文件本身<small>别人用 Edge、WPS 打开也能看到</small></label>
      ${S.writeToFile ? '<button data-pv="flush">现在就写进 PDF</button>' : ''}
      <button data-pv="system">用系统软件打开</button>
      <p class="sub">选中文字：划线、贴便签。双击空白处：单独贴一张便签。点划线可以改颜色或删掉。Ctrl+Z 撤销。</p>`;
    m.hidden = false;
  }

  async function flushNow() {
    if (S.saveTimer) { clearTimeout(S.saveTimer); await putItems(S); }
    status('正在写进 PDF…');
    const r = await B().api('/api/pdfnotes/flush?name=' + enc(S.name), { method: 'POST' });
    if (!S) return;
    if (r.ok) { S.dirtyFile = false; S.wrote = { rev: 0 }; status(S.items.length ? '批注已写进 PDF' : ''); B().toast('已写进 PDF 文件'); }
    else { status(r.message || '没写进去', true); B().toast(r.message || '没写进去'); }
  }

  async function setWrite(on) {
    if (S.saveTimer) { clearTimeout(S.saveTimer); await putItems(S); }
    const r = await B().api('/api/pdfnotes/settings?name=' + enc(S.name), { method: 'POST', json: { writeToFile: on } });
    if (!S) return;
    S.writeToFile = on;
    S.dirtyFile = false;
    B().toast(r.ok ? (on ? '批注会写进 PDF 文件' : '批注只存在百宝匣，PDF 文件里百宝匣写过的批注已拿掉') : (r.message || '没改成'));
    status(saveText());
  }

  // 导出成读书笔记：划的句子、便签、手写（截图），每条带"回到第 N 页"
  async function exportNotes() {
    const b = B();
    if (S.saveTimer) { clearTimeout(S.saveTimer); await putItems(S); }
    const ex = S.exported && S.exported.note ? S.exported : null;
    let note = null;
    if (ex) { note = await b.api('/api/notes/' + enc(ex.note)); if (!note || !note.text) note = null; }
    const done = new Set(note ? ex.ids : []);
    const list = S.items.filter(it => (it.note || it.text || it.type === 'ink') && !done.has(it.id))
      .sort((a, c) => a.page - c.page || ((anchorOf(a) || {}).y - (anchorOf(c) || {}).y));
    if (!list.length) return b.toast(note ? '没有新的批注要补' : '还没有批注可以导出');
    status('正在导出…');
    const title = S.name.replace(/\.pdf$/i, '');
    const link = n => `[回到第 ${n} 页](/#pdf/${enc(S.name)}/${n})`;
    let md = '';
    let last = 0, imgN = 0;
    for (const it of list) {
      if (it.page !== last) { md += `## 第 ${it.page} 页\n\n`; last = it.page; }
      if (it.type === 'highlight' && it.text) md += `> ${it.text.replace(/\n+/g, '\n> ')}\n\n`;
      if (it.type === 'ink') {
        const url = await inkShot(it, `${title}-批注-${it.page}-${++imgN}`);
        if (url) md += `![手写批注](${url})\n\n`;
      }
      if (it.note) md += `${it.type === 'highlight' ? '笔记：' : ''}${it.note}\n\n`;
      md += link(it.page) + '\n\n';
    }
    let r;
    if (note) {
      const day = new Date().toLocaleDateString('zh-CN');
      r = await b.api('/api/notes/' + enc(ex.note), { method: 'PUT', json: { text: note.text.replace(/\s*$/, '') + `\n\n## 补充 · ${day}\n\n` + md.replace(/^## /gm, '### ') } });
    } else {
      const head = `# 《${title}》读书笔记\n标签: 读书笔记\n\n来自 ${S.name} · 在 PDF 里加了新批注，打开 PDF 点"更新读书笔记"就会补上\n\n`;
      r = await b.api('/api/new-note', { method: 'POST', json: { title: `《${title}》读书笔记`, text: head + md } });
    }
    if (!r.ok) { status(saveText()); return b.toast(r.message || '没导出'); }
    const ids = [...done, ...list.map(x => x.id)];
    S.exported = { note: r.id, ids, at: Date.now() };
    await b.api('/api/pdfnotes?name=' + enc(S.name), { method: 'PUT', json: { exported: S.exported } });
    status(saveText());
    b.toast(note ? `补上了 ${list.length} 条` : '导出成说明了');
    b.openNote(r.id);
  }

  async function inkShot(it, name) {
    try {
      const page = S.pages[it.page - 1].page || (S.pages[it.page - 1].page = await S.doc.getPage(it.page));
      const vp = page.getViewport({ scale: 2 });
      let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
      for (const p of it.paths) for (const pt of p) { const [x, y] = vp.convertToViewportPoint(pt[0], pt[1]); x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
      const pad = 40;
      x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad); x2 = Math.min(vp.width, x2 + pad); y2 = Math.min(vp.height, y2 + pad);
      const full = document.createElement('canvas');
      full.width = vp.width; full.height = vp.height;
      await page.render({ canvasContext: full.getContext('2d'), viewport: vp, annotationMode: S.lib.AnnotationMode.DISABLE }).promise;
      const c = document.createElement('canvas');
      c.width = Math.round(x2 - x1); c.height = Math.round(y2 - y1);
      const g = c.getContext('2d');
      g.drawImage(full, x1, y1, c.width, c.height, 0, 0, c.width, c.height);
      g.strokeStyle = getComputedStyle(document.body).getPropertyValue('--ink-' + it.color).trim() || '#e5484d';
      g.lineWidth = (it.width || 2) * 2; g.lineCap = g.lineJoin = 'round';
      for (const p of it.paths) {
        g.beginPath();
        p.forEach((pt, i) => { const [x, y] = vp.convertToViewportPoint(pt[0], pt[1]); i ? g.lineTo(x - x1, y - y1) : g.moveTo(x - x1, y - y1); });
        g.stroke();
      }
      full.width = full.height = 0;
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const up = await B().uploadFile(blob, name + '.png', 'image');
      return up.ok ? up.url : null;
    } catch { return null; }
  }

  // ------------------------------------------------------------ 事件

  function onClick(e) {
    if (!S) return;
    const t = e.target;
    const act = t.closest('[data-pv]') && t.closest('[data-pv]').dataset.pv;
    if (act && t.closest('[data-pv]').tagName !== 'INPUT') {
      if (act !== 'menu' && act !== 'write') $('#pv-menu').hidden = true;
      if (act === 'back') return back();
      if (act === 'zoom-in') return zoom(S.scale * 1.15);
      if (act === 'zoom-out') return zoom(S.scale / 1.15);
      if (act === 'fit') return zoom(fitScale());
      if (act === 'ink') return setMode(S.mode === 'read' ? 'ink' : 'read');
      if (act === 'eraser') return setMode(S.mode === 'erase' ? 'ink' : 'erase');
      if (act === 'undo') return undo();
      if (act === 'side') { S.side = !S.side; lsSet('bb-pdf-side', S.side); sizePages(); return layoutNotes(); }
      if (act === 'list') return openList();
      if (act === 'menu') return openMenu();
      if (act === 'export') return exportNotes();
      if (act === 'flush') return flushNow();
      if (act === 'find-close') { $('#pv-found').hidden = true; return; }
      if (act === 'system') return B().api('/api/files/open', { method: 'POST', json: { name: S.name } }).then(r => r.ok || B().toast(r.message || '打不开'));
      return;
    }
    if (t.closest('#pv-menu a')) { $('#pv-menu').hidden = true; return; }
    const ic = t.closest('[data-ink-color]');
    if (ic) { S.inkColor = ic.dataset.inkColor; lsSet('bb-pdf-ink', S.inkColor); return setMode('ink'); }
    const iw = t.closest('[data-ink-width]');
    if (iw) { S.inkWidth = Number(iw.dataset.inkWidth); return setMode('ink'); }
    const go = t.closest('[data-go]');
    if (go) { const w = $('#pv-find').value.trim(); return goPage(Number(go.dataset.go), { word: w }); }
    const fo = t.closest('[data-focus]');
    if (fo) { if (innerWidth < 900) $('#pv-list').hidden = true; return focusItem(fo.dataset.focus); }
    const del = t.closest('[data-del]');
    if (del) return removeItem(del.dataset.del);
    const wd = t.closest('[data-wide]');
    if (wd) {
      const it = allItems().find(x => x.id === wd.dataset.wide);
      if (!it) return;
      if (it.foreign) { it.wide = !it.wide; return layoutNotes(); }
      snapshot(); it.wide = !it.wide; it.updated = Date.now();
      return changed();
    }
    if (S.dragged) { S.dragged = false; return; }
    const card = t.closest('.pv-card');
    if (card) {
      const id = card.dataset.id;
      if (card.classList.contains('tab') || S.active !== id) {
        if (!card.classList.contains('foreign')) S.editing = card.classList.contains('tab') ? id : S.editing;
        setActive(id);
      }
      return;
    }
    if (!$('#pv-menu').hidden && !t.closest('#pv-menu')) $('#pv-menu').hidden = true;
    const pin = t.closest('.pv-pin');
    if (pin) {
      const it = allItems().find(x => x.id === pin.dataset.id);
      if (it && !it.foreign) S.editing = it.id;
      return setActive(pin.dataset.id);
    }
    if (S.mode !== 'read') return;
    const pt = pagePoint(e);
    if (!pt) { if (S.active || S.editing) { S.editing = null; setActive(null); } return; }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = hitItem(pt);
    if (hit) {
      setActive(hit.id);
      if (!hit.foreign) showItemBar(hit, { left: e.clientX - 1, top: e.clientY - 12, width: 2, bottom: e.clientY + 6 });
      return;
    }
    hideBars();
    if (S.active || S.editing) { S.editing = null; setActive(null); }
  }

  function onDblClick(e) {
    if (!S || S.mode !== 'read') return;
    const pt = pagePoint(e);
    if (!pt) return;
    if (e.target.closest('.textLayer span') && !e.target.classList.contains('endOfContent')) return; // 双击字是选词
    if (hitItem(pt)) return;
    window.getSelection().removeAllRanges();
    const at = pt.pg.vp.convertToPdfPoint(pt.x - 9, pt.y - 9).map(v => Math.round(v * 100) / 100);
    const it = addItem({ type: 'note', page: pt.pg.n, color: S.lastColor, at, note: '' });
    S.editing = it.id; S.active = it.id;
    hideBars();
    paintPage(pt.pg);
    layoutNotes();
  }

  function onMouseUp(e) {
    if (!S || S.mode !== 'read') return;
    if (e.target.closest('.pv-float, .pv-side, .pv-bar, .pv-list, .pv-menu, .pv-found')) return;
    setTimeout(() => {
      if (!S) return;
      const info = selectionInfo();
      if (info) showSelBar(info);
      else { const b = document.getElementById('pv-selbar'); if (b) b.hidden = true; }
    }, 0);
  }

  function onInput(e) {
    if (!S) return;
    const ta = e.target.closest('.pv-card textarea');
    if (ta) {
      const it = S.items.find(x => x.id === ta.closest('.pv-card').dataset.id);
      if (!it) return;
      if (!S.typing) { snapshot(); S.typing = true; }
      it.note = ta.value.slice(0, 10000);
      it.updated = Date.now();
      autoGrow(ta);
      const tab = ta.closest('.pv-card').querySelector('.pv-tabtext');
      if (tab) tab.textContent = (it.note.split('\n')[0] || '…').slice(0, 16);
      clearTimeout(S.relayT);
      S.relayT = setTimeout(() => relayoutKeepFocus(), 400);
      return changed({ layout: false });
    }
    if (e.target.id === 'pv-find') { clearTimeout(S.findT); S.findT = setTimeout(() => find(e.target.value), 350); }
  }
  // 打字时卡片长高了，下面的卡片要让开
  function relayoutKeepFocus() {
    if (!S) return;
    if (S.composing) { clearTimeout(S.relayT); S.relayT = setTimeout(relayoutKeepFocus, 400); return; }
    layoutNotes();
  }

  function onFocusOut(e) {
    if (!S) return;
    const ta = e.target.closest && e.target.closest('.pv-card textarea');
    if (!ta) return;
    S.typing = false;
    const id = ta.closest('.pv-card').dataset.id;
    setTimeout(() => {
      if (!S) return;
      const still = document.activeElement && document.activeElement.closest && document.activeElement.closest(`.pv-card[data-id="${CSS.escape(id)}"]`);
      if (still) return;
      const it = S.items.find(x => x.id === id);
      if (S.editing === id) S.editing = null;
      if (it && it.type === 'note' && !(it.note || '').trim()) { S.items = S.items.filter(x => x !== it); if (S.active === id) S.active = null; changed({ repaint: [it.page] }); return; }
      if (it && it.note !== undefined && !it.note.trim()) delete it.note;
      layoutNotes();
    }, 120);
  }

  function onKey(e) {
    if (!S || B().state.view !== 'pdf') return;
    const inField = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); const f = $('#pv-find'); f.focus(); f.select(); return; }
    if (inField) {
      if (e.key === 'Escape') { e.target.blur(); if (e.target.id === 'pv-find') $('#pv-found').hidden = true; }
      if (e.target.id === 'pv-page' && e.key === 'Enter') { goPage(e.target.value); e.target.blur(); }
      if (e.target.id === 'pv-find' && e.key === 'Enter') { const r = $('#pv-found [data-go]'); if (r) r.click(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); return zoom(S.scale * 1.15); }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); return zoom(S.scale / 1.15); }
    if (e.key === 'Escape') { if (S.mode !== 'read') return setMode('read'); hideBars(); if (!$('#pv-list').hidden) { $('#pv-list').hidden = true; return; } if (S.active) return setActive(null); return back(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.active && S.items.some(x => x.id === S.active)) { e.preventDefault(); return removeItem(S.active); }
    const sc = $('#pv-scroll');
    if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); sc.scrollTop += sc.clientHeight * 0.9; }
    if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); sc.scrollTop -= sc.clientHeight * 0.9; }
    if (e.key === 'Home') goPage(1);
    if (e.key === 'End') goPage(S.pages.length);
  }

  function onHover(e) {
    if (!S) return;
    const c = e.target.closest && e.target.closest('.pv-card');
    const id = c && c.dataset.id;
    if (id === S.hover) return;
    S.hover = id;
    document.querySelectorAll('#view-pdf .hot').forEach(x => x.classList.remove('hot'));
    if (id) document.querySelectorAll(`#view-pdf [data-id="${CSS.escape(id)}"]`).forEach(x => x.classList.add('hot'));
  }

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    const v = $('#view-pdf');
    v.addEventListener('click', onClick);
    v.addEventListener('dblclick', onDblClick);
    v.addEventListener('mouseup', onMouseUp);
    v.addEventListener('input', onInput);
    v.addEventListener('compositionstart', () => { if (S) S.composing = true; });
    v.addEventListener('compositionend', () => { if (S) S.composing = false; });
    v.addEventListener('focusout', onFocusOut);
    v.addEventListener('mouseover', onHover);
    v.addEventListener('change', e => { if (S && e.target.dataset.pv === 'write') setWrite(e.target.checked); });
    v.addEventListener('pointerdown', onPointerDown);
    v.addEventListener('pointermove', onPointerMove);
    v.addEventListener('pointerup', onPointerUp);
    v.addEventListener('pointercancel', onPointerUp);
    v.addEventListener('scroll', e => { if (e.target.id === 'pv-scroll') onScroll(); }, true);
    v.addEventListener('wheel', e => { if (S && (e.ctrlKey || e.metaKey) && e.target.closest('#pv-scroll')) { e.preventDefault(); zoom(S.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => { if (S && S.pages.length) layoutNotes(); });
    window.addEventListener('beforeunload', () => { if (S) { savePos(S); if (S.saveTimer) putItems(S); } });
  }

  window.bbPdf = {
    open: (name, opts) => { bind(); return open(name, opts); },
    close,
    get current() { return S && S.name; },
  };
})();
