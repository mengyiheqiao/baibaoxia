// 百宝匣剪藏：选中一段文字后，在选区右下角冒出一个小图标，点一下就存进百宝匣。
// 只读取你选中的内容，不改网页；图标放在独立的影子 DOM 里，不受网页样式影响。
(() => {
  if (window.__baibaoxiaFloat) return;
  window.__baibaoxiaFloat = true;

  const MIN_CHARS = 12;          // 选中至少这么多字才出现
  let enabled = true;
  let host = null, shadow = null, btn = null, label = null;
  let hideTimer = null, busy = false;

  try {
    chrome.storage.local.get({ floatBtn: true, blockedSites: [] }, v => {
      enabled = v.floatBtn && !(v.blockedSites || []).includes(location.hostname);
      if (!enabled) hide();
    });
    chrome.storage.onChanged.addListener(() => {
      chrome.storage.local.get({ floatBtn: true, blockedSites: [] }, v => {
        enabled = v.floatBtn && !(v.blockedSites || []).includes(location.hostname);
        if (!enabled) hide();
      });
    });
  } catch {}

  const ICON = '<svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true"><rect x="4" y="8" width="24" height="19" rx="3" fill="#2f4a43"/><rect x="4" y="8" width="24" height="7" rx="3" fill="#3f6158"/><circle cx="16" cy="19.5" r="3.2" fill="#d8b766"/><path d="M11 5h10" stroke="#2f4a43" stroke-width="2.4" stroke-linecap="round"/></svg>';

  function build() {
    host = document.createElement('baibaoxia-clip');
    host.style.cssText = 'all: initial; position: absolute; z-index: 2147483647; left: 0; top: 0; display: none;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      button {
        all: unset; box-sizing: border-box; cursor: pointer;
        display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 7px;
        background: #fbfaf6; color: #1d2a27; border: 1px solid #cfd4cb; border-radius: 16px;
        box-shadow: 0 4px 14px -4px rgba(0,0,0,.35);
        font: 13px/1 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
        transition: padding .15s, background .15s;
        animation: pop .16s ease-out;
      }
      button:hover, button:focus-visible { padding: 0 12px 0 8px; background: #fff; border-color: #b8964c; }
      button:focus-visible { outline: 2px solid #2d6fd1; outline-offset: 2px; }
      .t { display: none; white-space: nowrap; }
      button:hover .t, button:focus-visible .t, button.state .t { display: inline; }
      button.state { padding: 0 12px 0 8px; }
      button.ok { background: #2f4a43; color: #f3f1ea; border-color: #2f4a43; }
      button.err { background: #fbe3dc; color: #6b2416; border-color: #e9b3a5; cursor: default; }
      button.busy { cursor: progress; }
      button.busy svg { animation: spin 1s linear infinite; }
      @keyframes pop { from { transform: scale(.6); opacity: 0; } }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style><button type="button" title="存进百宝匣">${ICON}<span class="t">存进百宝匣</span></button>`;
    btn = shadow.querySelector('button');
    label = shadow.querySelector('.t');
    // 按下时不要让网页把选区取消掉
    btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); save(); });
    document.documentElement.appendChild(host);
  }

  function setState(cls, text) {
    btn.className = cls ? 'state ' + cls : '';
    label.textContent = text || '存进百宝匣';
  }

  function hide() {
    clearTimeout(hideTimer);
    if (host && !busy) host.style.display = 'none';
  }

  function inEditable(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]'));
  }

  function showForSelection() {
    if (!enabled || busy) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!sel || sel.isCollapsed || !sel.rangeCount || text.replace(/\s+/g, '').length < MIN_CHARS) return hide();
    if (inEditable(sel.anchorNode) || inEditable(sel.focusNode)) return hide();
    const range = sel.getRangeAt(sel.rangeCount - 1);
    const rects = [...range.getClientRects()].filter(r => r.width || r.height);
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return hide();
    if (!host) build();
    setState('');
    // 放在选区最后一行的右下角，别超出屏幕
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    let x = r.right + 6, y = r.bottom + 6;
    x = Math.min(x, vw - 44); y = Math.min(y, vh - 40);
    x = Math.max(4, x); y = Math.max(4, y);
    host.style.left = (x + window.scrollX) + 'px';
    host.style.top = (y + window.scrollY) + 'px';
    host.style.display = 'block';
  }

  function save() {
    if (busy) return;
    let data;
    try { data = baibaoxiaExtract(true); } catch { data = null; }
    if (!data || !data.markdown) { setState('err', '没读到选中的内容'); hideTimer = setTimeout(hide, 2500); return; }
    busy = true;
    setState('busy', '正在存…');
    try {
      chrome.runtime.sendMessage({ type: 'clipData', data: { ...data, mode: 'excerpt' } }, r => {
        busy = false;
        if (chrome.runtime.lastError || !r) { setState('err', '插件刚更新过，刷新一下这个网页再试'); hideTimer = setTimeout(hide, 4000); return; }
        if (r.ok) {
          setState('ok', r.appended ? '已加到同一篇摘录里' : '已存进百宝匣');
          hideTimer = setTimeout(() => { hide(); }, 1600);
        } else {
          setState('err', r.message || '没存上');
          hideTimer = setTimeout(hide, 4000);
        }
      });
    } catch {
      busy = false;
      setState('err', '插件刚更新过，刷新一下这个网页再试');
      hideTimer = setTimeout(hide, 4000);
    }
  }

  // 松开鼠标 / 用键盘选完之后看一下有没有选中文字
  document.addEventListener('mouseup', e => {
    if (host && e.composedPath().includes(host)) return;
    setTimeout(showForSelection, 10);
  }, true);
  document.addEventListener('keyup', e => {
    if (e.key === 'Escape') return hide();
    if (e.shiftKey || e.key === 'Shift' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) setTimeout(showForSelection, 10);
  }, true);
  document.addEventListener('mousedown', e => {
    if (host && e.composedPath().includes(host)) return;
    hide();
  }, true);
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (host && host.style.display !== 'none' && !busy && (!sel || sel.isCollapsed)) hide();
  });
})();
