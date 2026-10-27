// 百宝匣前端
(function () {
  const APP_VERSION = '0.15.0';
  const OLD_BACKEND = '百宝匣后台还是旧版本，新功能用不了。请关掉黑色窗口（任务管理器里的 node.exe 也结束掉），然后重新双击"启动百宝匣.bat"。';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const state = {
    tools: [],
    toolsError: null,
    status: {},
    notes: [],
    files: [],
    view: 'tools',
    note: null,        // 当前打开的说明 { id, text, title, tags, updated }
    editing: false,
    space: 'main',     // main = 普通区，private = 私密区
    panelTool: null,
    pending: new Set(), // 本页正在启动的工具
    sections: [],
    private: { hasPassword: false, unlocked: false },
    openSections: new Set(), // 展开的栏目（每次打开页面都是收起的）
    dragging: false,
    checkup: {},      // 工具 id -> 上次体检结果
    updateInfo: {},   // 工具 id -> 检查更新结果
    chat: [],         // AI 管家的对话
  };

  // 随身口袋的状态（见文件后面的"随身口袋"一节）
  const pk = { open: false, items: [], box: {}, temp: false, form: false, timer: null, trash: false, useCode: false };

  // ---------------------------------------------------------------- 通用

  // 当前所在区的文件网址前缀
  const base = () => (state.space === 'private' ? '/私密区/' : '/记忆区/');
  const fileUrl = name => `${base()}资料/${encodeURIComponent(name)}`;

  async function api(path, opts = {}) {
    // 在私密区里，所有请求都带上 space=private
    if (state.space === 'private' && path.startsWith('/api/') && !path.startsWith('/api/private')) {
      path += (path.includes('?') ? '&' : '?') + 'space=private';
    }
    const headers = { ...(opts.headers || {}) };
    if (opts.method && opts.method !== 'GET') headers['X-Baibao'] = '1';
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    let res;
    try {
      res = await fetch(path, { ...opts, headers });
    } catch {
      return { ok: false, message: '连不上百宝匣后台。是不是把那个黑色窗口关掉了？重新双击"启动百宝匣"即可。' };
    }
    let body;
    try { body = await res.json(); } catch { return { ok: false, message: '后台返回了看不懂的内容。' }; }
    if (body && body.locked && state.space === 'private') {
      setTimeout(() => leavePrivate(true), 0);
      return { ok: false, message: '已自动锁上。' };
    }
    // 后台不认识这个指令：说明后台是旧版本
    if (res.status === 404 && path.startsWith('/api/') && body && body.error === '找不到') {
      return { ok: false, message: OLD_BACKEND };
    }
    return body;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ---------------------------------------------------------------- 视图切换

  function setView(v, { push = true } = {}) {
    state.view = v;
    for (const id of ['tools', 'memory', 'search', 'reader']) $('#view-' + id).hidden = id !== v;
    if (v !== 'reader' && state.reader) { state.reader = null; $('#rd-frame').src = 'about:blank'; }
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    if (push && v !== 'search' && v !== 'reader') {
      const h = v === 'memory' && state.note ? `#memory/${encodeURIComponent(state.note.id)}` : `#${v}`;
      if (location.hash !== h) history.replaceState(null, '', h);
    }
    if (v === 'tools') refreshStatus();
    if (v === 'memory') loadNotes();
  }

  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    $('#q').value = '';
    closePanel();
    setView(b.dataset.view);
  }));

  // ---------------------------------------------------------------- 图标、对话框

  // 图标可以是 emoji，也可以是上传的图片（图标/xxx.png）
  function isImgIcon(icon) {
    return /^图标\/[^/]+\.(png|jpe?g|gif|webp|ico)$/i.test(String(icon || ''));
  }
  function iconHtml(icon, cls = '') {
    if (isImgIcon(icon)) return `<img class="img-icon ${cls}" src="/${encodeURI(icon)}" alt="">`;
    return esc(icon);
  }

  // 代替 prompt 的小对话框，可以输密码
  function ask({ title, text = '', fields = [], okText = '确定', extra = null }) {
    return new Promise(resolve => {
      const dlg = document.createElement('dialog');
      dlg.className = 'ask';
      dlg.innerHTML = `<form method="dialog">
        <h2>${esc(title)}</h2>
        ${text ? `<p class="sub">${esc(text)}</p>` : ''}
        ${fields.map(f => `<label class="field"><span>${esc(f.label)}</span>
          <input name="${esc(f.name)}" type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="${f.type === 'password' ? 'off' : 'off'}"></label>`).join('')}
        <div class="ask-err" role="alert" hidden></div>
        <div class="btn-row">
          <button class="btn primary" value="ok">${esc(okText)}</button>
          <button class="btn" value="cancel" formnovalidate>取消</button>
          ${extra ? `<button class="btn ghost ${extra.danger ? 'danger' : ''}" value="extra" style="margin-left:auto">${esc(extra.label)}</button>` : ''}
        </div></form>`;
      document.body.appendChild(dlg);
      const done = v => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.querySelector('form').addEventListener('submit', e => {
        e.preventDefault();
        const which = e.submitter ? e.submitter.value : 'ok';
        if (which === 'cancel') return done(null);
        if (which === 'extra') return done({ _extra: true });
        const vals = {};
        dlg.querySelectorAll('input[name]').forEach(i => { vals[i.name] = i.value; });
        done(vals);
      });
      dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
      dlg.showModal();
      const first = dlg.querySelector('input');
      if (first) { first.focus(); first.select(); }
    });
  }

  // ---------------------------------------------------------------- 工具区

  const STATE_TEXT = { running: '运行中', error: '上次没打开', busy: '启动中…', idle: '' };

  // 设了密码：后台只发解锁后能看的；没设密码：页面自己藏
  function visibleTools() {
    return state.tools;
  }

  function toolState(t) {
    if (state.pending.has(t.id)) return 'busy';
    return (state.status[t.id] && state.status[t.id].state) || 'idle';
  }

  function drawerHtml(t) {
    const st = toolState(t);
    const busyText = state.status[t.id] && state.status[t.id].busy;
    const ck = state.checkup[t.id];
    const warn = ck && ck.level !== 'ok' ? ck : null;
    return `<div class="drawer${t.private ? ' private' : ''}" data-id="${esc(t.id)}" data-state="${st}" data-heat="${Number(t.heat) || 0}" draggable="true">
        <button class="face" type="button" title="${esc(warn ? '体检：' + warn.message : (t.desc || t.name))}">
          <span class="lamp" aria-hidden="true"></span>
          ${warn ? `<span class="ck-badge ${warn.level}" aria-label="体检有问题">!</span>` : ''}
          <span class="slip">${esc(t.name)}</span>
          <span class="glyph" aria-hidden="true">${iconHtml(t.icon)}</span>
          <span class="status-text">${esc(st === 'busy' && busyText ? busyText + '…' : STATE_TEXT[st])}</span>
          <span class="pull" aria-hidden="true"></span>
        </button>
        <button class="more" type="button" aria-label="${esc(t.name)}的更多操作">⋯</button>
      </div>`;
  }

  function addDrawerHtml(section, empty) {
    return `<div class="drawer add"><button class="face" type="button" data-add="${esc(section)}">
        <span class="slip">加一个工具</span><span class="glyph" aria-hidden="true">＋</span>
        <span class="status-text">${empty ? (section ? '也可以把抽屉拖进来' : '柜子还是空的') : ''}</span></button></div>`;
  }

  function renderTools() {
    if (state.dragging) return;
    const box = $('#tool-area');
    const err = $('#tools-error');
    err.hidden = !state.toolsError;
    err.textContent = state.toolsError || '';
    const list = visibleTools();
    const names = new Set(state.sections.map(s => s.name));
    let html = '';
    for (const s of state.sections) {
      const items = list.filter(t => t.section === s.name);
      const open = state.openSections.has(s.name);
      const running = items.filter(t => toolState(t) === 'running').length;
      html += `<section class="sect${open ? ' open' : ''}" data-section="${esc(s.name)}">
        <div class="sect-bar" draggable="true">
          <button class="sect-toggle" type="button" aria-expanded="${open}">
            <span class="chev" aria-hidden="true"></span>
            <span class="sect-name">${s.icon ? esc(s.icon) + ' ' : ''}${esc(s.name)}</span>
            <span class="sect-count">${items.length} 个${running ? `，${running} 个运行中` : ''}</span>
            <span class="peek" aria-hidden="true">${open ? '' : items.slice(0, 8).map(t => `<i>${iconHtml(t.icon)}</i>`).join('')}</span>
          </button>
          <button class="sect-more" type="button" aria-label="${esc(s.name)}栏目的操作">⋯</button>
        </div>
        ${open ? `<div class="cabinet">${items.map(drawerHtml).join('')}${addDrawerHtml(s.name, !items.length)}</div>` : ''}
      </section>`;
    }
    const loose = list.filter(t => !t.section || !names.has(t.section));
    html += `<section class="sect loose" data-section="">
      ${state.sections.length ? '<div class="sect-bar plain"><span class="sect-name">未分类</span></div>' : ''}
      <div class="cabinet">${loose.map(drawerHtml).join('')}${addDrawerHtml('', !list.length)}</div>
    </section>`;
    box.innerHTML = html;
    if (state.justAdded) {
      const d = box.querySelector(`.drawer[data-id="${CSS.escape(state.justAdded)}"]`);
      if (d) { d.classList.add('new'); d.scrollIntoView({ block: 'nearest' }); }
      state.justAdded = null;
    }
  }

  // 只更新灯和状态字，不重画整个柜子（拖动时也不会被打断）
  function updateDrawerStates() {
    let changed = false;
    document.querySelectorAll('#tool-area .drawer[data-id]').forEach(d => {
      const t = state.tools.find(x => x.id === d.dataset.id);
      if (!t) return;
      const st = toolState(t);
      if (d.dataset.state !== st) { d.dataset.state = st; changed = true; }
      const busyText = state.status[t.id] && state.status[t.id].busy;
      const txt = st === 'busy' && busyText ? busyText + '…' : STATE_TEXT[st];
      const el = d.querySelector('.status-text');
      if (el.textContent !== txt) el.textContent = txt;
    });
    // 收起的栏目里"几个运行中"也要更新
    if (changed && !state.dragging) renderTools();
  }

  $('#tool-area').addEventListener('click', async e => {
    const add = e.target.closest('[data-add]');
    if (add) return openForm(null, add.dataset.add);
    const sect = e.target.closest('.sect');
    if (e.target.closest('.sect-toggle')) {
      const name = sect.dataset.section;
      if (state.openSections.has(name)) state.openSections.delete(name);
      else state.openSections.add(name);
      renderTools();
      const again = document.querySelector(`.sect[data-section="${CSS.escape(name)}"] .sect-toggle`);
      if (again) again.focus();
      return;
    }
    if (e.target.closest('.sect-more')) return sectionMenu(sect.dataset.section);
    const d = e.target.closest('.drawer');
    if (!d) return;
    const id = d.dataset.id;
    if (e.target.closest('.more')) openPanel(id);
    else launchTool(id);
  });

  $('#new-section').addEventListener('click', async () => {
    const v = await ask({ title: '新建栏目', fields: [{ name: 'name', label: '栏目名字', placeholder: '比如：娱乐、学习、开发' }], okText: '建好' });
    if (!v || !v.name.trim()) return;
    const name = v.name;
    const r = await api('/api/sections', { method: 'POST', json: { action: 'add', name } });
    if (!r.ok) return toast(r.message || '没建成');
    state.openSections.add(r.name);
    await loadTools();
    toast(`建好了"${r.name}"，把抽屉拖到它上面就能放进去`, 3500);
  });

  async function sectionMenu(name) {
    const v = await ask({ title: `栏目"${name}"`, fields: [{ name: 'name', label: '名字', value: name }], okText: '改名', extra: { label: '删掉这个栏目', danger: true } });
    if (!v) return;
    const c = v._extra ? '' : v.name.trim();
    if (!v._extra && (!c || c === name)) return;
    if (v._extra) {
      if (!confirm(`删掉栏目"${name}"？里面的工具会移到"未分类"。`)) return;
      const r = await api('/api/sections', { method: 'POST', json: { action: 'delete', name } });
      if (!r.ok) return toast(r.message || '没删掉');
      toast(`已删掉栏目"${name}"`);
    } else {
      const r = await api('/api/sections', { method: 'POST', json: { action: 'rename', name, newName: c } });
      if (!r.ok) return toast(r.message || '没改成');
      if (state.openSections.delete(name)) state.openSections.add(r.name);
      toast(`已改名为"${r.name}"`);
    }
    await loadTools();
  }

  // ---------------------------------------------------------------- 拖动（鼠标 + 触屏长按）

  const drag = { kind: null, id: null, hoverTimer: null, hoverName: null };

  function clearDropMarks() {
    document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }

  function beginDrag(el) {
    const d = el.closest('.drawer[data-id]');
    const bar = el.closest('.sect-bar[draggable]');
    if (d) { drag.kind = 'tool'; drag.id = d.dataset.id; d.classList.add('dragging'); }
    else if (bar) { drag.kind = 'section'; drag.id = bar.parentElement.dataset.section; bar.parentElement.classList.add('dragging'); }
    else return false;
    state.dragging = true;
    return true;
  }

  function finishDrag() {
    document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    clearDropMarks();
    clearTimeout(drag.hoverTimer);
    drag.kind = null;
    drag.hoverName = null;
    state.dragging = false;
    renderTools();
  }

  // 根据手指 / 鼠标所在的位置，画出会放到哪
  function markDrop(target, x, y) {
    clearDropMarks();
    const sect = target && target.closest && target.closest('#tool-area .sect');
    if (!sect) return false;
    if (drag.kind === 'section') {
      if (sect.classList.contains('loose')) return true;
      const r = sect.getBoundingClientRect();
      sect.classList.add(y < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
      return true;
    }
    const d = target.closest('.drawer[data-id]');
    if (d && d.dataset.id !== drag.id) {
      const r = d.getBoundingClientRect();
      d.classList.add(x < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
      return true;
    }
    sect.classList.add('drop-into');
    // 停在收起的栏目上一会儿，自动展开
    if (!sect.classList.contains('open') && !sect.classList.contains('loose')) {
      const name = sect.dataset.section;
      if (drag.hoverName !== name) {
        drag.hoverName = name;
        clearTimeout(drag.hoverTimer);
        drag.hoverTimer = setTimeout(() => {
          state.openSections.add(name);
          state.dragging = false;
          renderTools();
          state.dragging = true;
          const dragged = document.querySelector(`.drawer[data-id="${CSS.escape(drag.id)}"]`);
          if (dragged) dragged.classList.add('dragging');
        }, 700);
      }
    } else {
      drag.hoverName = null;
      clearTimeout(drag.hoverTimer);
    }
    return true;
  }

  // 松手：算出新顺序并保存
  async function doDrop(target, x, y) {
    clearTimeout(drag.hoverTimer);
    const sect = target && target.closest && target.closest('#tool-area .sect');
    if (!sect || !drag.kind) return finishDrag();

    if (drag.kind === 'section') {
      if (sect.classList.contains('loose') || sect.dataset.section === drag.id) return finishDrag();
      const names = state.sections.map(s => s.name).filter(n => n !== drag.id);
      const r = sect.getBoundingClientRect();
      let i = names.indexOf(sect.dataset.section);
      if (y >= r.top + r.height / 2) i++;
      names.splice(i, 0, drag.id);
      state.sections = names.map(n => state.sections.find(s => s.name === n));
      finishDrag();
      await api('/api/arrange', { method: 'POST', json: { sections: names } });
      return;
    }

    const movingId = drag.id;
    const targetSection = sect.dataset.section;
    const order = displayOrder().filter(o => o.id !== movingId);
    const d = target.closest('.drawer[data-id]');
    let at;
    if (d && d.dataset.id !== movingId) {
      const r = d.getBoundingClientRect();
      at = order.findIndex(o => o.id === d.dataset.id) + (x >= r.left + r.width / 2 ? 1 : 0);
    } else {
      const last = order.map(o => o.section).lastIndexOf(targetSection);
      at = last >= 0 ? last + 1 : order.length;
    }
    order.splice(at, 0, { id: movingId, section: targetSection });
    const byId = new Map(state.tools.map(t => [t.id, t]));
    const moved = byId.get(movingId);
    const before = moved.section;
    moved.section = targetSection;
    const hidden = state.tools.filter(t => !order.some(o => o.id === t.id));
    state.tools = order.map(o => byId.get(o.id)).concat(hidden);
    if (targetSection) state.openSections.add(targetSection);
    finishDrag();
    const r = await api('/api/arrange', { method: 'POST', json: { tools: order } });
    if (!r.ok) { toast(r.message || '没保存上'); return loadTools(); }
    if (before !== targetSection) toast(targetSection ? `已放进"${targetSection}"` : '已移到未分类');
  }

  // 鼠标：用浏览器自带的拖放
  const area = $('#tool-area');
  area.addEventListener('dragstart', e => {
    if (!beginDrag(e.target)) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
  });
  area.addEventListener('dragend', () => { if (drag.kind) finishDrag(); });
  area.addEventListener('dragover', e => {
    if (!drag.kind) return;
    if (markDrop(e.target, e.clientX, e.clientY)) e.preventDefault();
  });
  area.addEventListener('drop', e => {
    if (!drag.kind) return;
    e.preventDefault();
    doDrop(e.target, e.clientX, e.clientY);
  });

  // 触屏和触控笔：长按半秒拿起来
  const touch = { timer: null, startX: 0, startY: 0, el: null, ghost: null, active: false, swallowClick: false };

  area.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const el = e.target.closest('.drawer[data-id], .sect-bar[draggable]');
    if (!el) return;
    touch.el = el;
    touch.startX = e.clientX;
    touch.startY = e.clientY;
    clearTimeout(touch.timer);
    touch.timer = setTimeout(() => {
      if (!beginDrag(el)) return;
      touch.active = true;
      touch.swallowClick = true;
      if (navigator.vibrate) navigator.vibrate(15);
      const r = el.getBoundingClientRect();
      const g = el.cloneNode(true);
      g.classList.remove('dragging');
      g.classList.add('drag-ghost');
      g.style.width = r.width + 'px';
      g.style.height = r.height + 'px';
      g.style.left = (touch.startX - r.width / 2) + 'px';
      g.style.top = (touch.startY - r.height / 2) + 'px';
      document.body.appendChild(g);
      touch.ghost = g;
    }, 450);
  });

  window.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse' || !touch.el) return;
    if (!touch.active) {
      // 手指先动了：那是在滚动页面，不是拖动
      if (Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) > 10) { clearTimeout(touch.timer); touch.el = null; }
      return;
    }
    const g = touch.ghost;
    g.style.left = (e.clientX - g.offsetWidth / 2) + 'px';
    g.style.top = (e.clientY - g.offsetHeight / 2) + 'px';
    markDrop(document.elementFromPoint(e.clientX, e.clientY), e.clientX, e.clientY);
    // 拖到屏幕边上时自动滚动
    if (e.clientY < 60) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
  });

  function endTouch(e, cancel) {
    clearTimeout(touch.timer);
    if (touch.ghost) { touch.ghost.remove(); touch.ghost = null; }
    const was = touch.active;
    touch.active = false;
    touch.el = null;
    if (!was) return;
    setTimeout(() => { touch.swallowClick = false; }, 400);
    if (cancel) return finishDrag();
    doDrop(document.elementFromPoint(e.clientX, e.clientY), e.clientX, e.clientY);
  }
  window.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') endTouch(e, false); });
  window.addEventListener('pointercancel', e => { if (e.pointerType !== 'mouse') endTouch(e, true); });
  // 拖动时不让页面跟着滚动、不弹长按菜单
  window.addEventListener('touchmove', e => { if (touch.active) e.preventDefault(); }, { passive: false });
  area.addEventListener('contextmenu', e => { if (touch.el || touch.active) e.preventDefault(); });
  // 长按拖完松手后，别把这一下当成点击
  area.addEventListener('click', e => {
    if (touch.swallowClick) { touch.swallowClick = false; e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  // 页面上从上到下的顺序：先各栏目，再未分类
  function displayOrder() {
    const list = visibleTools();
    const names = new Set(state.sections.map(s => s.name));
    const out = [];
    for (const s of state.sections) for (const t of list) if (t.section === s.name) out.push({ id: t.id, section: s.name });
    for (const t of list) if (!t.section || !names.has(t.section)) out.push({ id: t.id, section: '' });
    return out;
  }

  async function loadTools() {
    const r = await api('/api/tools');
    state.tools = r.tools || [];
    state.sections = r.sections || [];
    if (r.private) state.private = r.private;
    state.toolsError = r.error || (r.ok === false ? r.message : null);
    renderTools();
    loadCheckup().then(() => renderTools());
  }

  let statusTimer;
  async function refreshStatus() {
    clearTimeout(statusTimer);
    const r = await api('/api/status');
    if (r.status) {
      state.status = Object.fromEntries(r.status.map(s => [s.id, s]));
      if (r.error !== undefined) state.toolsError = r.error;
      updateDrawerStates();
      if (state.panelTool) renderPanel();
    }
    if (state.view === 'tools' || state.panelTool) statusTimer = setTimeout(refreshStatus, 3000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadTools().then(refreshStatus); } });

  async function launchTool(id) {
    const t = state.tools.find(x => x.id === id);
    if (!t) return;
    if (t.type === 'bookmarklet') return openPanel(id);
    if (t.type === 'builtin') return openOcr(t, true);
    if (state.pending.has(id)) return toast('正在启动，请稍等…');
    state.pending.add(id);
    renderTools();
    if (t.type === 'service') toast(`正在打开 ${t.name}…`, 60000);
    if (t.type === 'combo') toast(`正在执行"${t.name}"…`, 120000);
    const r = await api(`/api/tools/${encodeURIComponent(id)}/launch`, { method: 'POST' });
    state.pending.delete(id);
    if (r.ok) {
      toast(t.type === 'combo' ? `"${t.name}"的 ${r.steps} 步都做完了` : r.state === 'started' ? `${t.name} 已启动，浏览器正在打开` : `已打开 ${t.name}`);
    } else {
      toast(r.message || '没打开', 5000);
      openPanel(r.failedTool || id);
    }
    refreshStatus();
  }

  // ---------------------------------------------------------------- 侧边面板

  const BOOKMARKLET = "javascript:(function(){var W=window;['copy','cut','contextmenu','selectstart','dragstart'].forEach(function(n){W.addEventListener(n,function(e){e.stopPropagation();},true);});W.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&/^[acx]$/i.test(e.key))e.stopPropagation();},true);var s=document.createElement('style');s.textContent='*,*::before,*::after{user-select:text!important;-webkit-user-select:text!important;}';document.documentElement.appendChild(s);['oncopy','oncut','oncontextmenu','onselectstart','ondragstart','onmousedown'].forEach(function(p){document[p]=null;if(document.body)document.body[p]=null;});document.querySelectorAll('[oncopy],[oncontextmenu],[onselectstart],[ondragstart]').forEach(function(el){['oncopy','oncut','oncontextmenu','onselectstart','ondragstart'].forEach(function(p){el[p]=null;el.removeAttribute(p);});});var t=document.createElement('div');t.textContent='已解除复制限制';t.style.cssText='position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#2f4a43;color:#fff;padding:8px 16px;border-radius:6px;z-index:2147483647;font:14px sans-serif';document.documentElement.appendChild(t);setTimeout(function(){t.remove();},1800);})();";

  function openPanel(id) {
    state.form = null;
    state.ocr = null;
    state.panelTool = id;
    $('#panel').hidden = false; leavePocketPanel();
    $('#scrim').hidden = false;
    renderPanel(true);
    refreshStatus();
  }
  function closePanel() {
    leavePocketPanel();
    state.panelTool = null;
    state.form = null;
    state.ocr = null;
    $('#panel').hidden = true;
    $('#scrim').hidden = true;
  }
  $('#scrim').addEventListener('click', closePanel);

  function renderPanel(first) {
    const t = state.tools.find(x => x.id === state.panelTool);
    const box = $('#panel .panel-inner');
    if (!t) { closePanel(); return; }
    const st = toolState(t);
    const s = state.status[t.id] || {};
    const oldPre = box.querySelector('pre.log');
    const logOpen = !first && !!oldPre && !oldPre.hidden;
    const logText = logOpen ? oldPre.textContent : '';

    let body = '';
    const raw = t.raw || {};
    const upd = state.updateInfo[t.id];
    const ghBox = raw['来源'] ? `
        <div class="gh-box">
          <div class="sub">来源：<a href="${esc(raw['来源'])}" target="_blank" rel="noopener">${esc(raw['来源'].replace(/^https:\/\//, ''))}</a>${raw['版本'] ? `　版本 ${esc(raw['版本'].slice(0, 7))}` : ''}</div>
          ${upd && upd.loading ? '<p class="sub">正在检查…</p>'
            : upd && !upd.ok ? `<div class="err">${esc(upd.message)}</div>`
            : upd && upd.hasUpdate ? `<div class="hints">有新版本 ${esc(upd.latest)}（现在是 ${esc(upd.current || '未知')}）。更新只会覆盖项目自带的文件，你自己的数据不会动。</div>`
            : upd ? '<p class="sub">已经是最新版本了。</p>' : ''}
          <div class="btn-row">
            <button class="btn" data-act="check-update">检查更新</button>
            ${upd && upd.hasUpdate ? '<button class="btn primary" data-act="do-update">更新到新版本</button>' : ''}
          </div>
        </div>` : '';
    if (t.type === 'combo') {
      const steps = raw['步骤'] || [];
      body = `
        <div class="btn-row"><button class="btn primary" data-act="launch">开始执行</button></div>
        <ol class="combo-steps">${steps.map(st => `<li>${st['类型'] === '等待' ? `等 ${esc(st['秒'])} 秒` : st['类型'] === '网址' ? `打开网址 ${esc(st['网址'])}` : `打开"${esc(st['名字'])}"`}</li>`).join('')}</ol>`;
    } else if (t.type === 'builtin') {
      body = `<p>${esc(t.desc || '百宝匣自带的工具。')}</p><div class="btn-row"><button class="btn primary" data-act="launch">打开</button></div>`;
    } else if (t.type === 'bookmarklet') {
      body = `
        <p>这个工具作用在<strong>别的网页</strong>上，所以需要先在浏览器里放一个书签按钮，只做一次：</p>
        <ol>
          <li>按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> 让浏览器显示书签栏。</li>
          <li>用鼠标按住下面这个按钮，拖到书签栏上松手。</li>
        </ol>
        <a class="bookmarklet" href="${esc(BOOKMARKLET)}" onclick="return false">${isImgIcon(t.icon) ? '' : esc(t.icon) + ' '}${esc(t.name)}</a>
        <p>以后遇到不让复制、不让右键的网页，点一下书签栏上的这个按钮，页面顶部会提示"已解除复制限制"，然后就能正常复制了。</p>
        <p class="sub">少数网站把文字做成了图片，这种它解决不了。</p>`;
    } else {
      const err = st === 'error' && s.error ? s.error : null;
      body = `
        ${err ? `<div class="err">${esc(err.message)}${err.fix ? `<div style="margin-top:8px"><button class="btn primary" data-act="fix" data-kind="${esc(err.fix.kind)}">${esc(err.fix.label)}</button></div>` : ''}</div>` : ''}
        <div class="btn-row">
          <button class="btn primary" data-act="launch">${t.type === 'service' && st === 'running' ? '打开网页' : '打开'}</button>
          ${t.type === 'service' ? `<button class="btn" data-act="stop" ${st === 'running' || s.mine ? '' : 'disabled'}>停止</button>` : ''}
          ${t.folder ? `<button class="btn" data-act="folder">打开文件夹</button>` : ''}
        </div>
        <dl>
          <dt>类型</dt><dd>${esc(t.typeLabel)}</dd>
          ${t.folder ? `<dt>文件夹</dt><dd>${esc(t.folder)}</dd>` : ''}
          ${t.start ? `<dt>启动命令</dt><dd><code>${esc(t.start)}</code></dd>` : ''}
          ${t.url ? `<dt>网址</dt><dd>${esc(t.url)}</dd>` : ''}
          ${t.setup ? `<dt>自动安装</dt><dd>缺少 ${esc(t.setup.missing)} 时先运行 <code>${esc(t.setup.run)}</code></dd>` : ''}
        </dl>
        ${ghBox}
        ${t.type === 'service' ? `<button class="btn ghost" data-act="log">${logOpen ? '刷新运行记录' : '看运行记录'}</button>
        <pre class="log" ${logOpen ? '' : 'hidden'}>${esc(logText)}</pre>` : ''}`;
    }
    const ck = state.checkup[t.id];
    if (ck && ck.level !== 'ok') body = `<div class="${ck.level === 'error' ? 'err' : 'hints'}">体检发现：${esc(ck.message)}</div>` + body;
    box.innerHTML = `
      <h2 id="panel-title"><span aria-hidden="true">${iconHtml(t.icon)}</span>${esc(t.name)}
        <button class="close" data-act="close" aria-label="关闭">×</button></h2>
      <div class="sub">${esc(t.desc || '')}${t.type === 'service' && STATE_TEXT[st] ? `${t.desc ? '　' : ''}状态：${STATE_TEXT[st]}` : ''}</div>
      ${body}
      ${t.note ? `<p style="margin-top:22px"><button class="btn" data-act="note">看说明书：${esc(t.note)}</button></p>` : ''}
      <div class="btn-row panel-foot">
        <button class="btn" data-act="edit-tool">修改这个工具</button>
        <button class="btn ghost danger" data-act="delete-tool">从柜子里拿掉</button>
      </div>`;
  }

  $('#panel').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (/^quit/.test(b.dataset.act)) return quitFlow(b.dataset.act);
    if (/^desk-/.test(b.dataset.act)) return deskAct(b.dataset.act, b);
    if (/^(pw|backup|cfg|pv|skin|bt)-/.test(b.dataset.act)) return settingsAct(b.dataset.act, b);
    if (/^ocr-/.test(b.dataset.act)) return ocrAct(b.dataset.act);
    if (/^trash-/.test(b.dataset.act)) return trashAct(b.dataset.act, b);
    if (/^pk-/.test(b.dataset.act)) return pocketAct(b.dataset.act, b);
    if (b.dataset.act === 'enter-private') { closePanel(); return togglePrivate(); }
    if (b.dataset.act === 'ck-run') return runCheckupUI(false);
    if (b.dataset.act === 'ck-deep') return runCheckupUI(true);
    if (/^ai-/.test(b.dataset.act)) return aiDraftAct(b.dataset.act);
    if (b.dataset.act === 'open-settings') return openSettings();
    if (b.dataset.act === 'chat-clear') { state.chat = []; return openChat(); }
    if (/^(bm|bn)-/.test(b.dataset.act)) return;
    const id = state.panelTool;
    const enc = encodeURIComponent(id);
    switch (b.dataset.act) {
      case 'close': closePanel(); break;
      case 'launch': launchTool(id); break;
      case 'stop': {
        b.disabled = true;
        const r = await api(`/api/tools/${enc}/stop`, { method: 'POST' });
        toast(r.ok ? '已停止' : (r.message || '没停下来'));
        refreshStatus();
        break;
      }
      case 'folder': {
        const r = await api(`/api/tools/${enc}/open-folder`, { method: 'POST' });
        if (!r.ok) toast(r.message);
        break;
      }
      case 'fix': {
        if (b.dataset.kind === 'freeport' && !confirm('会强制关掉正在占用这个端口的程序，确定吗？')) return;
        state.pending.add(id);
        renderTools(); renderPanel();
        toast('正在修复，可能要一两分钟…', 120000);
        const r = await api(`/api/tools/${enc}/fix`, { method: 'POST', json: { kind: b.dataset.kind } });
        state.pending.delete(id);
        toast(r.ok ? '修好了，正在打开' : (r.message || '没修好'));
        refreshStatus();
        break;
      }
      case 'log': {
        const r = await api(`/api/tools/${enc}/log`);
        const pre = $('#panel pre.log');
        pre.hidden = false;
        pre.textContent = r.log || '（还没有记录）';
        pre.scrollTop = pre.scrollHeight;
        b.textContent = '刷新运行记录';
        break;
      }
      case 'note': {
        const t = state.tools.find(x => x.id === id);
        closePanel();
        $('#q').value = '';
        openNote(t.note);
        break;
      }
      case 'edit-tool': openForm(id); break;
      case 'check-update': {
        state.updateInfo[id] = { loading: true };
        renderPanel();
        state.updateInfo[id] = await api(`/api/tools/${enc}/check-update`, { method: 'POST' });
        if (state.panelTool === id) renderPanel();
        break;
      }
      case 'do-update': {
        if (!confirm('更新会先停掉这个工具，下载新版本覆盖进去，可能要一两分钟。继续吗？')) return;
        state.pending.add(id);
        renderTools();
        toast('正在更新…', 180000);
        const r = await api(`/api/tools/${enc}/update`, { method: 'POST' });
        state.pending.delete(id);
        delete state.updateInfo[id];
        toast(r.ok ? `更新好了，现在是 ${r.version}` : (r.message || '更新失败'), 5000);
        await loadTools();
        refreshStatus();
        if (state.panelTool === id) renderPanel();
        break;
      }
      case 'delete-tool': {
        const t = state.tools.find(x => x.id === id);
        if (!confirm(`把"${t.name}"从柜子里拿掉？\n只是不在百宝匣里显示了，电脑上的项目文件和说明书都不会删。`)) return;
        const r = await api(`/api/tools/${enc}`, { method: 'DELETE' });
        if (!r.ok) return toast(r.message || '没拿掉');
        closePanel();
        toast(`已拿掉"${t.name}"`);
        await loadTools();
        refreshStatus();
        break;
      }
    }
  });

  // ---------------------------------------------------------------- 桌面版

  // 桌面版才有 window.baibaoDesktop；网页版这里一直是 null
  let DESK = null;
  const keyLabel = acc => String(acc || '').replace('CommandOrControl', 'Ctrl').split('+').join(' + ') || '（不用）';
  const keyKbd = acc => String(acc || 'Ctrl+Alt+H').replace('CommandOrControl', 'Ctrl').split('+').map(k => `<kbd>${esc(k)}</kbd>`).join('+');
  const privateKey = () => (DESK && DESK.keys['私密']) || 'CommandOrControl+Alt+H';

  async function initDesktop() {
    if (!window.baibaoDesktop) return;
    try { DESK = await window.baibaoDesktop.get(); } catch { DESK = null; return; }
    document.body.classList.add('desktop');
    window.baibaoDesktop.onCommand(async cmd => {
      if (cmd === 'private') return togglePrivate();
      if (cmd === 'boss') {
        // 老板键：在私密区里就马上锁上，下次打开看到的是普通区
        if (state.space === 'private') {
          await api('/api/private/lock', { method: 'POST' });
          await leavePrivate(true);
        }
        closePanel();
      }
    });
  }

  function deskSectionHtml() {
    const k = DESK.keys;
    const row = (name, title, tip) => `<div class="desk-key"><span>${title}<small>${tip}</small></span>
      <button class="btn small key-btn" data-act="desk-key" data-name="${name}">${esc(keyLabel(k[name]))}</button>
      <button class="link-btn" data-act="desk-key-reset" data-name="${name}">恢复默认</button></div>`;
    return `<section class="setting" id="desk-setting">
      <strong>桌面版</strong>
      <p class="sub">这些快捷键在哪都能按，不用先点开百宝匣。点一下快捷键再按新的组合就能改。</p>
      ${row('呼出', '叫出 / 藏起百宝匣', '')}
      ${row('老板键', '老板键', '马上把百宝匣藏起来')}
      <div class="field" style="margin-top:12px"><span>点窗口右上角的 × 时</span>
        <label class="check"><input type="radio" name="close-mode" value="tray" ${DESK.closeMode !== 'quit' ? 'checked' : ''}> 藏到右下角托盘，继续运行（推荐）</label>
        <label class="check"><input type="radio" name="close-mode" value="quit" ${DESK.closeMode === 'quit' ? 'checked' : ''}> 直接退出百宝匣</label>
      </div>
      <p class="sub" style="margin-top:10px">你的数据（记忆区、工具、设置）都在：<button class="link-btn" data-act="desk-data">${esc(DESK.dataDir)}</button></p>
    </section>`;
  }

  // 改快捷键：等用户按下一个组合
  let capturing = null;
  function startCapture(btn) {
    if (capturing) capturing.btn.textContent = capturing.old;
    capturing = { btn, old: btn.textContent, name: btn.dataset.name };
    btn.textContent = '请按新的组合…（Esc 取消）';
    btn.classList.add('capturing');
  }
  document.addEventListener('keydown', async e => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    const { btn, old, name } = capturing;
    if (e.key === 'Escape') { btn.textContent = old; btn.classList.remove('capturing'); capturing = null; return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const mods = [];
    if (e.ctrlKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    let key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5)
      : /^F\d{1,2}$/.test(e.code) ? e.code : ({ Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\' })[e.code];
    if (!key) return toast('这个键用不了，换一个');
    if (!mods.includes('CommandOrControl') && !mods.includes('Alt') && !/^F\d/.test(key)) return toast('要和 Ctrl 或 Alt 一起按，免得打字时误触');
    const acc = [...mods, key].join('+');
    capturing = null;
    btn.classList.remove('capturing');
    const r = await window.baibaoDesktop.setKey(name, acc);
    if (!r.ok) { btn.textContent = old; return toast(r.message || '没改成', 4000); }
    DESK.keys = r.keys;
    btn.textContent = keyLabel(acc);
    toast(`改好了：${keyLabel(acc)}`);
  }, true);

  async function deskAct(act, btn) {
    if (act === 'desk-key') return startCapture(btn);
    if (act === 'desk-key-reset') {
      const r = await window.baibaoDesktop.setKey(btn.dataset.name, null);
      if (!r.ok) return toast(r.message || '没改成', 4000);
      DESK.keys = r.keys;
      const b = btn.parentElement.querySelector('.key-btn');
      if (b) b.textContent = keyLabel(r.keys[btn.dataset.name]);
      return toast('已恢复默认');
    }
    if (act === 'desk-data') return window.baibaoDesktop.openDataDir();
  }
  $('#panel').addEventListener('change', async e => {
    if (e.target.name !== 'close-mode' || !DESK) return;
    await window.baibaoDesktop.setCloseMode(e.target.value);
    DESK.closeMode = e.target.value;
    toast(e.target.value === 'quit' ? '点 × 会直接退出' : '点 × 会藏到托盘');
  });

  // ---------------------------------------------------------------- 设置

  async function openSettings() {
    state.form = null;
    state.panelTool = null;
    state.ocr = null;
    $('#panel').hidden = false; leavePocketPanel();
    $('#scrim').hidden = false;
    const box = $('#panel .panel-inner');
    box.innerHTML = '<h2 id="panel-title">设置<button class="close" type="button" data-act="close" aria-label="关闭">×</button></h2><p class="sub">读取中…</p>';
    const [a, st, skinHtml, bt] = await Promise.all([api('/api/autostart'), api('/api/settings'), skinSectionHtml(), api('/api/butler')]);
    const last = st.lastBackup ? fmtDate(st.lastBackup) : '还没备份过';
    box.innerHTML = `
      <h2 id="panel-title">设置<button class="close" type="button" data-act="close" aria-label="关闭">×</button></h2>

      ${skinHtml}

      ${state.space === 'private' ? `<section class="setting">
        <strong>私密区</strong>
        <p class="sub">普通区的页面上不会出现任何和这里有关的东西。按 ${keyKbd(privateKey())} 或点"锁上离开"出去，30 分钟不用会自动锁上。</p>
        ${DESK ? `<div class="desk-key"><span>私密区快捷键${DESK ? '（在哪都能按）' : ''}</span><button class="btn small key-btn" data-act="desk-key" data-name="私密">${esc(keyLabel(privateKey()))}</button><button class="link-btn" data-act="desk-key-reset" data-name="私密">恢复默认</button></div>` : ''}
        <div class="btn-row">
          <button class="btn" data-act="pw-set">改密码</button>
          <button class="btn" data-act="pv-import">把普通区的工具搬进来</button>
        </div>
      </section>` : ''}

      <section class="setting">
        <strong>自动备份</strong>
        <p class="sub">把记忆区、工具和栏目复制到另一个文件夹，每 30 分钟检查一次，只复制改过的。选一个网盘会自动同步的文件夹（OneDrive、百度网盘同步空间等），电脑坏了也不怕。</p>
        <label class="field"><span>备份到</span>
          <span class="with-btn">
            <input id="backup-dir" value="${esc(st.backupDir)}" placeholder="比如 C:\\Users\\你的名字\\OneDrive" spellcheck="false">
            <button class="btn" data-act="backup-save">${st.backupDir ? '保存' : '开始备份'}</button>
          </span>
          <small>在文件资源管理器里打开那个文件夹，点顶部地址栏复制，粘贴到这里。会在里面建一个"百宝匣备份"文件夹。</small>
        </label>
        ${st.suggestions && st.suggestions.length && !st.backupDir ? `<p class="sub">找到了这台电脑的 OneDrive：${st.suggestions.map(d => `<button class="link-btn" data-act="backup-pick" data-dir="${esc(d)}">${esc(d)}</button>`).join(' ')}</p>` : ''}
        ${st.backupDir ? `<p class="sub">上次备份：${esc(last)}${st.backupError ? `，出错：${esc(st.backupError)}` : ''}</p>
          <div class="btn-row"><button class="btn" data-act="backup-now">现在备份一次</button>
          <button class="btn" data-act="backup-restore">从备份恢复</button>
          <button class="btn ghost" data-act="backup-off">关掉自动备份</button></div>
          <p class="sub" style="margin-top:8px">"从备份恢复"会把备份里有、这台电脑上没有的东西拷回来。换了电脑、或者误删了文件时用。</p>` : ''}
      </section>

      <section class="setting">
        <strong>联网代理</strong>
        <p class="sub">从 GitHub 下载项目、剪藏国外网页的图片、工具体检时用。国内网站用不到。如果你开着 Clash 之类的代理软件，填它的地址（在代理软件设置里能看到端口）。</p>
        <span class="with-btn">
          <input id="proxy-input" value="${esc(st.proxy || '')}" placeholder="比如 http://127.0.0.1:7890，不用就留空" spellcheck="false">
          <button class="btn" data-act="cfg-proxy-save">保存</button>
        </span>
      </section>

      <section class="setting" id="ai-setting">
        <strong>AI</strong>
        <p class="sub">用来提炼资料速查卡、整理说明、回答问题。需要你在 AI 服务商那里注册拿一个密钥（按用量付费，一般很便宜）。</p>
        <div class="btn-row" style="margin-bottom:8px">
          <span class="sub" style="align-self:center">快速填好：</span>
          <button class="btn small" data-act="cfg-ai-preset" data-url="https://api.deepseek.com" data-model="deepseek-chat">DeepSeek</button>
          <button class="btn small" data-act="cfg-ai-preset" data-url="https://dashscope.aliyuncs.com/compatible-mode/v1" data-model="qwen-plus">通义千问</button>
        </div>
        <label class="field"><span>接口地址</span><input id="ai-url" value="${esc(st.ai.baseUrl)}" placeholder="https://api.deepseek.com" spellcheck="false"></label>
        <label class="field"><span>模型</span><input id="ai-model" value="${esc(st.ai.model)}" placeholder="deepseek-chat" spellcheck="false"></label>
        <label class="field"><span>密钥</span><input id="ai-key" type="password" placeholder="${st.ai.hasKey ? '已保存（不改就留空）' : 'sk-…'}" autocomplete="off"></label>
        <label class="check"><input type="checkbox" id="ai-proxy" ${st.ai.useProxy ? 'checked' : ''}> AI 也走上面的代理（用国外的 AI 服务时勾上）</label>
        <label class="check"><input type="checkbox" id="ai-free-set" ${st.ai.free ? 'checked' : ''}> <span>"问问"默认用自由回答<br><small>不勾：先按你的资料简短回答。勾上：像平常和 AI 聊天一样，用它自己的知识详细回答。问问面板里也能随时切换。</small></span></label>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn primary" data-act="cfg-ai-save">保存</button>
          <button class="btn" data-act="cfg-ai-test">测试一下</button>
        </div>
        <p class="sub" id="ai-test-result"></p>
      </section>

      ${bt && bt.ok ? butlerSectionHtml(bt) : ''}

      ${DESK && state.space !== 'private' ? deskSectionHtml() : ''}

      <section class="setting">
        <label class="check"><input type="checkbox" id="autostart" ${a.on ? 'checked' : ''} ${a.supported ? '' : 'disabled'}>
          <span><strong>开机自动启动</strong><br>
          <small>${DESK ? `电脑开机后百宝匣悄悄待在右下角托盘里，不弹窗口。想用时点托盘图标，或按 ${esc(keyLabel(DESK.keys['呼出']))}。` : '电脑开机后百宝匣在后台悄悄运行，不弹黑色窗口。想用时直接在浏览器打开 http://127.0.0.1:3456（建议收藏这个网址），或双击"启动百宝匣.bat"。'}${a.supported ? '' : '只在 Windows 上可用。'}</small></span></label>
      </section>

      ${state.space !== 'private' ? updateSectionHtml() : ''}

      <section class="setting">
        <strong>关闭百宝匣</strong>
        <p class="sub">${DESK ? '彻底退出百宝匣（托盘图标也会消失）。在这里关可以选择让它开的工具继续运行。' : '黑色窗口关掉也会关闭百宝匣，但那样会把它开的工具一起关掉。在这里关可以选择让工具继续运行。'}</p>
        <div id="quit-box"><button class="btn" data-act="quit">关闭百宝匣</button></div>
      </section>`;
    const cb = $('#autostart');
    if (cb) cb.addEventListener('change', async () => {
      const r = await api('/api/autostart', { method: 'POST', json: { on: cb.checked } });
      cb.checked = !!r.on;
      toast(r.on ? '已设为开机自动启动' : '已取消开机自动启动');
    });
  }
  $('#settings').addEventListener('click', openSettings);

  // 私密区里：把普通区的工具搬进来
  async function openImportPanel() {
    const r = await api('/api/private/main-tools');
    const list = r.tools || [];
    showPanel(`${panelHead('把普通区的工具搬进来')}
      <p class="sub">勾上要搬的，搬进来以后普通区就看不到它们了。</p>
      ${list.length ? `<ul class="pick-list">${list.map(t => `<li><label class="check"><input type="checkbox" value="${esc(t.id)}"> ${iconHtml(t.icon)} ${esc(t.name)}</label></li>`).join('')}</ul>
        <div class="btn-row"><button class="btn primary" data-act="pv-move">搬进来</button></div>` : '<p class="empty-note">普通区没有工具。</p>'}`);
  }

  function butlerSectionHtml(bt) {
    const priv = state.space === 'private';
    const p = bt.persona || {};
    return `<section class="setting" id="butler-setting">
      <strong>${priv ? '这边的管家' : '管家'}</strong>
      <p class="sub">"问问"里回答你的那位。起个名字，写下她的性格、说话方式、口头禅，AI 会照着演；她能做的事（翻资料、打开工具、新建说明）不用写。${priv ? '这里的设定只在私密区里用。' : ''}</p>
      <label class="field"><span>名字</span><input id="bt-name" value="${esc(p.名字 || '')}" maxlength="20" placeholder="百宝匣"></label>
      <label class="field"><span>人格设定</span><textarea id="bt-persona" rows="8" placeholder="比如：说话温柔，喜欢用游戏打比方……">${esc(p.设定 || '')}</textarea></label>
      ${priv ? `<label class="check"><input type="checkbox" id="bt-allow" ${bt.allowPrivate ? 'checked' : ''}> <span>允许管家看私密区的资料<br><small>打开后，在这里问问时，用到的私密区说明和资料会发给你设置的 AI 服务。不打开的话，她只能陪你聊天，看不到这里的任何东西。</small></span></label>` : ''}
      <div class="btn-row"><button class="btn primary" data-act="bt-save">保存</button></div>
    </section>`;
  }

  async function settingsAct(act, btn) {
    if (act === 'bt-save') {
      const json = { persona: { 名字: $('#bt-name').value.trim(), 设定: $('#bt-persona').value } };
      if ($('#bt-allow')) json.allowPrivate = $('#bt-allow').checked;
      const r = await api('/api/butler', { method: 'POST', json });
      if (!r.ok) return toast(r.message || '没存上');
      state.butler = null;
      return toast(`存好了，${r.persona.名字 || '管家'}下次回答就会用新的设定`);
    }
    if (act === 'skin-use') {
      const id = btn.dataset.id;
      const r = await api('/api/skins/use', { method: 'POST', json: { id } });
      if (!r.ok) return toast(r.message || '没换成');
      applySkin(id);
      document.querySelectorAll('#skin-setting .skin-card').forEach(c => {
        const b = c.querySelector('.skin-pick');
        const on = b.dataset.id === id;
        c.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        const em = b.querySelector('.skin-name em');
        if (on && !em) b.querySelector('.skin-name').insertAdjacentHTML('beforeend', '<em>使用中</em>');
        if (!on && em) em.remove();
      });
      return;
    }
    if (act === 'skin-del') {
      if (!confirm(`删掉皮肤"${btn.dataset.name}"？`)) return;
      const r = await api('/api/skins/delete', { method: 'POST', json: { id: btn.dataset.id } });
      if (!r.ok) return toast(r.message || '没删掉');
      applySkin(r.current);
      toast('删掉了');
      return openSettings();
    }
    if (act === 'pv-move') {
      const ids = [...document.querySelectorAll('#panel .pick-list input:checked')].map(i => i.value);
      if (!ids.length) return toast('先勾上要搬的工具');
      const r = await api('/api/private/move-in', { method: 'POST', json: { ids } });
      if (!r.ok) return toast(r.message || '没搬成');
      toast(`搬进来了 ${r.moved} 个`);
      closePanel();
      await loadTools();
      return;
    }
    if (act === 'pv-import') return openImportPanel();
    if (act === 'cfg-proxy-save') {
      const r = await api('/api/settings/proxy', { method: 'POST', json: { proxy: $('#proxy-input').value } });
      toast(r.ok ? (r.proxy ? '代理已保存' : '已清空代理') : (r.message || '没保存'));
      if (r.ok) $('#proxy-input').value = r.proxy;
      return;
    }
    if (act === 'cfg-ai-preset') {
      $('#ai-url').value = btn.dataset.url;
      $('#ai-model').value = btn.dataset.model;
      $('#ai-key').focus();
      toast('地址和模型填好了，再填上你的密钥');
      return;
    }
    if (act === 'cfg-ai-save' || act === 'cfg-ai-test') {
      const key = $('#ai-key').value.trim();
      await api('/api/ai', { method: 'POST', json: { baseUrl: $('#ai-url').value, model: $('#ai-model').value, key, useProxy: $('#ai-proxy').checked } });
      if (key) { $('#ai-key').value = ''; $('#ai-key').placeholder = '已保存（不改就留空）'; }
      if (act === 'cfg-ai-save') { toast('AI 设置已保存'); return; }
      const out = $('#ai-test-result');
      out.textContent = '正在连接…';
      btn.disabled = true;
      const r = await api('/api/ai/test', { method: 'POST' });
      btn.disabled = false;
      out.textContent = r.ok ? `连上了，AI 回复："${r.reply}"` : `没连上：${r.message}`;
      out.className = r.ok ? 'sub ok-text' : 'sub err-text';
      return;
    }
    if (act === 'backup-restore') {
      btn.disabled = true;
      const r = await api('/api/backup/restore', { method: 'POST', json: {} });
      btn.disabled = false;
      if (!r.ok) return toast(r.message || '恢复失败', 4000);
      if (r.conflicts) {
        const list = (r.conflictList || []).slice(0, 8).join('\n');
        const go = confirm(`已拷回 ${r.restored} 个本机没有的文件。\n\n另外有 ${r.conflicts} 个文件，备份里的和本机现在的不一样：\n${list}${r.conflicts > 8 ? '\n……' : ''}\n\n要用备份里的覆盖吗？（覆盖前会把本机现在的版本存到百宝匣文件夹里的"恢复前的旧文件"）`);
        if (go) {
          const r2 = await api('/api/backup/restore', { method: 'POST', json: { overwrite: true } });
          toast(r2.ok ? `恢复好了，覆盖了 ${r2.saved} 个文件，旧版本在"恢复前的旧文件"里` : (r2.message || '恢复失败'), 5000);
        }
      } else {
        toast(r.restored ? `恢复好了，拷回了 ${r.restored} 个文件` : '本机和备份一样，不需要恢复', 4000);
      }
      await loadTools();
      return openSettings();
    }
    if (act === 'pw-set' || act === 'pw-clear') {
      const has = state.private.hasPassword;
      const fields = [];
      if (has) fields.push({ name: 'old', label: '原来的密码', type: 'password' });
      if (act === 'pw-set') {
        fields.push({ name: 'p1', label: has ? '新密码（至少 4 位）' : '密码（至少 4 位）', type: 'password' });
        fields.push({ name: 'p2', label: '再输一遍', type: 'password' });
      }
      const v = await ask({
        title: act === 'pw-clear' ? '不要密码了' : (has ? '改密码' : '设一个密码'),
        text: '忘了密码的话，用记事本打开百宝匣文件夹里的 settings.json，删掉"私密密码"那一段，重启百宝匣后按 ' + keyLabel(privateKey()) + ' 重新设。',
        fields, okText: act === 'pw-clear' ? '去掉密码' : '保存',
      });
      if (!v) return;
      if (act === 'pw-set' && v.p1 !== v.p2) return toast('两次输入的不一样');
      const r = await api('/api/private/set', { method: 'POST', json: { old: v.old || '', password: act === 'pw-clear' ? '' : v.p1 } });
      if (!r.ok) return toast(r.message || '没设成');
      toast('密码改好了', 3000);
      if (state.space === 'private') return leavePrivate(true);
      await loadTools();
      return openSettings();
    }
    if (act === 'backup-pick') { $('#backup-dir').value = btn.dataset.dir; return; }
    if (act === 'backup-save' || act === 'backup-off') {
      const dir = act === 'backup-off' ? '' : $('#backup-dir').value.trim();
      if (act === 'backup-save' && !dir) return toast('先填一个文件夹位置');
      btn.disabled = true;
      toast(dir ? '正在备份…' : '正在关掉…', 30000);
      const r = await api('/api/backup', { method: 'POST', json: { dir } });
      btn.disabled = false;
      if (r.off) toast('已关掉自动备份');
      else toast(r.ok ? `备份好了，复制了 ${r.copied} 个文件` : (r.message || '备份失败'), 4000);
      return openSettings();
    }
    if (act === 'backup-now') {
      btn.disabled = true;
      toast('正在备份…', 30000);
      const r = await api('/api/backup', { method: 'POST', json: {} });
      toast(r.ok ? (r.copied ? `备份好了，复制了 ${r.copied} 个改过的文件` : '备份好了，没有新改动') : (r.message || '备份失败'), 4000);
      return openSettings();
    }
  }

  // ---------------------------------------------------------------- 截图识字

  function openOcr(t, start) {
    state.form = null;
    state.panelTool = null;
    state.ocr = { tool: t, status: 'idle', text: '', message: '' };
    $('#panel').hidden = false; leavePocketPanel();
    $('#scrim').hidden = false;
    renderOcr();
    if (start) ocrSnip();
  }

  function renderOcr() {
    const o = state.ocr;
    if (!o) return;
    const box = $('#panel .panel-inner');
    const keep = $('#ocr-text') ? $('#ocr-text').value : o.text;
    box.innerHTML = `
      <h2 id="panel-title"><span aria-hidden="true">${iconHtml(o.tool.icon)}</span>${esc(o.tool.name)}
        <button class="close" type="button" data-act="close" aria-label="关闭">×</button></h2>
      <div class="sub">框选屏幕上任意区域，把里面的字变成能复制的文字。网页、图片、视频、软件界面都行。</div>
      <div class="btn-row" style="margin:14px 0">
        <button class="btn primary" data-act="ocr-snip" ${o.status === 'busy' ? 'disabled' : ''}>${o.status === 'busy' ? '等你框选…' : '截图识字'}</button>
      </div>
      ${o.status === 'busy' ? '<p class="ocr-wait">屏幕变暗后，按住鼠标框住要识别的文字，松手就好。按 Esc 取消。</p>' : ''}
      ${o.message ? `<div class="${o.status === 'error' ? 'err' : 'hints'}">${esc(o.message)}</div>` : ''}
      <label class="field"><span>识别出的文字</span>
        <textarea id="ocr-text" rows="9" placeholder="识别结果会出现在这里。也可以直接在这个面板里按 Ctrl+V 粘贴一张图片来识别。">${esc(keep)}</textarea></label>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" data-act="ocr-copy">复制</button>
        <button class="btn ghost" data-act="ocr-note">存成一篇说明</button>
      </div>
      <div class="btn-row panel-foot">
        <button class="btn" data-act="ocr-edit">修改这个工具</button>
      </div>`;
  }

  async function ocrSnip() {
    const o = state.ocr;
    o.status = 'busy'; o.message = '';
    renderOcr();
    const r = await api('/api/ocr/snip', { method: 'POST' });
    if (state.ocr !== o) return;
    showOcrResult(r);
  }

  function showOcrResult(r) {
    const o = state.ocr;
    if (r.ok) {
      o.status = 'done';
      o.text = r.text;
      if ($('#ocr-text')) $('#ocr-text').value = r.text;
      o.message = r.empty ? '没认出文字。框得再大一点，或者换个清楚点的地方试试。' : '认出来了，文字已经复制好，可以直接 Ctrl+V 粘贴。';
      if (!r.empty) toast('文字已复制');
    } else {
      o.status = 'error';
      o.message = r.message || '没识别成功';
    }
    renderOcr();
  }

  document.addEventListener('paste', async e => {
    if (!state.ocr || $('#panel').hidden) return;
    const item = [...(e.clipboardData && e.clipboardData.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const o = state.ocr;
    o.status = 'busy'; o.message = '正在识别粘贴的图片…';
    renderOcr();
    const r = await api('/api/ocr/image', { method: 'POST', body: item.getAsFile(), headers: { 'Content-Type': 'application/octet-stream' } });
    if (state.ocr === o) showOcrResult(r);
  });

  async function ocrAct(act) {
    const text = $('#ocr-text') ? $('#ocr-text').value : '';
    if (act === 'ocr-snip') return ocrSnip();
    if (act === 'ocr-copy') {
      if (!text.trim()) return toast('还没有文字');
      try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { $('#ocr-text').select(); document.execCommand('copy'); toast('已复制'); }
      return;
    }
    if (act === 'ocr-note') {
      if (!text.trim()) return toast('还没有文字');
      const v = await ask({ title: '存成一篇说明', fields: [{ name: 'title', label: '标题', value: text.split(/\n/)[0].slice(0, 20) }], okText: '保存' });
      if (!v) return;
      const r = await api('/api/new-note', { method: 'POST', json: { title: v.title, text: `# ${v.title}\n标签: 截图识字\n\n${text}\n` } });
      if (!r.ok) return toast(r.message || '没存上');
      closePanel();
      $('#q').value = '';
      openNote(r.id);
      return;
    }
    if (act === 'ocr-edit') openForm(state.ocr.tool.id);
  }

  async function quitFlow(act) {
    const box = $('#quit-box');
    if (act === 'quit') {
      const r = await api('/api/running');
      const running = r.running || [];
      if (!running.length) {
        if (!confirm('关闭百宝匣？')) return;
        return doQuit(true);
      }
      box.innerHTML = `<p>这些工具还在运行：<strong>${running.map(esc).join('、')}</strong>。要一起关掉吗？</p>
        <div class="btn-row">
          <button class="btn primary" data-act="quit-stop">一起关掉</button>
          <button class="btn" data-act="quit-keep">让它们继续运行</button>
          <button class="btn ghost" data-act="quit-cancel">先不关</button>
        </div>`;
    }
    if (act === 'quit-stop') doQuit(true);
    if (act === 'quit-keep') doQuit(false);
    if (act === 'quit-cancel') box.innerHTML = '<button class="btn" data-act="quit">关闭百宝匣</button>';
  }

  async function doQuit(stopTools) {
    await api('/api/shutdown', { method: 'POST', json: { stopTools } });
    clearTimeout(statusTimer);
    document.body.innerHTML = `<div class="closed"><h1 class="mark">百宝匣</h1>
      <p>已关闭${stopTools ? '' : '，工具还在继续运行'}。</p>
      <p>${DESK ? '要再打开，双击"百宝匣.exe"。' : '要再打开，双击百宝匣文件夹里的"启动百宝匣.bat"。'}</p></div>`;
  }

  // ---------------------------------------------------------------- 电子书阅读

  const READ_KEY = (space, name) => `bb-read:${space}:${name}`;
  function loadReadPos(name) {
    try { return JSON.parse(localStorage.getItem(READ_KEY(state.space, name)) || 'null'); } catch { return null; }
  }
  function saveReadPos() {
    const r = state.reader;
    if (!r) return;
    try { localStorage.setItem(READ_KEY(state.space, r.name), JSON.stringify({ chapter: r.chapter, ratio: r.ratio || 0 })); } catch {}
  }
  function readerFont() {
    try { return Number(localStorage.getItem('bb-read-font')) || 18; } catch { return 18; }
  }

  async function openReader(name, { chapter = null, word = '' } = {}) {
    if (state.editing && !confirmLeave()) return;
    const info = await api(`/api/epub?name=${encodeURIComponent(name)}`);
    if (!info.ok) return toast(info.message || '这本书打不开');
    $('#q').value = '';
    const pos = loadReadPos(name);
    state.reader = {
      name, info,
      chapter: chapter !== null ? chapter : (pos ? Math.min(pos.chapter, info.chapters.length - 1) : 0),
      ratio: chapter !== null ? 0 : (pos ? pos.ratio : 0),
      word,
      font: readerFont(),
    };
    state.readerFrom = state.view === 'reader' ? state.readerFrom : state.view;
    setView('reader', { push: false });
    await loadBookNotes();
    renderBookNotesCount();
    $('#rd-title').textContent = info.title;
    $('#rd-toc').innerHTML = `<p class="rd-author">${esc(info.author || '')}</p><ol>${info.chapters.map((c, i) =>
      `<li><button data-ch="${i}">${esc(c.title)}</button></li>`).join('')}</ol>`;
    showChapter();
  }

  function showChapter() {
    const r = state.reader;
    if (!r) return;
    const c = r.info.chapters[r.chapter];
    $('#rd-chapter').textContent = c ? c.title : '';
    $('#rd-pos').textContent = `${r.chapter + 1} / ${r.info.chapters.length}`;
    document.querySelectorAll('#rd-toc button').forEach(b => b.setAttribute('aria-current', String(Number(b.dataset.ch) === r.chapter)));
    $('#view-reader [data-rd=prev]').disabled = r.chapter <= 0;
    $('#view-reader [data-rd=next]').disabled = r.chapter >= r.info.chapters.length - 1;
    const enc = c.href.split('/').map(encodeURIComponent).join('/');
    $('#rd-frame').src = `/书/${state.space}/${encodeURIComponent(r.name)}/${enc}`;
    saveReadPos();
    if (state.space === 'main') api('/api/stats/read', { method: 'POST', json: { name: r.name, title: r.info.title, chapter: r.chapter, total: r.info.chapters.length } });
  }

  // 每章加载好以后：套上阅读样式、恢复位置、高亮搜索词、接管书里的链接
  $('#rd-frame').addEventListener('load', () => {
    const r = state.reader;
    const frame = $('#rd-frame');
    let doc;
    try { doc = frame.contentDocument; } catch { return; }
    if (!r || !doc || !doc.documentElement) return;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const st = doc.createElement('style');
    st.textContent = `
      html { background: ${dark ? '#1b2220' : '#fbfaf6'}; }
      body { max-width: 38em; margin: 0 auto; padding: 28px 22px 60px;
        font-size: ${r.font}px !important; line-height: 1.85 !important;
        color: ${dark ? '#dde3dc' : '#22302c'} !important; background: transparent !important;
        font-family: "Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif; }
      img, svg { max-width: 100% !important; height: auto !important; }
      a { color: ${dark ? '#8fb4ff' : '#2d6fd1'}; }
      mark { background: #ffe58a; color: #222; }
      p { margin: .6em 0; }`;
    (doc.head || doc.documentElement).appendChild(st);
    hideSelBar();
    paintHighlights(doc);
    if (r.scrollTo) {
      const m = doc.querySelector(`mark.hl[data-hl="${r.scrollTo}"]`);
      r.scrollTo = null;
      if (m) { m.scrollIntoView({ block: 'center' }); r.ratio = null; }
    }
    // 高亮搜索词，滚到第一处
    if (r.word) {
      const hit = markWord(doc, r.word);
      r.word = '';
      if (hit) { hit.scrollIntoView({ block: 'center' }); r.ratio = null; }
    }
    const win = frame.contentWindow;
    if (r.ratio) {
      const h = doc.documentElement.scrollHeight - win.innerHeight;
      win.scrollTo(0, h * r.ratio);
    }
    let t;
    win.addEventListener('scroll', () => {
      hideSelBar();
      clearTimeout(t);
      t = setTimeout(() => {
        const h = doc.documentElement.scrollHeight - win.innerHeight;
        r.ratio = h > 0 ? win.scrollY / h : 0;
        saveReadPos();
      }, 300);
    });
    // 书里的链接：章节间跳转留在阅读器里，外部网址开新标签
    doc.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (/^https?:/i.test(href)) { e.preventDefault(); window.open(href, '_blank', 'noopener'); return; }
      const url = new URL(a.href);
      const prefix = `/书/${state.space}/${encodeURIComponent(r.name)}/`;
      if (!url.pathname.startsWith(prefix)) return;
      e.preventDefault();
      const inner = decodeURIComponent(url.pathname.slice(prefix.length));
      const i = r.info.chapters.findIndex(c => c.href === inner);
      if (i >= 0 && i !== r.chapter) { r.chapter = i; r.ratio = 0; showChapter(); }
      if (url.hash) setTimeout(() => { try { const el = frame.contentDocument.getElementById(url.hash.slice(1)); if (el) el.scrollIntoView(); } catch {} }, 300);
    });
    doc.addEventListener('keydown', readerKeys);
  });

  function markWord(doc, word) {
    const w = word.toLowerCase();
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
    let first = null, n;
    const nodes = [];
    while ((n = walker.nextNode())) if (n.nodeValue.toLowerCase().includes(w)) nodes.push(n);
    for (const node of nodes.slice(0, 50)) {
      const i = node.nodeValue.toLowerCase().indexOf(w);
      const range = doc.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + w.length);
      const m = doc.createElement('mark');
      range.surroundContents(m);
      if (!first) first = m;
    }
    return first;
  }

  function readerKeys(e) {
    if (state.view !== 'reader' || !state.reader) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') readerAct('next');
    if (e.key === 'ArrowLeft') readerAct('prev');
    if (e.key === 'Escape' && $('#panel').hidden) readerAct('back');
  }
  document.addEventListener('keydown', readerKeys);

  function readerAct(act) {
    const r = state.reader;
    if (!r) return;
    if (act === 'back') {
      state.reader = null;
      $('#rd-frame').src = 'about:blank';
      setView(state.readerFrom && state.readerFrom !== 'search' ? state.readerFrom : 'memory');
      return;
    }
    if (act === 'prev' && r.chapter > 0) { r.chapter--; r.ratio = 0; showChapter(); }
    if (act === 'next' && r.chapter < r.info.chapters.length - 1) { r.chapter++; r.ratio = 0; showChapter(); }
    if (act === 'toc') $('#view-reader').classList.toggle('toc-open');
    if (act === 'notes') openBookNotes();
    if (act === 'bigger' || act === 'smaller') {
      r.font = Math.max(14, Math.min(28, r.font + (act === 'bigger' ? 2 : -2)));
      try { localStorage.setItem('bb-read-font', String(r.font)); } catch {}
      const doc = $('#rd-frame').contentDocument;
      if (doc && doc.body) doc.body.style.setProperty('font-size', r.font + 'px', 'important');
    }
  }

  $('#view-reader').addEventListener('click', e => {
    const b = e.target.closest('[data-rd]');
    if (b) return readerAct(b.dataset.rd);
    const ch = e.target.closest('[data-ch]');
    if (ch && state.reader) {
      state.reader.chapter = Number(ch.dataset.ch);
      state.reader.ratio = 0;
      $('#view-reader').classList.remove('toc-open');
      showChapter();
    }
  });

  // ---------------------------------------------------------------- 回收站

  async function openTrash() {
    state.form = null; state.panelTool = null; state.ocr = null;
    $('#panel').hidden = false; leavePocketPanel();
    $('#scrim').hidden = false;
    const r = await api('/api/trash');
    const items = r.items || [];
    $('#panel .panel-inner').innerHTML = `
      <h2 id="panel-title">回收站<button class="close" type="button" data-act="close" aria-label="关闭">×</button></h2>
      <p class="sub">删掉的说明和资料都在这里，可以恢复，也可以彻底删除。</p>
      ${items.length ? `<ul class="trash-list">${items.map(it => `
        <li data-trash="${esc(it.name)}">
          <span class="g">${it.kind === 'note' ? '📄' : fileGlyph(it.name)}</span>
          <span class="tt"><span class="t">${esc(it.kind === 'note' ? it.name.replace(/\.md$/i, '') : it.name)}</span>
            <span class="s">${it.kind === 'note' ? '说明' : '资料'} · ${fmtSize(it.size)} · ${fmtDate(it.deleted)} 删除</span></span>
          <button class="btn small" data-act="trash-restore">恢复</button>
          <button class="btn small ghost danger" data-act="trash-delete">彻底删除</button>
        </li>`).join('')}</ul>
        <div class="btn-row panel-foot"><button class="btn ghost danger" data-act="trash-empty">清空回收站</button><button class="btn ghost" data-act="trash-folder">打开回收站文件夹</button></div>`
        : '<p class="empty-note">回收站是空的。</p>'}`;
  }
  $('#open-trash').addEventListener('click', openTrash);

  async function trashAct(act, btn) {
    const li = btn.closest('[data-trash]');
    const name = li && li.dataset.trash;
    if (act === 'trash-restore') {
      const r = await api('/api/trash/restore', { method: 'POST', json: { name } });
      if (!r.ok) return toast(r.message || '没恢复成');
      toast(r.kind === 'note' ? `已恢复说明"${r.id}"` : `已恢复"${r.name}"`);
    }
    if (act === 'trash-delete') {
      if (!confirm(`彻底删除"${name}"？删了就找不回来了。`)) return;
      const r = await api('/api/trash/delete', { method: 'POST', json: { name } });
      toast(r.ok ? '已彻底删除' : (r.message || '没删掉'), r.ok ? 2500 : 7000);
    }
    if (act === 'trash-folder') {
      await api('/api/trash/open-folder', { method: 'POST' });
      return toast('已打开回收站文件夹');
    }
    if (act === 'trash-empty') {
      if (!confirm('清空回收站？里面的东西都会彻底删除，找不回来。')) return;
      btn.disabled = true;
      const r = await api('/api/trash/delete', { method: 'POST', json: { all: true } });
      toast(r.failed ? `有 ${r.failed} 个没删掉：${(r.names || []).slice(0, 3).join('、')}。${r.message || ''}` : '回收站已清空', r.failed ? 9000 : 3000);
    }
    await loadNotes();
    openTrash();
  }

  // ---------------------------------------------------------------- 加工具 / 改工具的表单

  const ICONS = ['📖', '🎬', '🎵', '🎮', '🐙', '🌐', '📁', '🛠️', '📝', '🧪', '📊', '🖼️', '🤖', '🧰', '🔍', '📦'];
  const TYPES = [
    { code: 'link', label: '网址', tip: '点一下打开某个网站' },
    { code: 'service', label: '本地项目', tip: '要先启动、再打开网页的项目，比如本地跑的小网站' },
    { code: 'folder', label: '文件夹', tip: '点一下打开电脑上的某个文件夹' },
    { code: 'program', label: '程序', tip: '点一下打开电脑上的某个软件' },
    { code: 'combo', label: '组合技', tip: '一个按钮按顺序做好几件事，比如先开代理、再开某个项目' },
  ];
  const PATH_TIP = '在文件资源管理器里打开它，点一下顶部的地址栏，按 Ctrl+C 复制，再粘贴到这里。';
  const FILE_TIP = '在文件资源管理器里找到它，右键 → "复制文件地址"，再粘贴到这里。桌面快捷方式也可以。';

  function openForm(editId, presetSection = '') {
    const t = editId && state.tools.find(x => x.id === editId);
    const r = (t && t.raw) || {};
    state.form = {
      editId: t ? t.id : null,
      type: t ? t.type : 'link',
      name: r['名字'] || '',
      icon: r['图标'] || '',
      desc: r['一句话'] || '',
      url: r['网址'] || '',
      folder: r['文件夹'] || '',
      program: r['程序'] || '',
      start: r['启动命令'] || '',
      health: r['就绪检查'] || '',
      setupMissing: (r['缺少时先运行'] || {})['缺少'] || '',
      setupRun: (r['缺少时先运行'] || {})['运行'] || '',
      private: t ? !!r['私密'] : state.space === 'private',
      note: r['说明书'] || '',
      section: t ? (t.section || '') : (presetSection || ''),
      createNote: !t,
      hints: [],
      source: r['来源'] || '',
      version: r['版本'] || '',
      ghUrl: '',
      steps: (r['步骤'] || []).map(st => st['类型'] === '等待' ? { kind: 'wait', seconds: st['秒'] }
        : st['类型'] === '网址' ? { kind: 'url', url: st['网址'] } : { kind: 'tool', name: st['名字'] }),
    };
    state.panelTool = null;
    state.ocr = null;
    $('#panel').hidden = false; leavePocketPanel();
    $('#scrim').hidden = false;
    renderForm();
    const first = $('#panel input[name=name]');
    if (first && !t) setTimeout(() => $('#panel .types input:checked').focus(), 50);
  }

  function field(name, label, { tip = '', placeholder = '', value } = {}) {
    const v = value !== undefined ? value : state.form[name];
    return `<label class="field"><span>${label}</span>
      <input name="${name}" value="${esc(v)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
      ${tip ? `<small>${tip}</small>` : ''}</label>`;
  }

  function renderForm() {
    const f = state.form;
    const box = $('#panel .panel-inner');
    const locked = f.type === 'bookmarklet' || f.type === 'builtin';
    let typeFields = '';
    if (f.type === 'link') {
      typeFields = field('url', '网址', { placeholder: 'https://...' });
    } else if (f.type === 'folder') {
      typeFields = field('folder', '文件夹位置', { tip: PATH_TIP, placeholder: 'C:\\Users\\...' });
    } else if (f.type === 'program') {
      typeFields = field('program', '程序位置', { tip: FILE_TIP, placeholder: 'C:\\Program Files\\...\\xxx.exe' });
    } else if (f.type === 'combo') {
      const names = state.tools.filter(x => x.type !== 'combo' && x.id !== f.editId).map(x => x.name);
      typeFields = `
        <div class="field"><span>步骤（从上往下依次做）</span>
          <ol class="steps-edit">${f.steps.map((st, i) => `
            <li data-step="${i}">
              ${st.kind === 'wait' ? `等 <input type="number" min="1" max="120" data-sf="seconds" value="${esc(st.seconds || 3)}" class="num"> 秒`
                : st.kind === 'url' ? `打开网址 <input data-sf="url" value="${esc(st.url || '')}" placeholder="https://...">`
                : `打开 <select data-sf="name"><option value="">选一个工具</option>${names.map(n => `<option ${n === st.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`}
              <span class="step-btns">
                <button type="button" data-step-act="up" aria-label="往上挪" ${i ? '' : 'disabled'}>↑</button>
                <button type="button" data-step-act="down" aria-label="往下挪" ${i < f.steps.length - 1 ? '' : 'disabled'}>↓</button>
                <button type="button" data-step-act="del" aria-label="删掉这一步">×</button>
              </span>
            </li>`).join('')}</ol>
          ${f.steps.length ? '' : '<p class="sub">还没有步骤，点下面的按钮加。</p>'}
          <div class="btn-row">
            <button type="button" class="btn small" data-step-add="tool">＋ 打开一个工具</button>
            <button type="button" class="btn small" data-step-add="wait">＋ 等几秒</button>
            <button type="button" class="btn small" data-step-add="url">＋ 打开网址</button>
          </div>
          <small>本地项目会自动等它准备好再做下一步。哪一步失败就停下来告诉你。</small>
        </div>`;
    } else if (f.type === 'service') {
      typeFields = `
        ${f.editId ? '' : `<label class="field gh-field"><span>从 GitHub 收编（可不填）</span>
          <span class="with-btn">
            <input data-gh-url value="${esc(f.ghUrl)}" placeholder="https://github.com/作者/项目" autocomplete="off" spellcheck="false">
            <button type="button" class="btn" data-act="gh-fetch">下载</button>
          </span>
          <small>贴 GitHub 项目网址点"下载"，会下载到你的"百宝匣项目"文件夹，并自动认出怎么启动。已经下载好的项目就跳过这一项，直接填下面的文件夹。</small></label>`}
        ${f.source ? `<p class="sub">来源：${esc(f.source)}${f.version ? `，版本 ${esc(f.version.slice(0, 7))}` : ''}</p>` : ''}
        <label class="field"><span>项目文件夹</span>
          <span class="with-btn">
            <input name="folder" value="${esc(f.folder)}" placeholder="C:\\Users\\你的用户名\\项目名" autocomplete="off" spellcheck="false">
            <button type="button" class="btn" data-act="detect">自动识别</button>
          </span>
          <small>${PATH_TIP} 然后点"自动识别"，下面几项会自动填好。</small></label>
        ${f.hints.length ? `<ul class="hints">${f.hints.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
        ${field('start', '启动命令', { placeholder: 'node server.js' })}
        ${field('url', '启动好后打开的网址', { placeholder: 'http://127.0.0.1:3000' })}
        <details ${f.health || f.setupRun ? 'open' : ''}><summary>更多设置（一般不用改）</summary>
          ${field('health', '就绪检查网址', { tip: '这个网址能打开，就说明项目启动好了。不填就用上面的网址。' })}
          <div class="two">
            ${field('setupMissing', '缺少这个文件夹时', { placeholder: 'node_modules' })}
            ${field('setupRun', '先运行这条命令', { placeholder: 'npm install' })}
          </div>
        </details>`;
    }
    box.innerHTML = `
      <h2 id="panel-title">${f.editId ? `修改：${esc(f.editId)}` : '加一个工具'}
        <button class="close" type="button" data-act="close" aria-label="关闭">×</button></h2>
      <form id="tool-form" novalidate>
        <fieldset class="types" ${locked ? 'disabled' : ''}>
          <legend>这是什么</legend>
          ${locked ? `<span class="type-chip"><input type="radio" checked><span>${f.type === 'builtin' ? '百宝匣自带' : '书签工具'}</span></span>` : TYPES.map(ty => `
            <label class="type-chip" title="${esc(ty.tip)}">
              <input type="radio" name="type" value="${ty.code}" ${f.type === ty.code ? 'checked' : ''}>
              <span>${ty.label}</span></label>`).join('')}
          <small>${esc((TYPES.find(ty => ty.code === f.type) || {}).tip || '')}</small>
        </fieldset>
        ${typeFields}
        ${field('name', '名字', { placeholder: '抽屉上写的字' })}
        ${state.sections.length ? `<label class="field"><span>放进哪个栏目</span>
          <select name="section">
            <option value="">未分类</option>
            ${state.sections.map(sec => `<option value="${esc(sec.name)}" ${f.section === sec.name ? 'selected' : ''}>${esc(sec.name)}</option>`).join('')}
          </select></label>` : ''}
        <div class="field"><span>图标</span>
          <div class="icons">
            ${ICONS.map(ic => `<button type="button" class="icon${f.icon === ic ? ' on' : ''}" data-icon="${ic}" aria-label="图标 ${ic}">${ic}</button>`).join('')}
            ${isImgIcon(f.icon) ? `<button type="button" class="icon on" data-icon="${esc(f.icon)}" aria-label="上传的图片">${iconHtml(f.icon)}</button>` : ''}
            <input type="hidden" name="icon" value="${esc(f.icon)}">
            <input value="${isImgIcon(f.icon) || ICONS.includes(f.icon) ? '' : esc(f.icon)}" class="icon-input" data-custom-icon aria-label="自己输入图标" placeholder="其他">
            <button type="button" class="btn small" data-act="icon-upload">用图片</button>
            <input type="file" id="icon-file" accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon" hidden>
          </div>
          <small>可以按 Win+. 打开表情面板挑一个放进"其他"框；也可以点"用图片"选一张图片（比如网站的 logo）。</small>
        </div>
        ${field('desc', '一句话说明（可不填）')}
        ${state.space === 'private' && f.editId
          ? '<label class="check"><input type="checkbox" name="private" ' + (f.private !== false ? 'checked' : '') + '> 放在私密区（取消勾选就搬回普通区）</label>'
          : ''}
        ${f.note
          ? field('note', '说明书', { tip: '记忆区里对应说明的标题。' })
          : `<label class="check"><input type="checkbox" name="createNote" ${f.createNote ? 'checked' : ''}> 同时在记忆区建一篇说明书，记下怎么用和踩过的坑</label>`}
        <div class="form-error" role="alert" hidden></div>
        <div class="btn-row form-actions">
          <button type="submit" class="btn primary">${f.editId ? '保存修改' : '放进柜子'}</button>
          <button type="button" class="btn" data-act="close">取消</button>
        </div>
      </form>`;
  }

  function readFormInputs() {
    const form = $('#tool-form');
    if (!form) return;
    for (const el of form.querySelectorAll('input[name], select[name]')) {
      if (el.type === 'radio') { if (el.checked) state.form[el.name] = el.value; }
      else if (el.type === 'checkbox') state.form[el.name] = el.checked;
      else state.form[el.name] = el.value;
    }
  }

  function showFormError(msg) {
    const e = $('#panel .form-error');
    if (!e) return toast(msg);
    e.textContent = msg;
    e.hidden = !msg;
    if (msg) e.scrollIntoView({ block: 'nearest' });
  }

  async function ghFetch() {
    readFormInputs();
    const f = state.form;
    if (!f.ghUrl.trim()) return showFormError('先把 GitHub 项目网址粘贴进来。');
    const btn = $('#panel [data-act=gh-fetch]');
    if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
    toast('正在从 GitHub 下载，项目大的话要等一会儿…', 120000);
    const r = await api('/api/github/fetch', { method: 'POST', json: { url: f.ghUrl } });
    if (!r.ok) {
      toast('下载没成功');
      if (btn) { btn.disabled = false; btn.textContent = '下载'; }
      return showFormError(r.message || '下载失败');
    }
    toast('下载好了');
    for (const k of ['folder', 'start', 'url', 'health', 'setupMissing', 'setupRun', 'source', 'version']) if (r[k]) f[k] = r[k];
    if (!f.name && r.name) f.name = r.name;
    f.hints = r.hints || [];
    renderForm();
  }

  async function detect() {
    readFormInputs();
    const f = state.form;
    if (!f.folder.trim()) return showFormError('先把项目文件夹的位置粘贴进来。');
    const btn = $('#panel [data-act=detect]');
    if (btn) { btn.disabled = true; btn.textContent = '识别中…'; }
    const r = await api('/api/tools/detect', { method: 'POST', json: { folder: f.folder } });
    if (!r.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '自动识别'; }
      return showFormError(r.message || '没识别出来');
    }
    if (r.type === 'program') {
      f.type = 'program';
      f.program = f.folder;
      f.folder = '';
    }
    for (const k of ['start', 'url', 'health', 'setupMissing', 'setupRun']) if (r[k]) f[k] = r[k];
    if (!f.name && r.name) f.name = r.name;
    f.hints = r.hints && r.hints.length ? r.hints : ['识别好了，看一下下面几项对不对。'];
    renderForm();
  }

  $('#panel').addEventListener('input', e => {
    if (!state.form || !e.target.closest('#tool-form')) return;
    // 组合技的步骤、GitHub 地址：直接记到表单状态里
    const stepLi = e.target.closest('[data-step]');
    if (stepLi && e.target.dataset.sf) {
      state.form.steps[Number(stepLi.dataset.step)][e.target.dataset.sf] = e.target.value;
      return;
    }
    if (e.target.matches('[data-gh-url]')) { state.form.ghUrl = e.target.value; return; }
    if (e.target.name === 'type') {
      readFormInputs();
      state.form.hints = [];
      renderForm();
      return;
    }
    if (e.target.matches('[data-custom-icon]')) {
      const v = e.target.value.trim();
      $('#panel input[name=icon]').value = v;
      state.form.icon = v;
      document.querySelectorAll('#panel .icon').forEach(b => b.classList.toggle('on', b.dataset.icon === v));
    }
    showFormError('');
  });

  // 粘贴文件夹后自动识别；选了图标图片就上传
  $('#panel').addEventListener('change', async e => {
    if (state.form && e.target.id === 'icon-file' && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 2 * 1024 * 1024) return showFormError('图片太大了，选一张 2MB 以内的。');
      readFormInputs();
      const r = await api(`/api/icon?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      if (!r.ok) return showFormError(r.message || '图片没传上');
      state.form.icon = r.icon;
      renderForm();
      return;
    }
    if (state.form && state.form.type === 'service' && e.target.name === 'folder') {
      readFormInputs();
      if (state.form.folder.trim() && !state.form.start) detect();
    }
  });

  $('#panel').addEventListener('click', e => {
    if (!state.form) return;
    const ic = e.target.closest('[data-icon]');
    if (ic) {
      readFormInputs();
      state.form.icon = ic.dataset.icon;
      $('#panel input[name=icon]').value = ic.dataset.icon;
      const custom = $('#panel [data-custom-icon]');
      if (custom) custom.value = '';
      document.querySelectorAll('#panel .icon').forEach(b => b.classList.toggle('on', b === ic));
      return;
    }
    if (e.target.closest('[data-act=detect]')) detect();
    if (e.target.closest('[data-act=gh-fetch]')) ghFetch();
    const add = e.target.closest('[data-step-add]');
    if (add) {
      readFormInputs();
      const kind = add.dataset.stepAdd;
      state.form.steps.push(kind === 'wait' ? { kind, seconds: 3 } : kind === 'url' ? { kind, url: '' } : { kind: 'tool', name: '' });
      renderForm();
      return;
    }
    const sa = e.target.closest('[data-step-act]');
    if (sa) {
      readFormInputs();
      const i = Number(sa.closest('[data-step]').dataset.step);
      const st = state.form.steps;
      if (sa.dataset.stepAct === 'del') st.splice(i, 1);
      if (sa.dataset.stepAct === 'up' && i > 0) [st[i - 1], st[i]] = [st[i], st[i - 1]];
      if (sa.dataset.stepAct === 'down' && i < st.length - 1) [st[i + 1], st[i]] = [st[i], st[i + 1]];
      renderForm();
    }
    if (e.target.closest('[data-act=icon-upload]')) $('#icon-file').click();
  });

  $('#panel').addEventListener('submit', async e => {
    if (e.target.id !== 'tool-form') return;
    e.preventDefault();
    readFormInputs();
    const f = state.form;
    const btn = $('#tool-form [type=submit]');
    btn.disabled = true;
    const payload = { ...f };
    delete payload.hints;
    const r = f.editId
      ? await api(`/api/tools/${encodeURIComponent(f.editId)}`, { method: 'PUT', json: payload })
      : await api('/api/tools', { method: 'POST', json: payload });
    btn.disabled = false;
    if (!r.ok) return showFormError(r.message || '没保存成功');
    const wasEdit = !!f.editId;
    closePanel();
    if (f.section) state.openSections.add(f.section);
    state.justAdded = r.id;
    if (state.view !== 'tools') setView('tools');
    await loadTools();
    refreshStatus();
    if (state.space === 'private' && f.private === false) {
      toast('已搬回普通区', 3000);
    } else {
      toast(wasEdit ? '已保存修改' : `"${r.id}"已经放进柜子了，点它试试`);
    }
  });

  // ---------------------------------------------------------------- 记忆区

  async function loadNotes() {
    const [r, pg] = await Promise.all([api('/api/notes'), api('/api/pages')]);
    if (pg && pg.pages) { state.pages = pg.pages; state.pageItems = pg.items || {}; state.pageTop = pg.top || {}; }
    // 读取失败时保留页面上原来的列表，不要显示成"全没了"
    if (!r.notes) { toast(r.message || '记忆区读取失败，刷新一下试试', 5000); return; }
    state.notes = r.notes || [];
    state.files = r.files || [];
    state.trashCount = r.trash || 0;
    const tb = $('#open-trash');
    if (tb) tb.textContent = state.trashCount ? `回收站（${state.trashCount}）` : '回收站';
    // 有文件正在读取文字时，过几秒刷新一下状态
    clearTimeout(state.indexTimer);
    if (state.files.some(f => f.indexed === 'pending') && state.view === 'memory') state.indexTimer = setTimeout(loadNotes, 4000);
    renderShelf();
  }

  function renderShelf() {
    const cur = state.note && state.note.id;
    renderBinder();
    // 已经放进活页的不再出现在下面的列表里
    const filed = (kind, id) => !!(state.pageItems || {})[kind + ':' + id];
    const looseNotes = state.notes.filter(n => !filed('note', n.id));
    const looseFiles = state.files.filter(f => !filed('file', f.name));
    $('#loose-h').hidden = !(state.pages || []).length;
    // 剪藏来的单独放一个栏目（标签里有"剪藏"的）
    const isClip = n => n.tags.includes('剪藏');
    const item = n => `
      <li><button data-note="${esc(n.id)}" aria-current="${n.id === cur}" draggable="true">
        <span class="t">${esc(n.title)}</span>
        <span class="s">${esc(n.tags.filter(t => t !== '剪藏').join('、') || fmtDate(n.updated))}</span>
      </button></li>`;
    const mine = looseNotes.filter(n => !isClip(n));
    const clips = looseNotes.filter(isClip);
    $('#note-list').innerHTML = mine.length ? mine.map(item).join('') : `<li class="none">${state.notes.length ? '都放进活页了。' : '还没有说明，点"新建说明"写第一篇。'}</li>`;
    const box = $('#clip-group');
    box.hidden = !clips.length;
    if (state.clipsOpen === undefined) state.clipsOpen = false;
    if (state.note && isClip(state.note)) state.clipsOpen = true;
    box.innerHTML = clips.length ? `
      <button class="shelf-h clip-toggle" type="button" aria-expanded="${state.clipsOpen}">
        <span class="chev" aria-hidden="true"></span>剪藏 <span class="cnt">${clips.length}</span></button>
      <ul class="list" ${state.clipsOpen ? '' : 'hidden'}>${clips.map(item).join('')}</ul>` : '';
    $('#file-list').innerHTML = looseFiles.length ? looseFiles.map(f => `
      <li class="file-row" data-file="${esc(f.name)}" draggable="true">
        <a href="${fileUrl(f.name)}" target="_blank" rel="noopener" data-open="${esc(f.name)}">
          <span class="t">${fileGlyph(f.name)} ${esc(f.name)}</span><span class="s">${fmtSize(f.size)}${f.indexed === 'pending' ? ' · 正在读取文字' : f.indexed === 'failed' ? ' · 读不出文字' : ''}</span>
        </a>
        <span class="file-acts">
          ${state.space === 'main' && f.indexed === 'done' ? `<button type="button" data-file-act="ai" title="让 AI 把它提炼成一张速查卡">AI 提炼</button>` : ''}
          <button type="button" data-file-act="rename" aria-label="给 ${esc(f.name)} 改名">改名</button>
          <button type="button" data-file-act="delete" class="danger" aria-label="删除 ${esc(f.name)}">删除</button>
        </span>
      </li>`).join('') : `<li class="none">${state.files.length ? '都放进活页了。' : '还没有资料。'}</li>`;
  }

  $('#file-list').addEventListener('click', async e => {
    const open = e.target.closest('[data-open]');
    if (open && /\.epub$/i.test(open.dataset.open)) { e.preventDefault(); return openReader(open.dataset.open); }
    if (open && OFFICE_RE.test(open.dataset.open)) { e.preventDefault(); return openOffice(open.dataset.open); }
    const b = e.target.closest('[data-file-act]');
    if (!b) return;
    const name = b.closest('[data-file]').dataset.file;
    const enc = encodeURIComponent(name);
    if (b.dataset.fileAct === 'ai') return aiSummarize('file', name, 'cheatsheet');
    if (b.dataset.fileAct === 'delete') {
      if (!confirm(`删除"${name}"？它会被移到记忆区文件夹里的 .回收站，需要时还能找回来。`)) return;
      const r = await api(`/api/files/${enc}`, { method: 'DELETE' });
      toast(r.ok ? '已移到回收站' : (r.message || '没删掉'));
    } else {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const v = await ask({ title: '给资料改名', text: '后缀不用改。', fields: [{ name: 'name', label: '新名字', value: base }], okText: '改名' });
      if (!v || !v.name.trim() || v.name.trim() === base) return;
      const r = await api(`/api/files/${enc}`, { method: 'PUT', json: { newName: v.name.trim() } });
      toast(r.ok ? `已改名为"${r.name}"` : (r.message || '没改成'));
    }
    loadNotes();
  });

  $('#note-list').addEventListener('click', e => {
    const b = e.target.closest('[data-note]');
    if (b) openNote(b.dataset.note);
  });
  $('#clip-group').addEventListener('click', e => {
    if (e.target.closest('.clip-toggle')) { state.clipsOpen = !state.clipsOpen; return renderShelf(); }
    const b = e.target.closest('[data-note]');
    if (b) openNote(b.dataset.note);
  });

  // ---------------------------------------------------------------- 活页（记忆区最上面那一叠带标签的）

  // 一组低饱和、亮度接近的颜色：c 标签色，l 浅色（后排、选中底色），k 描边
  const PAGE_COLORS = [
    { c: '#dcae9a', l: '#eadbd3', k: '#a67a66' }, { c: '#c4adc9', l: '#e3dae5', k: '#8a7290' },
    { c: '#a9bfd1', l: '#d9e2ea', k: '#6f8aa1' }, { c: '#d4b98a', l: '#ebdfc8', k: '#9c8158' },
    { c: '#aec5ad', l: '#dbe5da', k: '#75906f' }, { c: '#d6c58e', l: '#ece4c8', k: '#9e8f57' },
    { c: '#b3b8c9', l: '#dddfe7', k: '#7b8195' }, { c: '#9ec4bd', l: '#d3e5e1', k: '#66918a' },
    { c: '#c9b4a0', l: '#e7ddd2', k: '#93806b' },
  ];
  const OFFICE_RE = /\.(docx|xlsx|pptx)$/i;
  const PER_ROW = 5, RISE = 28, TAB_H = 34, PAGE_SIZE = 7, MAX_ROWS = 3;
  state.pages = [];
  state.pageItems = {};
  state.pageTop = {};
  // 标签显示的顺序：钉住的在最前面，档案盒里的不显示
  function displayPages() {
    const live = (state.pages || []).filter(p => !p.archived);
    return [...live.filter(p => p.pinned), ...live.filter(p => !p.pinned)];
  }
  state.pagePos = {};
  const pageColor = p => PAGE_COLORS[(p && p.color) % PAGE_COLORS.length] || PAGE_COLORS[0];
  const activeKey = () => 'bb-page:' + state.space;
  function getActive() { try { return localStorage.getItem(activeKey()) || ''; } catch { return state.activePage || ''; } }
  function setActive(id) { state.activePage = id || ''; try { localStorage.setItem(activeKey(), id || ''); } catch {} }
  // 现在展开着的活页（新建说明、拖进来的文件就放进这一张）
  function openPageId() {
    const id = getActive();
    return id && state.pages.some(p => p.id === id && !p.archived) ? id : '';
  }
  const pageOf = (kind, id) => state.pageItems[kind + ':' + id] || '';

  function tabShape(w, h) {
    return `M0 ${h} C5 ${h} 7 ${h - 3} 8.5 ${h - 8} L13 8 C14.5 3 17 1.5 22 1.5 L${w - 22} 1.5 C${w - 17} 1.5 ${w - 14.5} 3 ${w - 13} 8 L${w - 8.5} ${h - 8} C${w - 7} ${h - 3} ${w - 5} ${h} ${w} ${h}`;
  }

  function pageContents(pid) {
    const notes = state.notes.filter(n => pageOf('note', n.id) === pid).map(n => ({ kind: 'note', id: n.id, t: n.title, s: '说明' + (n.tags.length ? ' · ' + n.tags.slice(0, 3).join('、') : ''), updated: n.updated }));
    const files = state.files.filter(f => pageOf('file', f.name) === pid).map(f => ({ kind: 'file', id: f.name, t: f.name, s: fileKind(f.name) + ' · ' + fmtSize(f.size), updated: f.updated }));
    const top = k => state.pageTop[k] || 0;
    // 置顶的排最前面，其余按最近改过的排
    return [...notes, ...files].map(it => ({ ...it, top: top(it.kind + ':' + it.id) }))
      .sort((a, b) => (b.top ? 1 : 0) - (a.top ? 1 : 0) || (b.top - a.top) || b.updated - a.updated);
  }
  function fileKind(name) {
    if (/\.docx?$/i.test(name)) return 'Word';
    if (/\.xlsx?$/i.test(name)) return 'Excel';
    if (/\.pptx?$/i.test(name)) return 'PPT';
    if (/\.pdf$/i.test(name)) return 'PDF';
    if (/\.epub$/i.test(name)) return '电子书';
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return '图片';
    return '资料';
  }

  function renderBinder() {
    const box = $('#binder');
    if (!box) return;
    const pages = state.pages || [];
    if (!pages.length || !displayPages().length) {
      if (pages.length) {
        box.innerHTML = `<button type="button" class="binder-empty" data-page-all><span><b>活页都在档案盒里</b>点这里拿出来</span></button>
          <button type="button" class="bnew import-link" data-page-new>＋ 新活页</button>`;
        return;
      }
      box.innerHTML = `<button type="button" class="binder-empty" data-page-new>
        <svg width="90" height="30" viewBox="0 0 90 30" aria-hidden="true"><path d="${tabShape(90, 30)}" fill="none" stroke="currentColor" stroke-dasharray="4 3"></path></svg>
        <span><b>＋ 新活页</b>东西多了，可以分到一张张带标签的活页里</span></button>
        <button type="button" class="bnew import-link" data-page-import>导入别人给的活页…</button>`;
      return;
    }
    const active = openPageId();
    const avail = Math.max(240, box.clientWidth || 320);
    const W = Math.min(92, Math.floor((avail - 6) / (1 + 0.884 * (PER_ROW - 1))));
    const STEP = Math.round(W * 0.884);
    // 最多三排；再多的收进最后一个"+N"标签
    const all = displayPages();
    const cap = PER_ROW * MAX_ROWS;
    let shownPages = all;
    let overflow = 0;
    if (all.length > cap) {
      shownPages = all.slice(0, cap - 1);
      // 展开着的那张如果被挤到后面了，换到看得见的位置
      const ai = all.findIndex(p => p.id === active);
      if (ai >= cap - 1) shownPages = [...all.slice(0, cap - 2), all[ai]];
      overflow = all.length - shownPages.length;
    }
    state.displayOrder = all.map(p => p.id);
    const slots = shownPages.length + (overflow ? 1 : 0);
    const nRows = Math.max(1, Math.ceil(slots / PER_ROW));
    const frontTop = (nRows - 1) * RISE;
    let tabs = '';
    const rowLenOf = row => Math.min(PER_ROW, slots - row * PER_ROW);
    shownPages.forEach((p, i) => {
      const row = Math.floor(i / PER_ROW), j = i % PER_ROW;
      const rowLen = rowLenOf(row);
      const front = row === 0;
      const shift = front ? 0 : (rowLen < PER_ROW ? STEP / 2 : Math.round(STEP / 4));
      const on = p.id === active;
      const col = pageColor(p);
      const h = on && front ? TAB_H + 2 : TAB_H;
      const z = on && front ? 40 : front ? 15 - j : 10 - row * 2 + (on ? 1 : 0);
      const lift = on && !front ? -6 : 0;
      const alt = all.indexOf(p) < 9 ? `，Alt+${all.indexOf(p) + 1}` : '';
      tabs += `<button type="button" class="bt${on ? ' on' : ''}${front ? ' front' : ' back'}${p.pinned ? ' pinned' : ''}" data-page="${esc(p.id)}" aria-pressed="${on}" draggable="true"
        title="${esc(p.name)}（${p.count} 件${p.pinned ? '，钉住了' : ''}${alt}）" style="left:${shift + j * STEP}px;top:${frontTop - row * RISE}px;width:${W}px;height:${h}px;z-index:${z};${lift ? `transform:translateY(${lift}px);` : ''}--c:${col.c};--l:${col.l};--k:${col.k}">
        <svg width="${W}" height="${TAB_H + 2}" viewBox="0 0 ${W} ${TAB_H + 2}" aria-hidden="true"><path d="${tabShape(W, TAB_H + 2)}"></path><rect x="${W / 2 - 12}" y="6" width="24" height="3" rx="1.5"></rect></svg>
        <span class="bt-name">${esc(p.name)}</span>${p.pinned ? '<span class="bt-pin" aria-hidden="true"></span>' : ''}</button>`;
    });
    if (overflow) {
      const i = shownPages.length, row = Math.floor(i / PER_ROW), j = i % PER_ROW;
      const front = row === 0;
      const shift = front ? 0 : (rowLenOf(row) < PER_ROW ? STEP / 2 : Math.round(STEP / 4));
      tabs += `<button type="button" class="bt more-tab${front ? ' front' : ' back'}" data-page-all title="还有 ${overflow} 张活页" style="left:${shift + j * STEP}px;top:${frontTop - row * RISE}px;width:${W}px;height:${TAB_H}px;z-index:${front ? 15 - j : 10 - row * 2};--c:var(--surface);--l:var(--surface);--k:var(--line)">
        <svg width="${W}" height="${TAB_H + 2}" viewBox="0 0 ${W} ${TAB_H + 2}" aria-hidden="true"><path d="${tabShape(W, TAB_H + 2)}"></path></svg>
        <span class="bt-name">+${overflow} ▾</span></button>`;
    }
    let card;
    const ap = pages.find(p => p.id === active);
    if (ap) {
      const col = pageColor(ap);
      const items = pageContents(ap.id);
      const pos = Math.min(state.pagePos[ap.id] || 0, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1));
      state.pagePos[ap.id] = pos;
      const shown = items.slice(pos * PAGE_SIZE, pos * PAGE_SIZE + PAGE_SIZE);
      const cur = state.note ? 'note:' + state.note.id : state.doc ? 'file:' + state.doc.name : '';
      const nPages = Math.ceil(items.length / PAGE_SIZE);
      card = `<div class="bcard${shownPages.indexOf(ap) < PER_ROW ? ' from-front' : ''}" style="--c:${col.c};--l:${col.l};--k:${col.k}" data-page-card="${esc(ap.id)}">
        <span class="hole" aria-hidden="true"></span><span class="hole b" aria-hidden="true"></span>
        <div class="bcard-head"><span class="bcard-name">${esc(ap.name)}</span><span class="bcard-count">${items.length} 件</span>
          <button type="button" class="bcard-more" data-page-menu="${esc(ap.id)}" aria-label="这张活页的操作">⋯</button></div>
        ${items.length ? `<ul class="bcard-list">${shown.map(it => `<li><button type="button" class="bitem" draggable="true" data-item-kind="${it.kind}" data-item-id="${esc(it.id)}" aria-current="${cur === it.kind + ':' + it.id}">
          <span class="t">${it.top ? '<span class="it-pin" title="置顶了" aria-label="置顶"></span>' : ''}${it.kind === 'file' ? fileGlyph(it.id) + ' ' : ''}${esc(it.t)}</span><span class="s">${esc(it.s)}</span></button></li>`).join('')}</ul>`
          : `<p class="bcard-empty">这张活页还是空的。把下面列表里的说明或资料拖到"${esc(ap.name)}"标签上，或者右键 →"放进活页"。展开着的时候新建说明、拖进来的文件也会直接放进来。</p>`}
        ${nPages > 1 ? `<nav class="bpager" aria-label="翻页"><button type="button" data-page-step="-1" ${pos ? '' : 'disabled'}>‹ 上一页</button><span>${pos + 1} / ${nPages}</span><button type="button" data-page-step="1" ${pos < nPages - 1 ? '' : 'disabled'}>下一页 ›</button></nav>` : ''}
      </div>`;
    } else {
      card = '<div class="bclosed" aria-hidden="true"></div>';
    }
    const archived = pages.filter(p => p.archived).length;
    box.innerHTML = `<div class="bnew-row"><button type="button" class="bnew" data-page-all>全部活页${archived ? ` · 档案盒 ${archived}` : ''}</button><button type="button" class="bnew" data-page-new>＋ 新活页</button></div><div class="btabs" style="height:${frontTop + TAB_H}px">${tabs}</div>${card}`;
  }
  window.addEventListener('resize', () => { if (state.view === 'memory') renderBinder(); });

  $('#binder').addEventListener('click', async e => {
    if (e.target.closest('[data-page-new]')) return newPage();
    if (e.target.closest('[data-page-all]')) return openAllPages();
    if (e.target.closest('[data-page-import]')) return pickPageFile();
    const tab = e.target.closest('.bt[data-page]');
    if (tab) {
      const id = tab.dataset.page;
      setActive(openPageId() === id ? '' : id);
      return renderBinder();
    }
    const step = e.target.closest('[data-page-step]');
    if (step) {
      const id = openPageId();
      state.pagePos[id] = (state.pagePos[id] || 0) + Number(step.dataset.pageStep);
      return renderBinder();
    }
    const more = e.target.closest('[data-page-menu]');
    if (more) { const r = more.getBoundingClientRect(); return pageMenu(more.dataset.pageMenu, r.left, r.bottom + 4); }
    const it = e.target.closest('.bitem');
    if (it) {
      if (it.dataset.itemKind === 'note') openNote(it.dataset.itemId);
      else openFile(it.dataset.itemId);
    }
  });

  async function newPage(putItem) {
    const v = await ask({ title: '新活页', text: '给这张活页起个名字，比如"软件说明""读书""生活"。', fields: [{ name: 'name', label: '名字', placeholder: '最多 20 个字' }], okText: '建好' });
    if (!v || !v.name.trim()) return null;
    const r = await api('/api/pages', { method: 'POST', json: { action: 'create', name: v.name.trim() } });
    if (!r.ok) { toast(r.message || '没建成'); return null; }
    if (putItem) await api('/api/pages', { method: 'POST', json: { action: 'put', page: r.page.id, items: [putItem] } });
    setActive(r.page.id);
    await loadNotes();
    toast(putItem ? `建好了"${r.page.name}"，已经放进去了` : `建好了"${r.page.name}"`);
    return r.page;
  }

  async function putInto(pageId, items) {
    const r = await api('/api/pages', { method: 'POST', json: { action: 'put', page: pageId || null, items } });
    if (!r.ok) return toast(r.message || '没放成');
    state.pages = r.pages; state.pageItems = r.items; state.pageTop = r.top || {};
    const p = state.pages.find(x => x.id === pageId);
    toast(p ? `已放进"${p.name}"` : '已移出活页，回到下面的列表');
    renderShelf();
    if (state.note || state.doc) refreshPicker();
  }

  // ---- 拖：把说明 / 资料拖到标签上
  let dragItem = null;
  function itemFromEl(el) {
    if (!el) return null;
    const n = el.closest('[data-note]');
    if (n && n.closest('.shelf')) return { kind: 'note', id: n.dataset.note };
    const f = el.closest('.file-row[data-file]');
    if (f) return { kind: 'file', id: f.dataset.file };
    const b = el.closest('.bitem');
    if (b) return { kind: b.dataset.itemKind, id: b.dataset.itemId };
    return null;
  }
  $('.shelf').addEventListener('dragstart', e => {
    const it = itemFromEl(e.target);
    if (!it) return;
    dragItem = it;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-baibao-item', JSON.stringify(it));
    e.dataTransfer.setData('text/plain', it.id);
    document.body.classList.add('dragging-item');
  });
  $('.shelf').addEventListener('dragend', () => {
    dragItem = null;
    document.body.classList.remove('dragging-item');
    document.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
  });
  const isItemDrag = e => e.dataTransfer && [...e.dataTransfer.types].includes('application/x-baibao-item');
  $('.shelf').addEventListener('dragover', e => {
    if (!isItemDrag(e)) return;
    const tab = e.target.closest('.bt[data-page], .bcard, #loose-h, #note-list, #file-list');
    document.querySelectorAll('.drop-hover').forEach(x => x !== tab && x.classList.remove('drop-hover'));
    if (!tab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tab.classList.add('drop-hover');
  });
  $('.shelf').addEventListener('drop', e => {
    if (!isItemDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    let it = dragItem;
    try { it = JSON.parse(e.dataTransfer.getData('application/x-baibao-item')); } catch {}
    document.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
    if (!it) return;
    const tab = e.target.closest('.bt[data-page]');
    const card = e.target.closest('.bcard');
    if (tab) return putInto(tab.dataset.page, [it]);
    if (card) return putInto(card.dataset.pageCard, [it]);
    if (e.target.closest('#loose-h, #note-list, #file-list') && pageOf(it.kind, it.id)) return putInto('', [it]);
  });

  // ---- 右键菜单
  function showMenu(html, x, y) {
    const m = $('#ctx');
    m.innerHTML = html;
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    const first = m.querySelector('button');
    if (first) first.focus();
  }
  function hideMenu() { const m = $('#ctx'); if (m) m.hidden = true; }
  document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) hideMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideMenu(); });
  window.addEventListener('blur', hideMenu);

  function itemMenu(it, x, y) {
    const cur = pageOf(it.kind, it.id);
    const pages = state.pages.filter(p => !p.archived).map(p => `<button type="button" role="menuitem" data-m="put" data-p="${esc(p.id)}"><i style="background:${pageColor(p).c}"></i>${esc(p.name)}${p.id === cur ? '<b>✓</b>' : ''}</button>`).join('');
    state.menuItem = it;
    const isTop = !!state.pageTop[it.kind + ':' + it.id];
    showMenu(`<div class="ctx-h">放进活页</div>${pages || '<div class="ctx-note">还没有活页</div>'}
      <hr><button type="button" role="menuitem" data-m="new">＋ 新活页并放进去…</button>
      ${cur ? `<button type="button" role="menuitem" data-m="top">${isTop ? '取消置顶' : '在活页里置顶'}</button><button type="button" role="menuitem" data-m="out">移出活页</button>` : ''}`, x, y);
  }

  function pageMenu(id, x, y) {
    const p = state.pages.find(q => q.id === id);
    if (!p) return;
    const order = displayPages();
    const i = order.indexOf(p);
    state.menuPage = id;
    showMenu(`<div class="ctx-h">${esc(p.name)}</div>
      <button type="button" role="menuitem" data-m="pin">${p.pinned ? '取消钉住' : '钉住（永远排在最前面）'}</button>
      <button type="button" role="menuitem" data-m="rename">改名</button>
      <div class="ctx-colors">${PAGE_COLORS.map((c, k) => `<button type="button" data-m="color" data-c="${k}" aria-label="换成第 ${k + 1} 种颜色" style="background:${c.c};border-color:${c.k}"${k === p.color ? ' aria-pressed="true"' : ''}></button>`).join('')}</div>
      <button type="button" role="menuitem" data-m="left" ${i > 0 ? '' : 'disabled'}>往前挪</button>
      <button type="button" role="menuitem" data-m="right" ${i < order.length - 1 ? '' : 'disabled'}>往后挪</button>
      <hr><button type="button" role="menuitem" data-m="export">导出这张活页（发给别人 / 换电脑带走）</button>
      <button type="button" role="menuitem" data-m="archive">放进档案盒（先收起来）</button>
      <button type="button" role="menuitem" data-m="del" class="danger">删掉这张活页</button>`, x, y);
  }

  $('#ctx').addEventListener('click', async e => {
    const b = e.target.closest('button[data-m]');
    if (!b || b.disabled) return;
    const m = b.dataset.m;
    hideMenu();
    if (m === 'put') return putInto(b.dataset.p, [state.menuItem]);
    if (m === 'top') {
      const it = state.menuItem;
      const on = !state.pageTop[it.kind + ':' + it.id];
      const r = await api('/api/pages', { method: 'POST', json: { action: 'top', on, items: [it] } });
      if (!r.ok) return toast(r.message || '没改成');
      state.pages = r.pages; state.pageItems = r.items; state.pageTop = r.top || {};
      toast(on ? '置顶了' : '取消置顶了');
      return renderShelf();
    }
    if (m === 'out') return putInto('', [state.menuItem]);
    if (m === 'new') return newPage(state.menuItem);
    const id = state.menuPage;
    const p = state.pages.find(q => q.id === id);
    if (!p) return;
    let r;
    if (m === 'rename') {
      const v = await ask({ title: '给活页改名', fields: [{ name: 'name', label: '新名字', value: p.name }], okText: '改名' });
      if (!v || !v.name.trim() || v.name.trim() === p.name) return;
      r = await api('/api/pages', { method: 'POST', json: { action: 'rename', id, name: v.name.trim() } });
    } else if (m === 'color') {
      r = await api('/api/pages', { method: 'POST', json: { action: 'color', id, color: Number(b.dataset.c) } });
    } else if (m === 'left' || m === 'right') {
      // 按看到的顺序和旁边那张换位置
      const order = displayPages();
      const k = order.indexOf(p) + (m === 'left' ? -1 : 1);
      const other = order[k];
      if (!other) return;
      const before = m === 'left' ? other.id : (order[k + 1] ? order[k + 1].id : null);
      r = await api('/api/pages', { method: 'POST', json: before ? { action: 'move', id, before } : { action: 'move', id, to: state.pages.length } });
    } else if (m === 'pin') {
      r = await api('/api/pages', { method: 'POST', json: { action: 'pin', id, on: !p.pinned } });
      if (r.ok) toast(p.pinned ? '取消钉住了' : '钉住了，它会一直排在最前面');
    } else if (m === 'archive') {
      r = await api('/api/pages', { method: 'POST', json: { action: 'archive', id, on: true } });
      if (r.ok) { if (openPageId() === id) setActive(''); toast(`"${p.name}"放进档案盒了，点"全部活页"能拿出来`, 3500); }
    } else if (m === 'export') {
      return exportPage(id);
    } else if (m === 'del') {
      if (!confirm(`删掉活页"${p.name}"？里面的 ${p.count} 件东西不会删，会回到下面的列表。`)) return;
      r = await api('/api/pages', { method: 'POST', json: { action: 'delete', id } });
      if (r.ok && openPageId() === id) setActive('');
    }
    if (!r || !r.ok) return toast((r && r.message) || '没改成');
    state.pages = r.pages; state.pageItems = r.items; state.pageTop = r.top || {};
    renderShelf();
    if (state.note || state.doc) refreshPicker();
  });

  // ---- 导出 / 导入一整张活页
  function exportPage(id) {
    const a = document.createElement('a');
    a.href = '/api/pages/export?id=' + encodeURIComponent(id) + (state.space === 'private' ? '&space=private' : '');
    const pg = (state.pages || []).find(x => x.id === id);
    a.download = ((pg && pg.name) || '活页').replace(/[\\/:*?"<>|]/g, '_') + '.bbpage';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('正在导出，存好的 .bbpage 文件可以发给别人，拖进百宝匣就能导入', 4000);
  }
  function pickPageFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.bbpage';
    inp.onchange = () => { if (inp.files[0]) importPage(inp.files[0]); };
    inp.click();
  }
  async function importPage(file) {
    toast(`正在导入 ${file.name}…`, 30000);
    const r = await api('/api/pages/import', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) return toast(r.message || '没导入成功', 4000);
    setActive(r.page.id);
    await loadNotes();
    if (state.view !== 'memory') setView('memory');
    toast(`导入好了：活页"${r.page.name}"，${r.count} 件东西`, 3500);
  }

  // ---- 全部活页（一行放不下的、档案盒里的都在这）
  function openAllPages() {
    const live = displayPages();
    const arch = state.pages.filter(p => p.archived);
    const row = p => `<li><button type="button" class="ap-item" data-ap-open="${esc(p.id)}"><i style="background:${pageColor(p).c};border-color:${pageColor(p).k}"></i>
      <span class="t">${esc(p.name)}${p.pinned ? ' <small>钉住</small>' : ''}</span><span class="s">${p.count} 件</span></button></li>`;
    showPanel(`${panelHead('全部活页')}
      <label class="field"><span class="sr">找活页</span><input id="ap-q" placeholder="找活页…打几个字" autocomplete="off"></label>
      <ul class="ap-list" id="ap-live">${live.map(row).join('') || '<li class="empty-note">还没有活页。</li>'}</ul>
      <h3 class="st-h">档案盒 <small style="font-weight:400;color:var(--muted)">用完的活页先收在这，里面的东西照样搜得到</small></h3>
      <ul class="ap-list" id="ap-arch">${arch.map(p => `<li class="ap-arch"><span><i style="background:${pageColor(p).c};border-color:${pageColor(p).k}"></i>${esc(p.name)} <small>${p.count} 件</small></span>
        <button type="button" class="btn small" data-ap-unarchive="${esc(p.id)}">拿出来</button></li>`).join('') || '<li class="empty-note">档案盒是空的。右键活页标签 →"放进档案盒"。</li>'}</ul>
      <div class="btn-row panel-foot"><button class="btn" data-ap-new>＋ 新活页</button><button class="btn ghost" data-ap-import>导入活页（.bbpage）…</button></div>
      <p class="sub">小技巧：Alt+1 到 Alt+9 直接打开前 9 张活页；按住标签可以拖着换顺序。</p>`);
    const q = $('#ap-q');
    q.focus();
    q.addEventListener('input', () => {
      const w = q.value.trim().toLowerCase();
      document.querySelectorAll('#ap-live li, #ap-arch li.ap-arch').forEach(li => { li.hidden = !!w && !li.textContent.toLowerCase().includes(w); });
    });
    q.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = [...document.querySelectorAll('#ap-live [data-ap-open]')].find(b => !b.closest('li').hidden);
      if (first) first.click();
    });
  }
  $('#panel').addEventListener('click', async e => {
    const o = e.target.closest('[data-ap-open]');
    if (o) {
      const id = o.dataset.apOpen;
      const all = displayPages();
      // 被收进"+N"里的那张，挪到前面来（钉住的后面）
      const idx = all.findIndex(p => p.id === id);
      if (idx >= PER_ROW * MAX_ROWS - 1) {
        const firstFree = all.find(p => !p.pinned);
        if (firstFree && firstFree.id !== id) {
          const r = await api('/api/pages', { method: 'POST', json: { action: 'move', id, before: firstFree.id } });
          if (r.ok) { state.pages = r.pages; state.pageItems = r.items; state.pageTop = r.top || {}; }
        }
      }
      setActive(id);
      closePanel();
      if (state.view !== 'memory') setView('memory'); else renderShelf();
      return;
    }
    const un = e.target.closest('[data-ap-unarchive]');
    if (un) {
      const r = await api('/api/pages', { method: 'POST', json: { action: 'archive', id: un.dataset.apUnarchive, on: false } });
      if (!r.ok) return toast(r.message || '没拿出来');
      state.pages = r.pages; state.pageItems = r.items; state.pageTop = r.top || {};
      renderShelf();
      toast('拿出来了');
      return openAllPages();
    }
    if (e.target.closest('[data-ap-new]')) { closePanel(); return newPage(); }
    if (e.target.closest('[data-ap-import]')) return pickPageFile();
  });

  // ---- Alt+1 ~ Alt+9：直接打开第几张活页
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const n = /^Digit([1-9])$/.exec(e.code);
    if (!n) return;
    const p = displayPages()[Number(n[1]) - 1];
    if (!p) return;
    e.preventDefault();
    setActive(p.id);
    if (state.view !== 'memory') setView('memory'); else renderShelf();
  });

  // ---- 按住标签拖着换顺序
  let dragPage = null;
  $('#binder').addEventListener('dragstart', e => {
    const t = e.target.closest && e.target.closest('.bt[data-page]');
    if (!t) return;
    dragPage = t.dataset.page;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-baibao-page', dragPage);
    e.stopPropagation();
  });
  $('#binder').addEventListener('dragover', e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('application/x-baibao-page')) return;
    const t = e.target.closest('.bt[data-page]');
    document.querySelectorAll('.bt.page-drop').forEach(x => x !== t && x.classList.remove('page-drop'));
    if (!t || t.dataset.page === dragPage) return;
    e.preventDefault();
    e.stopPropagation();
    t.classList.add('page-drop');
  });
  $('#binder').addEventListener('drop', async e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('application/x-baibao-page')) return;
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.bt.page-drop').forEach(x => x.classList.remove('page-drop'));
    const t = e.target.closest('.bt[data-page]');
    const id = e.dataTransfer.getData('application/x-baibao-page') || dragPage;
    dragPage = null;
    if (!t || !id || t.dataset.page === id) return;
    const r = await api('/api/pages', { method: 'POST', json: { action: 'move', id, before: t.dataset.page } });
    if (!r.ok) return toast(r.message || '没挪成');
    state.pages = r.pages; state.pageItems = r.items; state.pageTop = r.top || {};
    renderShelf();
  });
  $('#binder').addEventListener('dragend', () => { dragPage = null; document.querySelectorAll('.bt.page-drop').forEach(x => x.classList.remove('page-drop')); });

  $('.shelf').addEventListener('contextmenu', e => {
    const tab = e.target.closest('.bt[data-page]');
    if (tab) { e.preventDefault(); return pageMenu(tab.dataset.page, e.clientX, e.clientY); }
    const it = itemFromEl(e.target);
    if (it) { e.preventDefault(); itemMenu(it, e.clientX, e.clientY); }
  });

  // ---- 看说明 / 文档时，标题下面可以直接改它在哪张活页
  function pagePickerHtml(kind, id) {
    if (!state.pages.length) return '';
    const cur = pageOf(kind, id);
    return `<label class="page-pick">在活页：<select data-pick-kind="${kind}" data-pick-id="${esc(id)}">
      <option value="">（没放）</option>${state.pages.map(p => `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>`;
  }
  function refreshPicker() {
    const sel = $('#reader select[data-pick-kind]');
    if (!sel) return;
    const label = sel.closest('.page-pick');
    const tmp = document.createElement('span');
    tmp.innerHTML = pagePickerHtml(sel.dataset.pickKind, sel.dataset.pickId);
    if (tmp.firstElementChild) label.replaceWith(tmp.firstElementChild);
  }
  $('#reader').addEventListener('change', e => {
    const sel = e.target.closest('select[data-pick-kind]');
    if (sel) putInto(sel.value, [{ kind: sel.dataset.pickKind, id: sel.dataset.pickId }]);
  });

  // ---------------------------------------------------------------- Word / Excel / PPT 在百宝匣里看

  async function openOffice(name, opts = {}) {
    if (state.editing && !confirmLeave()) return;
    state.note = null;
    state.editing = false;
    state.doc = { name, loading: true, opts };
    setView('memory');
    renderReader();
    const r = await api('/api/office?name=' + encodeURIComponent(name));
    if (!state.doc || state.doc.name !== name) return;
    state.doc = { name, opts, ...(r.ok ? r : { error: r.message || '打不开' }) };
    renderReader();
  }

  function renderDoc() {
    const box = $('#reader');
    renderShelf();
    const d = state.doc;
    const kind = (d.name.match(/\.(\w+)$/) || [])[1].toLowerCase();
    const label = { docx: 'Word 文档', xlsx: 'Excel 表格', pptx: 'PPT' }[kind] || '文档';
    const f = state.files.find(x => x.name === d.name);
    box.innerHTML = `
      <div class="reader-head doc-head">${fileGlyph(d.name)}<h1>${esc(d.name)}</h1>
        <button class="btn" data-doc="open" title="用电脑上的 Word / Excel / WPS 打开">用系统软件打开</button>
        <button class="btn ghost" data-doc="note" title="把内容转成一篇可以编辑的说明，原文件还留着">变成可编辑的说明</button>
        ${state.space === 'main' && f && f.indexed === 'done' ? '<button class="btn ghost" data-doc="ai">AI 提炼</button>' : ''}</div>
      <div class="meta">${label}${d.size ? ' · ' + fmtSize(d.size) : ''}${pagePickerHtml('file', d.name)}</div>
      ${d.loading ? '<p class="empty-note">正在打开…</p>' : d.error ? `<div class="err">${esc(d.error)}</div>` : `<div class="md office office-${kind}">${d.html}</div>`}`;
    if (d.loading || d.error) return;
    const doc = box.querySelector('.office');
    const o = d.opts || {};
    let target = null;
    if (o.word) {
      const marks = markWord(doc, o.word);
      if (marks.length) target = marks[0];
    }
    if (o.para !== null && o.para !== undefined && kind === 'docx') target = doc.querySelector('#p' + o.para) || target;
    if (o.sheet !== null && o.sheet !== undefined && kind === 'xlsx') target = doc.querySelector('#s' + o.sheet) || target;
    if (o.page && kind === 'pptx') target = doc.querySelector('#s' + o.page) || target;
    if (target) {
      const mk = target.tagName === 'MARK' ? target : target.querySelector('mark') || target;
      setTimeout(() => mk.scrollIntoView({ block: 'center' }), 50);
    }
  }

  // 在文档里把搜的词标黄
  function markWord(root, word) {
    const w = String(word || '').trim().toLowerCase();
    if (!w) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.toLowerCase().includes(w)) nodes.push(walker.currentNode);
    const marks = [];
    for (const node of nodes) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let i = 0, j;
      const low = text.toLowerCase();
      while ((j = low.indexOf(w, i)) >= 0) {
        frag.appendChild(document.createTextNode(text.slice(i, j)));
        const m = document.createElement('mark');
        m.textContent = text.slice(j, j + w.length);
        frag.appendChild(m);
        marks.push(m);
        i = j + w.length;
      }
      frag.appendChild(document.createTextNode(text.slice(i)));
      node.replaceWith(frag);
    }
    return marks;
  }

  $('#reader').addEventListener('click', async e => {
    const b = e.target.closest('[data-doc]');
    if (!b || !state.doc) return;
    const name = state.doc.name;
    if (b.dataset.doc === 'open') {
      const r = await api('/api/files/open', { method: 'POST', json: { name } });
      toast(r.ok ? '已经让电脑用默认软件打开了' : (r.message || '没打开'));
    }
    if (b.dataset.doc === 'ai') aiSummarize('file', name, 'cheatsheet');
    if (b.dataset.doc === 'note') {
      b.disabled = true;
      const r = await api('/api/office/to-note', { method: 'POST', json: { name } });
      b.disabled = false;
      if (!r.ok) return toast(r.message || '没转成');
      toast(`转好了，新建了说明"${r.id}"`);
      await loadNotes();
      openNote(r.id);
    }
  });

  async function openNote(id, { edit = false } = {}) {
    if (state.editing && !confirmLeave()) return;
    const r = await api(`/api/notes/${encodeURIComponent(id)}?view=1`);
    if (r.error) {
      toast(`找不到说明"${id}"。可以在记忆区新建一篇，标题写成"${id}"。`, 4000);
      state.note = null;
    } else {
      state.note = r;
    }
    state.editing = edit && !!state.note;
    state.doc = null;
    setView('memory');
    renderReader();
    window.scrollTo(0, 0);
  }

  function bodyOf(text) {
    // 去掉第一行大标题和"标签："行，这两样单独显示
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let removedTitle = false;
    return lines.filter(l => {
      if (!removedTitle && /^#\s+/.test(l)) { removedTitle = true; return false; }
      if (/^(标签|tags)\s*[:：]/i.test(l)) return false;
      return true;
    }).join('\n');
  }

  function renderMd(text) {
    const div = document.createElement('div');
    div.className = 'md';
    div.innerHTML = window.renderMarkdown(bodyOf(text));
    // 把"速查"这一节包成便签
    const h = [...div.querySelectorAll('h2')].find(x => /^速查/.test(x.textContent.trim()));
    if (h) {
      const card = document.createElement('section');
      card.className = 'quick';
      h.before(card);
      let n = h;
      while (n && !(n !== h && /^H[12]$/.test(n.tagName))) {
        const next = n.nextElementSibling;
        card.appendChild(n);
        n = next;
      }
      // 速查卡里只有一个空的"-"时不显示
      if (!card.textContent.replace(/速查/, '').trim()) card.remove();
    }
    return div;
  }

  function renderReader() {
    const box = $('#reader');
    renderShelf();
    const n = state.note;
    if (!n && state.doc) return renderDoc();
    if (!n) {
      box.innerHTML = '<div class="empty"><p>左边选一篇说明来看，或者新建一篇。</p></div>';
      return;
    }
    if (state.editing) {
      box.innerHTML = `
        <div class="reader-head"><h1>编辑：${esc(n.title)}</h1>
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn primary" data-act="save">保存</button></div>
        <p class="edit-tip">第一行"# "后面是标题，"标签:"后面写几个词（用逗号隔开）。"## 速查"下面写最关键的几步。截图可以直接粘贴进来。按 Ctrl+S 保存。</p>
        <div class="editor">
          <textarea id="editor" spellcheck="false"></textarea>
          <div class="preview"></div>
        </div>`;
      const ta = $('#editor');
      ta.value = n.text;
      const prev = box.querySelector('.preview');
      const update = () => { prev.innerHTML = ''; prev.appendChild(renderMd(ta.value)); };
      let tm;
      ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(update, 200); });
      ta.addEventListener('paste', onPasteImage);
      update();
      ta.focus();
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
      return;
    }
    box.innerHTML = `
      <div class="reader-head"><h1>${esc(n.title)}</h1>
        <button class="btn" data-act="edit">编辑</button>
        ${state.space === 'main' ? '<button class="btn ghost" data-act="ai-tidy" title="让 AI 把这篇整理成清楚的步骤">AI 整理</button>' : ''}
        <button class="btn ghost danger" data-act="delete">删除</button></div>
      ${n.tags.length ? `<div class="tags">${n.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="meta">最后修改 ${fmtDate(n.updated)}${pagePickerHtml('note', n.id)}</div>`;
    box.appendChild(renderMd(n.text));
  }

  function confirmLeave() {
    const ta = $('#editor');
    if (!ta || !state.note || ta.value === state.note.text) return true;
    return confirm('还没保存，确定不要这些修改吗？');
  }

  async function saveNote() {
    const ta = $('#editor');
    if (!ta || !state.note) return;
    const r = await api(`/api/notes/${encodeURIComponent(state.note.id)}`, { method: 'PUT', json: { text: ta.value } });
    if (!r.ok) return toast(r.message || r.error || '保存失败');
    state.editing = false;
    toast('已保存');
    await loadNotes();
    const g = await api(`/api/notes/${encodeURIComponent(r.id)}`);
    state.note = g.error ? null : g;
    renderReader();
    history.replaceState(null, '', `#memory/${encodeURIComponent(r.id)}`);
  }

  $('#reader').addEventListener('click', async e => {
    const copy = e.target.closest('.copy');
    if (copy) {
      const code = copy.parentElement.querySelector('code').textContent;
      try { await navigator.clipboard.writeText(code); copy.textContent = '已复制'; }
      catch { copy.textContent = '复制失败'; }
      setTimeout(() => (copy.textContent = '复制'), 1500);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'edit') { state.editing = true; renderReader(); }
    if (b.dataset.act === 'ai-tidy') aiSummarize('note', state.note.id, 'tidy');
    if (b.dataset.act === 'cancel') { if (confirmLeave()) { state.editing = false; renderReader(); } }
    if (b.dataset.act === 'save') saveNote();
    if (b.dataset.act === 'delete') {
      if (!confirm(`删除"${state.note.title}"？它会被移到记忆区文件夹里的 .回收站，需要时还能找回来。`)) return;
      await api(`/api/notes/${encodeURIComponent(state.note.id)}`, { method: 'DELETE' });
      toast('已移到回收站');
      state.note = null;
      await loadNotes();
      renderReader();
    }
  });

  $('#new-note').addEventListener('click', async () => {
    if (state.editing && !confirmLeave()) return;
    const v = await ask({ title: '新建说明', fields: [{ name: 'title', label: '标题', placeholder: '比如：博客怎么发文章' }], okText: '新建' });
    if (!v) return;
    const title = v.title;
    const r = await api('/api/new-note', { method: 'POST', json: { title, page: openPageId() } });
    if (!r.ok) return toast(r.message || '没建成');
    state.editing = false;
    await loadNotes();
    openNote(r.id, { edit: true });
  });

  $('#open-mem-folder').addEventListener('click', () => api('/api/open-memory-folder', { method: 'POST' }));

  async function onPasteImage(e) {
    const item = [...(e.clipboardData && e.clipboardData.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const name = `截图-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
    toast('正在保存图片…');
    const r = await uploadFile(file, name, 'image');
    if (!r.ok) return toast(r.message || '图片保存失败');
    const ta = e.target;
    const md = `![](${r.url})`;
    ta.setRangeText(md, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
    toast('图片已插入');
  }

  async function uploadFile(file, name, kind, page = '') {
    return api(`/api/upload?kind=${kind}&name=${encodeURIComponent(name)}${page ? '&page=' + encodeURIComponent(page) : ''}`, {
      method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  // 拖文件进窗口
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e) || pk.dragOut) return;
    if (dragDepth++ === 0) {
      // 有活页的话，底部冒出一排标签：拖到哪张上就放进哪张
      const pages = state.pages || [];
      const open = openPageId();
      $('#drop-pages').innerHTML = (pages.length ? `<div class="dp-tip">放进哪一张活页？${open ? '不选就放进展开着的那张' : ''}</div><div class="dp-row">${pages.map(p => `<span class="dp-chip${p.id === open ? ' cur' : ''}" data-drop-page="${esc(p.id)}" style="--c:${pageColor(p).c};--k:${pageColor(p).k}">${esc(p.name)}</span>`).join('')}<span class="dp-chip none" data-drop-page="">先不放</span></div>` : '')
        + (state.space === 'private' ? '' : `<div class="dp-row"><span class="dp-chip pocket" data-drop-pocket="1">🎒 放进随身口袋${pk.box.connected ? '（同步到末影箱）' : ''}</span></div>`);
      const pocketOpen = pk.open && !$('#panel').hidden && state.space !== 'private';
      $('#dz-text').innerHTML = pocketOpen ? '松手就放进随身口袋' : '松手就收进记忆区<br><small>.bbskin 皮肤文件会直接装上</small>';
      if (pocketOpen) $('#drop-pages').innerHTML = '';
    }
    $('#dropzone').hidden = false;
  });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; } });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const chip = e.target.closest && e.target.closest('[data-drop-page],[data-drop-pocket]');
    document.querySelectorAll('.dp-chip.over').forEach(c => c !== chip && c.classList.remove('over'));
    if (chip) chip.classList.add('over');
  });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropzone').hidden = true;
    let files = [...e.dataTransfer.files];
    if (!files.length || pk.dragOut) return;
    // 口袋开着、或者拖到了"放进随身口袋"上：全部放进口袋
    if (state.space !== 'private' && ((e.target.closest && e.target.closest('[data-drop-pocket]')) || (pk.open && !$('#panel').hidden))) return pocketUpload(files);
    const chip = e.target.closest && e.target.closest('[data-drop-page]');
    const dropPage = chip ? chip.dataset.dropPage : openPageId();
    document.querySelectorAll('#skin-drop.over').forEach(x => x.classList.remove('over'));
    // 皮肤文件：装成皮肤，不收进记忆区
    const skinFiles = files.filter(f => /\.bbskin$/i.test(f.name) || (/\.zip$/i.test(f.name) && e.target.closest && e.target.closest('#skin-drop')));
    for (const f of skinFiles) await importSkinFile(f);
    files = files.filter(f => !skinFiles.includes(f));
    // 更新包：装更新，不收进记忆区（私密区里不处理）
    const updFiles = files.filter(f => /\.bbupdate$/i.test(f.name));
    document.querySelectorAll('#update-drop.over').forEach(x => x.classList.remove('over'));
    if (updFiles.length) {
      if (state.space === 'private') toast('请回到普通区再装更新包');
      else await installUpdate(updFiles[0]);
    }
    files = files.filter(f => !updFiles.includes(f));
    // 导出的活页：导入成一张新活页
    const pageFiles = files.filter(f => /\.bbpage$/i.test(f.name));
    for (const f of pageFiles) await importPage(f);
    files = files.filter(f => !pageFiles.includes(f));
    if (!files.length) return;
    // 正在编辑时拖进图片，就插进正文
    const ta = $('#editor');
    let lastNote = null;
    for (const f of files) {
      if (ta && f.type.startsWith('image/')) {
        const r = await uploadFile(f, f.name, 'image');
        if (r.ok) { ta.setRangeText(`![](${r.url})\n`, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
        continue;
      }
      toast(`正在收进 ${f.name}…`, 60000);
      const r = await uploadFile(f, f.name, 'file', dropPage);
      if (!r.ok) { toast(`${f.name} 没收进来：${r.message || ''}`, 4000); continue; }
      if (r.warn) { toast(r.warn, 9000); await new Promise(res => setTimeout(res, 2500)); }
      if (r.note) lastNote = r.note;
    }
    const dp = (state.pages || []).find(p => p.id === dropPage);
    toast(`收好了 ${files.length} 个文件${dp ? `，放进了"${dp.name}"` : ''}`);
    await loadNotes();
    if (lastNote) openNote(lastNote);
    else if (state.view !== 'memory') setView('memory');
  });

  // ---------------------------------------------------------------- 搜索

  let searchSeq = 0;
  let firstHit = null;
  async function runSearch() {
    const q = $('#q').value.trim();
    if (!q) {
      firstHit = null;
      setView(state.lastView || 'tools');
      return;
    }
    if (state.view !== 'search') state.lastView = state.view;
    setView('search', { push: false });
    const seq = ++searchSeq;
    const words = q.toLowerCase().split(/\s+/);
    const tools = visibleTools().filter(t => {
      const hay = [t.name, t.desc, t.typeLabel, t.note].join(' ').toLowerCase();
      return words.every(w => hay.includes(w));
    });
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    const notes = r.notes || [];
    const fr = r.files || {};
    const byName = fr.byName || [];
    const byContent = fr.byContent || [];
    firstHit = tools[0] || notes[0] || byName[0] || byContent[0] || null;
    recordSearch(q, tools.length + notes.length + byName.length + byContent.length);
    let first = true;
    const mark = () => { const c = first ? ' first' : ''; first = false; return c; };
    let html = '';
    if (tools.length) {
      html += '<h2>工具</h2>' + tools.map(t => {
        const c = mark();
        return `<button class="hit${c}" data-tool="${esc(t.id)}"><span class="g">${iconHtml(t.icon)}</span>
          <span><span class="t">${esc(t.name)}</span><br><span class="s">${esc(t.desc || t.typeLabel)}</span></span>${c ? '<kbd>回车打开</kbd>' : ''}</button>`;
      }).join('');
    }
    if (notes.length) {
      html += '<h2>说明</h2>' + notes.map(n => {
        const c = mark();
        return `<button class="hit${c}" data-note="${esc(n.id)}"><span class="g">📄</span>
          <span><span class="t">${esc(n.title)}</span><br><span class="s">${esc(n.snippet || n.tags.join('、'))}</span></span>${c ? '<kbd>回车打开</kbd>' : ''}</button>`;
      }).join('');
    }
    if (byName.length) {
      html += '<h2>资料 · 文件名里有</h2>' + byName.map(f => {
        const c = mark();
        return `<button class="hit${c}" data-file="${esc(f.name)}"><span class="g">${fileGlyph(f.name)}</span>
          <span><span class="t">${highlight(f.name, words)}</span><br><span class="s">${fmtSize(f.size)}</span></span>${c ? '<kbd>回车打开</kbd>' : ''}</button>`;
      }).join('');
    }
    if (byContent.length) {
      html += '<h2>资料 · 文件内容里有</h2>' + byContent.map(f => {
        const c = mark();
        const more = f.total > f.hits.length ? `<span class="s">还有 ${f.total - f.hits.length} 处</span>` : '';
        return `<div class="hit-group${c}">
          <button class="hit" data-file="${esc(f.name)}" data-page="${f.hits[0].page || ''}" data-chapter="${f.hits[0].chapter ?? ''}" data-para="${f.hits[0].para ?? ''}" data-sheet="${f.hits[0].sheet ?? ''}" data-word="${esc(words[0])}">
            <span class="g">${fileGlyph(f.name)}</span>
            <span><span class="t">${esc(f.name)}</span><br><span class="s">${f.total} 处</span></span>${c ? '<kbd>回车打开</kbd>' : ''}</button>
          <ul class="spots">${f.hits.map(h => `<li><button data-file="${esc(f.name)}" data-page="${h.page || ''}" data-chapter="${h.chapter ?? ''}" data-para="${h.para ?? ''}" data-sheet="${h.sheet ?? ''}" data-word="${esc(words[0])}">
            <b>${esc(h.label || '')}</b> ${highlight(h.snippet, words)}</button></li>`).join('')}${more ? `<li>${more}</li>` : ''}</ul>
        </div>`;
      }).join('');
    }
    if (fr.pending) html += `<p class="sub">还有 ${fr.pending} 个文件正在读取文字，过一会儿再搜就能搜到里面的内容。</p>`;
    $('#results').innerHTML = html || `<p style="color:var(--muted)">没找到"${esc(q)}"。换个词试试，或者去记忆区新建一篇说明。</p>${fr.pending ? `<p class="sub">还有 ${fr.pending} 个文件正在读取文字，过一会儿再搜。</p>` : ''}`;
  }

  let qTimer;
  $('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 150); });
  $('#q').addEventListener('keydown', async e => {
    if (e.key === 'Escape') { $('#q').value = ''; runSearch(); $('#q').blur(); }
    if (e.key === 'Enter') {
      clearTimeout(qTimer);
      await runSearch();
      const f = document.querySelector('#results .first');
      const target = f && (f.matches('button, a') ? f : f.querySelector('.hit'));
      if (target) target.click();
    }
  });
  $('#results').addEventListener('click', e => {
    const t = e.target.closest('[data-tool]');
    const n = e.target.closest('[data-note]');
    const fl = e.target.closest('[data-file]');
    if (t) launchTool(t.dataset.tool);
    if (n) { $('#q').value = ''; openNote(n.dataset.note); }
    if (fl) {
      openFile(fl.dataset.file, {
        page: fl.dataset.page ? Number(fl.dataset.page) : null,
        chapter: fl.dataset.chapter !== undefined && fl.dataset.chapter !== '' ? Number(fl.dataset.chapter) : null,
        word: fl.dataset.word || '',
        para: fl.dataset.para ? Number(fl.dataset.para) : null,
        sheet: fl.dataset.sheet ? Number(fl.dataset.sheet) : null,
      });
    }
  });

  function fileGlyph(name) {
    if (/\.docx?$/i.test(name)) return '<span class="ft ft-w" aria-hidden="true">W</span>';
    if (/\.xlsx?$/i.test(name)) return '<span class="ft ft-x" aria-hidden="true">X</span>';
    if (/\.pptx?$/i.test(name)) return '<span class="ft ft-p" aria-hidden="true">P</span>';
    if (/\.pdf$/i.test(name)) return '📕';
    if (/\.epub$/i.test(name)) return '📗';
    if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return '🖼️';
    if (/\.(txt|md|csv|log|json)$/i.test(name)) return '📄';
    return '📦';
  }

  function highlight(text, words) {
    let h = esc(text);
    for (const w of words) {
      if (!w) continue;
      const re = new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      h = h.replace(re, m => `<mark>${m}</mark>`);
    }
    return h;
  }

  // 打开一份资料：电子书在百宝匣里读，PDF 跳到对应页，其他交给浏览器
  function openFile(name, { page = null, chapter = null, word = '', para = null, sheet = null } = {}) {
    if (/\.epub$/i.test(name)) return openReader(name, { chapter, word });
    if (OFFICE_RE.test(name)) return openOffice(name, { page, para, sheet, word });
    let url = fileUrl(name);
    if (/\.pdf$/i.test(name) && page) url += `#page=${page}`;
    window.open(url, '_blank', 'noopener');
  }

  // ---------------------------------------------------------------- 皮肤

  const SKIN_OFF = document.body.dataset.skinOff === '1';
  state.skinId = document.body.dataset.skin || 'original';

  function applySkin(id) {
    let link = document.getElementById('skin-css');
    if (!id || id === 'original' || SKIN_OFF) {
      if (link) link.remove();
      delete document.body.dataset.skin;
      state.skinId = 'original';
      if (typeof loadMascot === 'function') setTimeout(loadMascot, 0);
      return;
    }
    const href = `/skin/${encodeURIComponent(id)}/skin.css`;
    if (!link) {
      link = document.createElement('link');
      link.id = 'skin-css';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    document.body.dataset.skin = id.replace(/[^\w一-龥-]/g, '');
    state.skinId = id;
    if (typeof loadMascot === 'function') setTimeout(loadMascot, 0);
  }

  async function syncSkin() {
    const r = await api('/api/skins');
    if (r && r.current) applySkin(r.current);
    return r;
  }

  const verNum = v => { const m = /^(\d+)\.(\d+)/.exec(String(v || '')); return m ? Number(m[1]) * 1000 + Number(m[2]) : 0; };

  function skinThumb(k) {
    if (k.preview) return `<span class="skin-thumb"><img src="/skin/${encodeURIComponent(k.id)}/${esc(k.preview)}" alt=""></span>`;
    const c = k.colors.length ? k.colors : ['#eeeeee', '#999999', '#555555', '#ffffff'];
    const g = i => esc(c[i % c.length]);
    return `<span class="skin-thumb mini" style="background:${g(0)}"><i style="background:${g(1)}"></i><b style="background:${g(3)};border-color:${g(1)}"></b><b style="background:${g(3)};border-color:${g(1)}"></b><u style="background:${g(2)}"></u></span>`;
  }

  async function skinSectionHtml() {
    const r = await api('/api/skins');
    if (!r || !r.skins) return '';
    const priv = state.space === 'private';
    const cards = r.skins.map(k => {
      const on = k.id === r.current;
      const old = k.fit && verNum(k.fit) && verNum(k.fit) < verNum(APP_VERSION);
      return `<div class="skin-card${on ? ' on' : ''}">
        <button class="skin-pick" type="button" data-act="skin-use" data-id="${esc(k.id)}" aria-pressed="${on}">
          ${skinThumb(k)}
          <span class="skin-name">${esc(k.name)}${on ? '<em>使用中</em>' : ''}</span>
          <span class="skin-by">${esc([k.author, k.version && 'v' + k.version].filter(Boolean).join(' · ') || (k.builtin ? '自带' : '导入的'))}${k.id.startsWith('p-') ? ' · 只在私密区' : ''}</span>
          ${k.desc ? `<span class="skin-desc">${esc(k.desc)}</span>` : ''}
          ${old ? `<span class="skin-warn">这套皮肤做于 ${esc(k.fit)} 版，新加的部分界面可能还是原皮的样子</span>` : ''}
          ${priv && !k.hasPrivate ? '<span class="skin-warn">没有专门做私密区的样子</span>' : ''}
        </button>
        ${k.builtin ? '' : `<button class="skin-del" type="button" data-act="skin-del" data-id="${esc(k.id)}" data-name="${esc(k.name)}">删掉</button>`}
      </div>`;
    }).join('');
    return `<section class="setting" id="skin-setting">
      <strong>${priv ? '私密区的皮肤' : '皮肤'}</strong>
      <p class="sub">${priv ? '私密区单独选一套，和外面互不影响。' : '换一身样子，功能都不变。'}也可以把皮肤文件（.bbskin）拖进来，像装游戏 mod 一样，装好就能换上。</p>
      <div class="skin-grid">${cards}</div>
      ${(r.skins.find(k => k.id === r.current) || {}).mascot ? `<label class="check"><input type="checkbox" id="mascot-on" ${mcOff() ? '' : 'checked'}> <span>显示看板娘<br><small>这套皮肤带了立绘：会呼吸、眨眼，跟着"问问"的回答换动作，点她就能聊天。很久不操作她会犯困。</small></span></label>` : ''}
      <label class="skin-drop" id="skin-drop">
        <input type="file" id="skin-file" accept=".bbskin,.zip" hidden>
        <span>把 <b>.bbskin</b> 皮肤文件拖到这里，或者<u>点这里选文件</u></span>
      </label>
      <small>换了皮肤以后界面乱了、找不到按钮？按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>0</kbd> 马上换回原皮。</small>
    </section>`;
  }

  async function importSkinFile(file) {
    if (!/\.(bbskin|zip)$/i.test(file.name)) return toast('皮肤文件应该是 .bbskin 结尾的');
    toast(`正在装皮肤 ${file.name}…`, 30000);
    const r = await api(`/api/skins/import?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!r.ok) return toast(r.message || '没装上', 5000);
    const u = await api('/api/skins/use', { method: 'POST', json: { id: r.id } });
    if (u.ok) applySkin(r.id);
    toast(`${r.replaced ? '更新' : '装好'}了皮肤"${r.name}"，已经换上${r.skipped ? `（有 ${r.skipped} 个不是皮肤用的文件没收）` : ''}`, 4000);
    if (!$('#panel').hidden && $('#skin-setting')) openSettings();
  }

  async function resetSkin() {
    await api('/api/skins/use', { method: 'POST', json: { id: 'original' } });
    applySkin('original');
    toast('已换回原皮');
    if (!$('#panel').hidden && $('#skin-setting')) openSettings();
  }

  // ---------------------------------------------------------------- 小更新包（.bbupdate）

  function updateSectionHtml() {
    return `<section class="setting" id="update-setting">
      <strong>更新百宝匣</strong>
      <p class="sub">现在是 <b>${esc(APP_VERSION)}</b> 版。拿到新的小更新包（.bbupdate）后拖进来就能更新，你的工具、说明、资料、设置都不会动。只装作者给你的更新包。</p>
      <label class="skin-drop" id="update-drop">
        <input type="file" id="update-file" accept=".bbupdate" hidden>
        <span>把 <b>.bbupdate</b> 更新包拖到这里，或者<u>点这里选文件</u></span>
      </label>
      <small>更新前被换掉的旧文件会存在百宝匣文件夹里的"恢复前的旧文件"中。</small>
    </section>`;
  }

  async function installUpdate(file) {
    if (!/\.bbupdate$/i.test(file.name)) return toast('更新包应该是 .bbupdate 结尾的');
    toast('正在检查更新包…', 30000);
    const hdr = { 'Content-Type': 'application/octet-stream' };
    const c = await api('/api/update/check', { method: 'POST', body: file, headers: hdr });
    if (!c.ok) return toast(c.message || '这不是百宝匣的更新包', 6000);
    if (!c.newer && !c.same) return toast(`这个更新包是 ${c.version}，比你现在的 ${c.current} 还旧，不用装。`, 6000);
    const q = c.same
      ? `你已经是 ${c.version} 版了。还要再装一次吗？（文件坏了想修复时可以这么做）`
      : `把百宝匣从 ${c.current} 更新到 ${c.version}？\n\n${c.notes ? '这次更新：\n' + c.notes + '\n\n' : ''}会替换 ${c.count} 个程序文件，你的工具、说明、资料、设置都不会动。\n${c.desktop ? '装好后百宝匣会自动重新打开。' : '装好后需要重新启动一下百宝匣。'}\n\n只装作者给你的更新包。继续吗？`;
    if (!confirm(q)) return toast('没有更新');
    toast('正在更新…', 60000);
    const r = await api('/api/update/apply', { method: 'POST', body: file, headers: hdr });
    if (!r.ok) return toast(r.message || '更新没装上', 8000);
    if (r.restart === 'auto') return toast(`更新到 ${r.version} 了，百宝匣马上重新打开…`, 60000);
    closePanel();
    const b = document.createElement('div');
    b.className = 'banner top';
    b.textContent = `已经更新到 ${r.version}。最后一步：关掉黑色窗口（或者在设置里点"关闭百宝匣"），再双击"启动百宝匣.bat"，然后按 Ctrl+F5 刷新这个页面。`;
    $('main').prepend(b);
    toast('更新装好了，重新启动一下百宝匣就能用上', 8000);
  }

  $('#panel').addEventListener('change', e => {
    if (e.target.id === 'mascot-on') {
      try { localStorage.setItem('bb-mascot-off', e.target.checked ? '0' : '1'); } catch {}
      loadMascot();
      return;
    }
    if (e.target.id === 'skin-file' && e.target.files[0]) importSkinFile(e.target.files[0]);
    if (e.target.id === 'update-file' && e.target.files[0]) { const f = e.target.files[0]; e.target.value = ''; installUpdate(f); }
  });
  $('#panel').addEventListener('dragover', e => {
    const z = e.target.closest && e.target.closest('#skin-drop, #update-drop');
    document.querySelectorAll('#skin-drop.over, #update-drop.over').forEach(x => x !== z && x.classList.remove('over'));
    if (z) z.classList.add('over');
  });

  // ---------------------------------------------------------------- 快捷键

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.editing) { e.preventDefault(); saveNote(); }
    if (e.key === 'Escape' && !$('#panel').hidden) closePanel();
    // Ctrl+Alt+H 显示 / 隐藏私密抽屉
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      togglePrivate();
    }
    // Ctrl+Alt+0 皮肤乱了时换回原皮
    if (e.ctrlKey && e.altKey && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
      e.preventDefault();
      resetSkin();
    }
  });
  // ---------------------------------------------------------------- 私密区

  async function togglePrivate() {
    if (state.space === 'private') return leavePrivate(false);
    if (!state.private.hasPassword) {
      const v = await ask({
        title: '先设一个私密区密码',
        text: '私密区是一个单独的板块，有自己的工具和说明。以后在任何时候按 ' + keyLabel(privateKey()) + '，输入这个密码就能进去。',
        fields: [{ name: 'p1', label: '密码（至少 4 位）', type: 'password' }, { name: 'p2', label: '再输一遍', type: 'password' }],
        okText: '设好并进入',
      });
      if (!v) return;
      if (v.p1 !== v.p2) return toast('两次输入的不一样');
      const r = await api('/api/private/set', { method: 'POST', json: { password: v.p1 } });
      if (!r.ok) return toast(r.message || '没设成');
      const u = await api('/api/private/unlock', { method: 'POST', json: { password: v.p1 } });
      if (!u.ok) return toast(u.message || '没进去');
      return enterPrivate();
    }
    const v = await ask({ title: '进入私密区', fields: [{ name: 'password', label: '密码', type: 'password' }], okText: '进入' });
    if (!v) return;
    const r = await api('/api/private/unlock', { method: 'POST', json: { password: v.password } });
    if (!r.ok) return toast(r.message || '密码不对');
    enterPrivate();
  }

  function resetSpaceState() {
    closePanel();
    state.chat = [];
    state.butler = null;
    state.mood = '待机';
    if ($('#q').value) $('#q').value = '';
    state.note = null;
    state.editing = false;
    state.openSections = new Set();
    state.status = {};
    state.reader = null;
  }

  async function enterPrivate() {
    resetSpaceState();
    state.space = 'private';
    await syncSkin();
    document.body.classList.add('private-space');
    $('.mark').textContent = '私密区';
    $('#leave-private').hidden = false;
    document.title = '百宝匣';
    await loadTools();
    setView('tools');
    toast(`已进入私密区。30 分钟不用会自动锁上，按 ${keyLabel(privateKey())} 立刻离开`, 3500);
  }

  async function leavePrivate(auto) {
    if (state.space !== 'private') return;
    if (state.editing && !auto && !confirmLeave()) return;
    // 看板娘可能还在取这边的皮肤，等它取完再上锁，免得请求被拒
    if (mc.pending) await mc.pending;
    if (!auto) await api('/api/private/lock', { method: 'POST' });
    resetSpaceState();
    state.space = 'main';
    await syncSkin();
    document.body.classList.remove('private-space');
    $('.mark').textContent = '百宝匣';
    $('#leave-private').hidden = true;
    await loadTools();
    setView('tools');
    toast('已上锁');
  }
  $('#leave-private').addEventListener('click', () => leavePrivate(false));

  window.addEventListener('beforeunload', e => {
    const ta = $('#editor');
    if (ta && state.note && ta.value !== state.note.text) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- 打开面板的通用写法

  function showPanel(html) {
    state.form = null; state.panelTool = null; state.ocr = null;
    $('#panel').hidden = false; leavePocketPanel();
    $('#scrim').hidden = false;
    $('#panel .panel-inner').innerHTML = html;
  }
  const panelHead = title => `<h2 id="panel-title">${title}<button class="close" type="button" data-act="close" aria-label="关闭">×</button></h2>`;

  // ---------------------------------------------------------------- 工具体检

  async function loadCheckup() {
    if (state.space !== 'main') { state.checkup = {}; state.checkupReport = null; return; }
    const r = await api('/api/checkup');
    state.checkupReport = r.report;
    state.checkup = {};
    for (const x of (r.report && r.report.results) || []) state.checkup[x.id] = x;
    renderCheckupBanner();
  }

  function renderCheckupBanner() {
    const el = $('#checkup-note');
    if (!el) return;
    const rep = state.checkupReport;
    const bad = rep ? rep.results.filter(x => x.level !== 'ok' && state.tools.some(t => t.id === x.id)) : [];
    el.hidden = !bad.length;
    el.innerHTML = bad.length ? `体检发现 ${bad.length} 个工具有问题 <button class="link-btn" data-open-checkup>查看</button>` : '';
  }

  const LEVEL = { ok: '✅', warn: '⚠️', error: '❌' };

  function renderCheckupPanel(rep, running) {
    const list = rep ? rep.results : [];
    const bad = list.filter(x => x.level !== 'ok');
    showPanel(`${panelHead('工具体检')}
      <p class="sub">把柜子里的工具挨个试一遍，坏了的提前告诉你。百宝匣每周会自动做一次快速体检。</p>
      <div class="btn-row">
        <button class="btn primary" data-act="ck-run" ${running ? 'disabled' : ''}>快速体检</button>
        <button class="btn" data-act="ck-deep" ${running ? 'disabled' : ''}>完整体检</button>
      </div>
      <p class="sub" style="margin-top:6px">快速体检只看网址能不能打开、文件还在不在；完整体检会把本地项目真的启动一次再关掉，要等久一点。</p>
      ${running ? '<p class="ocr-wait">正在体检，请稍等…</p>' : ''}
      ${rep ? `<p class="sub">${rep.deep ? '完整' : '快速'}体检，${fmtDate(rep.time)}：${list.length - bad.length} 个正常${bad.length ? `，<strong>${bad.length} 个有问题</strong>` : ''}</p>
        <ul class="ck-list">${[...bad, ...list.filter(x => x.level === 'ok')].map(x => `
          <li class="ck-${x.level}">
            <span class="ck-ico" aria-hidden="true">${LEVEL[x.level]}</span>
            <span class="tt"><span class="t">${esc(x.name)}</span><span class="s">${esc(x.message)}</span></span>
            ${x.level !== 'ok' && state.tools.some(t => t.id === x.id) ? `<button class="btn small" data-ck-open="${esc(x.id)}">看看</button>` : ''}
            ${x.fix ? `<button class="btn small primary" data-ck-fix="${esc(x.id)}" data-kind="${esc(x.fix.kind)}">${esc(x.fix.label)}</button>` : ''}
          </li>`).join('')}</ul>` : '<p class="empty-note">还没体检过。</p>'}`);
  }

  async function openCheckup() {
    const r = state.space === 'main' ? await api('/api/checkup') : { report: state.privateReport };
    renderCheckupPanel(r.report, r.running);
  }

  async function runCheckupUI(deep) {
    renderCheckupPanel(state.space === 'main' ? state.checkupReport : state.privateReport, true);
    const r = await api('/api/checkup', { method: 'POST', json: { deep } });
    if (!r.ok) { toast(r.message || '体检没完成'); return openCheckup(); }
    if (state.space === 'main') { state.checkupReport = r; state.checkup = {}; for (const x of r.results) state.checkup[x.id] = x; }
    else state.privateReport = r;
    renderTools();
    renderCheckupBanner();
    renderCheckupPanel(r, false);
    const bad = r.results.filter(x => x.level !== 'ok').length;
    toast(bad ? `体检完了，${bad} 个有问题` : '体检完了，全部正常');
  }

  // ---------------------------------------------------------------- 使用统计

  async function openStats() {
    const r = await api('/api/stats');
    if (!r.memory) return toast(r.message || '统计读不出来');
    const m = r.memory;
    const ago = t => {
      if (!t) return '从没打开过';
      const d = Math.floor((Date.now() - t) / 86400000);
      return d < 1 ? '今天' : d < 30 ? `${d} 天前` : d < 365 ? `${Math.floor(d / 30)} 个月前` : `${Math.floor(d / 365)} 年前`;
    };
    const bars = (items, attr, label = x => esc(x.name)) => {
      if (!items.length) return '<p class="empty-note">还没有记录。</p>';
      const max = Math.max(...items.map(x => x.count));
      return `<ul class="bars">${items.map(x => `<li><button class="bl" ${attr}="${esc(x.name)}">${label(x)}</button>
        <span class="bt"><span class="bf" style="width:${Math.max(4, x.count / max * 100)}%"></span></span><span class="bn">${x.count} 次</span></li>`).join('')}</ul>`;
    };
    const max = Math.max(1, ...r.days.map(d => d.count));
    showPanel(`${panelHead('使用统计')}
      <p class="sub">只记在你自己电脑上。${r.since ? `从 ${esc(r.since)} 开始记录。` : ''}</p>
      <div class="spark" role="img" aria-label="最近 30 天每天的使用次数">${r.days.map(d => `<span title="${esc(d.day)}：${d.count} 次" style="height:${d.count ? Math.max(8, d.count / max * 100) : 3}%"></span>`).join('')}</div>
      <p class="sub" style="margin-top:4px">最近 30 天</p>

      <h3 class="st-part">记忆区</h3>
      <div class="st-cards">
        <div><b>${m.notes}</b><span>篇说明</span></div>
        <div><b>${m.files}</b><span>份资料</span></div>
        <div><b>${m.month['新建']}</b><span>30 天新写</span></div>
        <div><b>${m.month['修改']}</b><span>30 天修改</span></div>
        <div><b>${m.month['剪藏']}</b><span>30 天剪藏</span></div>
      </div>
      ${m.stale.length ? `<h3 class="st-h">好久没看的说明</h3>
        <p class="sub">这些很久没打开了，翻一翻，免得哪天要用时忘了还有它。</p>
        <ul class="stale-list">${m.stale.map(x => `<li><button data-open-note="${esc(x.name)}">${esc(x.title)}</button><span class="s">${ago(x.last)}</span></li>`).join('')}</ul>` : ''}
      ${m.books.length ? `<h3 class="st-h">在读的书</h3>
        <ul class="book-list">${m.books.map(b => `<li><button data-open-file="${esc(b.name)}">📗 ${esc(b.title)}</button>
          <span class="bt"><span class="bf" style="width:${b.total ? Math.round((b.chapter + 1) / b.total * 100) : 0}%"></span></span>
          <span class="s">${b.total ? `${b.chapter + 1}/${b.total} 章` : ''} · ${ago(b.last)}</span></li>`).join('')}</ul>` : ''}
      <h3 class="st-h">最常看的说明</h3>${bars(m.topNotes, 'data-open-note')}
      <h3 class="st-h">最常翻的资料</h3>${bars(m.topFiles, 'data-open-file', x => fileGlyph(x.name) + ' ' + esc(x.name))}
      <h3 class="st-h">常搜的词</h3>${bars(m.searches, 'data-search')}
      ${m.misses.length ? `<h3 class="st-h">搜了但没找到的</h3>
        <p class="sub">这些你找过但记忆区里没有，点一下就新建一篇说明：</p>
        <ul class="chips">${m.misses.map(x => `<li><button data-new-note="${esc(x.name)}">${esc(x.name)}（${x.count} 次）</button></li>`).join('')}</ul>` : ''}

      <h3 class="st-part">工具区</h3>
      <h3 class="st-h">最常用的工具</h3>${bars(r.tools.top, 'data-ck-open', x => (x.icon ? iconHtml(x.icon) + ' ' : '') + esc(x.name))}
      ${r.tools.idle.length ? `<h3 class="st-h">两个月没用过的工具</h3>
        <p class="sub">用不上的可以拿掉，或者挪进一个栏目收起来。</p>
        <ul class="chips">${r.tools.idle.map(x => `<li><button data-ck-open="${esc(x.name)}">${iconHtml(x.icon)} ${esc(x.name)}</button></li>`).join('')}</ul>` : ''}`);
  }

  $('#panel').addEventListener('click', e => {
    const n = e.target.closest('[data-open-note]');
    if (n) { closePanel(); return openNote(n.dataset.openNote); }
    const f = e.target.closest('[data-open-file]');
    if (f) { closePanel(); return openFile(f.dataset.openFile); }
    const q = e.target.closest('[data-search]');
    if (q) { closePanel(); $('#q').value = q.dataset.search; runSearch(); }
  });

  // 搜索停下来 1.5 秒后记一笔（只记最后搜的那个词）
  let statSearchTimer;
  function recordSearch(q, found) {
    clearTimeout(statSearchTimer);
    if (state.space !== 'main' || q.length < 2) return;
    statSearchTimer = setTimeout(() => api('/api/stats/search', { method: 'POST', json: { q, found } }), 1500);
  }

  // ---------------------------------------------------------------- AI

  async function aiSummarize(kind, key, mode) {
    showPanel(`${panelHead(mode === 'tidy' ? 'AI 整理' : 'AI 提炼速查卡')}<p class="ocr-wait">正在让 AI 读${kind === 'note' ? '这篇说明' : '这份资料'}，长的资料可能要一两分钟…</p>`);
    const r = await api('/api/ai/summarize', { method: 'POST', json: kind === 'note' ? { kind, id: key, mode } : { kind, name: key, mode } });
    if (!r.ok) {
      showPanel(`${panelHead('AI')}<div class="err">${esc(r.message)}</div>
        ${/还没设置/.test(r.message) ? '<button class="btn primary" data-act="open-settings">去设置</button>' : ''}`);
      return;
    }
    state.aiDraft = { kind, key, mode, markdown: r.markdown, title: r.title };
    showPanel(`${panelHead(mode === 'tidy' ? 'AI 整理好了' : 'AI 提炼好了')}
      <p class="sub">看一下，满意就存下来。存了以后还能自己改。</p>
      <div class="btn-row">
        <button class="btn primary" data-act="ai-save-new">存成新说明</button>
        ${kind === 'note' ? '<button class="btn" data-act="ai-replace">替换原来的</button>' : ''}
        <button class="btn ghost" data-act="close">不要了</button>
      </div>
      <div class="ai-preview"></div>`);
    $('#panel .ai-preview').appendChild(renderMd(r.markdown));
  }

  async function aiDraftAct(act) {
    const d = state.aiDraft;
    if (!d) return;
    if (act === 'ai-save-new') {
      const r = await api('/api/new-note', { method: 'POST', json: { title: d.title, text: d.markdown } });
      if (!r.ok) return toast(r.message || '没存上');
      closePanel();
      toast('已存成新说明');
      openNote(r.id);
    }
    if (act === 'ai-replace') {
      if (!confirm('用 AI 整理的版本替换原来的内容？原来的会被覆盖。')) return;
      const r = await api(`/api/notes/${encodeURIComponent(d.key)}`, { method: 'PUT', json: { text: d.markdown } });
      if (!r.ok) return toast(r.message || '没存上');
      closePanel();
      toast('已替换');
      openNote(r.id);
    }
  }

  // ---- AI 管家
  const MOOD_FACE = { 待机: '😌', 思考: '🤔', 说话: '💬', 找到了: '✨', 开心: '😊', 惊讶: '😮', 困: '😪', 玩游戏: '🎮' };
  async function loadButler() {
    if (!state.butler) {
      const r = await api('/api/butler');
      state.butler = r.ok ? r : { persona: { 名字: '百宝匣' } };
    }
    return state.butler;
  }
  function butlerName() { return (state.butler && state.butler.persona && state.butler.persona.名字) || '百宝匣'; }
  function setMood(mood) {
    state.mood = mood || '待机';
    const f = $('#butler-face');
    if (f) { f.dataset.mood = state.mood; f.querySelector('.bf-emoji').textContent = MOOD_FACE[state.mood] || '😌'; f.querySelector('.bf-mood').textContent = state.mood; }
    mascotMood(state.mood);
  }

  // ---------------------------------------------------------------- 看板娘（皮肤自带的立绘）
  const MC_FALLBACK = { 找到了: '开心', 玩游戏: '待机', 说话: '待机', 思考: '待机', 开心: '待机', 惊讶: '待机', 困: '待机' };
  const mc = { cfg: null, skin: '', mood: '待机', back: null, blinkT: 0, lastAct: Date.now(), bubbleT: 0, token: 0 };
  const mcOff = () => { try { return localStorage.getItem('bb-mascot-off') === '1'; } catch { return false; } };
  function mcSrc(mood) {
    const imgs = mc.cfg.images;
    let m = mood;
    while (m && !imgs[m]) m = MC_FALLBACK[m];
    return `/skin/${encodeURIComponent(mc.skin)}/${imgs[m || '待机'].split('/').map(encodeURIComponent).join('/')}`;
  }
  function loadMascot() {
    mc.pending = loadMascotNow().catch(() => {});
    return mc.pending;
  }
  async function loadMascotNow() {
    const box = $('#mascot');
    const token = ++mc.token;
    box.hidden = true;
    document.body.classList.remove('has-mascot');
    mc.cfg = null;
    const r = await api('/api/skins');
    if (token !== mc.token || !r || !r.skins) return;
    const k = r.skins.find(x => x.id === r.current);
    if (!k || !k.mascot || SKIN_OFF || mcOff()) return;
    mc.cfg = k.mascot; mc.skin = k.id; mc.mood = '待机';
    for (const m of Object.keys(mc.cfg.images)) { const im = new Image(); im.src = mcSrc(m); }
    const [a, b] = box.querySelectorAll('.mc-img');
    a.src = mcSrc('待机'); a.classList.add('on'); b.classList.remove('on');
    box.querySelector('.mc-body').setAttribute('aria-label', `和${mc.cfg.name || butlerName()}说话`);
    box.className = '';
    box.hidden = false;
    document.body.classList.add('has-mascot');
    mcBlinkLoop();
    const h = new Date().getHours();
    mcSay(h < 5 ? '这么晚了……早点休息吧。' : h < 11 ? '早上好。' : h < 14 ? '中午好。' : h < 18 ? '下午好。' : h < 23 ? '晚上好。' : '夜深了……', 5000);
  }
  function mcSay(text, ms = 4000) {
    const bub = $('#mascot .mc-bubble');
    if (!bub || !mc.cfg) return;
    bub.textContent = text;
    bub.hidden = false;
    clearTimeout(mc.bubbleT);
    mc.bubbleT = setTimeout(() => { bub.hidden = true; }, ms);
  }
  function mascotMood(mood) {
    if (!mc.cfg) return;
    const box = $('#mascot');
    const src = mcSrc(mood);
    const imgs = box.querySelectorAll('.mc-img');
    const front = [...imgs].find(i => i.classList.contains('on')) || imgs[0];
    const back = front === imgs[0] ? imgs[1] : imgs[0];
    mc.mood = mood;
    box.dataset.mood = mood;
    // 一次性的小动作
    box.classList.remove('mc-hop', 'mc-shake');
    void box.offsetWidth;
    if (mood === '找到了' || mood === '开心') box.classList.add('mc-hop');
    if (mood === '惊讶') box.classList.add('mc-shake');
    if (front.getAttribute('src') === src) return;
    back.src = src;
    const swap = () => { back.classList.add('on'); front.classList.remove('on'); };
    if (back.complete) swap(); else back.onload = swap;
    // 回答完过一会儿回到待机
    clearTimeout(mc.backT);
    if (!['待机', '思考', '困', '玩游戏'].includes(mood)) mc.backT = setTimeout(() => { if (mc.mood === mood) mascotMood('待机'); }, 9000);
  }
  // 眨眼：待机时每隔几秒闭一下眼
  function mcBlinkLoop() {
    clearTimeout(mc.blinkT);
    mc.blinkT = setTimeout(() => {
      if (!mc.cfg) return;
      const closed = mc.cfg.images['待机-闭眼'];
      const front = $('#mascot .mc-img.on');
      if (closed && mc.mood === '待机' && front && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const open = front.getAttribute('src');
        const shut = mcSrc('待机-闭眼');
        front.src = shut;
        setTimeout(() => {
          if (front.getAttribute('src') === shut) front.src = open;
          // 偶尔连眨两下
          if (Math.random() < .25) setTimeout(() => { if (mc.mood === '待机') { front.src = shut; setTimeout(() => { if (front.getAttribute('src') === shut) front.src = open; }, 120); } }, 220);
        }, 130);
      }
      mcBlinkLoop();
    }, 2500 + Math.random() * 3500);
  }
  // 很久没动：先犯困，再低头玩游戏；一动就醒
  function mcActivity() {
    mc.lastAct = Date.now();
    if (mc.cfg && (mc.mood === '困' || mc.mood === '玩游戏')) { mascotMood('惊讶'); setTimeout(() => { if (mc.mood === '惊讶') mascotMood('待机'); }, 900); }
  }
  ['pointerdown', 'keydown', 'wheel'].forEach(ev => window.addEventListener(ev, mcActivity, { passive: true }));
  setInterval(() => {
    if (!mc.cfg || document.hidden) return;
    const idle = Date.now() - mc.lastAct;
    if (idle > 240000 && mc.mood !== '玩游戏' && mc.cfg.images['玩游戏']) mascotMood('玩游戏');
    else if (idle > 90000 && mc.mood === '待机') { mascotMood('困'); mcSay('……有点困了。', 3500); }
  }, 10000);
  $('#mascot').addEventListener('click', e => {
    if (!e.target.closest('.mc-body')) return;
    mascotMood('惊讶');
    setTimeout(() => mascotMood('开心'), 450);
    if (!($('#panel') && !$('#panel').hidden && $('#chat-log'))) openChat();
  });

  async function openChat() {
    if (state.aiFree === undefined) {
      const st = await api('/api/settings');
      state.aiFree = !!(st.ai && st.ai.free);
    }
    await loadButler();
    showPanel(`${panelHead('问问' + butlerName())}
      <div class="butler-head">
        <div class="butler-face" id="butler-face" data-mood="${esc(state.mood || '待机')}"><span class="bf-emoji">${MOOD_FACE[state.mood || '待机']}</span><span class="bf-mood">${esc(state.mood || '待机')}</span></div>
        <p class="sub" id="chat-mode-tip">${chatModeTip()}</p>
      </div>
      <label class="check chat-mode"><input type="checkbox" id="chat-free" ${state.aiFree ? 'checked' : ''}>
        <span><strong>自由回答</strong> <small>打开后会像平常聊天一样，用 AI 自己的知识详细回答；你的资料只当参考</small></span></label>
      <div class="chat" id="chat-log"></div>
      <form class="chat-form" id="chat-form">
        <textarea id="chat-input" rows="2" placeholder="吩咐${esc(butlerName())}做点什么，比如：帮我看看昨天存的资料讲了什么"></textarea>
        <button class="btn primary" type="submit">发送</button>
      </form>
      ${state.chat.length ? '<button class="link-btn" data-act="chat-clear">清空对话</button>' : ''}`);
    renderChat();
    setTimeout(() => $('#chat-input') && $('#chat-input').focus(), 50);
  }

  function chatModeTip() {
    const n = esc(butlerName());
    return state.aiFree
      ? `自由回答：什么都可以问。问到你的资料时，${n}会自己去翻，还会标出处。`
      : `${n}会自己翻你的说明和资料：按日期找、读完再总结、打开工具、新建说明、放进活页，都可以直接吩咐。`;
  }

  function renderChat() {
    const log = $('#chat-log');
    if (!log) return;
    const day = new Date(Date.now() - 86400000);
    const ystd = `${day.getMonth() + 1}月${day.getDate()}日`;
    log.innerHTML = state.chat.length ? '' : `<div class="chat-tips">可以这样吩咐：
      <button data-ask="帮我看看${ystd}存的资料主要讲了什么">帮我看看${ystd}存的资料主要讲了什么</button>
      <button data-ask="我最近剪藏了哪些文章？">我最近剪藏了哪些文章？</button>
      <button data-ask="哪些说明好久没看了？">哪些说明好久没看了？</button>
      <button data-ask="我记过哪些关于 Python 的东西？">我记过哪些关于 Python 的东西？</button></div>`;
    state.chat.forEach((m, mi) => {
      const div = document.createElement('div');
      div.className = 'msg ' + m.role;
      if (m.role === 'user') {
        div.textContent = m.content;
      } else if (m.pending) {
        div.innerHTML = `${(m.steps || []).map(st => `<div class="chat-step">${esc(st.say || '翻资料中…')}</div>`).join('')}<span class="dots">${m.steps && m.steps.length ? '' : '想一想'}</span>`;
      } else if (m.error) {
        div.innerHTML = `<div class="err">${esc(m.error)}</div>${/还没设置/.test(m.error) ? '<button class="btn small primary" data-act="open-settings">去设置</button>' : ''}`;
      } else {
        if (m.steps && m.steps.length) div.insertAdjacentHTML('beforeend', `<details class="chat-steps"><summary>翻了 ${m.steps.length} 次资料</summary>${m.steps.map(st => `<div class="chat-step">${esc(st.say || st.tool)}</div>`).join('')}</details>`);
        div.appendChild(renderMd(m.content));
        if (m.sources && m.sources.length) {
          div.insertAdjacentHTML('beforeend', `<div class="srcs">出处：${m.sources.map(s => `<button data-src="${mi}:${s.n}">[${s.n}] ${esc(s.title)}${s.label ? ' · ' + esc(s.label) : ''}</button>`).join('')}</div>`);
        }
        for (const [ai, a] of (m.actions || []).entries()) {
          let label, done = a.done;
          if (a.type === 'launch') label = `${a.done ? '已打开' : '打开'}"${a.tool}"`;
          else if (a.type === 'open') label = `打开${a.kind === 'note' ? '说明' : '资料'}"${a.title}"`;
          else if (a.type === 'create_note') { done = a.ok; label = a.ok ? `已新建"${a.id}"${a.page ? `，放进了"${a.page}"` : ''} · 打开看看` : `没建成：${a.message || ''}`; }
          else if (a.type === 'put_in_page') { label = `已把 ${a.count} 件放进"${a.page}"${a.created ? '（新建的活页）' : ''}`; div.insertAdjacentHTML('beforeend', `<div class="chat-done">✓ ${esc(label)}</div>`); continue; }
          else continue;
          div.insertAdjacentHTML('beforeend', `<button class="btn small ${done ? '' : 'primary'} chat-act" data-chat-act="${mi}:${ai}">${esc(label)}</button>`);
        }
      }
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }

  // 边查边说：后台一行一个 JSON，先是查找进度，最后是回答
  async function askButler(json, onStep) {
    let url = '/api/ai/ask' + (state.space === 'private' ? '?space=private' : '');
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'X-Baibao': '1', 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(json) });
    } catch { return { ok: false, message: '连不上百宝匣后台。' }; }
    if (!res.ok || !res.body || !/ndjson/.test(res.headers.get('content-type') || '')) {
      let b; try { b = await res.json(); } catch { b = null; }
      if (b && b.locked && state.space === 'private') { setTimeout(() => leavePrivate(true), 0); return { ok: false, message: '已自动锁上。' }; }
      return b || { ok: false, message: OLD_BACKEND };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.step) onStep(o.step);
        if (o.done) done = o.done;
      }
      if (end) break;
    }
    return done || { ok: false, message: '回答到一半断了，再问一次吧。' };
  }

  async function sendChat(text) {
    const q = text.trim();
    if (!q) return;
    const history = state.chat.filter(m => !m.pending && !m.error).map(m => ({ role: m.role, content: m.content }));
    state.chat.push({ role: 'user', content: q });
    const reply = { role: 'assistant', pending: true, steps: [] };
    state.chat.push(reply);
    const space = state.space;
    setMood('思考');
    renderChat();
    const r = await askButler({ question: q, history, free: !!state.aiFree }, st => { reply.steps.push(st); setMood(st.mood || '思考'); renderChat(); });
    if (state.space !== space) return; // 中途换了区，丢掉
    reply.pending = false;
    if (!r.ok) { reply.error = r.message; setMood('惊讶'); renderChat(); return; }
    reply.content = r.answer;
    reply.sources = r.sources || [];
    reply.actions = r.actions || [];
    reply.steps = r.steps || reply.steps;
    setMood(r.mood);
    renderChat();
    // 吩咐打开的工具直接打开；新建、放进活页的已经做好了，刷新列表
    for (const a of reply.actions) {
      if (a.type === 'launch' && a.id) { a.done = true; launchTool(a.id); }
    }
    if (reply.actions.some(a => a.type === 'create_note' || a.type === 'put_in_page')) loadNotes();
    renderChat();
  }

  async function chatAction(mi, ai) {
    const a = state.chat[mi].actions[ai];
    if (a.type === 'launch' && a.id) { a.done = true; launchTool(a.id); renderChat(); }
    if (a.type === 'open') { closePanel(); if (a.kind === 'note') openNote(a.id); else openFile(a.name); }
    if (a.type === 'create_note' && a.ok) { closePanel(); openNote(a.id); }
  }

  function openSource(mi, n) {
    const s = state.chat[mi].sources.find(x => x.n === n);
    if (!s) return;
    if (s.kind === 'note') { closePanel(); return openNote(s.id); }
    openFile(s.name, { page: s.page || null, chapter: s.chapter ?? null });
  }

  $('#panel').addEventListener('submit', e => {
    if (e.target.id !== 'chat-form') return;
    e.preventDefault();
    const ta = $('#chat-input');
    const v = ta.value;
    ta.value = '';
    sendChat(v);
  });
  $('#panel').addEventListener('change', async e => {
    if (e.target.id !== 'chat-free' && e.target.id !== 'ai-free-set') return;
    state.aiFree = e.target.checked;
    const tip = $('#chat-mode-tip');
    if (tip) tip.textContent = chatModeTip();
    await api('/api/ai/free', { method: 'POST', json: { on: state.aiFree } });
    toast(state.aiFree ? '已打开自由回答' : '已改回资料优先');
  });
  $('#panel').addEventListener('keydown', e => {
    if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });

  // 0.7 面板里的各种按钮
  $('#panel').addEventListener('click', e => {
    const t = e.target;
    const ask1 = t.closest('[data-ask]');
    if (ask1) return sendChat(ask1.dataset.ask);
    const ca = t.closest('[data-chat-act]');
    if (ca) { const [mi, ai] = ca.dataset.chatAct.split(':').map(Number); return chatAction(mi, ai); }
    const src = t.closest('[data-src]');
    if (src) { const [mi, n] = src.dataset.src.split(':').map(Number); return openSource(mi, n); }
    const ckOpen = t.closest('[data-ck-open]');
    if (ckOpen) {
      const id = ckOpen.dataset.ckOpen;
      const tool = state.tools.find(x => x.id === id);
      if (tool && tool.section) state.openSections.add(tool.section);
      return openPanel(id);
    }
    const ckFix = t.closest('[data-ck-fix]');
    if (ckFix) {
      const id = ckFix.dataset.ckFix;
      ckFix.disabled = true;
      toast('正在修复…', 120000);
      api(`/api/tools/${encodeURIComponent(id)}/fix`, { method: 'POST', json: { kind: ckFix.dataset.kind } }).then(r => {
        toast(r.ok ? '修好了' : (r.message || '没修好'), 4000);
        if (r.ok) runCheckupUI(false);
      });
      return;
    }
    const nn = t.closest('[data-new-note]');
    if (nn) {
      closePanel();
      api('/api/new-note', { method: 'POST', json: { title: nn.dataset.newNote } }).then(r => { if (r.ok) openNote(r.id, { edit: true }); });
    }
  });

  // ---------------------------------------------------------------- 电子书书签、划线、笔记

  async function loadBookNotes() {
    const r = state.reader;
    if (!r) return;
    r.notes = await api(`/api/booknotes?name=${encodeURIComponent(r.name)}`);
    if (!r.notes.highlights) r.notes = { bookmarks: [], highlights: [] };
  }
  async function saveBookNotes() {
    const r = state.reader;
    if (!r || !r.notes) return;
    await api('/api/booknotes', { method: 'POST', json: { name: r.name, ...r.notes } });
    renderBookNotesCount();
  }
  function renderBookNotesCount() {
    const r = state.reader;
    const b = $('#view-reader [data-rd=notes]');
    if (b && r && r.notes) b.textContent = `笔记（${r.notes.highlights.length + r.notes.bookmarks.length}）`;
  }

  // 在一章里找到一段文字（可能跨好几个标签），给它套上标记
  function paintText(doc, text, id) {
    if (!text) return null;
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = '', n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: full.length }); full += n.nodeValue; }
    const at = full.indexOf(text);
    if (at < 0) return null;
    const end = at + text.length;
    let first = null;
    for (const { node, start } of nodes) {
      const s = Math.max(at, start), e = Math.min(end, start + node.nodeValue.length);
      if (s >= e) continue;
      const range = doc.createRange();
      range.setStart(node, s - start);
      range.setEnd(node, e - start);
      const m = doc.createElement('mark');
      m.className = 'hl';
      m.dataset.hl = id;
      range.surroundContents(m);
      if (!first) first = m;
    }
    return first;
  }

  function paintHighlights(doc) {
    const r = state.reader;
    if (!r || !r.notes) return;
    const st = doc.createElement('style');
    st.textContent = 'mark.hl{background:#ffe9a8;color:inherit;border-bottom:2px solid #e2b93b;cursor:pointer} mark.hl[data-note="1"]{border-bottom-style:dashed}';
    (doc.head || doc.documentElement).appendChild(st);
    for (const h of r.notes.highlights.filter(x => x.chapter === r.chapter)) {
      const m = paintText(doc, h.text, h.id);
      if (m && h.note) doc.querySelectorAll(`mark.hl[data-hl="${h.id}"]`).forEach(x => { x.dataset.note = '1'; x.title = h.note; });
    }
    // 选中文字后，在上面弹出"划线 / 写笔记"
    doc.addEventListener('mouseup', () => setTimeout(() => showSelBar(doc), 10));
    doc.addEventListener('touchend', () => setTimeout(() => showSelBar(doc), 300));
    doc.addEventListener('click', e => {
      const m = e.target.closest && e.target.closest('mark.hl');
      if (m) openHighlight(m.dataset.hl);
    });
  }

  function hideSelBar() { const b = $('#sel-bar'); if (b) b.remove(); }

  function showSelBar(doc) {
    hideSelBar();
    const sel = doc.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text || text.length > 2000) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const fr = $('#rd-frame').getBoundingClientRect();
    const bar = document.createElement('div');
    bar.id = 'sel-bar';
    bar.className = 'sel-bar';
    bar.innerHTML = '<button data-sel="hl">划线</button><button data-sel="note">写笔记</button><button data-sel="copy">复制</button>';
    bar.style.left = Math.max(8, fr.left + rect.left + rect.width / 2 - 90) + 'px';
    bar.style.top = Math.max(8, fr.top + rect.top - 44) + 'px';
    document.body.appendChild(bar);
    bar.addEventListener('mousedown', e => e.preventDefault());
    bar.addEventListener('click', async e => {
      const b = e.target.closest('[data-sel]');
      if (!b) return;
      hideSelBar();
      if (b.dataset.sel === 'copy') { try { await navigator.clipboard.writeText(text); toast('已复制'); } catch {} return; }
      let note = '';
      if (b.dataset.sel === 'note') {
        const v = await ask({ title: '写笔记', text: text.length > 80 ? text.slice(0, 80) + '…' : text, fields: [{ name: 'note', label: '笔记' }], okText: '保存' });
        if (!v) return;
        note = v.note;
      }
      const r = state.reader;
      const h = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), chapter: r.chapter, text, note, time: Date.now() };
      r.notes.highlights.push(h);
      sel.removeAllRanges();
      const m = paintText(doc, text, h.id);
      if (m && note) doc.querySelectorAll(`mark.hl[data-hl="${h.id}"]`).forEach(x => { x.dataset.note = '1'; x.title = note; });
      await saveBookNotes();
      toast(note ? '笔记存好了' : '划好了');
    });
  }

  async function openHighlight(id) {
    const r = state.reader;
    const h = r.notes.highlights.find(x => x.id === id);
    if (!h) return;
    const v = await ask({ title: '这条划线', text: h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text, fields: [{ name: 'note', label: '笔记', value: h.note }], okText: '保存笔记', extra: { label: '删掉划线', danger: true } });
    if (!v) return;
    if (v._extra) r.notes.highlights = r.notes.highlights.filter(x => x.id !== id);
    else h.note = v.note;
    await saveBookNotes();
    showChapter();
  }

  function openBookNotes() {
    const r = state.reader;
    if (!r) return;
    const ch = i => (r.info.chapters[i] || {}).title || `第 ${i + 1} 部分`;
    const hs = [...r.notes.highlights].sort((a, b) => a.chapter - b.chapter || a.time - b.time);
    showPanel(`${panelHead('书签和笔记')}
      <div class="btn-row">
        <button class="btn" data-act="bm-add">在这里加书签</button>
        <button class="btn" data-act="bn-export" ${hs.length ? '' : 'disabled'}>导出成一篇说明</button>
      </div>
      <h3 class="st-h">书签</h3>
      ${r.notes.bookmarks.length ? `<ul class="bn-list">${r.notes.bookmarks.map((b, i) => `<li>
        <button class="bn-go" data-bm="${i}"><b>${esc(ch(b.chapter))}</b> ${esc(b.title || '')}<span class="s">${b.time ? fmtDate(b.time) : ''}</span></button>
        <button class="btn small ghost danger" data-bm-del="${i}">删</button></li>`).join('')}</ul>` : '<p class="empty-note">还没有书签。</p>'}
      <h3 class="st-h">划线和笔记</h3>
      ${hs.length ? `<ul class="bn-list">${hs.map(h => `<li>
        <button class="bn-go" data-hl-go="${esc(h.id)}"><b>${esc(ch(h.chapter))}</b><span class="q">${esc(h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text)}</span>${h.note ? `<span class="nt">${esc(h.note)}</span>` : ''}</button></li>`).join('')}</ul>`
        : '<p class="empty-note">读的时候选中一段文字，就能划线或写笔记。</p>'}`);
  }

  async function bookNotesAct(e) {
    const r = state.reader;
    if (!r) return false;
    const t = e.target;
    const act = t.closest('[data-act]') && t.closest('[data-act]').dataset.act;
    if (act === 'bm-add') {
      const v = await ask({ title: '加书签', fields: [{ name: 'title', label: '给这个位置起个名字（可不填）' }], okText: '加上' });
      if (!v) return true;
      r.notes.bookmarks.push({ chapter: r.chapter, ratio: r.ratio || 0, title: v.title, time: Date.now() });
      await saveBookNotes();
      openBookNotes();
      return true;
    }
    if (act === 'bn-export') {
      const ch = i => (r.info.chapters[i] || {}).title || `第 ${i + 1} 部分`;
      const hs = [...r.notes.highlights].sort((a, b) => a.chapter - b.chapter || a.time - b.time);
      let md = `# 《${r.info.title}》读书笔记\n标签: 读书笔记${r.info.author ? ', ' + r.info.author : ''}\n\n`;
      let last = -1;
      for (const h of hs) {
        if (h.chapter !== last) { md += `## ${ch(h.chapter)}\n\n[回到这一章](/#read/${encodeURIComponent(r.name)}/${h.chapter})\n\n`; last = h.chapter; }
        md += `> ${h.text.replace(/\n+/g, '\n> ')}\n\n${h.note ? h.note + '\n\n' : ''}`;
      }
      const res = await api('/api/new-note', { method: 'POST', json: { title: `《${r.info.title}》读书笔记`, text: md } });
      if (!res.ok) { toast(res.message || '没导出'); return true; }
      closePanel();
      toast('已导出成说明');
      openNote(res.id);
      return true;
    }
    const bm = t.closest('[data-bm]');
    if (bm) {
      const b = r.notes.bookmarks[Number(bm.dataset.bm)];
      closePanel();
      r.chapter = b.chapter; r.ratio = b.ratio; showChapter();
      return true;
    }
    const bmd = t.closest('[data-bm-del]');
    if (bmd) { r.notes.bookmarks.splice(Number(bmd.dataset.bmDel), 1); await saveBookNotes(); openBookNotes(); return true; }
    const hg = t.closest('[data-hl-go]');
    if (hg) {
      const h = r.notes.highlights.find(x => x.id === hg.dataset.hlGo);
      closePanel();
      if (h) { r.chapter = h.chapter; r.ratio = 0; r.scrollTo = h.id; showChapter(); }
      return true;
    }
    return false;
  }
  $('#panel').addEventListener('click', e => { if (state.reader) bookNotesAct(e); });

  $('#open-checkup').addEventListener('click', openCheckup);
  $('#open-stats').addEventListener('click', openStats);
  $('#open-mem-stats').addEventListener('click', openStats);
  $('#ask-ai').addEventListener('click', openChat);
  $('#checkup-note').addEventListener('click', e => { if (e.target.closest('[data-open-checkup]')) openCheckup(); });

  // ---------------------------------------------------------------- 启动

  // ---------------------------------------------------------------- 随身口袋 + 末影箱（0.15）
  // 口袋：随手放文件的地方，拖进来、拖出去；连上末影箱后自动加密同步到自己的 GitHub 私有仓库

  const BOX_DOC = 'https://github.com/mengyiheqiao/baibaoxia/blob/main/docs/%E6%9C%AB%E5%BD%B1%E7%AE%B1.md';

  async function openPocket(opts = {}) {
    if (state.space === 'private') return;
    pk.open = true;
    pk.form = !!opts.form;
    pk.trash = false;
    showPanel(`${panelHead('随身口袋')}<p class="sub">读取中…</p>`);
    pk.open = true;
    $('#panel').classList.add('pocket-panel');
    await refreshPocket();
    clearInterval(pk.timer);
    // 面板开着时，每 3 秒看一眼同步进度
    pk.timer = setInterval(() => { if (!pk.open || $('#panel').hidden) { clearInterval(pk.timer); pk.open = false; $('#panel').classList.remove('pocket-panel'); return; } if (!pk.form && !pk.trash) refreshPocket(); }, 3000);
  }

  function leavePocketPanel() {
    pk.open = false;
    clearInterval(pk.timer);
    $('#panel').classList.remove('pocket-panel');
  }

  async function refreshPocket() {
    const r = await api('/api/pocket');
    if (!r || !r.items) { if (r && r.message) toast(r.message); return; }
    pk.items = r.items; pk.box = r.box || {}; pk.temp = !!r.temp;
    if (pk.open && !$('#panel').hidden) renderPocket();
    renderPocketBadge();
  }

  function renderPocketBadge() {
    const b = $('#pocket-btn');
    if (!b) return;
    const pending = pk.items.filter(x => x.sync === 'pending').length;
    b.dataset.state = pk.box.error ? 'error' : pk.box.syncing || pending ? 'busy' : pk.box.connected ? 'ok' : '';
    b.title = pk.box.error ? '末影箱同步出错：' + pk.box.error : pk.box.connected ? `末影箱：${pk.box.repo}` : '随身口袋';
  }

  function boxLine() {
    const b = pk.box;
    if (!b.connected) return `<div class="box-line off"><span class="box-dot"></span><span>还没连上末影箱，口袋里的东西只在这台电脑上。</span><button class="btn small primary" data-act="pk-form">连接末影箱</button></div>`;
    const when = b.lastSync ? fmtDate(b.lastSync).slice(5) : '还没同步过';
    const st = b.syncing ? (b.progress || '同步中…') : b.error ? `出错：${b.error}` : `上次同步 ${when}`;
    return `<div class="box-line${b.error ? ' err' : b.syncing ? ' busy' : ''}"><span class="box-dot"></span><span><b class="box-name">末影箱</b> ${esc(b.repo)} · ${esc(b.device)}<br><small>${esc(st)}</small></span><button class="btn small" data-act="pk-sync" ${b.syncing ? 'disabled' : ''}>同步</button></div>`;
  }

  const SYNC_LABEL = { synced: ['✓', '已同步'], pending: ['↑', '等着上传'], cloud: ['☁', '在云端，点"拿下来"'], pulling: ['↓', '正在拿下来'] };

  function renderPocket() {
    const box = $('#panel .panel-inner');
    if (pk.form) return renderBoxForm();
    if (pk.trash) return renderPocketTrash();
    const items = pk.items;
    box.innerHTML = `${panelHead('随身口袋')}
      ${pk.temp ? '<p class="temp-note">临时模式：关掉百宝匣后，这台电脑上的口袋会清空。</p>' : ''}
      ${boxLine()}
      <div class="pocket-drop" id="pocket-drop">把文件拖到这里放进口袋<br><small>拿走的时候，把文件从下面拖到桌面或者别的窗口里</small></div>
      ${items.length ? `<ul class="pocket-list">${items.map(it => {
        const [g, tip] = SYNC_LABEL[it.sync] || ['', ''];
        const cloud = it.sync === 'cloud' || it.sync === 'pulling';
        return `<li class="pk-item${cloud ? ' cloud' : ''}" ${cloud ? '' : 'draggable="true"'} data-name="${esc(it.name)}">
          <span class="pk-glyph">${fileGlyph(it.name)}</span>
          <span class="pk-main"><span class="pk-name">${esc(it.name)}</span><small>${fmtSize(it.size)} · ${esc(fmtDate(it.mtime).slice(5))}${it.by && cloud ? ` · 来自${esc(it.by)}` : ''}</small></span>
          ${g ? `<span class="pk-sync s-${it.sync}" title="${esc(tip)}">${g}</span>` : ''}
          ${cloud ? `<button class="btn small" data-act="pk-pull" ${it.sync === 'pulling' ? 'disabled' : ''}>拿下来</button>` : `<button class="btn small ghost" data-act="pk-open">打开</button>`}
          <button class="link-btn danger" data-act="pk-del" aria-label="删除">删除</button>
        </li>`;
      }).join('')}</ul>` : '<p class="empty-note">口袋是空的。</p>'}
      <div class="btn-row panel-foot">
        <button class="btn ghost" data-act="pk-folder">打开文件夹</button>
        <button class="btn ghost" data-act="pk-trash">回收站</button>
        ${pk.box.connected ? '<button class="btn ghost" data-act="pk-form">末影箱设置</button>' : ''}
      </div>
      <p class="sub">${pk.box.connected ? '20 MB 以下的文件会自动同步到每台连着同一个末影箱的电脑；更大的文件在别的电脑上显示为"在云端"，要用时点"拿下来"。' : '连上末影箱以后，在学校、公司的电脑上打开百宝匣，连上同一个末影箱就能拿到这些文件。'}</p>`;
  }

  function renderBoxForm() {
    const b = pk.box;
    const box = $('#panel .panel-inner');
    box.innerHTML = `${panelHead('末影箱')}
      ${b.connected ? `<p class="sub">已连接 <b>${esc(b.repo)}</b>，这台电脑叫"${esc(b.device)}"。</p>
        <section class="setting">
          <strong>连接码</strong>
          <p class="sub">把仓库名和令牌用箱子密码加密成一串字。存在手机备忘录里、发给自己都行，别人拿到没有密码也用不了。到了学校的电脑上，贴连接码、输密码就能连上，不用再去 GitHub 翻令牌。</p>
          <span class="with-btn"><input id="box-code-pw" type="password" placeholder="输入箱子密码" autocomplete="off"><button class="btn" data-act="pk-code">生成</button></span>
          <textarea id="box-code-out" class="code-out" rows="3" readonly hidden></textarea>
        </section>
        <div class="btn-row"><button class="btn" data-act="pk-back">← 回到口袋</button><button class="btn ghost danger" data-act="pk-disconnect">断开</button></div>
        <p class="sub">断开只是让这台电脑不再同步，口袋里的文件和云端的东西都不会删。</p>` : `
      <p class="sub">末影箱把口袋里的东西加密以后存进<b>你自己的</b> GitHub 私有仓库。在别的电脑上连同一个仓库、输同一个密码，就能拿到。GitHub 上只看得到乱码。</p>
      <ol class="box-steps">
        <li>在 GitHub 上<a href="https://github.com/new" target="_blank" rel="noopener">新建一个仓库</a>，选 Private（私有），名字随便，比如 my-box</li>
        <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">生成一个令牌</a>：Repository access 选 Only select repositories，勾上刚才的仓库；Permissions 里把 Contents 设成 Read and write</li>
        <li>把仓库名、令牌填到下面，再设一个箱子密码</li>
      </ol>
      <p class="sub"><a href="${BOX_DOC}" target="_blank" rel="noopener">一步一步的详细教程</a></p>
      <div class="seg" role="tablist"><button type="button" class="${pk.useCode ? '' : 'on'}" data-act="pk-mode" data-code="">仓库 + 令牌</button><button type="button" class="${pk.useCode ? 'on' : ''}" data-act="pk-mode" data-code="1">我有连接码</button></div>
      ${pk.useCode ? `<label class="field"><span>连接码</span><textarea id="box-code" rows="3" placeholder="BBX1.…" spellcheck="false"></textarea><small>在已经连上末影箱的电脑上：随身口袋 → 末影箱设置 → 生成连接码。</small></label>` : `
      <label class="field"><span>仓库</span><input id="box-repo" placeholder="你的用户名/my-box" spellcheck="false" autocomplete="off"></label>
      <label class="field"><span>令牌</span><input id="box-token" type="password" placeholder="github_pat_…" autocomplete="off"></label>`}
      <label class="field"><span>箱子密码</span><input id="box-pw" type="password" autocomplete="new-password" placeholder="至少 6 位"><small>第一次连接时设定；以后每台电脑都用这个密码。忘了就打不开里面的东西，谁也帮不了你，记牢。</small></label>
      <label class="field"><span>这台电脑叫</span><input id="box-device" maxlength="30" placeholder="比如 宿舍电脑、学校机房"></label>
      <div class="btn-row"><button class="btn primary" data-act="pk-connect">连接</button>${pk.items.length || !pk.temp ? '<button class="btn ghost" data-act="pk-back">先不连</button>' : ''}</div>
      <p class="sub" id="box-msg"></p>
      ${pk.temp ? '<p class="temp-note">临时模式：令牌和密码只在这次打开时用，关掉百宝匣就一起清掉。</p>' : '<p class="sub">令牌和加密钥匙存在这台电脑的百宝匣文件夹里（.末影箱），不会上传。</p>'}`}`;
    const dev = $('#box-device');
    if (dev && !dev.value) api('/api/box').then(r => { if (r && r.hostname && !dev.value) dev.placeholder = r.hostname; });
  }

  async function renderPocketTrash() {
    const r = await api('/api/pocket/trash');
    const items = (r && r.items) || [];
    $('#panel .panel-inner').innerHTML = `${panelHead('口袋的回收站')}
      <p class="sub">在口袋里删掉的、被别的电脑上的新版本换掉的文件都在这里。</p>
      ${items.length ? `<ul class="pocket-list">${items.map(it => `<li class="pk-item" data-name="${esc(it.name)}"><span class="pk-glyph">${fileGlyph(it.name)}</span><span class="pk-main"><span class="pk-name">${esc(it.name)}</span><small>${fmtSize(it.size)} · 删于 ${esc(fmtDate(it.deleted).slice(5))}</small></span><button class="btn small" data-act="pk-restore">放回口袋</button></li>`).join('')}</ul>` : '<p class="empty-note">回收站是空的。</p>'}
      <div class="btn-row panel-foot"><button class="btn" data-act="pk-back">← 回到口袋</button></div>`;
  }

  async function pocketAct(act, b) {
    const li = b.closest('.pk-item');
    const name = li && li.dataset.name;
    if (act === 'pk-form') { pk.form = true; pk.trash = false; return renderPocket(); }
    if (act === 'pk-back') { pk.form = false; pk.trash = false; return refreshPocket(); }
    if (act === 'pk-trash') { pk.trash = true; return renderPocket(); }
    if (act === 'pk-folder') return api('/api/pocket/folder', { method: 'POST' });
    if (act === 'pk-open') { const r = await api('/api/pocket/open', { method: 'POST', json: { name } }); if (!r.ok) toast(r.message); return; }
    if (act === 'pk-pull') { b.disabled = true; const r = await api('/api/pocket/pull', { method: 'POST', json: { name } }); toast(r.ok ? '正在从末影箱拿下来…' : r.message); return refreshPocket(); }
    if (act === 'pk-restore') { const r = await api('/api/pocket/restore', { method: 'POST', json: { name } }); toast(r.ok ? '放回口袋了' : r.message); return renderPocket(); }
    if (act === 'pk-del') {
      const it = pk.items.find(x => x.name === name);
      const cloudOnly = it && (it.sync === 'cloud' || it.sync === 'pulling');
      const msg = cloudOnly ? `从末影箱里删掉"${name}"？所有电脑上都会消失。` : pk.box.connected ? `删掉"${name}"？连着末影箱的其他电脑上也会删掉（都会先放进回收站）。` : `删掉"${name}"？会先放进口袋的回收站。`;
      if (!confirm(msg)) return;
      const r = await api('/api/pocket/delete', { method: 'POST', json: { name } });
      if (!r.ok) toast(r.message);
      return refreshPocket();
    }
    if (act === 'pk-sync') {
      b.disabled = true;
      pk.box.syncing = true; renderPocket();
      const r = await api('/api/box/sync', { method: 'POST' });
      if (r.box) pk.box = r.box;
      toast(r.ok ? (r.changed ? `同步好了：上传 ${r.uploaded || 0} 个，拿下来 ${r.downloaded || 0} 个` : '已经是最新的了') : (r.message || '同步失败'), 4000);
      return refreshPocket();
    }
    if (act === 'pk-connect') {
      const msg = $('#box-msg');
      const v = id => ($(id) ? $(id).value : '');
      const body = { repo: v('#box-repo'), token: v('#box-token'), code: v('#box-code'), password: v('#box-pw'), device: v('#box-device') || $('#box-device').placeholder };
      b.disabled = true;
      msg.textContent = '正在连接 GitHub…第一次可能要十几秒';
      const r = await api('/api/box/connect', { method: 'POST', json: body });
      b.disabled = false;
      if (!r.ok) { msg.textContent = r.message || '没连上'; return; }
      toast(r.created ? '末影箱建好了，口袋里的东西会自动传上去' : '连上了，正在把末影箱里的东西拿下来', 4000);
      pk.form = false;
      return refreshPocket();
    }
    if (act === 'pk-mode') { pk.useCode = !!b.dataset.code; return renderPocket(); }
    if (act === 'pk-code') {
      const r = await api('/api/box/code', { method: 'POST', json: { password: $('#box-code-pw').value } });
      if (!r.ok) return toast(r.message);
      const out = $('#box-code-out');
      out.hidden = false; out.value = r.code; out.select();
      try { await navigator.clipboard.writeText(r.code); toast('连接码已经复制好了'); } catch {}
      return;
    }
    if (act === 'pk-disconnect') {
      if (!confirm('断开末影箱？这台电脑以后不再同步，文件都不会删。')) return;
      await api('/api/box/disconnect', { method: 'POST' });
      pk.form = false;
      return refreshPocket();
    }
  }

  async function pocketUpload(files) {
    let ok = 0;
    for (const f of files) {
      toast(`正在放进口袋：${f.name}…`, 60000);
      const r = await api(`/api/pocket/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' } });
      if (r.ok) ok++; else toast(`${f.name} 没放进去：${r.message || ''}`, 4000);
    }
    if (ok) toast(`放进口袋了 ${ok} 个文件${pk.box.connected ? '，马上同步到末影箱' : ''}`);
    if (pk.open && !$('#panel').hidden) refreshPocket(); else { await refreshPocket(); openPocket(); }
  }

  // 从口袋里拖出去：桌面版交给系统拖放（真正的文件）；网页版用 Chrome 的 DownloadURL
  $('#panel').addEventListener('dragstart', e => {
    const li = e.target.closest && e.target.closest('.pk-item[draggable]');
    if (!li) return;
    const name = li.dataset.name;
    pk.dragOut = true;
    setTimeout(() => { pk.dragOut = false; }, 10000);
    if (window.baibaoDesktop && window.baibaoDesktop.dragOut) {
      e.preventDefault();
      window.baibaoDesktop.dragOut(name);
      setTimeout(() => { pk.dragOut = false; }, 500);
      return;
    }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('DownloadURL', `application/octet-stream:${name}:${location.origin}/口袋/${encodeURIComponent(name)}`);
    e.dataTransfer.setData('text/uri-list', `${location.origin}/口袋/${encodeURIComponent(name)}`);
  });
  $('#panel').addEventListener('dragend', () => { pk.dragOut = false; });
  $('#panel').addEventListener('dblclick', e => {
    const li = e.target.closest && e.target.closest('.pk-item[draggable]');
    if (li) api('/api/pocket/open', { method: 'POST', json: { name: li.dataset.name } });
  });

  $('#pocket-btn').addEventListener('click', () => { $('#q').value = ''; openPocket(); });

  // 临时模式：顶上挂一条提示，没连末影箱就直接打开连接页面
  async function initPocket() {
    if (state.space === 'private') return;
    await refreshPocket();
    if (pk.temp) {
      document.body.classList.add('temp-mode');
      if (!$('#temp-banner')) {
        const b = document.createElement('div');
        b.id = 'temp-banner';
        b.className = 'banner top temp-banner main-only';
        b.innerHTML = '临时模式：这是别人的电脑，关掉百宝匣后不会留下你的任何东西。<button class="link-btn" type="button">打开随身口袋</button>';
        b.querySelector('button').addEventListener('click', () => openPocket());
        $('main').prepend(b);
      }
      if (!pk.box.connected) openPocket({ form: true });
    }
    // 没开面板时也每分钟看一眼，让按钮上的小点保持最新
    setInterval(() => { if (state.space !== 'private' && !(pk.open && !$('#panel').hidden)) refreshPocket(); }, 60000);
  }

  function route() {
    let h = location.hash.slice(1);
    try { h = decodeURIComponent(h); } catch {}
    if (h.startsWith('read/')) {
      const parts = h.slice(5).split('/');
      const ch = Number(parts.pop());
      history.replaceState(null, '', '#memory');
      openReader(parts.join('/'), { chapter: Number.isFinite(ch) ? ch : null });
    } else if (h.startsWith('memory/')) openNote(h.slice(7));
    else if (h === 'memory') setView('memory');
    else setView('tools');
  }
  window.addEventListener('hashchange', route);

  (async function init() {
    await initDesktop();
    loadMascot();
    const v = await api('/api/version');
    if (v.version !== APP_VERSION) {
      const b = document.createElement('div');
      b.className = 'banner top';
      const pageNewer = v.version && parseFloat(v.version) < parseFloat(APP_VERSION);
      b.textContent = !v.version ? OLD_BACKEND
        : pageNewer ? `页面是 ${APP_VERSION} 版，后台是 ${v.version} 版。` + OLD_BACKEND
        : `后台已经是 ${v.version} 版，页面还是旧的。按 Ctrl+F5 刷新一下页面。`;
      $('main').prepend(b);
    }
    await loadTools();
    route();
    initPocket();
  })();
})();
