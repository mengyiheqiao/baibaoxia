// 百宝匣剪藏：右键菜单 + 发送给百宝匣
const BAIBAO = 'http://127.0.0.1:3456';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'bb-page', title: '把这一页存进百宝匣', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'bb-sel', title: '把选中的内容存进百宝匣', contexts: ['selection'] });
  chrome.storage.local.get({ floatBtn: true }, v => { if (v.floatBtn === undefined) chrome.storage.local.set({ floatBtn: true }); });
});

async function extract(tabId, selectionOnly) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['clip.js'] });
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: s => baibaoxiaExtract(s), args: [selectionOnly] });
  return res && res.result;
}

// 配对码：百宝匣 设置 → 浏览器剪藏插件配对码。同一台电脑上别的账户也可能占着 3456 端口，
// 所以每次发送前先让对方用配对码签一个随机数，签对了才是你自己的百宝匣
const getKey = () => new Promise(r => chrome.storage.local.get({ pairKey: '' }, v => r(v.pairKey || '')));

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 返回 { ok: 连上了, version, genuine: 配对码对得上 }
async function check(key) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const j = await (await fetch(BAIBAO + '/api/ping?nonce=' + nonce)).json();
  const genuine = !!key && typeof j.proof === 'string' && j.proof === await hmacHex(key, 'baibao-proof:' + nonce);
  return { ok: true, version: j.version, genuine };
}

async function send(data) {
  const key = await getKey();
  if (!key) return { ok: false, message: '还没配对：点浏览器右上角的插件图标，粘贴百宝匣设置里的配对码。' };
  if (!(await check(key)).genuine) return { ok: false, message: '配对码对不上，或者连上的不是你自己的百宝匣，没有发送。' };
  const r = await fetch(BAIBAO + '/api/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Baibao': '1', 'X-Baibao-Key': key },
    body: JSON.stringify(data),
  });
  return r.json();
}

async function clip(tabId, selectionOnly) {
  try {
    const data = await extract(tabId, selectionOnly);
    if (!data || !data.markdown) return { ok: false, message: '这个页面没找到正文。' };
    if (selectionOnly) data.mode = 'excerpt';
    return await send(data);
  } catch (e) {
    const m = String(e && e.message || e);
    if (/Failed to fetch|NetworkError/i.test(m)) return { ok: false, message: '连不上百宝匣，先把百宝匣打开。' };
    if (/Cannot access|cannot be scripted|chrome:\/\//i.test(m)) return { ok: false, message: '浏览器自己的页面不能剪藏。' };
    return { ok: false, message: m };
  }
}

function badge(tabId, ok) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2f4a43' : '#c4503a' });
  chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const r = await clip(tab.id, info.menuItemId === 'bb-sel');
  badge(tab.id, r.ok);
});

// 网页上选中文字后点小图标：内容已经在网页里整理好了，这里只负责发给百宝匣
async function sendData(data) {
  try {
    if (!data || !data.markdown) return { ok: false, message: '没读到选中的内容。' };
    return await send(data);
  } catch (e) {
    const m = String(e && e.message || e);
    if (/Failed to fetch|NetworkError/i.test(m)) return { ok: false, message: '连不上百宝匣，先把百宝匣打开' };
    return { ok: false, message: m };
  }
}

// 弹出窗口发来的请求
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'clip') {
    clip(msg.tabId, !!msg.selectionOnly).then(r => { badge(msg.tabId, r.ok); reply(r); });
    return true;
  }
  if (msg && msg.type === 'clipData') {
    sendData(msg.data).then(r => { if (sender.tab) badge(sender.tab.id, r.ok); reply(r); });
    return true;
  }
  if (msg && msg.type === 'ping') {
    getKey().then(key => check(key).then(r => reply({ ...r, paired: !!key }))).catch(() => reply({ ok: false }));
    return true;
  }
  return false;
});
