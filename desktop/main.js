// 百宝匣桌面版：一个独立的窗口 + 右下角托盘 + 全局快捷键。
// 后台还是同一个 server.js，只是跑在这个程序里面，不再需要黑色窗口和浏览器。
'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage, dialog, ipcMain, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const os = require('os');

// ---- 临时模式：在学校、网吧这类别人的电脑上用。数据和浏览器缓存都放进系统临时文件夹，退出时整个删掉
const TEMP_PREFIX = 'baibaoxia-temp-';
const TEMP_DIR = (() => {
  const a = process.argv.find(x => x.startsWith('--baibao-temp='));
  if (!a) return '';
  const d = path.resolve(a.slice('--baibao-temp='.length));
  // 只认系统临时文件夹里、名字对得上的文件夹，免得退出时删错东西
  return path.dirname(d) === path.resolve(os.tmpdir()) && path.basename(d).startsWith(TEMP_PREFIX) ? d : '';
})();
if (TEMP_DIR) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  app.setPath('userData', path.join(TEMP_DIR, '.electron'));
  process.env.BAIBAO_TEMP = '1';
}

// ---- 数据放在哪：打包好的桌面版放在 百宝匣.exe 旁边；开发时就是项目文件夹
const DATA = TEMP_DIR || (process.env.BAIBAO_DESKTOP_DATA ? path.resolve(process.env.BAIBAO_DESKTOP_DATA) : app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'));
process.env.BAIBAO_DATA = DATA;
process.env.BAIBAO_NO_OPEN = '1';
process.env.BAIBAO_DESKTOP = '1';

app.setName('百宝匣');
if (process.platform === 'win32') app.setAppUserModelId('百宝匣');

const ICON = path.join(__dirname, 'icon.png');
const ICON_ICO = path.join(__dirname, 'icon.ico');
const START_HIDDEN = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;
let serverApi = null;
let base = '';
let hiddenTipShown = false;
let relaunching = false;

const DEFAULT_KEYS = { 呼出: 'CommandOrControl+Alt+B', 老板键: 'CommandOrControl+Alt+X', 私密: 'CommandOrControl+Alt+H' };
const KEY_CMD = { 呼出: 'show', 老板键: 'boss', 私密: 'private' };

// ---- 只允许开一个
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

// ---- 给 server.js 用的接口
global.baibaoDesktop = {
  ready() { onServerReady(); },
  fatal(msg) {
    dialog.showErrorBox('百宝匣开不起来', msg);
    quitting = true;
    app.exit(1);
  },
  beforeExit() {
    quitting = true;
    try { globalShortcut.unregisterAll(); } catch {}
    try { if (tray) tray.destroy(); } catch {}
    if (TEMP_DIR) cleanupTempLater(TEMP_DIR);
    if (relaunching) app.exit(0);
  },
  // 装完小更新包：重新打开百宝匣（工具不关）
  relaunch() {
    quitting = true;
    relaunching = true;
    const args = process.argv.slice(1).filter(a => a !== '--hidden');
    app.relaunch({ args });
    try { serverApi.shutdown(false); } catch { app.exit(0); }
  },
  autostartSupported() { return !TEMP_DIR && (process.platform === 'win32' || process.platform === 'darwin'); },
  getAutostart() {
    try { return !!app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; } catch { return false; }
  },
  setAutostart(on) {
    try { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); } catch {}
  },
};

function settings() { try { return serverApi.readSettings(); } catch { return {}; } }
function saveSettings(patch) { try { serverApi.writeSettings(patch); } catch {} }
function desk() { return settings()['桌面'] || {}; }
function saveDesk(patch) { saveSettings({ '桌面': { ...desk(), ...patch } }); }
function keys() { return { ...DEFAULT_KEYS, ...(desk()['快捷键'] || {}) }; }

// ---- 第一次打开桌面版：问一下要不要把网页版的数据搬过来
const DATA_ITEMS = ['tools.json', 'layout.json', 'settings.json', '统计.json', '记忆区', '私密区', '图标', '皮肤', '随身口袋'];

// 自己拷文件夹（不用 fs.cpSync：新版 Node 在 Windows 上碰到中文名字可能出问题）
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dst, n));
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function hideOnWindows(p) {
  if (process.platform !== 'win32' || !fs.existsSync(p)) return;
  try { require('child_process').execFile('attrib', ['+h', p], { windowsHide: true }, () => {}); } catch {}
}

async function offerMigration() {
  if (!app.isPackaged) return;
  if (fs.existsSync(path.join(DATA, 'tools.json')) || fs.existsSync(path.join(DATA, 'settings.json'))) return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '百宝匣',
    message: '第一次打开百宝匣桌面版',
    detail: '以前用过网页版百宝匣吗？可以把那边的说明、资料、工具和设置都搬过来。\n（只是复制一份，原来的文件不会动。）',
    buttons: ['搬过来', '从头开始'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return;
  for (;;) {
    const r = await dialog.showOpenDialog({ title: '选以前的百宝匣文件夹（里面有"启动百宝匣.bat"和"记忆区"的那个）', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return;
    const from = r.filePaths[0];
    if (path.resolve(from) === path.resolve(DATA)) return;
    if (!fs.existsSync(path.join(from, 'tools.json')) && !fs.existsSync(path.join(from, '记忆区'))) {
      const again = await dialog.showMessageBox({ type: 'warning', title: '百宝匣', message: '这个文件夹里没有百宝匣的数据', detail: '要选里面有"记忆区"文件夹和"tools.json"的那个文件夹。', buttons: ['重新选', '算了'], defaultId: 0, cancelId: 1, noLink: true });
      if (again.response !== 0) return;
      continue;
    }
    const failed = [];
    for (const name of DATA_ITEMS) {
      const src = path.join(from, name);
      if (!fs.existsSync(src)) continue;
      try { copyTree(src, path.join(DATA, name)); } catch (e) { failed.push(name + '：' + e.message); }
    }
    hideOnWindows(path.join(DATA, '私密区'));
    // 网页版设过开机自启，就换成桌面版的开机自启
    const vbs = process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '百宝匣.vbs');
    if (vbs && fs.existsSync(vbs)) {
      try { fs.unlinkSync(vbs); } catch {}
      global.baibaoDesktop.setAutostart(true);
    }
    await dialog.showMessageBox({
      type: failed.length ? 'warning' : 'info', title: '百宝匣',
      message: failed.length ? '大部分搬过来了，有几样没搬成' : '搬好了',
      detail: (failed.length ? failed.join('\n') + '\n\n' : '') + '以后就用桌面版吧。原来的网页版文件夹可以留着当备份，确认没问题以后再删。',
      buttons: ['好'], noLink: true,
    });
    return;
  }
}

// ---- 临时模式的收尾：百宝匣自己退出后才能删干净（Windows 上开着的文件删不掉），
// 所以另起一个小进程，等百宝匣完全退出再删
function cleanupTempLater(dir) {
  const script = `
    const fs = require('fs'), path = require('path');
    const dir = ${JSON.stringify(dir)}, pid = ${process.pid};
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    function rm(p) {
      let st; try { st = fs.lstatSync(p); } catch { return; }
      if (st.isDirectory()) { for (const n of fs.readdirSync(p)) rm(path.join(p, n)); try { fs.rmdirSync(p); } catch {} }
      else { try { fs.chmodSync(p, 0o666); } catch {} try { fs.unlinkSync(p); } catch {} }
    }
    let n = 0;
    const tick = () => {
      if (alive() && n++ < 60) return setTimeout(tick, 500);
      for (let i = 0; i < 10 && fs.existsSync(dir); i++) { rm(dir); if (fs.existsSync(dir)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); }
    };
    setTimeout(tick, 300);`;
  try {
    const child = require('child_process').spawn(process.execPath, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch {}
}

// 上次没删干净的临时文件夹（比如直接断电了），这次顺手删掉
function cleanupOldTemps() {
  const t = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(t); } catch { return; }
  for (const n of names) {
    const d = path.join(t, n);
    if (!n.startsWith(TEMP_PREFIX) || d === TEMP_DIR) continue;
    try { require(path.join(__dirname, '..', 'lib', 'fsx.js')).removeTree(d, 1); } catch {}
  }
}

// 第一次在一台电脑上打开（旁边没有数据）：问一下是自己的电脑还是临时用
async function askTempMode() {
  if (TEMP_DIR) return false;
  const fresh = !fs.existsSync(path.join(DATA, 'tools.json')) && !fs.existsSync(path.join(DATA, 'settings.json'));
  if (!fresh || (!app.isPackaged && !process.env.BAIBAO_ASK_TEMP)) return false;
  const { response } = await dialog.showMessageBox({
    type: 'question', title: '百宝匣',
    message: '这是你自己的电脑吗？',
    detail: '自己的电脑：数据存在百宝匣.exe 旁边，一直留着。\n\n别人的电脑（学校机房、网吧、借来的）：用临时模式，连上末影箱就能拿到你的随身口袋；关掉百宝匣后，你的东西、密码、浏览记录都会删干净。',
    buttons: ['我自己的电脑', '临时用一下'],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  if (response !== 1) return false;
  const dir = path.join(os.tmpdir(), TEMP_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  // 临时文件夹要在程序一开始就设好，所以带着它重新打开一次
  const args = process.argv.slice(1).filter(a => a !== '--hidden' && !a.startsWith('--baibao-temp='));
  app.relaunch({ args: [...args, '--baibao-temp=' + dir] });
  app.exit(0);
  return true;
}

async function start() {
  Menu.setApplicationMenu(null);
  cleanupOldTemps();
  try { if (await askTempMode()) return; } catch {}
  if (!TEMP_DIR) { try { await offerMigration(); } catch (e) { dialog.showErrorBox('搬数据出错了', String(e && e.message || e)); } }
  createTray();
  try {
    serverApi = require(path.join(__dirname, '..', 'server.js'));
  } catch (e) {
    dialog.showErrorBox('百宝匣开不起来', String(e && e.stack || e));
    app.exit(1);
  }
}

function onServerReady() {
  base = `http://${serverApi.HOST}:${serverApi.PORT}`;
  registerKeys();
  createWindow();
}

// ---------------------------------------------------------------- 窗口

function savedBounds() {
  const b = desk()['窗口'];
  if (!b || !b.width) return null;
  // 屏幕换了（比如拔了外接显示器），窗口别跑到看不见的地方
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 80;
  });
  return visible ? b : { width: b.width, height: b.height };
}

function createWindow() {
  const b = savedBounds() || { width: 1280, height: 840 };
  win = new BrowserWindow({
    ...b,
    minWidth: 420,
    minHeight: 480,
    title: '百宝匣',
    icon: process.platform === 'win32' ? ICON_ICO : ICON,
    show: false,
    backgroundColor: '#e8ebe4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (desk()['最大化']) win.maximize();
  win.loadURL(base + '/');
  win.once('ready-to-show', () => { if (!START_HIDDEN) { win.show(); win.focus(); } });

  // 记住窗口大小和位置
  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    if (win.isMaximized()) return saveDesk({ 最大化: true });
    saveDesk({ 窗口: win.getBounds(), 最大化: false });
  };
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(remember, 500); };
  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', remember);
  win.on('unmaximize', remember);

  // 点关闭：默认藏到托盘里继续运行
  win.on('close', e => {
    if (quitting) return;
    if (TEMP_DIR || desk()['关窗口'] === 'quit') { e.preventDefault(); quitApp(true); return; }
    e.preventDefault();
    win.hide();
    if (!hiddenTipShown && !desk()['托盘提示过']) {
      hiddenTipShown = true;
      saveDesk({ 托盘提示过: true });
      if (tray && process.platform === 'win32') {
        tray.displayBalloon({ iconType: 'info', title: '百宝匣还在这里', content: `藏到了右下角的托盘里，点图标或按 ${label(keys().呼出)} 就能叫出来。` });
      }
    }
  });

  // 新窗口：同一个百宝匣里的东西（PDF、图片）在百宝匣自己的小窗口里打开；外面的网址交给默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(base + '/')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true } } };
    }
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(base + '/')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('did-create-window', child => {
    child.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(base + '/')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
    });
  });
  // F12 打开开发者工具，F5 / Ctrl+R 刷新，Ctrl+= / Ctrl+- 缩放
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key;
    if (k === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (k === 'F5' || (input.control && k.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
    else if (input.control && (k === '=' || k === '+')) { win.webContents.setZoomLevel(Math.min(5, win.webContents.getZoomLevel() + 0.5)); e.preventDefault(); }
    else if (input.control && k === '-') { win.webContents.setZoomLevel(Math.max(-3, win.webContents.getZoomLevel() - 0.5)); e.preventDefault(); }
    else if (input.control && k === '0' && !input.alt) { win.webContents.setZoomLevel(0); e.preventDefault(); }
  });
  win.webContents.on('render-process-gone', () => { if (!quitting) setTimeout(() => win && !win.isDestroyed() && win.reload(), 800); });
}

function showWindow() {
  if (!win || win.isDestroyed()) { if (base) createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function send(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('baibao:cmd', cmd);
}

// ---------------------------------------------------------------- 托盘

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, process.platform === 'darwin' ? 'tray-16.png' : 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip(TEMP_DIR ? '百宝匣（临时模式）' : '百宝匣');
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const auto = global.baibaoDesktop.getAutostart();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开百宝匣', click: () => showWindow() },
    { label: '截图识字', visible: process.platform === 'win32', click: () => trayOcr() },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: auto, visible: global.baibaoDesktop.autostartSupported(), click: item => { global.baibaoDesktop.setAutostart(item.checked); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: '退出百宝匣', click: () => quitApp(true) },
  ]));
}

function post(pathName, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body || {});
    const req = http.request(base + pathName, { method: 'POST', headers: { 'X-Baibao': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 120000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(data);
  });
}

async function trayOcr() {
  if (!base) return;
  const r = await post('/api/ocr/snip', {});
  if (r && r.ok && r.text) {
    clipboard.writeText(r.text);
    tray.displayBalloon({ iconType: 'info', title: '认出来了，已经复制好', content: r.text.slice(0, 120) });
  } else if (r && r.cancelled) {
    // 没框就算了
  } else {
    tray.displayBalloon({ iconType: 'warning', title: '截图识字', content: (r && r.message) || '没认出文字' });
  }
}

async function quitApp(stopTools) {
  if (quitting) return;
  quitting = true;
  try { globalShortcut.unregisterAll(); } catch {}
  try { await serverApi.shutdown(stopTools); } catch { app.exit(0); }
}

app.on('before-quit', () => { if (!quitting) { quitting = true; try { serverApi && serverApi.shutdown(true); } catch {} } });
app.on('window-all-closed', () => { /* 窗口关了也继续在托盘里 */ });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });

// ---------------------------------------------------------------- 全局快捷键

function label(acc) {
  return String(acc || '').replace('CommandOrControl', 'Ctrl').split('+').join(' + ');
}

function registerKeys() {
  globalShortcut.unregisterAll();
  const k = keys();
  const failed = [];
  for (const [name, acc] of Object.entries(k)) {
    if (!acc) continue;
    let ok = false;
    try { ok = globalShortcut.register(acc, () => onKey(KEY_CMD[name])); } catch { ok = false; }
    if (!ok) failed.push(name);
  }
  return failed;
}

function onKey(cmd) {
  if (cmd === 'show') return toggleWindow();
  if (cmd === 'boss') {
    // 老板键：马上藏起来；在私密区里就顺便锁上
    send('boss');
    if (win && !win.isDestroyed()) win.hide();
    return;
  }
  if (cmd === 'private') {
    showWindow();
    setTimeout(() => send('private'), 60);
  }
}

// 页面里改快捷键、改关窗口方式
ipcMain.handle('baibao:get-desktop', () => ({
  version: serverApi ? serverApi.VERSION : '',
  keys: keys(),
  defaults: DEFAULT_KEYS,
  closeMode: TEMP_DIR || desk()['关窗口'] === 'quit' ? 'quit' : 'tray',
  temp: !!TEMP_DIR,
  dataDir: DATA,
}));

ipcMain.handle('baibao:set-key', (e, name, acc) => {
  if (!DEFAULT_KEYS[name]) return { ok: false, message: '没有这个快捷键。' };
  acc = acc === null ? DEFAULT_KEYS[name] : String(acc || '');
  const cur = keys();
  if (acc && Object.entries(cur).some(([n, a]) => n !== name && a === acc)) return { ok: false, message: '这个组合已经用在别的快捷键上了。' };
  // 先试一下能不能注册
  if (acc) {
    try { globalShortcut.unregister(cur[name]); } catch {}
    let ok = false;
    try { ok = globalShortcut.register(acc, () => onKey(KEY_CMD[name])); } catch { ok = false; }
    if (!ok) { registerKeys(); return { ok: false, message: '这个组合用不了，可能被别的软件占用了，换一个试试。' }; }
  }
  const saved = { ...(desk()['快捷键'] || {}) };
  saved[name] = acc;
  saveDesk({ 快捷键: saved });
  const failed = registerKeys();
  return { ok: !failed.includes(name), keys: keys(), label: label(acc) };
});

ipcMain.handle('baibao:set-close-mode', (e, mode) => {
  saveDesk({ 关窗口: mode === 'quit' ? 'quit' : 'tray' });
  return { ok: true };
});

ipcMain.handle('baibao:open-data-dir', () => { shell.openPath(DATA); return { ok: true }; });

// 从随身口袋拖文件出去：交给系统拖放，拖到桌面、文件夹、QQ、浏览器上传框都行
ipcMain.on('baibao:drag-out', (e, name) => {
  const dir = path.join(DATA, '随身口袋');
  const n = String(name || '');
  const file = path.join(dir, n);
  if (!n || n.startsWith('.') || path.dirname(file) !== dir || !fs.existsSync(file)) return;
  let icon = nativeImage.createFromPath(ICON);
  if (!icon.isEmpty()) icon = icon.resize({ width: 32, height: 32 });
  try { e.sender.startDrag({ file, icon }); } catch {}
});
