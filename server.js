// 百宝匣 —— 本地后台
// 只用 Node.js 自带功能，不需要 npm install。
// 运行：node server.js   然后浏览器打开 http://127.0.0.1:3456

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

// CODE：程序文件所在的地方；ROOT：你的数据（记忆区、工具、设置）所在的地方。
// 网页版两个是同一个文件夹；桌面版的数据放在百宝匣.exe 旁边，程序在 resources 里面。
const CODE = __dirname;
const ROOT = process.env.BAIBAO_DATA ? path.resolve(process.env.BAIBAO_DATA) : __dirname;
const DESKTOP = global.baibaoDesktop || null;
const VERSION = '0.15.0';
const PORT = Number(process.env.BAIBAO_PORT) || 3456;
const HOST = '127.0.0.1';
const TOOLS_FILE = path.join(ROOT, 'tools.json');
const MEMORY_DIR = path.join(ROOT, '记忆区');
const FILES_DIR = path.join(MEMORY_DIR, '资料');
const IMAGES_DIR = path.join(MEMORY_DIR, '图片');
const PUBLIC_DIR = path.join(CODE, 'public');
const LAYOUT_FILE = path.join(ROOT, 'layout.json');
const LOG_DIR = path.join(ROOT, '运行记录');
const TRASH_DIR = path.join(MEMORY_DIR, '.回收站');
const IS_WIN = process.platform === 'win32';
const STARTUP_FILE = IS_WIN && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '百宝匣.vbs')
  : '';

// 第一次运行：数据文件夹里还没有工具和记忆区，就从程序自带的默认内容（defaults 文件夹）拷一份
{
  const DEF = path.join(CODE, 'defaults');
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    if (!fs.existsSync(TOOLS_FILE) && fs.existsSync(path.join(DEF, 'tools.json'))) fs.copyFileSync(path.join(DEF, 'tools.json'), TOOLS_FILE);
    const seed = path.join(DEF, '记忆区');
    if (!fs.existsSync(MEMORY_DIR) && fs.existsSync(seed)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      for (const n of fs.readdirSync(seed)) if (/\.md$/i.test(n)) fs.copyFileSync(path.join(seed, n), path.join(MEMORY_DIR, n));
    }
  } catch (e) { console.error('准备数据文件夹失败：', e.message); }
}
for (const d of [MEMORY_DIR, FILES_DIR, IMAGES_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- 栏目

// 普通区的栏目存在"栏目"，私密区的存在"私密栏目"
const LAYOUT_KEY = space => (space === 'private' ? '私密栏目' : '栏目');

function readLayoutFile() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; }
}

function readLayout(space = 'main') {
  const j = readLayoutFile();
  const sections = Array.isArray(j[LAYOUT_KEY(space)]) ? j[LAYOUT_KEY(space)] : [];
  return { sections: sections.filter(s => s && s['名字']).map(s => ({ name: String(s['名字']), icon: s['图标'] || '' })) };
}

function writeLayout(sections, space = 'main') {
  const j = readLayoutFile();
  j[LAYOUT_KEY(space)] = sections.map(s => ({ '名字': s.name, '图标': s.icon || '' }));
  const tmp = LAYOUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, LAYOUT_FILE);
}

function cleanSection(name) {
  return String(name || '').replace(/[\\/"<>]/g, '').trim().slice(0, 20);
}

// ---------------------------------------------------------------- 工具配置

const TYPE_MAP = { '服务': 'service', '网址': 'link', '书签工具': 'bookmarklet', '文件夹': 'folder', '程序': 'program', '内置': 'builtin', '组合': 'combo' };

function readTools() {
  let raw;
  try {
    raw = fs.readFileSync(TOOLS_FILE, 'utf8').replace(/^﻿/, '');
  } catch {
    return { tools: [], error: '找不到 tools.json。把它删干净后重新启动百宝匣，会自动生成一份新的。' };
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    let where = '';
    if (m) {
      const line = raw.slice(0, Number(m[1])).split('\n').length;
      where = `（大约在第 ${line} 行附近）`;
    }
    return { tools: [], error: `tools.json 格式写错了${where}。常见原因：少了逗号、多了逗号、引号是中文引号、路径里用了单个反斜杠。` };
  }
  if (!Array.isArray(list)) return { tools: [], error: 'tools.json 最外层应该是方括号 [ ]。' };
  const seen = new Set();
  const tools = list.map((t, i) => {
    let name = String(t['名字'] || `工具${i + 1}`);
    while (seen.has(name)) name += '_';
    seen.add(name);
    const folder = t['文件夹'] ? path.resolve(ROOT, String(t['文件夹'])) : '';
    const setup = t['缺少时先运行'] || null;
    return {
      id: name,
      name,
      icon: t['图标'] || '◻',
      type: TYPE_MAP[t['类型']] || 'service',
      typeLabel: t['类型'] || '服务',
      folder,
      start: t['启动命令'] || '',
      url: t['网址'] || '',
      health: t['就绪检查'] || t['网址'] || '',
      program: t['程序'] || '',
      waitSeconds: Number(t['最多等待秒数']) || 40,
      setup: setup && setup['缺少'] && setup['运行'] ? { missing: String(setup['缺少']), run: String(setup['运行']) } : null,
      private: !!t['私密'],
      note: t['说明书'] || '',
      desc: t['一句话'] || '',
      section: t['栏目'] ? String(t['栏目']) : '',
      feature: t['功能'] || '',
      index: i,
      raw: t,
    };
  });
  return { tools, error: null };
}

function findTool(id) {
  return readTools().tools.find(t => t.id === id);
}

// ---------------------------------------------------------------- 在页面上增改工具

const TYPE_LABEL = { service: '服务', link: '网址', folder: '文件夹', program: '程序', bookmarklet: '书签工具', builtin: '内置', combo: '组合' };

function readRawList() {
  const { error } = readTools();
  if (error && fs.existsSync(TOOLS_FILE)) throw new Error(error + ' 请先把 tools.json 修好，或者把它删掉重新开始。');
  if (!fs.existsSync(TOOLS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8').replace(/^﻿/, ''));
}

function writeRawList(list) {
  if (fs.existsSync(TOOLS_FILE)) fs.copyFileSync(TOOLS_FILE, TOOLS_FILE + '.bak');
  const tmp = TOOLS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, TOOLS_FILE);
}

// 把表单内容变成 tools.json 里的一项；返回 { raw } 或 { error }
function toolFromForm(f, keep = {}) {
  const s = v => (v === undefined || v === null ? '' : String(v).trim());
  const name = s(f.name).replace(/[\\/]/g, '');
  const type = TYPE_LABEL[f.type] ? f.type : 'link';
  if (!name) return { error: '请填写名字。' };
  const raw = { ...keep };
  for (const k of ['名字', '图标', '类型', '一句话', '文件夹', '启动命令', '网址', '就绪检查', '缺少时先运行', '程序', '私密', '说明书', '栏目', '步骤']) delete raw[k];
  // 换成别的类型时，GitHub 来源也一起去掉
  if (type !== 'service') { delete raw['来源']; delete raw['版本']; }
  raw['名字'] = name;
  raw['图标'] = s(f.icon) || '📦';
  raw['类型'] = TYPE_LABEL[type];
  if (s(f.desc)) raw['一句话'] = s(f.desc);

  const fixUrl = u => (u && !/^[a-z]+:\/\//i.test(u) ? 'http://' + u : u);
  if (type === 'link') {
    const url = fixUrl(s(f.url));
    if (!url) return { error: '请填写网址。' };
    raw['网址'] = url;
  }
  if (type === 'folder') {
    if (!s(f.folder)) return { error: '请填写文件夹位置。' };
    raw['文件夹'] = s(f.folder).replace(/^"|"$/g, '');
  }
  if (type === 'program') {
    if (!s(f.program)) return { error: '请填写程序位置。' };
    raw['程序'] = s(f.program).replace(/^"|"$/g, '');
  }
  if (type === 'service') {
    if (!s(f.folder)) return { error: '请填写项目文件夹。' };
    if (!s(f.start)) return { error: '请填写启动命令（可以先点"自动识别"）。' };
    if (!s(f.url)) return { error: '请填写启动后要打开的网址（可以先点"自动识别"）。' };
    raw['文件夹'] = s(f.folder).replace(/^"|"$/g, '');
    raw['启动命令'] = s(f.start);
    raw['网址'] = fixUrl(s(f.url));
    if (s(f.health)) raw['就绪检查'] = fixUrl(s(f.health));
    if (s(f.setupMissing) && s(f.setupRun)) raw['缺少时先运行'] = { '缺少': s(f.setupMissing), '运行': s(f.setupRun) };
    // 从 GitHub 收编来的，记下来源和版本，以后可以检查更新
    if (s(f.source)) raw['来源'] = s(f.source);
    if (s(f.version)) raw['版本'] = s(f.version);
  }
  if (type === 'combo') {
    const steps = (Array.isArray(f.steps) ? f.steps : []).map(st => {
      if (st.kind === 'wait') return { '类型': '等待', '秒': Math.min(120, Math.max(1, Number(st.seconds) || 3)) };
      if (st.kind === 'url') return s(st.url) ? { '类型': '网址', '网址': s(st.url) } : null;
      return s(st.name) ? { '类型': '工具', '名字': s(st.name) } : null;
    }).filter(Boolean);
    if (!steps.length) return { error: '组合里至少要有一个步骤。' };
    if (steps.some(st => st['名字'] === name)) return { error: '组合不能包含它自己。' };
    raw['步骤'] = steps;
  }
  raw['私密'] = !!f.private;
  if (s(f.note)) raw['说明书'] = s(f.note);
  const sec = cleanSection(f.section);
  // 栏目要属于工具所在的那个区；换了区就回到未分类
  if (sec && readLayout(raw['私密'] ? 'private' : 'main').sections.some(x => x.name === sec)) raw['栏目'] = sec;
  return { raw };
}

function createToolNote(raw) {
  const name = cleanName(raw['名字']);
  const file = path.join(spaceDirs(raw['私密'] ? 'private' : 'main').root, name + '.md');
  if (fs.existsSync(file)) return name;
  const lines = [`# ${name}`, `标签: ${name}, ${raw['类型']}`, '', '## 速查', `- 百宝匣工具区点"${name}"抽屉即可打开`];
  if (raw['类型'] === '服务') {
    lines.push(`- 手动启动：在 \`${raw['文件夹']}\` 里运行 \`${raw['启动命令']}\`，然后打开 ${raw['网址']}`);
    if (raw['缺少时先运行']) lines.push(`- 第一次或更新后：先运行 \`${raw['缺少时先运行']['运行']}\``);
  } else if (raw['网址']) {
    lines.push(`- 网址：${raw['网址']}`);
  } else if (raw['文件夹']) {
    lines.push(`- 位置：\`${raw['文件夹']}\``);
  } else if (raw['程序']) {
    lines.push(`- 程序位置：\`${raw['程序']}\``);
  }
  lines.push('', '## 详细', '', '（项目来源、怎么用、踩过的坑写在这里）', '');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return name;
}

// 看一眼项目文件夹，猜它怎么启动、开在哪个端口
function detectProject(folderIn) {
  const folder = path.resolve(ROOT, String(folderIn || '').trim().replace(/^"|"$/g, ''));
  if (!folderIn || !fs.existsSync(folder)) return { ok: false, message: `找不到这个文件夹：${folderIn || '（空）'}` };
  if (!fs.statSync(folder).isDirectory()) {
    if (/\.(exe|bat|cmd|lnk)$/i.test(folder)) return { ok: true, type: 'program', name: path.parse(folder).name, hints: ['这是一个程序文件，已经帮你切换成"程序"类型。'] };
    return { ok: false, message: '这是一个文件，不是文件夹。' };
  }
  const has = f => fs.existsSync(path.join(folder, f));
  const read = f => { try { return fs.readFileSync(path.join(folder, f), 'utf8').slice(0, 200000); } catch { return ''; } };
  const out = { ok: true, type: 'service', name: path.basename(folder), start: '', url: '', health: '', setupMissing: '', setupRun: '', hints: [] };
  let mainFiles = [];

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(read('package.json')); } catch {}
    if (pkg.scripts && pkg.scripts.start) {
      // "node xxx.js" 这种直接用，少绕一层 npm
      out.start = /^node\s+[\w./-]+$/.test(pkg.scripts.start.trim()) ? pkg.scripts.start.trim() : 'npm start';
      out.hints.push(`找到 package.json，启动脚本是"${pkg.scripts.start}"。`);
    } else if (pkg.scripts && pkg.scripts.dev) {
      out.start = 'npm run dev';
      out.hints.push(`找到 package.json，用开发模式启动"${pkg.scripts.dev}"。`);
    }
    const main = pkg.main && has(pkg.main) ? pkg.main : ['server.js', 'index.js', 'app.js', 'main.js'].find(has);
    if (!out.start && main) out.start = `node ${main}`;
    if (main) mainFiles.push(main);
    const deps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
    if (deps) { out.setupMissing = 'node_modules'; out.setupRun = 'npm install'; }
  } else if (['app.py', 'main.py', 'server.py', 'manage.py'].some(has)) {
    const f = ['manage.py', 'app.py', 'main.py', 'server.py'].find(has);
    out.start = f === 'manage.py' ? 'python manage.py runserver' : `python ${f}`;
    mainFiles.push(f);
    if (f === 'manage.py') out.url = 'http://127.0.0.1:8000';
    if (has('requirements.txt')) out.hints.push('这是 Python 项目。第一次用之前可能要在项目文件夹运行一次 pip install -r requirements.txt。');
  } else if (['docker-compose.yml', 'compose.yml', 'docker-compose.yaml'].some(has)) {
    out.start = 'docker compose up';
    out.hints.push('这个项目用 Docker 启动，需要先打开 Docker Desktop。');
  } else if (has('index.html')) {
    out.start = 'npx --yes serve -l 5000 .';
    out.url = 'http://127.0.0.1:5000';
    out.hints.push('这是一个静态网页，用一个临时小服务器打开它。');
  }

  // 找端口
  if (!out.url) {
    const sources = [...mainFiles, '.env.example', '.env', 'README.md', 'readme.md', 'vite.config.js', 'vite.config.ts']
      .filter(has).map(read);
    const pats = [
      /PORT['"]?\)?\s*(?:\|\||\?\?|=|:|,)\s*['"]?(\d{4,5})/i,
      /\.listen\(\s*(\d{4,5})/,
      /(?:127\.0\.0\.1|localhost):(\d{4,5})/,
      /port\s*[:=]\s*(\d{4,5})/i,
    ];
    let port = '';
    for (const src of sources) {
      for (const p of pats) { const m = p.exec(src); if (m) { port = m[1]; break; } }
      if (port) break;
    }
    if (port) out.url = `http://127.0.0.1:${port}`;
    else if (out.start.startsWith('npm run dev')) out.url = 'http://127.0.0.1:5173';
    else if (out.start) out.hints.push('没找到端口号，请手动填网址（通常在项目 README 里写着）。');
  }
  // 健康检查地址
  if (out.url) {
    const all = mainFiles.map(read).join('\n') + read('README.md');
    if (/['"`]\/healthz['"`]|\/healthz\b/.test(all)) out.health = out.url + '/healthz';
  }
  if (!out.start) out.hints.push('没认出这是什么项目，请手动填启动命令。');
  return out;
}

// ---------------------------------------------------------------- 进程管理

const procs = new Map();      // id -> { child, startedAt }
const lastError = new Map();  // id -> { message, fix }
const busy = new Map();       // id -> '启动中' | '安装中'

// 运行记录写进文件，这样百宝匣关掉后工具还能继续跑
function logFile(id) {
  return path.join(LOG_DIR, (cleanName(id) || 'tool') + '.log');
}

function appendLog(id, text) {
  try { fs.appendFileSync(logFile(id), text); } catch {}
}

function logSize(id) {
  try { return fs.statSync(logFile(id)).size; } catch { return 0; }
}

// 读运行记录：from 给定时只读这之后的部分，否则读最后 64KB
function readLogBuf(id, from) {
  try {
    const fd = fs.openSync(logFile(id), 'r');
    const size = fs.fstatSync(fd).size;
    const start = from !== undefined ? Math.min(from, size) : Math.max(0, size - 65536);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf;
  } catch { return Buffer.alloc(0); }
}

function decode(buf) {
  let start = 0;
  while (start < buf.length && start < 4 && (buf[start] & 0xc0) === 0x80) start++;
  const b = buf.subarray(start);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    try { return new TextDecoder('gbk').decode(b); } catch { return b.toString('utf8'); }
  }
}

function logText(id, from) {
  return decode(readLogBuf(id, from));
}

function runShell(cmd, cwd, id) {
  // 记录太大就清空重来
  try { if (fs.statSync(logFile(id)).size > 2 * 1024 * 1024) fs.writeFileSync(logFile(id), ''); } catch {}
  const fd = fs.openSync(logFile(id), 'a');
  const child = spawn(cmd, {
    cwd,
    shell: true,
    windowsHide: true,
    detached: true,              // 独立运行：关掉百宝匣时可以选择让它继续跑
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  fs.closeSync(fd);
  return child;
}

function killTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (IS_WIN) {
      exec(`taskkill /pid ${pid} /T /F`, () => resolve());
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
      setTimeout(resolve, 300);
    }
  });
}

function portOf(url) {
  try {
    const u = new URL(url);
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch { return 0; }
}

// 找出占用某个端口的进程（Windows 用 netstat，其他系统用 lsof）
function pidsOnPort(port) {
  return new Promise(resolve => {
    if (!port) return resolve([]);
    const cmd = IS_WIN ? 'netstat -ano -p tcp' : `lsof -t -iTCP:${port} -sTCP:LISTEN`;
    exec(cmd, { windowsHide: true }, (err, out) => {
      if (err && !out) return resolve([]);
      const pids = new Set();
      if (IS_WIN) {
        for (const line of String(out).split(/\r?\n/)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 5 && /LISTEN/i.test(cols[3]) && cols[1].endsWith(':' + port)) pids.add(Number(cols[4]));
        }
      } else {
        for (const s of String(out).split(/\s+/)) if (/^\d+$/.test(s)) pids.add(Number(s));
      }
      pids.delete(process.pid);
      pids.delete(0);
      resolve([...pids]);
    });
  });
}

function checkUrl(url, timeoutMs = 1500) {
  return new Promise(resolve => {
    if (!url) return resolve(false);
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, res => {
        res.resume();
        resolve(res.statusCode < 500);
      });
    } catch { return resolve(false); }
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function openInSystem(target) {
  const cmd = IS_WIN ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

function openFolder(dir) {
  const cmd = IS_WIN ? `explorer "${dir}"`
    : process.platform === 'darwin' ? `open "${dir}"` : `xdg-open "${dir}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

// 把常见报错翻译成人话
function diagnose(tool, log) {
  let m;
  if ((m = /Cannot find module '([^']+)'/.exec(log)) || /MODULE_NOT_FOUND/.test(log)) {
    const mod = m ? m[1] : '';
    const canInstall = tool.setup || fs.existsSync(path.join(tool.folder, 'package.json'));
    return {
      message: `缺少零件${mod ? ` ${mod}` : ''}。通常是项目更新后需要重新安装一次。`,
      fix: canInstall ? { kind: 'install', label: '自动安装零件并重试' } : null,
    };
  }
  if (/EADDRINUSE|address already in use|通常每个套接字地址/.test(log)) {
    return {
      message: '端口被别的程序占用了。可能是它已经在另一个窗口里运行。',
      fix: { kind: 'freeport', label: '关掉占用端口的程序并重试' },
    };
  }
  if ((m = /'([^']+)' 不是内部或外部命令/.exec(log)) || (m = /'([^']+)' is not recognized/.exec(log)) || (m = /(\S+): (?:command )?not found/.exec(log))) {
    const cmd = m[1];
    const hint = /^node|npm/.test(cmd) ? '需要安装 Node.js（nodejs.org 下载 LTS 版）。'
      : /^py/.test(cmd) ? '需要安装 Python（python.org）。' : '请确认这个程序已经安装。';
    return { message: `电脑找不到命令 ${cmd}。${hint}`, fix: null };
  }
  return null;
}

async function runSetup(tool) {
  busy.set(tool.id, '安装中');
  appendLog(tool.id, `\n[百宝匣] 正在运行：${tool.setup ? tool.setup.run : 'npm install'}\n`);
  tool.setupLogFrom = logSize(tool.id);
  const code = await new Promise(resolve => {
    const child = runShell(tool.setup ? tool.setup.run : 'npm install', tool.folder, tool.id);
    child.on('exit', c => resolve(c));
    child.on('error', () => resolve(-1));
  });
  busy.delete(tool.id);
  return code === 0;
}

async function launchService(tool, { forceSetup = false } = {}) {
  lastError.delete(tool.id);

  // 已经开着了：直接打开网页
  if (await checkUrl(tool.health)) {
    if (tool.url) openInSystem(tool.url);
    return { ok: true, state: 'opened' };
  }
  if (!tool.folder || !fs.existsSync(tool.folder)) {
    return fail(tool, { message: `找不到文件夹：${tool.folder || '（没有填写）'}。可能是文件夹被移动、改名或删掉了：点抽屉右上角 ⋯ →“修改这个工具”，重新填一下文件夹位置。`, fix: null });
  }
  if (!tool.start) {
    return fail(tool, { message: '没有填写"启动命令"：点抽屉右上角 ⋯ →“修改这个工具”补上。', fix: null });
  }

  // 缺少某个文件夹时先安装
  if (forceSetup || (tool.setup && !fs.existsSync(path.join(tool.folder, tool.setup.missing)))) {
    const ok = await runSetup(tool);
    if (!ok) {
      return fail(tool, diagnose(tool, logText(tool.id, tool.setupLogFrom)) || { message: '安装零件失败了。打开"运行记录"看看具体报错。', fix: null });
    }
  }

  busy.set(tool.id, '启动中');
  appendLog(tool.id, `\n[百宝匣] ${new Date().toLocaleString('zh-CN')} 启动：${tool.start}\n`);
  const logFrom = logSize(tool.id);
  const child = runShell(tool.start, tool.folder, tool.id);
  const entry = { child, startedAt: Date.now(), exited: false, code: null };
  procs.set(tool.id, entry);
  child.on('exit', code => {
    entry.exited = true;
    entry.code = code;
    if (procs.get(tool.id) === entry) procs.delete(tool.id);
  });
  child.on('error', () => { entry.exited = true; });

  const deadline = Date.now() + tool.waitSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (entry.exited) {
      busy.delete(tool.id);
      const log = logText(tool.id, logFrom);
      return fail(tool, diagnose(tool, log) || { message: `程序启动后马上退出了（退出码 ${entry.code}）。打开"运行记录"看看具体报错。`, fix: null });
    }
    if (!tool.health) {
      if (Date.now() - entry.startedAt > 1500) break;
      continue;
    }
    if (await checkUrl(tool.health)) {
      busy.delete(tool.id);
      if (tool.url) openInSystem(tool.url);
      return { ok: true, state: 'started' };
    }
  }
  busy.delete(tool.id);
  if (!tool.health) return { ok: true, state: 'started' };
  return fail(tool, { message: `等了 ${tool.waitSeconds} 秒还没准备好。可以再等一会儿点一次，或打开"运行记录"看看。`, fix: null });
}

function fail(tool, err) {
  lastError.set(tool.id, err);
  return { ok: false, ...err };
}

async function stopTool(tool) {
  const entry = procs.get(tool.id);
  if (entry) {
    await killTree(entry.child.pid);
    procs.delete(tool.id);
  }
  // 不是百宝匣开的，也按端口关掉（只针对本机的服务型工具）
  if (tool.type === 'service' && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(tool.health) && await checkUrl(tool.health)) {
    for (const pid of await pidsOnPort(portOf(tool.health))) await killTree(pid);
  }
  lastError.delete(tool.id);
  appendLog(tool.id, `\n[百宝匣] ${new Date().toLocaleString('zh-CN')} 已停止\n`);
  return { ok: true };
}

async function launch(tool, req) {
  switch (tool.type) {
    case 'combo': return launchCombo(tool, req);
    case 'service': return launchService(tool);
    case 'link':
      if (!tool.url) return { ok: false, message: '没有填写"网址"。' };
      openInSystem(tool.url);
      return { ok: true, state: 'opened' };
    case 'folder':
      if (!tool.folder || !fs.existsSync(tool.folder)) return { ok: false, message: `找不到文件夹：${tool.folder}` };
      openFolder(tool.folder);
      return { ok: true, state: 'opened' };
    case 'program': {
      const p = tool.program ? path.resolve(ROOT, tool.program) : '';
      if (!p || !fs.existsSync(p)) return { ok: false, message: `找不到程序：${p || '（没有填写）'}` };
      openInSystem(p);
      return { ok: true, state: 'opened' };
    }
    case 'bookmarklet':
      return { ok: true, state: 'panel' };
    case 'builtin':
      return { ok: true, state: 'builtin', feature: tool.feature };
    default:
      return { ok: false, message: '不认识的类型' };
  }
}

async function statusAll() {
  const { tools, error } = readTools();
  const out = await Promise.all(tools.map(async t => {
    let state = 'idle';
    if (t.type === 'service') {
      if (busy.has(t.id)) state = 'busy';
      else if (await checkUrl(t.health, 800)) state = 'running';
      else if (procs.has(t.id) && !t.health) state = 'running';
      else if (lastError.has(t.id)) state = 'error';
    }
    return { id: t.id, state, busy: busy.get(t.id) || null, error: lastError.get(t.id) || null, mine: procs.has(t.id) };
  }));
  return { status: out, error };
}

// ---------------------------------------------------------------- 记忆区（普通区和私密区各一套）

const docs = require('./lib/docs.js');
const PRIVATE_DIR = path.join(ROOT, '私密区');

function spaceDirs(space) {
  const root = space === 'private' ? PRIVATE_DIR : MEMORY_DIR;
  const d = {
    space: space === 'private' ? 'private' : 'main',
    root,
    files: path.join(root, '资料'),
    images: path.join(root, '图片'),
    trash: path.join(root, '.回收站'),
    index: path.join(root, '.索引'),
    url: space === 'private' ? '/私密区/' : '/记忆区/',
  };
  const fresh = d.space === 'private' && !fs.existsSync(root);
  for (const k of ['root', 'files', 'images']) fs.mkdirSync(d[k], { recursive: true });
  if (d.space === 'private') preparePrivate(d, fresh);
  return d;
}

// 私密区文件夹：Windows 上设成隐藏；第一次进来时放一篇说明
let privatePrepared = false;
function preparePrivate(d, fresh) {
  if (privatePrepared && !fresh) return;
  privatePrepared = true;
  if (IS_WIN) exec(`attrib +h "${d.root}"`, { windowsHide: true }, () => {});
  try {
    const s = readSettings();
    if (s['私密说明已放']) return;
    const note = path.join(d.root, '私密区使用说明.md');
    if (!fs.existsSync(note)) {
      fs.writeFileSync(note, [
        '# 私密区使用说明',
        '标签: 私密区, 怎么用',
        '',
        '## 速查',
        '- 进来、出去：按 Ctrl+Alt+H；或者点右上角"锁上离开"',
        '- 30 分钟不用会自动锁上',
        '- 改密码、把普通区的工具搬进来：右上角齿轮',
        '- 普通区的页面、设置、使用说明里都不会出现私密区',
        '',
        '## 详细',
        '',
        '私密区有自己的工具、栏目、说明、资料和回收站，和普通区完全分开，普通区里搜不到这里的东西。',
        '',
        '- 在这里加的工具、写的说明、拖进来的资料都只在私密区',
        '- 修改这里的工具时取消"放在私密区"，就会搬回普通区',
        '- 忘了密码：用记事本打开百宝匣文件夹里的 settings.json，删掉"私密密码"那一段，保存后重启百宝匣，再按 Ctrl+Alt+H 重新设',
        '- 文件放在百宝匣文件夹里的"私密区"文件夹（Windows 上是隐藏的），备份时也会一起备份',
        '- 密码防的是别人在页面上看到，文件本身是普通文件',
        '- 这里的东西默认不会发给 AI，也不记使用统计；想让"问问"里的管家帮你翻这里的资料，在设置 → 这边的管家里打开',
        '',
      ].join('\n'), 'utf8');
    }
    writeSettings({ '私密说明已放': true });
  } catch {}
}

function safeJoin(base, name) {
  const p = path.resolve(base, name);
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

function cleanName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/^\.+/, '').trim().slice(0, 80);
}

function parseNote(file, text) {
  const lines = text.split(/\r?\n/);
  const h = lines.find(l => /^#\s+/.test(l));
  const title = h ? h.replace(/^#\s+/, '').trim() : file.replace(/\.md$/i, '');
  const tagLine = lines.find(l => /^(标签|tags)\s*[:：]/i.test(l));
  const tags = tagLine ? tagLine.replace(/^(标签|tags)\s*[:：]/i, '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean) : [];
  return { title, tags };
}

function listNotes(d) {
  const files = fs.readdirSync(d.root).filter(f => /\.md$/i.test(f));
  return files.map(f => {
    const full = path.join(d.root, f);
    try {
      const text = fs.readFileSync(full, 'utf8');
      const st = fs.statSync(full);
      return { id: f.replace(/\.md$/i, ''), ...parseNote(f, text), updated: st.mtimeMs, text };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updated - a.updated);
}

function listFiles(d) {
  return fs.readdirSync(d.files).filter(f => !f.startsWith('.')).map(f => {
    const st = safeStat(path.join(d.files, f));
    if (!st || !st.isFile()) return null;
    const ix = indexState(d, f, st);
    return { name: f, size: st.size, updated: st.mtimeMs, indexed: ix };
  }).filter(Boolean).sort((a, b) => b.updated - a.updated);
}

// ---- 资料内容索引：PDF 每页、EPUB 每章、文本文件的文字存成 .索引/文件名.json

const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|webp)$/i;
// 能读出文字来搜索的：PDF、电子书、Word/Excel/PPT、文本；Windows 上图片也能截图识字
const INDEXABLE = IS_WIN ? /\.(pdf|epub|docx|xlsx|pptx|txt|md|markdown|csv|log|json|png|jpe?g|bmp|gif|webp)$/i : /\.(pdf|epub|docx|xlsx|pptx|txt|md|markdown|csv|log|json)$/i;
const office = require('./lib/office.js');
const indexQueue = [];
let indexRunning = false;
const indexCache = new Map(); // 索引文件路径 -> { mtime, data }

function indexPath(d, name) {
  return path.join(d.index, name + '.json');
}

// 'done' 已建好 | 'pending' 排队中 | 'failed' 读不出来 | 'none' 不支持的类型
function indexState(d, name, st) {
  if (!INDEXABLE.test(name)) return 'none';
  try {
    const j = readIndex(d, name);
    if (j && j.size === st.size && Math.abs(j.mtime - st.mtimeMs) < 2000) return j.failed ? (IMAGE_EXT.test(name) ? 'none' : 'failed') : 'done';
  } catch {}
  return 'pending';
}

function readIndex(d, name) {
  const p = indexPath(d, name);
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  const c = indexCache.get(p);
  if (c && c.mtime === st.mtimeMs) return c.data;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  indexCache.set(p, { mtime: st.mtimeMs, data });
  return data;
}

function queueIndex(d) {
  for (const f of fs.readdirSync(d.files)) {
    if (f.startsWith('.') || !INDEXABLE.test(f)) continue;
    let st;
    try { st = fs.statSync(path.join(d.files, f)); } catch { continue; }
    if (indexState(d, f, st) !== 'pending') continue;
    if (!indexQueue.some(q => q.d.root === d.root && q.name === f)) indexQueue.push({ d, name: f });
  }
  // 清掉已经没有对应文件的索引
  try {
    for (const j of fs.readdirSync(d.index)) {
      if (!fs.existsSync(path.join(d.files, j.replace(/\.json$/, '')))) fs.unlinkSync(path.join(d.index, j));
    }
  } catch {}
  runIndexQueue();
}

async function runIndexQueue() {
  if (indexRunning) return;
  indexRunning = true;
  while (indexQueue.length) {
    const { d, name } = indexQueue.shift();
    const file = path.join(d.files, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let parts = null, failed = false;
    try {
      if (IMAGE_EXT.test(name)) {
        // 图片：用 Windows 自带的识字认一下里面的字
        while (ocrBusy) await new Promise(r => setTimeout(r, 1000));
        ocrBusy = true;
        let r;
        try { r = await runOcr(['-Mode', 'image', '-Image', file]); } finally { ocrBusy = false; }
        if (r && r.ok && r.text) parts = [{ label: '图片里的字', text: r.text }];
        else failed = true;
      } else {
        parts = await docs.extractParts(file);
      }
    } catch (e) {
      failed = true;
    }
    if (!parts && !failed) continue;
    // 只扫描、没有文字的 PDF（扫描件）也记一下，免得每次重扫
    const data = { size: st.size, mtime: st.mtimeMs, failed, parts: (parts || []).map(p => ({ label: p.label, page: p.page, chapter: p.chapter, para: p.para, sheet: p.sheet, text: p.text })) };
    try {
      fs.mkdirSync(d.index, { recursive: true });
      fs.writeFileSync(indexPath(d, name), JSON.stringify(data), 'utf8');
    } catch {}
    await new Promise(r => setImmediate(r));
  }
  indexRunning = false;
}

function makeSnippet(text, word) {
  const plain = text.replace(/\s+/g, ' ');
  const j = plain.toLowerCase().indexOf(word);
  if (j < 0) return plain.slice(0, 80);
  return (j > 30 ? '…' : '') + plain.slice(Math.max(0, j - 30), j + 60) + (j + 60 < plain.length ? '…' : '');
}

function search(q, d) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { notes: [], files: { byName: [], byContent: [] } };
  const notes = [];
  for (const n of listNotes(d)) {
    const title = n.title.toLowerCase();
    const tags = n.tags.join(' ').toLowerCase();
    const body = n.text.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      const s = (title.includes(w) ? 10 : 0) + (tags.includes(w) ? 5 : 0) + (body.includes(w) ? 1 : 0);
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    // 摘要：去掉标题行、标签行和 Markdown 符号
    const plain = n.text.split(/\r?\n/)
      .filter(l => !/^#\s+/.test(l) && !/^(标签|tags)\s*[:：]/i.test(l))
      .join(' ').replace(/[#`*>|]+/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
    notes.push({ id: n.id, title: n.title, tags: n.tags, snippet: makeSnippet(plain, words[0]), score });
  }
  notes.sort((a, b) => b.score - a.score);

  const all = listFiles(d);
  const byName = all.filter(f => words.every(w => f.name.toLowerCase().includes(w)));
  const byContent = [];
  for (const f of all) {
    if (f.indexed !== 'done') continue;
    let ix;
    try { ix = readIndex(d, f.name); } catch { continue; }
    if (!ix || !ix.parts) continue;
    const hits = [];
    let total = 0;
    for (const part of ix.parts) {
      const t = part.text.toLowerCase();
      if (!words.every(w => t.includes(w))) continue;
      total++;
      if (hits.length < 5) hits.push({ label: part.label, page: part.page, chapter: part.chapter, para: part.para, sheet: part.sheet, snippet: makeSnippet(part.text, words[0]) });
    }
    if (total) byContent.push({ name: f.name, size: f.size, total, hits });
  }
  byContent.sort((a, b) => b.total - a.total);
  const pending = all.filter(f => f.indexed === 'pending').length;
  return { notes, files: { byName, byContent, pending } };
}

// ---- 活页：记忆区最上面那一叠带标签的活页，用来整理说明和资料
// 存在每个区自己的 .活页.json 里：{ pages: [{ id, name, color }], items: { "note:说明名": 活页id, "file:文件名": 活页id } }
const PAGE_COLORS = 9;
function binderFile(d) { return path.join(d.root, '.活页.json'); }
function readBinder(d) {
  try {
    const j = JSON.parse(fs.readFileSync(binderFile(d), 'utf8'));
    return { pages: Array.isArray(j.pages) ? j.pages : [], items: j.items && typeof j.items === 'object' ? j.items : {}, top: j.top && typeof j.top === 'object' ? j.top : {} };
  } catch { return { pages: [], items: {}, top: {} }; }
}
function writeBinder(d, b) {
  const f = binderFile(d);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 1), 'utf8');
  fs.renameSync(tmp, f);
}
const binderKey = (kind, id) => kind + ':' + id;
// 网址里的括号也要转义，不然 Markdown 的图片链接会断
const encUrl = s => encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29');
function binderPut(d, kind, id, pageId) {
  const b = readBinder(d);
  const k = binderKey(kind, id);
  if (pageId && b.pages.some(p => p.id === pageId)) b.items[k] = pageId;
  else delete b.items[k];
  writeBinder(d, b);
}
function binderRename(d, kind, oldId, newId) {
  if (oldId === newId) return;
  const b = readBinder(d);
  const k = binderKey(kind, oldId);
  if (!b.items[k]) return;
  b.items[binderKey(kind, newId)] = b.items[k];
  delete b.items[k];
  writeBinder(d, b);
}
function binderView(d) {
  const b = readBinder(d);
  const notes = new Set(listNotes(d).map(n => n.id));
  const files = new Set(listFiles(d).map(f => f.name));
  const exists = k => k.startsWith('note:') ? notes.has(k.slice(5)) : k.startsWith('file:') ? files.has(k.slice(5)) : false;
  const count = {};
  const items = {};
  const top = {};
  for (const [k, pid] of Object.entries(b.items)) {
    if (!exists(k)) continue;
    items[k] = pid;
    count[pid] = (count[pid] || 0) + 1;
    if (b.top[k]) top[k] = b.top[k];
  }
  return { pages: b.pages.map(p => ({ ...p, count: count[p.id] || 0 })), items, top };
}
function pageByName(d, name) {
  return readBinder(d).pages.find(p => p.name === name) || null;
}

// ---- 回收站

// ---- 删文件（Windows 上最容易出问题的地方）
// 百宝匣自己开着的文件先放开；只读的先去掉只读；被占用就多试几次；
// 还是删不掉，就先挪进看不见的".待删除"文件夹，以后自动再删
const openStreams = new Map();
function trackStream(file, stream) {
  const key = path.resolve(file);
  if (!openStreams.has(key)) openStreams.set(key, new Set());
  const set = openStreams.get(key);
  set.add(stream);
  stream.on('close', () => { set.delete(stream); if (!set.size) openStreams.delete(key); });
}
function releaseHandles(target) {
  const t = path.resolve(target);
  for (const [file, set] of openStreams) {
    if (file === t || file.startsWith(t + path.sep)) for (const st of set) { try { st.destroy(); } catch {} }
  }
  for (const k of [...epubCache.keys()]) if (k === t || k.startsWith(t + path.sep)) epubCache.delete(k);
}
function makeWritable(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) makeWritable(path.join(p, n));
    fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
  } catch {}
}
const fsx = require('./lib/fsx.js');
const sleepMs = fsx.sleepMs;
const LATER_DIR = '.待删除';
function hardDelete(target, d) {
  releaseHandles(target);
  makeWritable(target);
  let err = null;
  for (let i = 0; i < 2; i++) {
    try { fsx.removeTree(target); } catch (e) { err = e; }
    if (!fs.existsSync(target)) return { ok: true };
    sleepMs(150);
  }
  // 挪到看不见的地方，过一会儿再删
  try {
    const later = path.join(d.root, LATER_DIR);
    fs.mkdirSync(later, { recursive: true });
    fs.renameSync(target, path.join(later, Date.now().toString(36) + '-' + path.basename(target)));
    setTimeout(cleanLater, 60 * 1000).unref();
    return { ok: true, later: true };
  } catch (e) {
    const code = (err && err.code) || e.code || '';
    logCrash(`删不掉 ${target}：${code} ${(err || e).message}`);
    return { ok: false, code };
  }
}
function cleanLater() {
  for (const root of [MEMORY_DIR, PRIVATE_DIR]) {
    const later = path.join(root, LATER_DIR);
    if (!fs.existsSync(later)) continue;
    let names = [];
    try { names = fs.readdirSync(later); } catch { continue; }
    for (const n of names) {
      const f = path.join(later, n);
      makeWritable(f);
      try { fsx.removeTree(f, 1); } catch {}
    }
    try { if (!fs.readdirSync(later).length) fs.rmdirSync(later); } catch {}
  }
}
setTimeout(cleanLater, 5000).unref();
setInterval(cleanLater, 10 * 60 * 1000).unref();
function deleteFailMessage(code) {
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return `有文件正被别的程序打开着（比如还开着这个 PDF 的阅读器、或者网盘正在同步它），先关掉那个程序再删。（${code}）`;
  return `删不掉${code ? '（' + code + '）' : ''}。可以点"打开回收站文件夹"手动删。`;
}

function moveToTrash(d, file, name) {
  fs.mkdirSync(d.trash, { recursive: true });
  const target = path.join(d.trash, uniqueName(d.trash, name));
  releaseHandles(file);
  try { fs.renameSync(file, target); }
  catch (e) { sleepMs(300); releaseHandles(file); fs.renameSync(file, target); }
  const now = new Date();
  try { fs.utimesSync(target, now, now); } catch {}
}

// 读目录时，个别文件读不了（比如 Windows 上正在被删除的文件）就跳过，不要整个出错
function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function listTrash(d) {
  if (!fs.existsSync(d.trash)) return [];
  return fs.readdirSync(d.trash).map(f => {
    const st = safeStat(path.join(d.trash, f));
    return st && { name: f, size: st.size, deleted: st.mtimeMs, kind: /\.md$/i.test(f) ? 'note' : 'file' };
  }).filter(Boolean).sort((a, b) => b.deleted - a.deleted);
}

// ---- 电子书：章节信息缓存
const epubCache = new Map();
function epubFor(file) {
  const st = fs.statSync(file);
  const c = epubCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.info;
  const info = docs.epubInfo(file);
  epubCache.set(file, { mtime: st.mtimeMs, info });
  if (epubCache.size > 10) epubCache.delete(epubCache.keys().next().value);
  return info;
}

// ---------------------------------------------------------------- 设置（密码、备份）

const crypto = require('crypto');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const ICON_DIR = path.join(ROOT, '图标');

// ---- 皮肤
const skins = require('./lib/skins.js');
const SKIN_BUILTIN = path.join(PUBLIC_DIR, 'skins');
const SKIN_USER = path.join(ROOT, '皮肤');
const SKIN_PRIVATE = path.join(PRIVATE_DIR, '.皮肤');
function skinDir(id, req) {
  id = String(id || '');
  if (!id || id === 'original') return null;
  let m;
  if ((m = /^u-([\w\u4e00-\u9fa5-]+)$/.exec(id))) return path.join(SKIN_USER, m[1]);
  if ((m = /^p-([\w\u4e00-\u9fa5-]+)$/.exec(id))) return req && privateOk(req) ? path.join(SKIN_PRIVATE, m[1]) : null;
  if (/^[\w-]+$/.test(id)) return path.join(SKIN_BUILTIN, id);
  return null;
}
function skinExists(id, req) {
  const d = skinDir(id, req);
  return !!(d && skins.readMeta(d));
}
function currentSkin(space, req) {
  const id = readSettings()[space === 'private' ? '私密皮肤' : '皮肤'] || 'original';
  if (space === 'main' && id.startsWith('p-')) return 'original';
  return id === 'original' || skinExists(id, req) ? id : 'original';
}
function skinRoots(space) {
  const roots = [{ dir: SKIN_BUILTIN, prefix: '', builtin: true }, { dir: SKIN_USER, prefix: 'u-' }];
  if (space === 'private') roots.push({ dir: SKIN_PRIVATE, prefix: 'p-' });
  return roots;
}
fs.mkdirSync(ICON_DIR, { recursive: true });

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, '')) || {}; } catch { return {}; }
}
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return s;
}

// ---- 私密密码
// 设了密码以后，没解锁时后台根本不把私密工具发给页面
const unlockTokens = new Map(); // token -> 过期时间
const UNLOCK_MS = 30 * 60 * 1000;
const failedTries = [];

function hasPassword() {
  const s = readSettings();
  return !!(s['私密密码'] && s['私密密码'].hash);
}
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(pw) {
  const p = readSettings()['私密密码'];
  if (!p) return false;
  const a = Buffer.from(hashPassword(pw, p.salt), 'hex');
  const b = Buffer.from(p.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPassword(pw) {
  if (!pw) return writeSettings({ '私密密码': null });
  const salt = crypto.randomBytes(16).toString('hex');
  return writeSettings({ '私密密码': { salt, hash: hashPassword(pw, salt) } });
}
function cookieToken(req) {
  const m = /(?:^|;\s*)bb_unlock=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}
// 私密区必须设了密码并且已经解锁
function privateOk(req) {
  return hasPassword() && isUnlocked(req);
}
function isUnlocked(req) {
  if (!hasPassword()) return false;
  const t = cookieToken(req);
  const exp = t && unlockTokens.get(t);
  if (!exp || exp < Date.now()) { if (t) unlockTokens.delete(t); return false; }
  unlockTokens.set(t, Date.now() + UNLOCK_MS); // 用着就续期
  return true;
}
function tooManyTries() {
  const now = Date.now();
  while (failedTries.length && failedTries[0] < now - 60000) failedTries.shift();
  return failedTries.length >= 5;
}
function canSee(req, tool) {
  return !tool.private || privateOk(req);
}
// 工具属于哪个区
function inSpace(tool, space) {
  return space === 'private' ? !!tool.private : !tool.private;
}

// ---- 自动备份：把记忆区和配置复制到一个网盘同步文件夹
let backupTimer = null;
let backupState = { running: false, last: null, error: null, copied: 0 };

function suggestBackupDirs() {
  const out = [];
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (process.env[k] && fs.existsSync(process.env[k]) && !out.includes(process.env[k])) out.push(process.env[k]);
  }
  return out;
}

function copyNewer(src, dst, stats) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === '.回收站' || name === '.索引' || name === LATER_DIR) continue;
      copyNewer(path.join(src, name), path.join(dst, name), stats);
    }
    return;
  }
  let need = true;
  try {
    const d = fs.statSync(dst);
    need = d.size !== st.size || Math.abs(d.mtimeMs - st.mtimeMs) > 2000;
  } catch {}
  if (!need) return;
  fs.copyFileSync(src, dst);
  fs.utimesSync(dst, st.atime, st.mtime);
  stats.copied++;
}

function runBackup() {
  const dir = readSettings()['备份位置'];
  if (!dir) return { ok: false, message: '还没设置备份位置。' };
  if (!fs.existsSync(dir)) return { ok: false, message: `备份位置不存在：${dir}` };
  const dest = path.join(dir, '百宝匣备份');
  if (path.resolve(dest).startsWith(ROOT + path.sep)) return { ok: false, message: '备份位置不能放在百宝匣文件夹里面。' };
  backupState.running = true;
  const stats = { copied: 0 };
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['tools.json', 'layout.json', 'settings.json']) {
      if (fs.existsSync(path.join(ROOT, f))) copyNewer(path.join(ROOT, f), path.join(dest, f), stats);
    }
    copyNewer(MEMORY_DIR, path.join(dest, '记忆区'), stats);
    if (fs.existsSync(POCKET_DIR)) copyNewer(POCKET_DIR, path.join(dest, '随身口袋'), stats);
    if (fs.existsSync(PRIVATE_DIR)) {
      const pd = path.join(dest, '私密区');
      copyNewer(PRIVATE_DIR, pd, stats);
      if (IS_WIN) exec(`attrib +h "${pd}"`, { windowsHide: true }, () => {});
    }
    if (fs.existsSync(ICON_DIR)) copyNewer(ICON_DIR, path.join(dest, '图标'), stats);
    if (fs.existsSync(SKIN_USER)) copyNewer(SKIN_USER, path.join(dest, '皮肤'), stats);
    backupState = { running: false, last: Date.now(), error: null, copied: stats.copied, dest };
    writeSettings({ '上次备份': backupState.last });
    return { ok: true, copied: stats.copied, dest };
  } catch (e) {
    backupState = { running: false, last: backupState.last, error: e.message, copied: 0, dest };
    return { ok: false, message: '备份失败：' + e.message };
  }
}

// 从备份恢复：本机没有的文件直接拷回来；本机有但不一样的，overwrite 时才覆盖，
// 覆盖前先把本机的旧文件存到"恢复前的旧文件"里
function sameFile(a, b) {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  if (Math.abs(sa.mtimeMs - sb.mtimeMs) < 2000) return true;
  if (sa.size > 20 * 1024 * 1024) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function restoreBackup(overwrite) {
  const dir = readSettings()['备份位置'];
  if (!dir) return { ok: false, message: '还没设置备份位置。' };
  const src = path.join(dir, '百宝匣备份');
  if (!fs.existsSync(src)) return { ok: false, message: `备份位置里没有"百宝匣备份"文件夹：${src}` };
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:]/g, '-').replace(/\s+/g, '_');
  const saveRoot = path.join(ROOT, '恢复前的旧文件', stamp);
  const r = { ok: true, restored: 0, conflicts: 0, saved: 0, conflictList: [] };
  const map = [['tools.json', TOOLS_FILE], ['layout.json', LAYOUT_FILE], ['记忆区', MEMORY_DIR], ['私密区', PRIVATE_DIR], ['图标', ICON_DIR], ['皮肤', SKIN_USER]];
  function walk(from, to, rel) {
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(from)) {
        if (n === '.索引' || n === '.回收站') continue;
        walk(path.join(from, n), path.join(to, n), path.join(rel, n));
      }
      return;
    }
    if (!fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      fs.utimesSync(to, st.atime, st.mtime);
      r.restored++;
      return;
    }
    if (sameFile(from, to)) return;
    if (!overwrite) { r.conflicts++; if (r.conflictList.length < 20) r.conflictList.push(rel); return; }
    const keep = path.join(saveRoot, rel);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.copyFileSync(to, keep);
    r.saved++;
    fs.copyFileSync(from, to);
    fs.utimesSync(to, st.atime, st.mtime);
    r.restored++;
  }
  try {
    for (const [name, target] of map) {
      const f = path.join(src, name);
      if (fs.existsSync(f)) walk(f, target, name);
    }
    // 设置只拿回密码（本机还没设密码的时候）
    const bs = path.join(src, 'settings.json');
    if (fs.existsSync(bs)) {
      try {
        const b = JSON.parse(fs.readFileSync(bs, 'utf8'));
        if (b['私密密码'] && !hasPassword()) { writeSettings({ '私密密码': b['私密密码'] }); r.restored++; }
      } catch {}
    }
  } catch (e) {
    return { ok: false, message: '恢复出错：' + e.message, ...r };
  }
  queueIndex(spaceDirs('main'));
  scheduleCheckup();
  if (fs.existsSync(PRIVATE_DIR)) queueIndex(spaceDirs('private'));
  if (r.saved) r.savedTo = saveRoot;
  return r;
}

function scheduleBackups() {
  clearInterval(backupTimer);
  if (!readSettings()['备份位置']) return;
  runBackup();
  backupTimer = setInterval(runBackup, 30 * 60 * 1000);
  backupTimer.unref();
}

// ---- 截图识字（Windows 自带的识字引擎）
let ocrBusy = false;

function runOcr(args) {
  return new Promise(resolve => {
    if (!IS_WIN) return resolve({ ok: false, message: '截图识字只能在 Windows 上用。' });
    const ps = path.join(CODE, 'lib', 'ocr.ps1');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', ps, ...args], { windowsHide: true });
    const out = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => out.push(d));
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, message: '找不到 PowerShell，截图识字用不了。' }); });
    child.on('exit', () => {
      clearTimeout(timer);
      const text = decode(Buffer.concat(out)).replace(/^﻿/, '');
      const line = text.split(/\r?\n/).reverse().find(l => l.trim().startsWith('{'));
      let r = null;
      try { r = JSON.parse(line.trim().replace(/^﻿/, '')); } catch {}
      if (!r) return resolve({ ok: false, message: '识字程序没有正常返回结果。', detail: text.slice(-500) });
      if (r.ok) return resolve({ ok: true, text: r.text || '', empty: !r.text });
      const msg = {
        NO_SNIP: '没有截到图（等了一分钟，或者按了 Esc）。',
        NO_IMAGE: '找不到图片。',
        NO_ENGINE: '这台电脑没装识字用的语言包。打开 设置 → 时间和语言 → 语言和区域 → 中文（简体）旁边的 ⋯ → 语言选项，安装"光学字符识别"。',
        ERROR: '识字出错了。',
      }[r.code] || '识字出错了。';
      resolve({ ok: false, message: msg, detail: r.detail || '' });
    });
  });
}

const OCR_TMP = path.join(LOG_DIR, 'ocr.png');

async function ocrSnip() {
  if (ocrBusy) return { ok: false, message: '上一次截图还没完成。' };
  ocrBusy = true;
  try { return await runOcr(['-Mode', 'snip', '-Out', OCR_TMP]); } finally { ocrBusy = false; }
}

async function ocrImage(buf) {
  if (ocrBusy) return { ok: false, message: '上一次识字还没完成。' };
  ocrBusy = true;
  try {
    fs.writeFileSync(OCR_TMP, buf);
    return await runOcr(['-Mode', 'image', '-Image', OCR_TMP]);
  } finally { ocrBusy = false; }
}

// 第一次运行新版本时，把自带工具放进柜子（只放一次，拿掉了就不会再加回来）
function addBuiltins() {
  const s = readSettings();
  const added = s['已添加自带工具'] || [];
  if (added.includes('截图识字')) return;
  try {
    const list = readRawList();
    if (!list.some(t => t['类型'] === '内置' && t['功能'] === '截图识字')) {
      list.push({ '名字': list.some(t => t['名字'] === '截图识字') ? '截图识字(自带)' : '截图识字', '图标': '🔤', '类型': '内置', '功能': '截图识字', '一句话': '框选屏幕上任意区域，把里面的字变成可以复制的文字' });
      writeRawList(list);
    }
    writeSettings({ '已添加自带工具': [...added, '截图识字'] });
  } catch {}
}

// ---------------------------------------------------------------- 0.7：联网、GitHub、组合技、体检、统计、AI、剪藏、读书笔记

const os = require('os');
const net = require('./lib/net.js');
const github = require('./lib/github.js');
const PROJECTS_DIR = path.join(os.homedir(), '百宝匣项目');

function proxySetting() {
  return String(readSettings()['代理'] || '').trim();
}

// ---- GitHub 收编
async function githubFetch(input, destIn) {
  const r = github.parseRepo(input);
  if (!r) return { ok: false, message: '看不懂这个地址。贴 GitHub 项目页面的网址，比如 https://github.com/作者/项目' };
  const dest = destIn ? path.resolve(String(destIn).trim().replace(/^"|"$/g, '')) : path.join(PROJECTS_DIR, r.repo);
  try {
    const d = await github.download(r, dest, { proxy: proxySetting() });
    const det = detectProject(dest);
    return {
      ok: true, ...det, folder: dest, files: d.count,
      source: github.repoUrl(r) + (r.branch ? `/tree/${r.branch}` : ''),
      version: d.sha,
      hints: [`已下载到 ${dest}（${d.count} 个文件）。`, ...(det.hints || [])],
    };
  } catch (e) {
    return { ok: false, message: '下载失败：' + net.netError(e, proxySetting()) };
  }
}

async function checkUpdate(tool) {
  const src = tool.raw['来源'];
  const r = src && github.parseRepo(src);
  if (!r) return { ok: false, message: '这个工具不是从 GitHub 收编的。' };
  try {
    const latest = await github.latestSha(r, proxySetting());
    const current = tool.raw['版本'] || '';
    return { ok: true, hasUpdate: !current || latest !== current, current: current.slice(0, 7), latest: latest.slice(0, 7) };
  } catch (e) {
    return { ok: false, message: '检查失败：' + net.netError(e, proxySetting()) };
  }
}

async function updateTool(tool) {
  const r = github.parseRepo(tool.raw['来源'] || '');
  if (!r) return { ok: false, message: '这个工具不是从 GitHub 收编的。' };
  if (!tool.folder || !fs.existsSync(tool.folder)) return { ok: false, message: '找不到项目文件夹。' };
  const wasRunning = tool.type === 'service' && await checkUrl(tool.health);
  await stopTool(tool);
  busy.set(tool.id, '更新中');
  try {
    const d = await github.download(r, tool.folder, { proxy: proxySetting(), update: true });
    appendLog(tool.id, `\n[百宝匣] ${new Date().toLocaleString('zh-CN')} 已从 GitHub 更新到 ${d.sha.slice(0, 7)}\n`);
    const list = readRawList();
    if (list[tool.index]) { list[tool.index]['版本'] = d.sha; writeRawList(list); }
    busy.delete(tool.id);
    // 更新后可能需要重新安装零件
    if (tool.setup) {
      const ok = await runSetup(tool);
      if (!ok) return { ok: false, message: '代码已更新，但安装零件失败了。打开"运行记录"看看。' };
    }
    if (wasRunning) await launchService(findTool(tool.id) || tool);
    return { ok: true, version: d.sha.slice(0, 7), files: d.count };
  } catch (e) {
    busy.delete(tool.id);
    return { ok: false, message: '更新失败：' + net.netError(e, proxySetting()) };
  }
}

// ---- 组合技：按顺序做好几件事
async function launchCombo(tool, req) {
  const steps = Array.isArray(tool.raw['步骤']) ? tool.raw['步骤'] : [];
  if (!steps.length) return { ok: false, message: '这个组合里还没有步骤。' };
  const all = readTools().tools;
  busy.set(tool.id, '执行中');
  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const label = `第 ${i + 1} 步`;
      if (s['类型'] === '等待') {
        await new Promise(r => setTimeout(r, Math.min(120, Math.max(0, Number(s['秒']) || 0)) * 1000));
      } else if (s['类型'] === '网址') {
        if (!s['网址']) continue;
        openInSystem(/^[a-z]+:\/\//i.test(s['网址']) ? s['网址'] : 'http://' + s['网址']);
      } else {
        const t = all.find(x => x.name === s['名字']);
        if (!t || !canSee(req, t)) return { ok: false, message: `${label}要打开的"${s['名字']}"找不到了，可能被改名或拿掉了。` };
        if (t.type === 'combo') return { ok: false, message: `${label}：组合里不能再套组合。` };
        if (t.type === 'builtin' || t.type === 'bookmarklet') continue;
        const r = await launch(t, req);
        if (!r.ok) return { ok: false, message: `${label}"${t.name}"没打开：${r.message || ''}`, fix: r.fix, failedTool: t.id };
      }
    }
    return { ok: true, state: 'opened', steps: steps.length };
  } finally {
    busy.delete(tool.id);
  }
}

// ---- 工具体检
let checkupRunning = false;

async function checkTool(t, deep, req) {
  const r = { id: t.id, name: t.name, level: 'ok', message: '' };
  const bad = (level, message, fix) => Object.assign(r, { level, message, fix: fix || null });
  try {
    if (t.type === 'link') {
      if (!t.url) return bad('error', '没有填网址');
      try {
        const res = await net.request(t.url, { timeout: 12000, maxBytes: 3 * 1024 * 1024, proxy: proxySetting() });
        if (res.status >= 500) bad('warn', `网站出错了（${res.status}）`);
        else if (res.status === 404) bad('warn', '网页不存在了（404）');
        else r.message = '能打开';
      } catch (e) {
        if (/太大/.test(e.message)) r.message = '能打开';
        else bad('warn', '打不开：' + net.netError(e, proxySetting()));
      }
    } else if (t.type === 'folder') {
      if (!t.folder || !fs.existsSync(t.folder)) bad('error', `文件夹不见了：${t.folder}`);
      else r.message = '文件夹在';
    } else if (t.type === 'program') {
      const p = t.program ? path.resolve(ROOT, t.program) : '';
      if (!p || !fs.existsSync(p)) bad('error', `程序不见了：${p}`);
      else r.message = '程序在';
    } else if (t.type === 'service') {
      if (!t.folder || !fs.existsSync(t.folder)) return bad('error', `项目文件夹不见了：${t.folder}`);
      if (!t.start) return bad('error', '没有填启动命令');
      if (await checkUrl(t.health)) { r.message = '正在运行'; return r; }
      if (t.setup && !fs.existsSync(path.join(t.folder, t.setup.missing))) {
        if (!deep) return bad('warn', `缺少 ${t.setup.missing}，第一次启动时会自动安装`);
      }
      if (deep) {
        const res = await launchService(t);
        if (res.ok) { r.message = '能正常启动'; await stopTool(t); }
        else bad('error', res.message, res.fix);
      } else {
        r.message = '文件都在（完整体检会真的启动一次）';
      }
    } else if (t.type === 'combo') {
      const all = readTools().tools;
      const miss = (t.raw['步骤'] || []).filter(s => (s['类型'] || '工具') === '工具' && !all.some(x => x.name === s['名字']));
      if (miss.length) bad('error', `步骤里的"${miss.map(s => s['名字']).join('、')}"找不到了`);
      else r.message = `${(t.raw['步骤'] || []).length} 个步骤都在`;
    } else {
      r.message = '百宝匣自带';
    }
  } catch (e) {
    bad('warn', '检查时出错：' + e.message);
  }
  return r;
}

async function runCheckup(deep, req, space = 'main') {
  if (checkupRunning) return { ok: false, message: '体检正在进行中，等一下。' };
  checkupRunning = true;
  try {
    const tools = readTools().tools.filter(t => inSpace(t, space) && (!req || canSee(req, t)));
    const results = [];
    // 网址类可以一起查，本地项目一个一个来
    const quick = tools.filter(t => t.type !== 'service' || !deep);
    const slow = tools.filter(t => t.type === 'service' && deep);
    for (let i = 0; i < quick.length; i += 6) {
      results.push(...await Promise.all(quick.slice(i, i + 6).map(t => checkTool(t, deep, req))));
    }
    for (const t of slow) results.push(await checkTool(t, deep, req));
    const order = new Map(tools.map((t, i) => [t.id, i]));
    results.sort((a, b) => order.get(a.id) - order.get(b.id));
    const report = { time: Date.now(), deep, space, results };
    if (space === 'main') writeSettings({ '上次体检': report });
    return { ok: true, ...report };
  } finally {
    checkupRunning = false;
  }
}

// 每周自动做一次快速体检
function scheduleCheckup() {
  const tick = () => {
    const last = readSettings()['上次体检'];
    if (!last || Date.now() - last.time > 7 * 24 * 3600 * 1000) runCheckup(false, null, 'main').catch(() => {});
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 6 * 3600 * 1000).unref();
}

// ---- 使用统计（只记普通区，只存在本机）
const STATS_FILE = path.join(ROOT, '统计.json');
let statsCache = null;
let statsTimer = null;

function readStats() {
  if (!statsCache) {
    try { statsCache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { statsCache = {}; }
    for (const k of ['工具', '说明', '搜索', '每天', '资料', '读书', '动作']) statsCache[k] = statsCache[k] || {};
  }
  return statsCache;
}
function saveStatsSoon() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(statsCache), 'utf8'); } catch {}
  }, 2000);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function record(kind, key, extra, { count = true } = {}) {
  if (!key) return;
  const s = readStats();
  const e = s[kind][key] || (s[kind][key] = { 次数: 0 });
  if (count) e.次数++;
  e.最近 = Date.now();
  if (extra) Object.assign(e, extra);
  if (count) s['每天'][today()] = (s['每天'][today()] || 0) + 1;
  saveStatsSoon();
}
// 记忆区里的动作：新建、修改、剪藏，按天记
function recordAction(what) {
  const s = readStats();
  const d = s['动作'][today()] || (s['动作'][today()] = {});
  d[what] = (d[what] || 0) + 1;
  s['每天'][today()] = (s['每天'][today()] || 0) + 1;
  saveStatsSoon();
}
// 同一份资料半小时内反复打开只算一次（PDF 阅读器会分好几次来要文件）
const fileOpenSeen = new Map();
function recordFileOpen(name) {
  const last = fileOpenSeen.get(name) || 0;
  if (Date.now() - last < 30 * 60 * 1000) return;
  fileOpenSeen.set(name, Date.now());
  record('资料', name);
}

function statsReport() {
  const s = readStats();
  const DAY = 24 * 3600 * 1000;
  const d = spaceDirs('main');
  const tools = readTools().tools.filter(t => !t.private);
  const notes = listNotes(d);
  const files = listFiles(d);
  const top = (obj, exists) => Object.entries(obj)
    .filter(([k]) => !exists || exists(k))
    .map(([k, v]) => ({ name: k, count: v['次数'], last: v['最近'], found: v['结果'] }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const noteIds = new Set(notes.map(n => n.id));
  const fileNames = new Set(files.map(f => f.name));
  const toolIds = new Set(tools.map(t => t.id));

  // 最近 30 天
  const days = [];
  const sum = { 新建: 0, 修改: 0, 剪藏: 0 };
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.now() - i * DAY);
    const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    days.push({ day: k, count: s['每天'][k] || 0 });
    const a = s['动作'][k] || {};
    for (const w of Object.keys(sum)) sum[w] += a[w] || 0;
  }

  // 好久没看的说明：三个月没打开过（或者写了一个月以上从来没打开过）
  const stale = notes.map(n => {
    const e = s['说明'][n.id];
    const last = e ? e['最近'] : null;
    const age = Date.now() - (last || n.updated);
    return { name: n.id, title: n.title, last, age };
  }).filter(x => x.age > (x.last ? 90 : 30) * DAY).sort((a, b) => b.age - a.age).slice(0, 10);

  // 在读的书
  const books = Object.entries(s['读书']).filter(([k]) => fileNames.has(k)).map(([k, v]) => ({
    name: k, title: v['书名'] || k, chapter: v['章'] || 0, total: v['共'] || 0, last: v['最近'],
  })).sort((a, b) => b.last - a.last).slice(0, 8);

  const searches = top(s['搜索']);
  return {
    memory: {
      notes: notes.length,
      files: files.length,
      month: sum,
      topNotes: top(s['说明'], k => noteIds.has(k)).slice(0, 10),
      topFiles: top(s['资料'], k => fileNames.has(k)).slice(0, 10),
      books,
      stale,
      searches: searches.filter(x => x.found !== 0).slice(0, 10),
      misses: searches.filter(x => x.found === 0).slice(0, 10),
    },
    tools: {
      top: top(s['工具'], k => toolIds.has(k)).slice(0, 10).map(x => ({ ...x, icon: (tools.find(t => t.id === x.name) || {}).icon })),
      idle: tools.filter(t => {
        const e = s['工具'][t.id];
        return !e || Date.now() - e['最近'] > 60 * DAY;
      }).map(t => ({ name: t.id, icon: t.icon, last: s['工具'][t.id] ? s['工具'][t.id]['最近'] : null })),
    },
    days,
    since: Object.keys(s['每天']).sort()[0] || null,
  };
}

// ---- AI（兼容 OpenAI 格式的接口：DeepSeek、通义千问、Claude 等都行）
function aiConfig() {
  const a = readSettings()['AI'] || {};
  return { baseUrl: String(a['地址'] || '').trim().replace(/\/+$/, ''), key: String(a['密钥'] || '').trim(), model: String(a['模型'] || '').trim() };
}

async function aiChat(messages, { json = false, maxTokens = 2000 } = {}) {
  const c = aiConfig();
  if (!c.baseUrl || !c.key || !c.model) throw new Error('还没设置 AI。在右上角齿轮 → AI 里填好地址、密钥和模型。');
  const url = /\/chat\/completions$/.test(c.baseUrl) ? c.baseUrl : c.baseUrl + '/chat/completions';
  const body = { model: c.model, messages, temperature: 0.3, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  const opts = { headers: { Authorization: `Bearer ${c.key}` }, timeout: 180000, proxy: readSettings()['AI用代理'] ? proxySetting() : '' };
  let r = await net.postJson(url, body, opts);
  if (json && r.status === 400) { delete body.response_format; r = await net.postJson(url, body, opts); }
  if (r.status === 401 || r.status === 403) throw new Error('密钥不对，或者没有权限。');
  if (r.status === 402) throw new Error('账户余额不足。');
  if (r.status === 404) throw new Error('地址或模型名不对。');
  if (r.status === 429) throw new Error('请求太频繁或额度用完了，等一会儿再试。');
  if (r.status >= 400 || !r.data) throw new Error(`AI 服务出错了（${r.status}）：${(r.data && r.data.error && r.data.error.message) || r.text.slice(0, 200)}`);
  const msg = r.data.choices && r.data.choices[0] && r.data.choices[0].message;
  return { text: (msg && msg.content) || '', usage: r.data.usage || null };
}

function cutText(s, n) {
  return s.length > n ? s.slice(0, n) + '\n……（后面太长，没有发给 AI）' : s;
}

async function aiSummarize(d, body) {
  let source = '', title = '', from = '';
  if (body.kind === 'note') {
    const f = safeJoin(d.root, cleanName(body.id || '') + '.md');
    if (!f || !fs.existsSync(f)) return { ok: false, message: '找不到这篇说明。' };
    source = fs.readFileSync(f, 'utf8');
    title = parseNote(body.id, source).title;
  } else {
    const name = String(body.name || '');
    const ix = readIndex(d, name);
    if (!ix || !ix.parts || !ix.parts.length) return { ok: false, message: '这个文件的文字还没读出来，或者它是扫描件，里面没有文字。' };
    source = ix.parts.map(p => (p.label ? `【${p.label}】\n` : '') + p.text).join('\n\n');
    title = name.replace(/\.[^.]+$/, '');
    from = name;
  }
  if (!source.trim()) return { ok: false, message: '里面没有文字可以整理。' };
  const tidy = body.mode === 'tidy';
  const sys = tidy
    ? '你帮用户把他自己写的笔记整理成清楚的使用说明。保留所有事实和命令，不要编造。输出 Markdown：第一行"# 标题"，第二行"标签: 词1, 词2"（3 到 6 个，写"什么时候会用到"这种场景词），然后"## 速查"写 3 到 8 条最关键的步骤，再"## 详细"分小节写完整内容。命令和代码放进代码块。'
    : '你帮用户从一份资料里提炼出一张"速查卡"，让他以后忘了的时候一眼就能找到怎么做。只根据给你的内容写，不知道的不要编。输出 Markdown：第一行"# 标题"，第二行"标签: 词1, 词2"（3 到 6 个，写场景词），然后"## 速查"写 5 到 10 条最常用的操作（每条一句话，能写出页码或章节就在后面括号写出处，例如"（第 12 页）"），再"## 详细"按主题分小节，写清楚具体步骤、要填的数值、命令。命令和代码放进代码块。用中文。';
  const user = `${tidy ? '我的笔记' : '资料'}《${title}》的内容如下：\n\n${cutText(source, 60000)}`;
  try {
    const r = await aiChat([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 3000 });
    let md = r.text.replace(/^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/m, '$1').trim();
    if (!/^#\s/.test(md)) md = `# ${title}${tidy ? '' : ' 速查'}\n\n` + md;
    if (from) md += `\n\n---\n由 AI 根据资料"${from}"整理，重要的地方请对照原文确认。\n`;
    return { ok: true, markdown: md, title: (/^#\s+(.+)$/m.exec(md) || [])[1] || title };
  } catch (e) {
    return { ok: false, message: e.message.startsWith('还没设置') ? e.message : 'AI 出错：' + net.netError(e) };
  }
}

// 从本地资料里找出和问题最相关的几段（中文按两个字一组来比对）
function grams(text) {
  const t = text.toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9_.+#-]{2,}/g) || []) out.add(w);
  const cjk = t.replace(/[^一-鿿]/g, ' ').split(/\s+/).filter(Boolean);
  for (const seg of cjk) {
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}
const STOP = new Set(['怎么', '什么', '如何', '一下', '这个', '那个', '上次', '可以', '我的', '帮我', '是不', '不是', '一个', '的是', '我想', '要怎']);

function retrieve(question, d, limit = 6) {
  const q = [...grams(question)].filter(g => !STOP.has(g));
  if (!q.length) return [];
  const chunks = [];
  for (const n of listNotes(d)) {
    const paras = n.text.split(/\n(?=##?\s)/);
    paras.forEach((p, i) => chunks.push({ kind: 'note', id: n.id, title: n.title, label: i ? (/^##?\s+(.+)/.exec(p) || [])[1] || '' : '', text: p.slice(0, 1800) }));
  }
  for (const f of listFiles(d)) {
    if (f.indexed !== 'done') continue;
    const ix = readIndex(d, f.name);
    for (const part of (ix && ix.parts) || []) {
      for (let i = 0; i < part.text.length; i += 1500) {
        chunks.push({ kind: 'file', name: f.name, title: f.name, label: part.label, page: part.page, chapter: part.chapter, text: part.text.slice(i, i + 1600) });
      }
    }
  }
  for (const c of chunks) {
    const lower = (c.title + ' ' + c.text).toLowerCase();
    let score = 0;
    for (const g of q) if (lower.includes(g)) score += g.length > 2 ? 3 : 1;
    if (c.title && q.some(g => c.title.toLowerCase().includes(g))) score += 4;
    c.score = score;
  }
  return chunks.filter(c => c.score > 1).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- AI 管家（会自己翻资料、能听吩咐做事）
const butlerLib = require('./lib/butler.js');
function ensurePage(d, name) {
  const b = readBinder(d);
  let pg = b.pages.find(x => x.name === name);
  let created = false;
  if (!pg) {
    const used = new Set(b.pages.map(x => x.color));
    let color = [...Array(PAGE_COLORS).keys()].find(c => !used.has(c));
    if (color === undefined) color = b.pages.length % PAGE_COLORS;
    pg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name).slice(0, 20), color, created: Date.now() };
    b.pages.unshift(pg);
    writeBinder(d, b);
    created = true;
  }
  return { page: pg, created };
}
const butler = butlerLib.createButler({
  aiChat, listNotes, listFiles, readIndex, retrieve, binderView, statsReport, readTools,
  createNote(d, title, text, pageName) {
    const t = cleanName(title) || '新的说明';
    const name = uniqueName(d.root, t + '.md');
    const id = name.replace(/\.md$/i, '');
    let body = String(text);
    body = /^# .*$/m.test(body) ? body.replace(/^# .*$/m, `# ${id}`) : `# ${id}\n\n${body}`;
    fs.writeFileSync(path.join(d.root, name), body, 'utf8');
    let page = '';
    if (pageName) { const r = ensurePage(d, pageName); binderPut(d, 'note', id, r.page.id); page = r.page.name; }
    if (d.root === MEMORY_DIR) recordAction('新建');
    return { ok: true, id, page };
  },
  putInPage(d, pageName, items) {
    const r = ensurePage(d, pageName);
    for (const it of items) binderPut(d, it.kind, it.id, r.page.id);
    return { ok: true, created: r.created };
  },
});
// 管家的人格：白天（普通区）存在设置里；夜里（私密区）存在私密区文件夹里，普通区看不到
function butlerFile() { return path.join(PRIVATE_DIR, '.管家.json'); }
function readButler(space) {
  if (space === 'private') {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(butlerFile(), 'utf8')); } catch {}
    return { persona: { ...butlerLib.DEFAULT_PERSONA.private, ...(j['人格'] || {}) }, allowPrivate: !!j['可以看私密区'] };
  }
  const s = readSettings()['管家'] || {};
  return { persona: { ...butlerLib.DEFAULT_PERSONA.main, ...s } };
}
function writeButler(space, patch) {
  const clean = v => ({ 名字: String(v.名字 || '').trim().slice(0, 20), 设定: String(v.设定 || '').slice(0, 6000) });
  if (space === 'private') {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(butlerFile(), 'utf8')); } catch {}
    if (patch.persona) j['人格'] = clean(patch.persona);
    if (patch.allowPrivate !== undefined) j['可以看私密区'] = !!patch.allowPrivate;
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(butlerFile(), JSON.stringify(j, null, 2), 'utf8');
  } else if (patch.persona) {
    writeSettings({ '管家': clean(patch.persona) });
  }
}
async function butlerAsk(body, space, onStep) {
  const question = String(body.question || '').trim();
  if (!question) return { ok: false, message: '问点什么吧。' };
  const b = readButler(space);
  const free = body.free !== undefined ? !!body.free : !!readSettings()['AI自由回答'];
  try {
    return await butler.run({
      question, history: body.history, free, space, d: spaceDirs(space),
      persona: { 名字: b.persona.名字 || '百宝匣', 设定: b.persona.设定 || '' },
      privateBlind: space === 'private' && !b.allowPrivate, onStep,
    });
  } catch (e) {
    return { ok: false, message: e.message.startsWith('还没设置') ? e.message : 'AI 出错：' + net.netError(e) };
  }
}

// ---- 网页剪藏：把插件发来的正文存成说明，图片下载到本地
async function saveClip(body, d) {
  let title = cleanName(body.title || '') || '剪藏';
  let md = String(body.markdown || '');
  const pageUrl = String(body.url || '');
  if (!md.trim()) return { ok: false, message: '没有内容。' };
  const urls = [...new Set([...md.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map(m => m[1]))].slice(0, 80);
  let saved = 0;
  for (const u of urls) {
    try {
      const r = await net.request(u, { timeout: 20000, maxBytes: 10 * 1024 * 1024, proxy: proxySetting(), headers: { Referer: pageUrl, Accept: 'image/*' } });
      const type = String(r.headers['content-type'] || '');
      if (r.status !== 200 || !/^image\//.test(type)) continue;
      const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' })[type.split(';')[0]] || '.png';
      if (ext === '.svg') continue;
      const name = uniqueName(d.images, `剪藏-${Date.now().toString(36)}-${saved}${ext}`);
      fs.writeFileSync(path.join(d.images, name), r.body);
      md = md.split(`(${u})`).join(`(${d.url}图片/${encUrl(name)})`);
      saved++;
    } catch {}
  }
  const date = new Date().toLocaleDateString('zh-CN');
  // 选中一段存的"摘录"：同一个网页存的几段放进同一篇
  if (body.mode === 'excerpt') {
    const name = cleanName(title + '（摘录）') + '.md';
    const f = path.join(d.root, name);
    if (fs.existsSync(f)) {
      const old = fs.readFileSync(f, 'utf8');
      if (pageUrl && old.includes(`> 来源：${pageUrl} ，`)) {
        fs.writeFileSync(f, old.replace(/\s*$/, '') + `\n\n---\n\n${md.trim()}\n`, 'utf8');
        return { ok: true, id: name.replace(/\.md$/i, ''), appended: true, images: saved, imagesTotal: urls.length };
      }
    }
    title = title + '（摘录）';
  }
  const text = `# ${title}\n标签: 剪藏${body.site ? ', ' + String(body.site).replace(/[,，]/g, ' ') : ''}\n\n> 来源：${pageUrl} ，${date} 剪藏\n\n${md.trim()}\n`;
  const file = uniqueName(d.root, title + '.md');
  fs.writeFileSync(path.join(d.root, file), text, 'utf8');
  // 有一张叫"剪藏"的活页，就自动放进去
  const clipPage = pageByName(d, '剪藏');
  if (clipPage) binderPut(d, 'note', file.replace(/\.md$/i, ''), clipPage.id);
  return { ok: true, id: file.replace(/\.md$/i, ''), images: saved, imagesTotal: urls.length };
}

// ---- 电子书书签、划线、笔记
function bookNotesFile(d, name) {
  return path.join(d.root, '.书笔记', cleanName(name) + '.json');
}
function readBookNotes(d, name) {
  try { return JSON.parse(fs.readFileSync(bookNotesFile(d, name), 'utf8')); } catch { return { bookmarks: [], highlights: [] }; }
}
function writeBookNotes(d, name, data) {
  const f = bookNotesFile(d, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const clean = {
    bookmarks: (data.bookmarks || []).slice(0, 500).map(b => ({ chapter: Number(b.chapter) || 0, ratio: Number(b.ratio) || 0, title: String(b.title || '').slice(0, 100), time: Number(b.time) || Date.now() })),
    highlights: (data.highlights || []).slice(0, 2000).map(h => ({ id: String(h.id || '').slice(0, 40), chapter: Number(h.chapter) || 0, text: String(h.text || '').slice(0, 2000), note: String(h.note || '').slice(0, 5000), time: Number(h.time) || Date.now() })),
  };
  fs.writeFileSync(f, JSON.stringify(clean), 'utf8');
  return clean;
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.epub': 'application/epub+zip',
  '.mp4': 'video/mp4', '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// 发文件：支持只要一段（PDF 阅读器会这样要），浏览器中途不要了就马上把文件放开，
// 读文件出错也不会让百宝匣崩掉（Windows 上开着的文件删不干净，就是因为没放开）
function sendFile(res, file, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: '找不到' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    let start = 0, end = st.size - 1, code = 200;
    const range = req && req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && st.size) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    if (!st.size) { res.writeHead(200, headers); return res.end(); }
    const stream = fs.createReadStream(file, { start, end });
    trackStream(file, stream);
    // 浏览器不读了又不断开（PDF 阅读器常这样），30 秒没动静就放开文件
    res.setTimeout(30000, () => { stream.destroy(); res.destroy(); });
    stream.on('error', () => {
      if (!res.headersSent) send(res, 404, { error: '读不了这个文件' });
      else res.destroy();
    });
    stream.once('open', () => { res.writeHead(code, headers); stream.pipe(res); });
    res.on('close', () => stream.destroy());
  });
}

function readBody(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('太大了')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const b = await readBody(req, 5 * 1024 * 1024);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length) || '文件';
  let n = name, i = 2;
  while (fs.existsSync(path.join(dir, n))) n = `${base}(${i++})${ext}`;
  return n;
}

// ---------------------------------------------------------------- 随身口袋 + 末影箱（0.15）
// 随身口袋：一个放随手文件的地方；连上末影箱以后，里面的东西加密存进自己的 GitHub 私有仓库，换台电脑也能拿到
const POCKET_DIR = path.join(ROOT, '随身口袋');
const POCKET_TRASH = path.join(POCKET_DIR, '.回收站');
const BOX_DIR = path.join(ROOT, '.末影箱');
const BOX_CONF = path.join(BOX_DIR, 'conf.json');
const TEMP_MODE = process.env.BAIBAO_TEMP === '1';
const { createBox } = require('./lib/box.js');
const box = createBox({
  dir: POCKET_DIR,
  stateDir: BOX_DIR,
  proxy: () => proxySetting(),
  getConf() { try { return JSON.parse(fs.readFileSync(BOX_CONF, 'utf8')); } catch { return null; } },
  setConf(c) {
    if (!c) { try { fs.unlinkSync(BOX_CONF); } catch {} return; }
    fs.mkdirSync(BOX_DIR, { recursive: true });
    fs.writeFileSync(BOX_CONF + '.tmp', JSON.stringify(c, null, 2));
    fs.renameSync(BOX_CONF + '.tmp', BOX_CONF);
  },
  trash(file, name) {
    if (!fs.existsSync(file)) return;
    moveToTrash({ trash: POCKET_TRASH }, file, name);
  },
});
if (IS_WIN) exec(`attrib +h "${BOX_DIR}"`, { windowsHide: true }, () => {});

function pocketFile(name) {
  const n = String(name || '');
  const f = safeJoin(POCKET_DIR, n);
  if (!f || path.dirname(f) !== POCKET_DIR || n.startsWith('.')) return null;
  return f;
}

const server = http.createServer(async (req, res) => {
  try {
    // 只接受本机访问
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'forbidden' });

    const url = new URL(req.url, `http://${HOST}`);
    const p = decodeURIComponent(url.pathname);

    // 写操作必须带这个请求头，防止别的网站偷偷调用
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-baibao'] !== '1') {
      return send(res, 403, { error: 'forbidden' });
    }

    // 普通区 / 私密区：私密区的任何东西都要先解锁
    const space = url.searchParams.get('space') === 'private' ? 'private' : 'main';
    if (space === 'private' && p.startsWith('/api/') && !p.startsWith('/api/private') && !privateOk(req)) {
      return send(res, 403, { ok: false, locked: true, message: '私密区已经上锁了。' });
    }

    if (p === '/api/tools' && req.method === 'GET') {
      const t = readTools();
      // 亮度 0~5：按使用次数算，皮肤可以用它让常用的工具更显眼（私密区不记统计，都是 0）
      const used = space === 'main' ? readStats()['工具'] : {};
      const max = Math.max(1, ...Object.values(used).map(e => e['次数'] || 0));
      const heat = id => { const c = (used[id] && used[id]['次数']) || 0; return c ? Math.max(1, Math.ceil(5 * Math.log(1 + c) / Math.log(1 + max))) : 0; };
      return send(res, 200, {
        tools: t.tools.filter(x => inSpace(x, space) && canSee(req, x)).map(x => ({ ...x, heat: heat(x.id) })), error: t.error,
        sections: readLayout(space).sections,
        private: { hasPassword: hasPassword(), unlocked: hasPassword() && isUnlocked(req) },
      });
    }
    if (p === '/api/version' && req.method === 'GET') {
      return send(res, 200, { version: VERSION });
    }
    if (p === '/api/status' && req.method === 'GET') {
      const st = await statusAll();
      const tools = readTools().tools;
      st.status = st.status.filter(x => { const t = tools.find(y => y.id === x.id); return t && inSpace(t, space) && canSee(req, t); });
      return send(res, 200, st);
    }
    if (p === '/api/tools/detect' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, detectProject(body.folder));
    }
    if (p === '/api/tools' && req.method === 'POST') {
      const body = await readJson(req);
      if (space === 'private') body.private = true;
      if (body.private && !hasPassword()) return send(res, 200, { ok: false, message: '要放进私密区，先在设置里设一个密码。' });
      const list = readRawList();
      const r = toolFromForm(body);
      if (r.error) return send(res, 200, { ok: false, message: r.error });
      if (list.some(t => t['名字'] === r.raw['名字'])) return send(res, 200, { ok: false, message: `已经有一个叫"${r.raw['名字']}"的工具了，换个名字吧。` });
      if (body.createNote && !r.raw['说明书']) r.raw['说明书'] = createToolNote(r.raw);
      list.push(r.raw);
      writeRawList(list);
      return send(res, 200, { ok: true, id: r.raw['名字'] });
    }
    let m;
    if ((m = /^\/api\/tools\/([^/]+)$/.exec(p)) && (req.method === 'PUT' || req.method === 'DELETE')) {
      const tool = findTool(m[1]);
      if (!tool || !canSee(req, tool)) return send(res, 200, { ok: false, message: '找不到这个工具，刷新一下页面。' });
      const list = readRawList();
      if (req.method === 'DELETE') {
        await stopTool(tool).catch(() => {});
        list.splice(tool.index, 1);
        writeRawList(list);
        return send(res, 200, { ok: true });
      }
      const body = await readJson(req);
      if (space === 'private' && body.private === undefined) body.private = true;
      if (body.private && !hasPassword()) return send(res, 200, { ok: false, message: '要放进私密区，先在设置里设一个密码。' });
      const r = toolFromForm(body, list[tool.index]);
      if (r.error) return send(res, 200, { ok: false, message: r.error });
      if (list.some((t, i) => i !== tool.index && t['名字'] === r.raw['名字'])) return send(res, 200, { ok: false, message: `已经有一个叫"${r.raw['名字']}"的工具了，换个名字吧。` });
      if (body.createNote && !r.raw['说明书']) r.raw['说明书'] = createToolNote(r.raw);
      list[tool.index] = r.raw;
      writeRawList(list);
      return send(res, 200, { ok: true, id: r.raw['名字'] });
    }
    if ((m = /^\/api\/tools\/(.+)\/(launch|stop|fix|log|open-folder|check-update|update)$/.exec(p))) {
      const tool = findTool(m[1]);
      if (!tool || !canSee(req, tool)) return send(res, 404, { ok: false, message: '找不到这个工具，可能被改过或已上锁，刷新一下页面。' });
      const action = m[2];
      if (action === 'log') return send(res, 200, { log: logText(tool.id) });
      if (busy.has(tool.id) && action !== 'stop') return send(res, 200, { ok: false, message: `正在${busy.get(tool.id)}，请稍等。` });
      if (action === 'launch') {
        const r = await launch(tool, req);
        if (r.ok && space === 'main' && tool.type !== 'bookmarklet') record('工具', tool.id);
        return send(res, 200, r);
      }
      if (action === 'check-update') return send(res, 200, await checkUpdate(tool));
      if (action === 'update') return send(res, 200, await updateTool(tool));
      if (action === 'stop') return send(res, 200, await stopTool(tool));
      if (action === 'open-folder') {
        if (tool.folder && fs.existsSync(tool.folder)) { openFolder(tool.folder); return send(res, 200, { ok: true }); }
        return send(res, 200, { ok: false, message: '这个工具没有文件夹。' });
      }
      if (action === 'fix') {
        const body = await readJson(req);
        if (body.kind === 'install') {
          await stopTool(tool);
          return send(res, 200, await launchService(tool, { forceSetup: true }));
        }
        if (body.kind === 'freeport') {
          await stopTool(tool);
          for (const pid of await pidsOnPort(portOf(tool.health || tool.url))) await killTree(pid);
          await new Promise(r => setTimeout(r, 500));
          return send(res, 200, await launchService(tool));
        }
        return send(res, 400, { ok: false, message: '不认识的修复方式' });
      }
    }

    // ---- 随身口袋 + 末影箱：只在普通区
    if (p.startsWith('/api/pocket') || p.startsWith('/api/box')) {
      if (space === 'private') return send(res, 404, { error: '找不到' });
    }
    if (p === '/api/pocket' && req.method === 'GET') {
      return send(res, 200, { items: box.list(), box: box.info(), temp: TEMP_MODE });
    }
    if (p === '/api/pocket/upload' && req.method === 'POST') {
      let name = cleanName(url.searchParams.get('name') || '') || '文件';
      if (name.startsWith('~$')) name = name.slice(2) || '文件';
      const buf = await readBody(req, 2 * 1024 * 1024 * 1024);
      const target = pocketFile(name);
      if (!target) return send(res, 400, { ok: false, message: '名字不合法' });
      // 同名文件：内容一样就不重复放；不一样就换成新的，旧的进回收站
      if (fs.existsSync(target)) {
        const same = fs.statSync(target).size === buf.length && fs.readFileSync(target).equals(buf);
        if (same) return send(res, 200, { ok: true, name, same: true });
        moveToTrash({ trash: POCKET_TRASH }, target, name);
      }
      fs.writeFileSync(target, buf);
      box.kick(1500);
      return send(res, 200, { ok: true, name });
    }
    if (p === '/api/pocket/delete' && req.method === 'POST') {
      const body = await readJson(req);
      const f = pocketFile(body.name);
      if (!f) return send(res, 400, { ok: false, message: '名字不合法' });
      if (fs.existsSync(f)) { moveToTrash({ trash: POCKET_TRASH }, f, path.basename(f)); box.kick(1500); return send(res, 200, { ok: true }); }
      if (box.dropRemote(path.basename(f))) return send(res, 200, { ok: true });
      return send(res, 200, { ok: false, message: '找不到这个文件了。' });
    }
    if (p === '/api/pocket/pull' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, box.pull(String(body.name || '')) ? { ok: true } : { ok: false, message: '云端没有这个文件了。' });
    }
    if (p === '/api/pocket/open' && req.method === 'POST') {
      const body = await readJson(req);
      const f = pocketFile(body.name);
      if (!f || !fs.existsSync(f)) return send(res, 200, { ok: false, message: '找不到这个文件。' });
      openInSystem(f);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/pocket/folder' && req.method === 'POST') {
      fs.mkdirSync(POCKET_DIR, { recursive: true });
      openFolder(POCKET_DIR);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/pocket/trash' && req.method === 'GET') {
      return send(res, 200, { items: listTrash({ trash: POCKET_TRASH }) });
    }
    if (p === '/api/pocket/restore' && req.method === 'POST') {
      const body = await readJson(req);
      const src = safeJoin(POCKET_TRASH, String(body.name || ''));
      if (!src || path.dirname(src) !== POCKET_TRASH || !fs.existsSync(src)) return send(res, 200, { ok: false, message: '回收站里找不到它了。' });
      const name = uniqueName(POCKET_DIR, path.basename(src));
      fs.renameSync(src, path.join(POCKET_DIR, name));
      box.kick(1500);
      return send(res, 200, { ok: true, name });
    }
    if (p === '/api/box' && req.method === 'GET') {
      return send(res, 200, { ...box.info(), temp: TEMP_MODE, hostname: os.hostname() });
    }
    if (p === '/api/box/connect' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await box.connect(body);
      if (r.ok) { box.start(); r.box = box.info(); }
      return send(res, 200, r);
    }
    if (p === '/api/box/code' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, box.makeCode(String(body.password || '')));
    }
    if (p === '/api/box/sync' && req.method === 'POST') {
      const r = await box.sync('manual');
      return send(res, 200, { ...r, box: box.info() });
    }
    if (p === '/api/box/disconnect' && req.method === 'POST') {
      box.stop();
      box.disconnect();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/notes' && req.method === 'GET') {
      const d = spaceDirs(space);
      queueIndex(d);
      return send(res, 200, {
        notes: listNotes(d).map(({ text, ...n }) => n),
        files: listFiles(d),
        trash: listTrash(d).length,
      });
    }
    if ((m = /^\/api\/notes\/(.+)$/.exec(p))) {
      const d = spaceDirs(space);
      const id = cleanName(m[1]);
      const file = id && safeJoin(d.root, id + '.md');
      if (!file) return send(res, 400, { error: '名字不合法' });
      if (req.method === 'GET') {
        if (!fs.existsSync(file)) return send(res, 404, { error: '找不到这篇' });
        if (url.searchParams.get('view') === '1' && space === 'main') record('说明', id);
        const text = fs.readFileSync(file, 'utf8');
        return send(res, 200, { id, text, ...parseNote(id, text), updated: fs.statSync(file).mtimeMs });
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const text = String(body.text || '');
        // 标题改了就顺便改文件名
        let newId = cleanName(parseNote(id, text).title) || id;
        let target = safeJoin(d.root, newId + '.md');
        if (newId !== id && fs.existsSync(target)) { newId = id; target = file; }
        fs.writeFileSync(target, text, 'utf8');
        if (target !== file && fs.existsSync(file)) fs.unlinkSync(file);
        if (newId !== id) binderRename(d, 'note', id, newId);
        if (space === 'main') recordAction('修改');
        return send(res, 200, { ok: true, id: newId });
      }
      if (req.method === 'DELETE') {
        if (fs.existsSync(file)) moveToTrash(d, file, id + '.md');
        return send(res, 200, { ok: true });
      }
    }
    if (p === '/api/new-note' && req.method === 'POST') {
      const d = spaceDirs(space);
      const body = await readJson(req);
      const title = cleanName(body.title || '') || '新的说明';
      const name = uniqueName(d.root, title + '.md');
      const id = name.replace(/\.md$/i, '');
      const text = body.text ? String(body.text).replace(/^# .*$/m, `# ${id}`) : `# ${id}\n标签: \n\n## 速查\n- \n\n## 详细\n\n`;
      fs.writeFileSync(path.join(d.root, name), text, 'utf8');
      if (body.page) binderPut(d, 'note', id, String(body.page));
      if (space === 'main') recordAction('新建');
      return send(res, 200, { ok: true, id });
    }
    if (p === '/api/pages' && req.method === 'GET') {
      return send(res, 200, binderView(spaceDirs(space)));
    }
    if (p === '/api/pages' && req.method === 'POST') {
      const d = spaceDirs(space);
      const body = await readJson(req);
      const b = readBinder(d);
      const page = b.pages.find(x => x.id === body.id);
      const act = body.action;
      if (act === 'create') {
        const name = String(body.name || '').trim().slice(0, 20);
        if (!name) return send(res, 200, { ok: false, message: '给活页起个名字。' });
        if (b.pages.some(x => x.name === name)) return send(res, 200, { ok: false, message: `已经有一张叫"${name}"的活页了。` });
        const used = new Set(b.pages.map(x => x.color));
        let color = Number.isInteger(body.color) ? body.color : [...Array(PAGE_COLORS).keys()].find(c => !used.has(c));
        if (color === undefined) color = b.pages.length % PAGE_COLORS;
        const np = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, color, created: Date.now() };
        // 新的活页放在最前面
        b.pages.unshift(np);
        writeBinder(d, b);
        return send(res, 200, { ok: true, page: np });
      }
      if (!page && act !== 'put' && act !== 'top') return send(res, 200, { ok: false, message: '找不到这张活页。' });
      if (act === 'rename') {
        const name = String(body.name || '').trim().slice(0, 20);
        if (!name) return send(res, 200, { ok: false, message: '名字不能是空的。' });
        if (b.pages.some(x => x.name === name && x.id !== page.id)) return send(res, 200, { ok: false, message: `已经有一张叫"${name}"的活页了。` });
        page.name = name;
      } else if (act === 'color') {
        page.color = Math.max(0, Math.min(PAGE_COLORS - 1, Number(body.color) || 0));
      } else if (act === 'delete') {
        // 活页删掉，里面的东西回到下面的列表，不会丢
        b.pages = b.pages.filter(x => x.id !== page.id);
        for (const k of Object.keys(b.items)) if (b.items[k] === page.id) delete b.items[k];
      } else if (act === 'pin') {
        page.pinned = !!body.on;
      } else if (act === 'archive') {
        // 放进档案盒：平时不显示标签，里面的东西照样搜得到
        page.archived = !!body.on;
        if (page.archived) page.pinned = false;
      } else if (act === 'top') {
        for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 100)) {
          if (!it || !['note', 'file'].includes(it.kind) || !it.id) continue;
          const k = binderKey(it.kind, String(it.id));
          if (body.on) b.top[k] = Date.now(); else delete b.top[k];
        }
      } else if (act === 'move') {
        const from = b.pages.indexOf(page);
        b.pages.splice(from, 1);
        let to;
        if (body.before) {
          const k = b.pages.findIndex(x => x.id === body.before);
          to = k < 0 ? b.pages.length : k;
        } else {
          to = Math.max(0, Math.min(b.pages.length, Number(body.to)));
        }
        b.pages.splice(to, 0, page);
      } else if (act === 'put') {
        const target = body.page ? b.pages.find(x => x.id === body.page) : null;
        if (body.page && !target) return send(res, 200, { ok: false, message: '找不到这张活页。' });
        for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 500)) {
          if (!it || !['note', 'file'].includes(it.kind) || !it.id) continue;
          const k = binderKey(it.kind, String(it.id));
          if (target) b.items[k] = target.id; else delete b.items[k];
        }
      } else {
        return send(res, 200, { ok: false, message: '不认识的操作。' });
      }
      writeBinder(d, b);
      return send(res, 200, { ok: true, ...binderView(d) });
    }
    // ---- 导出 / 导入一整张活页（.bbpage，其实是 zip）
    if (p === '/api/pages/export' && req.method === 'GET') {
      const d = spaceDirs(space);
      const b = readBinder(d);
      const page = b.pages.find(x => x.id === url.searchParams.get('id'));
      if (!page) return send(res, 404, { error: '找不到这张活页' });
      const entries = [];
      const notes = [], files = [], images = new Set();
      for (const [k, pid] of Object.entries(b.items)) {
        if (pid !== page.id) continue;
        if (k.startsWith('note:')) {
          const id = k.slice(5);
          const f = safeJoin(d.root, id + '.md');
          if (!f || !fs.existsSync(f)) continue;
          const text = fs.readFileSync(f, 'utf8');
          for (const m2 of text.matchAll(/\/(?:记忆区|私密区)\/图片\/([^)\s"'<>]+)/g)) { try { images.add(decodeURIComponent(m2[1])); } catch {} }
          entries.push({ name: 'notes/' + id + '.md', data: text });
          notes.push(id);
        } else if (k.startsWith('file:')) {
          const name = k.slice(5);
          const f = safeJoin(d.files, name);
          if (!f || path.dirname(f) !== d.files || !fs.existsSync(f)) continue;
          entries.push({ name: 'files/' + name, data: fs.readFileSync(f) });
          files.push(name);
        }
      }
      for (const im of images) {
        const f = safeJoin(d.images, im);
        if (f && path.dirname(f) === d.images && fs.existsSync(f)) entries.push({ name: 'images/' + im, data: fs.readFileSync(f) });
      }
      entries.unshift({ name: 'manifest.json', data: JSON.stringify({ app: '百宝匣', kind: '活页', version: VERSION, name: page.name, color: page.color, notes, files, top: Object.keys(b.top).filter(k => b.items[k] === page.id), exported: new Date().toISOString() }, null, 1) });
      const zip = require('./lib/zipw.js').makeZip(entries);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="page.bbpage"; filename*=UTF-8''${encodeURIComponent(page.name + '.bbpage')}`,
        'Content-Length': zip.length,
        'Cache-Control': 'no-store',
      });
      return res.end(zip);
    }
    if (p === '/api/pages/import' && req.method === 'POST') {
      const d = spaceDirs(space);
      let zip, man;
      try {
        zip = docs.readZip(await readBody(req));
        man = JSON.parse(zip.get('manifest.json').toString('utf8'));
      } catch { return send(res, 200, { ok: false, message: '这不是百宝匣导出的活页文件。' }); }
      if (!man || man.kind !== '活页') return send(res, 200, { ok: false, message: '这不是百宝匣导出的活页文件。' });
      const b = readBinder(d);
      let name = String(man.name || '导入的活页').slice(0, 18) || '导入的活页';
      for (let i = 2; b.pages.some(x => x.name === name); i++) name = String(man.name).slice(0, 15) + ` (${i})`;
      const np = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, color: Number.isInteger(man.color) ? man.color % PAGE_COLORS : 0, created: Date.now() };
      b.pages.unshift(np);
      // 图片先放好，记下新名字，说明里的图片地址跟着改
      const imgMap = {};
      for (const n of zip.names()) {
        if (!n.startsWith('images/') || n.endsWith('/')) continue;
        const orig = cleanName(n.slice(7));
        if (!orig || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(orig)) continue;
        const nn = uniqueName(d.images, orig);
        fs.writeFileSync(path.join(d.images, nn), zip.get(n));
        imgMap[orig] = nn;
      }
      let count = 0;
      const topKeys = new Set(Array.isArray(man.top) ? man.top : []);
      for (const n of zip.names()) {
        if (n.endsWith('/')) continue;
        if (n.startsWith('notes/') && /\.md$/i.test(n)) {
          const id0 = cleanName(n.slice(6).replace(/\.md$/i, ''));
          if (!id0) continue;
          const fname = uniqueName(d.root, id0 + '.md');
          const id = fname.replace(/\.md$/i, '');
          let text = zip.get(n).toString('utf8').replace(/\/(?:记忆区|私密区)\/图片\/([^)\s"'<>]+)/g, (all, enc) => {
            let orig; try { orig = decodeURIComponent(enc); } catch { return all; }
            return imgMap[orig] ? `${d.url}图片/${encUrl(imgMap[orig])}` : all;
          });
          if (id !== id0) text = text.replace(/^# .*$/m, `# ${id}`);
          fs.writeFileSync(path.join(d.root, fname), text, 'utf8');
          b.items[binderKey('note', id)] = np.id;
          if (topKeys.has('note:' + id0)) b.top[binderKey('note', id)] = Date.now();
          count++;
        } else if (n.startsWith('files/')) {
          const orig = cleanName(n.slice(6));
          if (!orig) continue;
          const nn = uniqueName(d.files, orig);
          fs.writeFileSync(path.join(d.files, nn), zip.get(n));
          b.items[binderKey('file', nn)] = np.id;
          if (topKeys.has('file:' + orig)) b.top[binderKey('file', nn)] = Date.now();
          count++;
        }
      }
      writeBinder(d, b);
      queueIndex(d);
      return send(res, 200, { ok: true, page: np, count });
    }
    // ---- 小更新包（.bbupdate）：先检查，确认后再装
    if ((p === '/api/update/check' || p === '/api/update/apply') && req.method === 'POST') {
      const updater = require('./lib/update.js');
      let info;
      try { info = updater.inspect(await readBody(req, 60 * 1024 * 1024), VERSION, { electron: process.versions.electron }); }
      catch { return send(res, 200, { ok: false, message: '这不是百宝匣的更新包。' }); }
      if (!info.ok) return send(res, 200, info);
      const brief = { ok: true, version: info.version, current: info.current, newer: info.newer, same: info.same, notes: info.notes, count: info.files.length, desktop: !!DESKTOP };
      if (p === '/api/update/check') return send(res, 200, brief);
      if (!info.newer && !info.same) return send(res, 200, { ok: false, message: `这个更新包是 ${info.version}，比你现在的 ${info.current} 还旧，没有安装。` });
      const r = updater.apply(info, CODE, path.join(ROOT, '恢复前的旧文件'));
      if (!r.ok) return send(res, 200, r);
      send(res, 200, { ...brief, installed: true, backup: r.backup, restart: DESKTOP && DESKTOP.relaunch ? 'auto' : 'manual' });
      if (DESKTOP && DESKTOP.relaunch) setTimeout(() => DESKTOP.relaunch(), 800);
      return;
    }
    // ---- Word / Excel / PPT：在百宝匣里看、用系统软件打开、变成说明
    if (p === '/api/office' && req.method === 'GET') {
      const d = spaceDirs(space);
      const name = url.searchParams.get('name') || '';
      const f = safeJoin(d.files, name);
      if (!f || path.dirname(f) !== d.files || !fs.existsSync(f)) return send(res, 200, { ok: false, message: '找不到这个文件。' });
      if (!office.OFFICE_EXT.test(name)) return send(res, 200, { ok: false, message: '这不是 Word / Excel / PPT 文件。' });
      try {
        const base = `/办公/${d.space}/${encodeURIComponent(name)}/`;
        const html = office.officeHtml(f, inner => base + inner.split('/').map(encodeURIComponent).join('/'));
        if (space === 'main') recordFileOpen(name);
        return send(res, 200, { ok: true, name, kind: path.extname(name).slice(1).toLowerCase(), html, size: fs.statSync(f).size });
      } catch (e) {
        return send(res, 200, { ok: false, message: '这个文件打不开，可能已经损坏，或者不是新版格式。可以试试"用系统软件打开"。' });
      }
    }
    if (p === '/api/office/to-note' && req.method === 'POST') {
      const d = spaceDirs(space);
      const body = await readJson(req);
      const name = String(body.name || '');
      const f = safeJoin(d.files, name);
      if (!f || path.dirname(f) !== d.files || !fs.existsSync(f) || !office.OFFICE_EXT.test(name)) return send(res, 200, { ok: false, message: '找不到这个文件。' });
      let md = '';
      try { md = office.officeMarkdown(f); } catch { return send(res, 200, { ok: false, message: '这个文件读不出来。' }); }
      const title = cleanName(name.replace(/\.[^.]+$/, '')) || '文档';
      const noteName = uniqueName(d.root, title + '.md');
      const id = noteName.replace(/\.md$/i, '');
      fs.writeFileSync(path.join(d.root, noteName), `# ${id}\n标签: 资料\n\n> 从"${name}"转过来的，原文件还在资料里。\n\n${md}\n`, 'utf8');
      const pid = readBinder(d).items[binderKey('file', name)];
      if (pid) binderPut(d, 'note', id, pid);
      if (space === 'main') recordAction('新建');
      return send(res, 200, { ok: true, id });
    }
    if (p === '/api/files/open' && req.method === 'POST') {
      const d = spaceDirs(space);
      const body = await readJson(req);
      const f = safeJoin(d.files, String(body.name || ''));
      if (!f || path.dirname(f) !== d.files || !fs.existsSync(f)) return send(res, 200, { ok: false, message: '找不到这个文件。' });
      openInSystem(f);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/search' && req.method === 'GET') {
      return send(res, 200, search(url.searchParams.get('q') || '', spaceDirs(space)));
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const d = spaceDirs(space);
      const kind = url.searchParams.get('kind') === 'image' ? 'image' : 'file';
      let name = cleanName(url.searchParams.get('name') || '') || (kind === 'image' ? '图片.png' : '文件');
      const dir = kind === 'image' ? d.images : d.files;
      // 拖进来的 .md 文件直接变成一篇说明
      const toNote = kind === 'file' && /\.md$/i.test(name);
      const target = toNote ? d.root : dir;
      name = uniqueName(target, name);
      fs.writeFileSync(path.join(target, name), await readBody(req));
      if (kind === 'file' && !toNote) queueIndex(d);
      const pageId = url.searchParams.get('page');
      if (kind === 'file' && pageId) binderPut(d, toNote ? 'note' : 'file', toNote ? name.replace(/\.md$/i, '') : name, pageId);
      return send(res, 200, {
        warn: kind === 'file' && office.OLD_OFFICE_EXT.test(name) ? `"${name}"是老格式，百宝匣看不了里面的内容，也搜不到。用 Word / Excel 打开它，另存为新格式（.docx / .xlsx / .pptx）再拖进来就好了。` : '',
        ok: true, name,
        note: toNote ? name.replace(/\.md$/i, '') : null,
        url: `${d.url}${kind === 'image' ? '图片' : '资料'}/${encUrl(name)}`,
      });
    }

    // ---- 回收站
    if (p === '/api/trash' && req.method === 'GET') {
      return send(res, 200, { items: listTrash(spaceDirs(space)) });
    }
    if (p === '/api/trash/restore' && req.method === 'POST') {
      const d = spaceDirs(space);
      const body = await readJson(req);
      const src = safeJoin(d.trash, String(body.name || ''));
      if (!src || path.dirname(src) !== d.trash || !fs.existsSync(src)) return send(res, 200, { ok: false, message: '回收站里找不到它了。' });
      const isNote = /\.md$/i.test(src);
      const destDir = isNote ? d.root : d.files;
      const name = uniqueName(destDir, path.basename(src));
      fs.renameSync(src, path.join(destDir, name));
      if (!isNote) queueIndex(d);
      return send(res, 200, { ok: true, name, kind: isNote ? 'note' : 'file', id: isNote ? name.replace(/\.md$/i, '') : null });
    }
    if (p === '/api/trash/delete' && req.method === 'POST') {
      const d = spaceDirs(space);
      const body = await readJson(req);
      if (body.all) {
        const failed = [];
        let names = [];
        try { names = fs.existsSync(d.trash) ? fs.readdirSync(d.trash) : []; } catch {}
        for (const n of names) {
          const f = path.join(d.trash, n);
          if (path.dirname(f) !== d.trash) continue;
          const r = hardDelete(f, d);
          if (!r.ok) failed.push({ name: n, code: r.code });
        }
        return send(res, 200, { ok: !failed.length, failed: failed.length, names: failed.map(x => x.name), message: failed.length ? deleteFailMessage(failed[0].code) : '' });
      }
      const f = safeJoin(d.trash, String(body.name || ''));
      if (!f || path.dirname(f) !== d.trash) return send(res, 200, { ok: false, message: '找不到。' });
      const r = hardDelete(f, d);
      if (!r.ok) return send(res, 200, { ok: false, message: deleteFailMessage(r.code) });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/trash/open-folder' && req.method === 'POST') {
      const d = spaceDirs(space);
      fs.mkdirSync(d.trash, { recursive: true });
      openFolder(d.trash);
      return send(res, 200, { ok: true });
    }

    // ---- 电子书
    if (p === '/api/epub' && req.method === 'GET') {
      const d = spaceDirs(space);
      const f = safeJoin(d.files, url.searchParams.get('name') || '');
      if (!f || path.dirname(f) !== d.files || !fs.existsSync(f)) return send(res, 200, { ok: false, message: '找不到这本书。' });
      try {
        const info = epubFor(f);
        if (space === 'main') recordFileOpen(path.basename(f));
        return send(res, 200, { ok: true, title: info.title, author: info.author, chapters: info.chapters });
      } catch (e) {
        return send(res, 200, { ok: false, message: '这本电子书打不开：' + e.message });
      }
    }

    // ---- 栏目
    if (p === '/api/layout' && req.method === 'GET') {
      return send(res, 200, readLayout(space));
    }
    if (p === '/api/sections' && req.method === 'POST') {
      const body = await readJson(req);
      const { sections } = readLayout(space);
      const mine = t => (space === 'private' ? !!t['私密'] : !t['私密']);
      const name = cleanSection(body.name);
      if (body.action === 'add') {
        if (!name) return send(res, 200, { ok: false, message: '请填写栏目名字。' });
        if (name === '未分类' || sections.some(x => x.name === name)) return send(res, 200, { ok: false, message: `已经有"${name}"这个栏目了。` });
        sections.push({ name, icon: String(body.icon || '').slice(0, 8) });
        writeLayout(sections, space);
        return send(res, 200, { ok: true, name });
      }
      const i = sections.findIndex(x => x.name === name);
      if (i < 0) return send(res, 200, { ok: false, message: '找不到这个栏目，刷新一下页面。' });
      if (body.action === 'rename') {
        const nn = cleanSection(body.newName);
        if (!nn) return send(res, 200, { ok: false, message: '请填写新名字。' });
        if (nn !== name && (nn === '未分类' || sections.some(x => x.name === nn))) return send(res, 200, { ok: false, message: `已经有"${nn}"这个栏目了。` });
        sections[i].name = nn;
        if (body.icon !== undefined) sections[i].icon = String(body.icon || '').slice(0, 8);
        const list = readRawList();
        for (const t of list) if (mine(t) && t['栏目'] === name) t['栏目'] = nn;
        writeRawList(list);
        writeLayout(sections, space);
        return send(res, 200, { ok: true, name: nn });
      }
      if (body.action === 'delete') {
        sections.splice(i, 1);
        const list = readRawList();
        for (const t of list) if (mine(t) && t['栏目'] === name) delete t['栏目'];
        writeRawList(list);
        writeLayout(sections, space);
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { ok: false, message: '不认识的操作' });
    }
    // 拖动后保存：sections 是栏目顺序，tools 是工具的新顺序和所在栏目
    if (p === '/api/arrange' && req.method === 'POST') {
      const body = await readJson(req);
      const layout = readLayout(space);
      const list = readRawList();
      const tools = readTools().tools.filter(t => inSpace(t, space) && canSee(req, t));
      if (Array.isArray(body.sections)) {
        const byName = new Map(layout.sections.map(x => [x.name, x]));
        const next = body.sections.map(n => byName.get(n)).filter(Boolean);
        for (const x of layout.sections) if (!next.includes(x)) next.push(x);
        writeLayout(next, space);
        layout.sections = next;
      }
      if (Array.isArray(body.tools)) {
        const valid = new Set(layout.sections.map(x => x.name));
        const used = new Set();
        const out = [];
        for (const item of body.tools) {
          const t = tools.find(x => x.id === item.id);
          if (!t || used.has(t.index)) continue;
          used.add(t.index);
          const raw = list[t.index];
          if (item.section && valid.has(item.section)) raw['栏目'] = item.section;
          else delete raw['栏目'];
          out.push(raw);
        }
        // 页面上没出现的（比如藏起来的私密工具）放在后面，栏目不变
        list.forEach((raw, i) => { if (!used.has(i)) out.push(raw); });
        writeRawList(out);
      }
      return send(res, 200, { ok: true });
    }

    // ---- 资料：改名、删除
    if ((m = /^\/api\/files\/(.+)$/.exec(p)) && (req.method === 'PUT' || req.method === 'DELETE')) {
      const d = spaceDirs(space);
      const name = m[1];
      const file = safeJoin(d.files, name);
      if (!file || path.dirname(file) !== d.files || !fs.existsSync(file)) return send(res, 200, { ok: false, message: '找不到这个文件，刷新一下页面。' });
      if (req.method === 'DELETE') {
        moveToTrash(d, file, name);
        try { fs.unlinkSync(indexPath(d, name)); } catch {}
        return send(res, 200, { ok: true });
      }
      const body = await readJson(req);
      let nn = cleanName(body.newName || '');
      if (!nn) return send(res, 200, { ok: false, message: '请填写新名字。' });
      if (!path.extname(nn) && path.extname(name)) nn += path.extname(name);
      if (nn === name) return send(res, 200, { ok: true, name });
      if (fs.existsSync(path.join(d.files, nn))) return send(res, 200, { ok: false, message: `已经有一个叫"${nn}"的文件了。` });
      releaseHandles(file);
      fs.renameSync(file, path.join(d.files, nn));
      try { fs.renameSync(indexPath(d, name), indexPath(d, nn)); } catch {}
      binderRename(d, 'file', name, nn);
      return send(res, 200, { ok: true, name: nn });
    }

    // ---- 关闭百宝匣
    if (p === '/api/running' && req.method === 'GET') {
      const st = await statusAll();
      const tools = readTools().tools;
      return send(res, 200, { running: st.status.filter(x => x.state === 'running' && canSee(req, tools.find(y => y.id === x.id) || {})).map(x => x.id) });
    }
    if (p === '/api/shutdown' && req.method === 'POST') {
      const body = await readJson(req);
      send(res, 200, { ok: true });
      setTimeout(() => shutdown(body.stopTools !== false), 200);
      return;
    }

    // ---- 开机自启（Windows）
    if (p === '/api/autostart') {
      if (DESKTOP) {
        // 桌面版：用系统的"开机启动"，开机后藏在托盘里
        if (req.method === 'POST') {
          const body = await readJson(req);
          DESKTOP.setAutostart(!!body.on);
          if (body.on && STARTUP_FILE && fs.existsSync(STARTUP_FILE)) { try { fs.unlinkSync(STARTUP_FILE); } catch {} }
        }
        return send(res, 200, { supported: DESKTOP.autostartSupported(), on: DESKTOP.getAutostart(), desktop: true });
      }
      if (!STARTUP_FILE) return send(res, 200, { supported: false, on: false });
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (body.on) {
          // 用 VBS 在后台悄悄启动：不弹黑色窗口，也不自动打开浏览器
          const q = s => s.replace(/"/g, '""');
          const nodeExe = q(process.execPath);
          const serverJs = q(path.join(CODE, 'server.js'));
          const vbs = [
            "' 百宝匣开机自启。删掉这个文件就不会开机启动了。",
            'Set sh = CreateObject("WScript.Shell")',
            'sh.Environment("Process")("BAIBAO_NO_OPEN") = "1"',
            'sh.CurrentDirectory = "' + q(CODE) + '"',
            'sh.Run """' + nodeExe + '"" ""' + serverJs + '""", 0, False',
            '',
          ].join('\r\n');
          fs.mkdirSync(path.dirname(STARTUP_FILE), { recursive: true });
          // UTF-16 带 BOM，中文路径才不会乱码
          fs.writeFileSync(STARTUP_FILE, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
        } else if (fs.existsSync(STARTUP_FILE)) {
          fs.unlinkSync(STARTUP_FILE);
        }
      }
      return send(res, 200, { supported: true, on: fs.existsSync(STARTUP_FILE) });
    }

    // ---- 0.7 新功能
    if (p === '/api/ping') {
      return send(res, 200, { ok: true, app: '百宝匣', version: VERSION });
    }
    if (p === '/api/github/fetch' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await githubFetch(body.url, body.dest));
    }
    if (p === '/api/checkup' && req.method === 'GET') {
      if (space === 'private') return send(res, 200, { report: null });
      return send(res, 200, { report: readSettings()['上次体检'] || null, running: checkupRunning });
    }
    if (p === '/api/checkup' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await runCheckup(!!body.deep, req, space));
    }
    if (p === '/api/stats' && req.method === 'GET') {
      return send(res, 200, statsReport());
    }
    if (p === '/api/stats/read' && req.method === 'POST') {
      const body = await readJson(req);
      if (space === 'main' && body.name) record('读书', String(body.name).slice(0, 200), { 书名: String(body.title || '').slice(0, 100), 章: Number(body.chapter) || 0, 共: Number(body.total) || 0 }, { count: false });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stats/search' && req.method === 'POST') {
      const body = await readJson(req);
      if (space === 'main') {
        const q = String(body.q || '').trim().slice(0, 40);
        if (q.length >= 2) record('搜索', q, { 结果: Number(body.found) || 0 });
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ai' && req.method === 'POST') {
      const body = await readJson(req);
      const cur = readSettings()['AI'] || {};
      const next = {
        '地址': body.baseUrl !== undefined ? String(body.baseUrl).trim() : cur['地址'] || '',
        '模型': body.model !== undefined ? String(body.model).trim() : cur['模型'] || '',
        // 密钥留空表示不改
        '密钥': body.key ? String(body.key).trim() : cur['密钥'] || '',
      };
      if (body.clearKey) next['密钥'] = '';
      writeSettings({ 'AI': next, 'AI用代理': !!body.useProxy });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ai/free' && req.method === 'POST') {
      const body = await readJson(req);
      writeSettings({ 'AI自由回答': !!body.on });
      return send(res, 200, { ok: true, on: !!body.on });
    }
    if (p === '/api/ai/test' && req.method === 'POST') {
      try {
        const r = await aiChat([{ role: 'user', content: '回复"连上了"三个字。' }], { maxTokens: 20 });
        return send(res, 200, { ok: true, reply: r.text.slice(0, 50) });
      } catch (e) {
        return send(res, 200, { ok: false, message: net.netError(e) });
      }
    }
    if (p === '/api/ai/summarize' && req.method === 'POST') {
      if (space === 'private') return send(res, 200, { ok: false, message: '私密区的内容不会发给 AI。' });
      return send(res, 200, await aiSummarize(spaceDirs(space), await readJson(req)));
    }
    if (p === '/api/ai/ask' && req.method === 'POST') {
      const body = await readJson(req);
      // 页面要求"边查边说"时，一行一个 JSON 地发回去：先是查找进度，最后是回答
      if (/ndjson/.test(req.headers.accept || '')) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const r = await butlerAsk(body, space, st => { try { res.write(JSON.stringify({ step: st }) + '\n'); } catch {} });
        return res.end(JSON.stringify({ done: r }) + '\n');
      }
      return send(res, 200, await butlerAsk(body, space));
    }
    if (p === '/api/butler' && req.method === 'GET') {
      const b = readButler(space);
      return send(res, 200, { ok: true, persona: b.persona, ...(space === 'private' ? { allowPrivate: b.allowPrivate } : {}), moods: butlerLib.MOODS });
    }
    if (p === '/api/butler' && req.method === 'POST') {
      const body = await readJson(req);
      writeButler(space, { persona: body.persona, allowPrivate: space === 'private' ? body.allowPrivate : undefined });
      return send(res, 200, { ok: true, ...readButler(space) });
    }
    if (p === '/api/clip' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await saveClip(body, spaceDirs('main'));
      if (r.ok) recordAction('剪藏');
      return send(res, 200, r);
    }
    if (p === '/api/booknotes' && req.method === 'GET') {
      return send(res, 200, readBookNotes(spaceDirs(space), url.searchParams.get('name') || ''));
    }
    if (p === '/api/booknotes' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { ok: true, ...writeBookNotes(spaceDirs(space), body.name || '', body) });
    }

    // ---- 私密密码
    if (p === '/api/skins' && req.method === 'GET') {
      const list = skins.listSkins(skinRoots(space));
      const original = { id: 'original', builtin: true, name: '原皮', author: '百宝匣', version: VERSION, fit: VERSION, desc: '深色木柜子 + 铜拉环，百宝匣最初的样子。', colors: ['#e8ebe4', '#2f4a43', '#b8964c', '#f7f5ee'], hasPrivate: true, preview: null };
      return send(res, 200, { skins: [original, ...list], current: currentSkin(space, req), app: VERSION });
    }
    if (p === '/api/skins/use' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.id || 'original');
      if (space === 'main' && id.startsWith('p-')) return send(res, 200, { ok: false, message: '找不到这套皮肤。' });
      if (id !== 'original' && !skinExists(id, req)) return send(res, 200, { ok: false, message: '找不到这套皮肤。' });
      writeSettings({ [space === 'private' ? '私密皮肤' : '皮肤']: id });
      return send(res, 200, { ok: true, id });
    }
    if (p === '/api/skins/import' && req.method === 'POST') {
      let buf;
      try { buf = await readBody(req, 31 * 1024 * 1024); } catch { return send(res, 200, { ok: false, message: '皮肤文件太大了（超过 30MB）。' }); }
      const name = url.searchParams.get('name') || '皮肤.bbskin';
      const priv = space === 'private';
      const r = skins.importSkin(buf, name, priv ? SKIN_PRIVATE : SKIN_USER);
      if (!r.ok) return send(res, 200, r);
      const id = (priv ? 'p-' : 'u-') + r.slug;
      return send(res, 200, { ok: true, id, name: r.meta.name, replaced: r.replaced, skipped: r.skipped });
    }
    if (p === '/api/skins/delete' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.id || '');
      if (!/^(u|p)-/.test(id) || (id.startsWith('p-') && space !== 'private')) return send(res, 200, { ok: false, message: '自带的皮肤不能删。' });
      const d = skinDir(id, req);
      if (!d || !fs.existsSync(d)) return send(res, 200, { ok: false, message: '找不到这套皮肤。' });
      fsx.removeTree(d);
      const st = readSettings();
      const patch = {};
      if (st['皮肤'] === id) patch['皮肤'] = 'original';
      if (st['私密皮肤'] === id) patch['私密皮肤'] = 'original';
      if (Object.keys(patch).length) writeSettings(patch);
      return send(res, 200, { ok: true, current: currentSkin(space, req) });
    }
    if (p === '/api/private' && req.method === 'GET') {
      return send(res, 200, { hasPassword: hasPassword(), unlocked: hasPassword() && isUnlocked(req) });
    }
    if (p === '/api/private/unlock' && req.method === 'POST') {
      const body = await readJson(req);
      if (!hasPassword()) return send(res, 200, { ok: false, message: '还没设密码。' });
      if (tooManyTries()) return send(res, 200, { ok: false, message: '输错太多次了，等一分钟再试。' });
      if (!checkPassword(body.password || '')) {
        failedTries.push(Date.now());
        return send(res, 200, { ok: false, message: '密码不对。' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      unlockTokens.set(token, Date.now() + UNLOCK_MS);
      res.setHeader('Set-Cookie', `bb_unlock=${token}; Path=/; HttpOnly; SameSite=Strict`);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/private/lock' && req.method === 'POST') {
      const t = cookieToken(req);
      if (t) unlockTokens.delete(t);
      res.setHeader('Set-Cookie', 'bb_unlock=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/private/main-tools' && req.method === 'GET') {
      if (!privateOk(req)) return send(res, 403, { ok: false, locked: true });
      return send(res, 200, { tools: readTools().tools.filter(t => !t.private).map(t => ({ id: t.id, name: t.name, icon: t.icon })) });
    }
    if (p === '/api/private/move-in' && req.method === 'POST') {
      if (!privateOk(req)) return send(res, 403, { ok: false, locked: true });
      const body = await readJson(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const tools = readTools().tools;
      const list = readRawList();
      let moved = 0;
      for (const t of tools) {
        if (!ids.has(t.id) || t.private) continue;
        list[t.index]['私密'] = true;
        delete list[t.index]['栏目'];
        moved++;
      }
      writeRawList(list);
      return send(res, 200, { ok: true, moved });
    }
    if (p === '/api/private/set' && req.method === 'POST') {
      const body = await readJson(req);
      if (hasPassword()) {
        if (tooManyTries()) return send(res, 200, { ok: false, message: '输错太多次了，等一分钟再试。' });
        if (!checkPassword(body.old || '')) { failedTries.push(Date.now()); return send(res, 200, { ok: false, message: '原来的密码不对。' }); }
      }
      const pw = String(body.password || '');
      if (pw && pw.length < 4) return send(res, 200, { ok: false, message: '密码至少 4 位。' });
      setPassword(pw);
      unlockTokens.clear();
      res.setHeader('Set-Cookie', 'bb_unlock=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return send(res, 200, { ok: true, hasPassword: !!pw });
    }

    // ---- 设置和备份
    if (p === '/api/settings' && req.method === 'GET') {
      const s = readSettings();
      return send(res, 200, {
        backupDir: s['备份位置'] || '',
        lastBackup: backupState.last || s['上次备份'] || null,
        backupError: backupState.error,
        suggestions: suggestBackupDirs(),
        hasPassword: hasPassword(),
        isWindows: IS_WIN,
        proxy: s['代理'] || '',
        ai: { baseUrl: (s['AI'] || {})['地址'] || '', model: (s['AI'] || {})['模型'] || '', hasKey: !!((s['AI'] || {})['密钥']), useProxy: !!s['AI用代理'], free: !!s['AI自由回答'] },
      });
    }
    if (p === '/api/settings/proxy' && req.method === 'POST') {
      const body = await readJson(req);
      let v = String(body.proxy || '').trim();
      if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
      if (v) { try { new URL(v); } catch { return send(res, 200, { ok: false, message: '代理地址的格式不对，应该像 http://127.0.0.1:7890' }); } }
      writeSettings({ '代理': v });
      return send(res, 200, { ok: true, proxy: v });
    }
    if (p === '/api/backup' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.dir !== undefined) {
        const dir = String(body.dir || '').trim().replace(/^"|"$/g, '');
        if (dir) {
          const full = path.resolve(dir);
          if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return send(res, 200, { ok: false, message: `找不到这个文件夹：${dir}` });
          if (full === ROOT || full.startsWith(ROOT + path.sep)) return send(res, 200, { ok: false, message: '备份位置不能放在百宝匣文件夹里面，要选一个别的地方（最好是网盘同步文件夹）。' });
          writeSettings({ '备份位置': full });
        } else {
          writeSettings({ '备份位置': '' });
          clearInterval(backupTimer);
          return send(res, 200, { ok: true, off: true });
        }
        scheduleBackups();
        return send(res, 200, { ok: !backupState.error, message: backupState.error, dest: backupState.dest, copied: backupState.copied });
      }
      return send(res, 200, runBackup());
    }
    if (p === '/api/backup/restore' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, restoreBackup(!!body.overwrite));
    }

    // ---- 截图识字
    if (p === '/api/ocr/snip' && req.method === 'POST') {
      return send(res, 200, await ocrSnip());
    }
    if (p === '/api/ocr/image' && req.method === 'POST') {
      const buf = await readBody(req, 30 * 1024 * 1024);
      if (!buf.length) return send(res, 200, { ok: false, message: '没收到图片。' });
      return send(res, 200, await ocrImage(buf));
    }

    // ---- 图标图片
    if (p === '/api/icon' && req.method === 'POST') {
      let name = cleanName(url.searchParams.get('name') || '') || 'icon.png';
      if (!/\.(png|jpe?g|gif|webp|ico)$/i.test(name)) return send(res, 200, { ok: false, message: '图标只支持 png、jpg、gif、webp、ico 图片。' });
      const buf = await readBody(req, 2 * 1024 * 1024);
      name = uniqueName(ICON_DIR, name);
      fs.writeFileSync(path.join(ICON_DIR, name), buf);
      return send(res, 200, { ok: true, icon: '图标/' + name });
    }

    if (p === '/api/open-memory-folder' && req.method === 'POST') {
      openFolder(spaceDirs(space).root);
      return send(res, 200, { ok: true });
    }

    if ((m = /^\/skin\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'GET') {
      const d = skinDir(m[1], req);
      const f = d && safeJoin(d, m[2]);
      if (!f || f.includes(`${path.sep}.`) && !d.includes(`${path.sep}.皮肤`)) return send(res, 404, { error: '找不到' });
      const ext = path.extname(f).toLowerCase();
      const type = ({ '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' })[ext];
      if (!type) return send(res, 404, { error: '找不到' });
      fs.readFile(f, (err, data) => {
        if (err) return send(res, 404, { error: '找不到' });
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': ext === '.css' || ext === '.json' ? 'no-cache' : 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; sandbox",
        });
        res.end(data);
      });
      return;
    }
    if (p.startsWith('/图标/') && req.method === 'GET') {
      const f = safeJoin(ICON_DIR, p.slice('/图标/'.length));
      if (!f) return send(res, 403, { error: 'forbidden' });
      return sendFile(res, f, req);
    }
    if (p.startsWith('/记忆区/')) {
      const f = safeJoin(MEMORY_DIR, p.slice('/记忆区/'.length));
      if (!f || f.includes(`${path.sep}.`)) return send(res, 403, { error: 'forbidden' });
      if (path.dirname(f) === FILES_DIR && !/^bytes=(?!0-)/.test(req.headers.range || '')) recordFileOpen(path.basename(f));
      return sendFile(res, f, req);
    }
    if (p.startsWith('/口袋/') && req.method === 'GET') {
      const f = pocketFile(p.slice('/口袋/'.length));
      if (!f) return send(res, 403, { error: 'forbidden' });
      return sendFile(res, f, req);
    }
    if (p.startsWith('/私密区/')) {
      if (!privateOk(req)) return send(res, 403, { error: '私密区已上锁' });
      const f = safeJoin(PRIVATE_DIR, p.slice('/私密区/'.length));
      if (!f || f.includes(`${path.sep}.`)) return send(res, 403, { error: 'forbidden' });
      return sendFile(res, f, req);
    }
    // Word / PPT 里的图片：/办公/main/文件名.docx/word/media/image1.png
    if ((m = /^\/办公\/(main|private)\/([^/]+)\/((?:word|ppt|xl)\/media\/[^/]+)$/.exec(p)) && req.method === 'GET') {
      if (m[1] === 'private' && !privateOk(req)) return send(res, 403, { error: '私密区已上锁' });
      const d = spaceDirs(m[1]);
      const f = safeJoin(d.files, m[2]);
      if (!f || path.dirname(f) !== d.files || !fs.existsSync(f) || !office.OFFICE_EXT.test(f)) return send(res, 404, { error: '找不到' });
      let data = null;
      try { data = docs.readZip(f).get(m[3]); } catch {}
      const ext = path.extname(m[3]).toLowerCase();
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' }[ext];
      if (!data || !type) return send(res, 404, { error: '找不到' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      return res.end(data);
    }
    // 电子书里的章节、图片、样式：/书/main/书名.epub/OEBPS/text/ch1.xhtml
    if ((m = /^\/书\/(main|private)\/([^/]+)\/(.+)$/.exec(p)) && req.method === 'GET') {
      if (m[1] === 'private' && !privateOk(req)) return send(res, 403, { error: '私密区已上锁' });
      const d = spaceDirs(m[1]);
      const f = safeJoin(d.files, m[2]);
      if (!f || path.dirname(f) !== d.files || !fs.existsSync(f)) return send(res, 404, { error: '找不到这本书' });
      let info;
      try { info = epubFor(f); } catch { return send(res, 404, { error: '打不开' }); }
      const inner = path.posix.normalize(m[3]);
      const data = inner.startsWith('..') ? null : info.zip.get(inner);
      if (!data) return send(res, 404, { error: '书里没有这个文件' });
      const ext = path.extname(inner).toLowerCase();
      const type = /\.x?html?$/.test(ext) ? 'text/html; charset=utf-8'
        : ({ '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        // 书里的脚本一律不让运行
        'Content-Security-Policy': "default-src 'self' data:; script-src 'none'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; font-src 'self' data:",
      });
      return res.end(data);
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      // 把普通区当前的皮肤直接写进页面，打开时不会先闪一下原皮
      let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      const off = url.searchParams.get('skin') === 'off';
      const id = off ? 'original' : currentSkin('main', req);
      if (id !== 'original') {
        html = html.replace('<link rel="stylesheet" href="/style.css">', `<link rel="stylesheet" href="/style.css">\n<link id="skin-css" rel="stylesheet" href="/skin/${encodeURIComponent(id)}/skin.css">`)
          .replace('<body>', `<body data-skin="${id.replace(/[^\w\u4e00-\u9fa5-]/g, '')}">`);
      }
      if (off) html = html.replace('<body', '<body data-skin-off="1"');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET') {
      const f = safeJoin(PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
      if (!f) return send(res, 403, { error: 'forbidden' });
      return sendFile(res, f, req);
    }
    send(res, 404, { error: '找不到' });
  } catch (e) {
    send(res, 500, { ok: false, message: '百宝匣出错了：' + e.message });
  }
});

// 问一下已经在运行的百宝匣是什么版本
function askRunning(method, pathName, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: HOST, port: PORT, path: pathName, method, timeout: 2000,
      headers: { 'X-Baibao': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

let retried = false;
server.on('error', async e => {
  if (e.code === 'EADDRINUSE') {
    const other = await askRunning('GET', '/api/version');
    if (DESKTOP) {
      // 桌面版：网页版百宝匣还开着，就让它退出（工具继续跑），由桌面版接手
      if (other && other.version && !retried) {
        retried = true;
        await askRunning('POST', '/api/shutdown', { stopTools: false });
        setTimeout(() => server.listen(PORT, HOST), 1500);
        return;
      }
      DESKTOP.fatal(`端口 ${PORT} 被别的程序占用了，百宝匣开不起来。\n可以重启一下电脑再试。`);
      return;
    }
    if (other && other.version === VERSION) {
      console.log(`百宝匣已经开着了，直接帮你打开页面：http://${HOST}:${PORT}`);
      openInSystem(`http://${HOST}:${PORT}`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (other && other.version && !retried) {
      // 后台是别的版本：让它退出（工具继续跑），换成这个
      retried = true;
      console.log(`发现旧版百宝匣（${other.version}）还在运行，正在换成新版 ${VERSION}…`);
      await askRunning('POST', '/api/shutdown', { stopTools: false });
      setTimeout(() => server.listen(PORT, HOST), 1500);
      return;
    }
    console.log('');
    console.log(`  端口 ${PORT} 被占用了，可能是旧版百宝匣还在后台运行。`);
    console.log('  请按 Ctrl+Shift+Esc 打开任务管理器 → 详细信息 → 结束所有 node.exe，');
    console.log('  然后重新双击"启动百宝匣.bat"。');
    console.log('');
    setTimeout(() => process.exit(1), 300);
  } else {
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  addBuiltins();
  scheduleBackups();
  queueIndex(spaceDirs('main'));
  box.start();
  const { tools, error } = readTools();
  console.log('');
  console.log('  百宝匣已启动');
  console.log(`  页面地址：http://${HOST}:${PORT}`);
  console.log(`  工具 ${tools.length} 个${error ? '（tools.json 有问题：' + error + '）' : ''}`);
  console.log('  这个窗口别关，关掉百宝匣就停了（由它开的工具也会一起关掉）。');
  console.log('');
  if (DESKTOP) DESKTOP.ready();
  else if (!process.env.BAIBAO_NO_OPEN) openInSystem(`http://${HOST}:${PORT}`);
});

// 万一哪里出了没想到的错，记下来，但百宝匣继续运行，不要整个崩掉
function logCrash(e) {
  try { fs.appendFileSync(path.join(LOG_DIR, '百宝匣出错.log'), `[${new Date().toLocaleString('zh-CN')}] ${(e && e.stack) || e}\n`); } catch {}
}
process.on('uncaughtException', e => { if (e && e.code === 'EADDRINUSE') return; logCrash(e); });
process.on('unhandledRejection', e => logCrash(e));

// 关闭百宝匣时，把它开的工具一起关掉
let exiting = false;
async function shutdown(stopTools = true) {
  if (exiting) return;
  exiting = true;
  // 末影箱还有没传上去的，退出前最多再等 20 秒
  if (box.connected()) {
    box.stop();
    await Promise.race([box.sync('exit').catch(() => {}), new Promise(r => setTimeout(r, 20000))]);
  }
  if (stopTools) await Promise.all([...procs.values()].map(e => killTree(e.child.pid)));
  else for (const e of procs.values()) { try { e.child.unref(); } catch {} }
  console.log(stopTools ? '百宝匣已关闭。' : '百宝匣已关闭，工具还在继续运行。');
  if (DESKTOP) DESKTOP.beforeExit();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => shutdown(true)); } catch {}
}

// 桌面版要用到的几样东西
module.exports = { VERSION, PORT, HOST, ROOT, TEMP_MODE, readSettings, writeSettings, shutdown };
