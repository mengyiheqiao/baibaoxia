const $ = s => document.querySelector(s);
let tab;

function say(text, cls) { const m = $('#msg'); m.textContent = text; m.className = 'msg ' + (cls || ''); }

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  tab = tabs[0];
  $('#title').textContent = tab ? tab.title : '';
  ping();
});

async function go(selectionOnly) {
  $('#page').disabled = true;
  say('正在保存…（图片多的话要等一会儿）');
  chrome.runtime.sendMessage({ type: 'clip', tabId: tab.id, selectionOnly }, r => {
    $('#page').disabled = false;
    if (r && r.ok) say(`存好了："${r.id}"${r.imagesTotal ? `，图片 ${r.images}/${r.imagesTotal} 张` : ''}`, 'ok');
    else say((r && r.message) || '没存上', 'err');
  });
}
$('#page').addEventListener('click', () => go(false));

// 小图标的开关
let host = '';
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  try { host = new URL(tabs[0].url).hostname; } catch {}
  chrome.storage.local.get({ floatBtn: true, blockedSites: [] }, v => {
    $('#float').checked = v.floatBtn;
    $('#site').checked = !!host && v.blockedSites.includes(host);
    $('#site').disabled = !host || !v.floatBtn;
  });
});
$('#float').addEventListener('change', e => {
  chrome.storage.local.set({ floatBtn: e.target.checked });
  $('#site').disabled = !host || !e.target.checked;
});
$('#site').addEventListener('change', e => {
  chrome.storage.local.get({ blockedSites: [] }, v => {
    const set = new Set(v.blockedSites);
    if (e.target.checked) set.add(host); else set.delete(host);
    chrome.storage.local.set({ blockedSites: [...set] });
  });
});

// 配对
function ping() {
  chrome.runtime.sendMessage({ type: 'ping' }, r => {
    const st = $('#pair-state');
    if (!r || !r.ok) { say('连不上百宝匣，先把百宝匣打开。', 'err'); $('#page').disabled = true; st.textContent = ''; return; }
    $('#page').disabled = false;
    if (!r.paired) { st.textContent = '还没配对：把百宝匣设置里的"浏览器剪藏插件配对码"粘贴到下面。'; st.className = 'tip err'; $('#page').disabled = true; }
    else if (!r.genuine) { st.textContent = '配对码对不上（或连上的不是你自己的百宝匣），请重新粘贴。'; st.className = 'tip err'; $('#page').disabled = true; }
    else { st.textContent = '已配对 ✓'; st.className = 'tip ok'; }
  });
}
$('#pair-save').addEventListener('click', () => {
  const k = $('#pair-key').value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(k)) { $('#pair-state').textContent = '这不像配对码：应该是 64 个字母和数字。'; $('#pair-state').className = 'tip err'; return; }
  chrome.storage.local.set({ pairKey: k }, () => { $('#pair-key').value = ''; ping(); });
});
