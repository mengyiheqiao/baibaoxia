// 打包百宝匣。Windows / macOS / Linux 上都能运行，只需要 Node.js 20+。
//
//   node scripts/build.js web        网页版压缩包（要装 Node.js 才能用）
//   node scripts/build.js desktop    Windows 桌面版压缩包（自动下载 Electron；要先 npm install 装好 resedit）
//   node scripts/build.js update     小更新包 .bbupdate（可加 --from 0.11.0 --notes "这次改了什么"）
//   node scripts/build.js all        上面三个都做
//
// 做好的文件放在 dist 文件夹里。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readZip } = require('../lib/docs');
const { makeZip } = require('../lib/zipw');
const updater = require('../lib/update');

const SRC = path.resolve(__dirname, '..');
const DIST = path.join(SRC, 'dist');
const CACHE = path.join(DIST, 'cache');
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const ELECTRON = String((pkg.devDependencies || {}).electron || '').replace(/^[^\d]*/, '');

// 程序本身（两个版本都要）
const APP_FILES = ['server.js', 'package.json', 'lib', 'public', 'desktop', 'defaults'];
// 用户直接看得到的东西
const EXTRA_FILES = ['浏览器插件', '皮肤示例', 'LICENSE'];

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };

// 把文件夹里的文件都列出来：[{ name: 压缩包里的路径, file: 磁盘上的路径 }]
function collect(rel, prefix) {
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [{ name: prefix + rel, file: abs }];
  const out = [];
  for (const n of fs.readdirSync(abs)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    out.push(...collect(rel + '/' + n, prefix));
  }
  return out;
}
const load = list => list.map(e => ({ name: e.name, data: fs.readFileSync(e.file) }));

function assertUnique(entries) {
  const seen = new Set();
  for (const e of entries) { if (seen.has(e.name)) throw new Error('压缩包里有重名文件：' + e.name); seen.add(e.name); }
  return entries;
}

function save(name, buf) {
  fs.mkdirSync(DIST, { recursive: true });
  const f = path.join(DIST, name);
  fs.writeFileSync(f, buf);
  console.log(`  做好了 ${path.relative(SRC, f)}（${(buf.length / 1048576).toFixed(1)} MB）`);
  return f;
}

// ---------------------------------------------------------------- 网页版

function buildWeb() {
  console.log('网页版…');
  const top = '百宝匣/';
  const entries = load([
    ...APP_FILES.flatMap(f => collect(f, top)),
    ...EXTRA_FILES.flatMap(f => collect(f, top)),
    ...collect('启动百宝匣.bat', top),
  ]);
  return save(`百宝匣-网页版-${VERSION}.zip`, makeZip(assertUnique(entries)));
}

// ---------------------------------------------------------------- 桌面版（Windows）

async function download(url, file) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  console.log('  下载', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败（${res.status}）：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

function patchExe(buf, icoFile) {
  let ResEdit;
  try { ResEdit = require('resedit'); } catch {
    throw new Error('缺少 resedit。先在项目文件夹里运行：npm install --ignore-scripts');
  }
  const exe = ResEdit.NtExecutable.from(buf, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(icoFile));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, groups.length ? groups[0].id : 1, groups.length ? groups[0].lang : 1033, icon.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [a, b, c] = VERSION.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  const strings = { FileDescription: '百宝匣', ProductName: '百宝匣', InternalName: '百宝匣', OriginalFilename: '百宝匣.exe', CompanyName: '百宝匣', LegalCopyright: '' };
  for (const lang of vi.getAllLanguagesForStringValues()) vi.setStringValues(lang, strings);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

async function buildDesktop() {
  if (!ELECTRON) throw new Error('package.json 的 devDependencies 里没写 electron 版本');
  console.log(`桌面版（Electron ${ELECTRON}）…`);
  const base = `https://github.com/electron/electron/releases/download/v${ELECTRON}/`;
  const zipName = `electron-v${ELECTRON}-win32-x64.zip`;
  const zipBuf = await download(base + zipName, path.join(CACHE, zipName));
  // 核对下载的文件没有损坏、没被篡改
  const sums = (await download(base + 'SHASUMS256.txt', path.join(CACHE, `SHASUMS256-${ELECTRON}.txt`))).toString('utf8');
  const want = (sums.split('\n').find(l => l.trim().endsWith(zipName)) || '').split(/\s+/)[0];
  const got = crypto.createHash('sha256').update(zipBuf).digest('hex');
  if (!want || want !== got) throw new Error(`Electron 压缩包校验不通过，删掉 dist/cache 重新下载试试`);

  const top = '百宝匣/';
  const entries = [];
  const zip = readZip(zipBuf);
  for (const n of zip.names()) {
    if (n.endsWith('/')) continue;
    if (n === 'resources/default_app.asar') continue;
    if (n.startsWith('locales/') && !/\/(zh-CN|en-US)\.pak$/.test(n)) continue; // 只留中文和英文界面
    let data = zip.get(n);
    let name = n;
    if (n === 'electron.exe') { name = '百宝匣.exe'; data = patchExe(data, path.join(SRC, 'desktop', 'icon.ico')); }
    entries.push({ name: top + name, data });
  }
  entries.push(...load(APP_FILES.flatMap(f => collect(f, top + 'resources/app/'))));
  // Electron 自己带了一份 LICENSE（必须保留），百宝匣的协议换个名字放
  entries.push(...load(EXTRA_FILES.flatMap(f => collect(f, top))).map(e => e.name === top + 'LICENSE' ? { ...e, name: top + '百宝匣-LICENSE.txt' } : e));
  entries.push({ name: top + '先看我.txt', data: fs.readFileSync(path.join(SRC, 'desktop', 'README-桌面版.txt')) });
  console.log('  压缩中，要一两分钟…');
  return save(`百宝匣-桌面版-${VERSION}.zip`, makeZip(assertUnique(entries)));
}

// ---------------------------------------------------------------- 小更新包

function buildUpdate() {
  console.log('小更新包…');
  const buf = updater.build(SRC, { version: VERSION, notes: opt('notes') || '', from: opt('from'), electron: ELECTRON || undefined });
  return save(`百宝匣更新-${VERSION}.bbupdate`, buf);
}

(async () => {
  const what = args[0] || 'all';
  if (!['web', 'desktop', 'update', 'all'].includes(what)) {
    console.log('用法：node scripts/build.js web | desktop | update | all');
    process.exit(1);
  }
  if (what === 'web' || what === 'all') buildWeb();
  if (what === 'update' || what === 'all') buildUpdate();
  if (what === 'desktop' || what === 'all') await buildDesktop();
})().catch(e => { console.error('\n打包失败：' + e.message); process.exit(1); });
