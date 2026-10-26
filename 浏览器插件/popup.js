const $ = s => document.querySelector(s);
let tab;

function say(text, cls) { const m = $('#msg'); m.textContent = text; m.className = 'msg ' + (cls || ''); }

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  tab = tabs[0];
  $('#title').textContent = tab ? tab.title : '';
  chrome.runtime.sendMessage({ type: 'ping' }, r => {
    if (!r || !r.ok) { say('连不上百宝匣，先把百宝匣打开。', 'err'); $('#page').disabled = true; }
  });
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
