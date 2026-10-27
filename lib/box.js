// 末影箱：把随身口袋（还可以加上记忆区、工具）加密后存进你自己的 GitHub 私有仓库，换一台电脑也能拿到。
//
// 仓库里只有这几样：
//   box-salt.json   加密用的盐和参数（不是秘密），外加一段用来核对密码的密文
//   box.json        加密后的清单：每个文件叫什么、多大、内容指纹、存在哪几块里
//   o/<编号>-<n>    加密后的文件内容，大文件切成几块
// 密码不会离开这台电脑；GitHub 上看到的全是乱码。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('./net.js');
const { removeTree } = require('./fsx.js');

const API = (process.env.BAIBAO_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const CHUNK = 25 * 1024 * 1024;       // 每块 25MB（GitHub 单个 blob 上限 100MB，留足余量）
const AUTO_LIMIT = 20 * 1024 * 1024;  // 比这大的文件不自动下载，要用时点一下
const TOMB_DAYS = 30;                 // 删除记录保留多久
const BATCH_BLOBS = Number(process.env.BAIBAO_BOX_BATCH) || 40; // 一轮最多新建多少块（GitHub 一分钟内最多新建 80 个左右）
const BATCH_PAUSE = Number(process.env.BAIBAO_BOX_PAUSE) || 45000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const CHECK_TEXT = 'baibaoxia-box-v1';

// ---------------------------------------------------------------- 加密：AES-256-GCM，格式 iv(12) | 密文 | tag(16)

function deriveKey(password, salt, prm = SCRYPT) {
  return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, { N: prm.N, r: prm.r, p: prm.p, maxmem: 256 * prm.N * prm.r });
}
function encrypt(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}
function decrypt(key, buf) {
  if (buf.length < 28) throw new Error('数据坏了');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
function hashFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// ---------------------------------------------------------------- GitHub

function parseRepo(s) {
  const t = String(s || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(t);
  return m ? `${m[1]}/${m[2]}` : '';
}

class BoxError extends Error {}

function client(repo, token, proxy) {
  const base = `${API}/repos/${repo}`;
  async function call(method, p, payload, okCodes = [200, 201]) {
    const body = payload === undefined ? null : JSON.stringify(payload);
    let r;
    try {
      r = await net.request(base + p, {
        method, body, proxy, timeout: 120000,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (e) { throw new BoxError(net.netError(e, proxy)); }
    let data = null;
    try { data = JSON.parse(r.body.toString('utf8')); } catch {}
    if (!okCodes.includes(r.status)) {
      const err = new BoxError(explain(r.status, data, p));
      err.status = r.status;
      throw err;
    }
    return { status: r.status, data };
  }
  return {
    call,
    repoInfo: () => call('GET', ''),
    async head(branch) {
      // 空仓库没有分支：GitHub 返回 404 或 409
      const r = await call('GET', `/git/ref/heads/${encodeURIComponent(branch)}`, undefined, [200, 404, 409]);
      return r.status === 200 ? r.data.object.sha : null;
    },
    async treeOf(commitSha) {
      const c = await call('GET', `/git/commits/${commitSha}`);
      const t = await call('GET', `/git/trees/${c.data.tree.sha}`);
      return { tree: c.data.tree.sha, entries: t.data.tree || [] };
    },
    async getBlob(sha) {
      const r = await call('GET', `/git/blobs/${sha}`);
      return Buffer.from(r.data.content || '', r.data.encoding === 'base64' ? 'base64' : 'utf8');
    },
    async putBlob(buf) {
      const r = await call('POST', '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' });
      return r.data.sha;
    },
    async putFile(p, buf, message) {
      return call('PUT', `/contents/${p}`, { message, content: buf.toString('base64') });
    },
    async commit({ head, baseTree, changes, message, branch }) {
      const t = await call('POST', '/git/trees', { base_tree: baseTree, tree: changes });
      const c = await call('POST', '/git/commits', { message, tree: t.data.sha, parents: head ? [head] : [] });
      // force:false：别的电脑刚刚也改过的话，这里会失败，重新来一遍
      const r = await call('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: c.data.sha, force: false }, [200, 409, 422]);
      return r.status === 200 ? c.data.sha : null;
    },
  };
}

function explain(status, data, p) {
  const msg = data && data.message ? String(data.message) : '';
  if (status === 401) return '令牌不对或者过期了，重新生成一个填进来。';
  if (status === 429 || (status === 403 && /rate limit/i.test(msg))) return 'GitHub 说传得太快了，过几分钟会自动接着同步。';
  if (status === 403) return '令牌没有这个仓库的权限。生成令牌时要勾上这个仓库，权限选 Contents：Read and write。';
  if (status === 404 && p === '') return '找不到这个仓库。检查一下名字，或者令牌没有勾上这个仓库。';
  if (status === 404) return '仓库里少了东西，可能被手动改过。';
  if (status === 413) return '文件太大，GitHub 不收。';
  return `GitHub 出错了（${status}${msg ? '：' + msg : ''}）`;
}

function readCode(code, password) {
  const m = /BBX1\.([A-Za-z0-9_-]+)/.exec(String(code || '').replace(/\s+/g, ''));
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], 'base64url');
    const j = JSON.parse(decrypt(deriveKey(password, buf.subarray(0, 16)), buf.subarray(16)).toString('utf8'));
    return j.repo && j.token ? j : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- 合并：两台电脑都改了同一份设置（工具、栏目、活页）时，按条目合并
// b = 上次同步时的样子，l = 这台电脑现在的，r = 云端现在的；同一条两边都改了，以这台电脑的为准

const J = v => (v === undefined ? undefined : JSON.stringify(v));
function pick3(bv, lv, rv) {
  if (lv === rv) return lv;
  if (lv === bv) return rv;
  if (rv === bv) return lv;
  return lv !== undefined ? lv : rv;
}
function mergeMap(b, l, r) {
  b = b || {}; l = l || {}; r = r || {};
  const out = {};
  for (const k of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
    const v = pick3(J(b[k]), J(l[k]), J(r[k]));
    if (v !== undefined) out[k] = JSON.parse(v);
  }
  return out;
}
function mergeList(b, l, r, keyOf) {
  const m = arr => { const x = new Map(); for (const it of arr || []) { const k = keyOf(it); if (k && !x.has(k)) x.set(k, it); } return x; };
  const B = m(b), L = m(l), R = m(r);
  const order = mp => [...mp.keys()];
  // 这台电脑调过顺序、云端没调，就用这台电脑的顺序；否则用云端的
  const useLocal = J(order(L)) !== J(order(B)) && J(order(R)) === J(order(B));
  const keys = [...(useLocal ? order(L) : order(R))];
  for (const k of [...order(L), ...order(R)]) if (!keys.includes(k)) keys.push(k);
  const out = [];
  for (const k of keys) {
    const v = pick3(J(B.get(k)), J(L.get(k)), J(R.get(k)));
    if (v !== undefined) out.push(JSON.parse(v));
  }
  return out;
}

// ---------------------------------------------------------------- 末影箱本体
//
// opts:
//   stateDir                放同步记录的文件夹
//   getConf() / setConf(c)  连接信息（仓库、令牌、钥匙、这台电脑叫什么、同步哪些）
//   proxy()                 代理地址
//   areas(conf)             要同步的文件夹：[{ key, dir, deep, auto, trash(abs, rel), isSeed?(rel, hash), changed?() }]
//                           auto：多大以内自动下载（0 = 从不自动，要用时再拿）
//   docs(conf)              要合并的设置：[{ key, get(), set(v), merge(b, l, r), pristine() }]
//   onChange()              同步结束时调用

function createBox(opts) {
  const { stateDir } = opts;
  const STATE = path.join(stateDir, 'state.json');
  const TMP = path.join(stateDir, '下载中');
  fs.mkdirSync(stateDir, { recursive: true });

  let state = readState();
  let running = null;           // 正在进行的同步
  let again = false;            // 同步时又有变化，结束后再来一次
  const status = { syncing: false, lastSync: state.lastSync || 0, error: '', progress: '' };

  function readState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
  }
  function saveState() {
    state.lastSync = status.lastSync;
    const tmp = STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE);
  }
  // 0.15.0 只有口袋，名字前面没有 "pocket/"
  if (state.known && !state.v) {
    const pre = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => ['pocket/' + k, v]));
    state.known = pre(state.known); state.cache = pre(state.cache); state.remoteView = pre(state.remoteView);
    state.pull = (state.pull || []).map(k => 'pocket/' + k); state.drop = (state.drop || []).map(k => 'pocket/' + k);
  }
  state.v = 2;
  for (const k of ['known', 'cache', 'remoteView', 'docBase']) if (!state[k]) state[k] = {};
  for (const k of ['pull', 'drop']) if (!state[k]) state[k] = [];

  const conf = () => opts.getConf() || null;
  const connected = () => { const c = conf(); return !!(c && c.repo && c.token && c.key); };
  const areas = () => (opts.areas ? opts.areas(conf() || {}) : []);
  const docs = () => (connected() && opts.docs ? opts.docs(conf()) : []);
  const areaOf = (key, list = areas()) => list.find(a => key.startsWith(a.key + '/'));
  const safeRel = rel => !!rel && !rel.split('/').some(x => !x || x === '.' || x === '..') && !/[\\:]/.test(rel);
  const absOf = (a, rel) => path.join(a.dir, ...rel.split('/'));

  // ---- 本地文件：点开头的、Office 的临时文件（~$ 开头）都不算
  function scan(a, out) {
    const walk = (d, pre) => {
      let names = [];
      try { names = fs.readdirSync(d); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.') || n.startsWith('~$')) continue;
        const abs = path.join(d, n);
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) { if (a.deep) walk(abs, pre + n + '/'); continue; }
        if (!st.isFile()) continue;
        const key = a.key + '/' + pre + n;
        const c = state.cache[key];
        let hash = c && c.size === st.size && c.mtime === st.mtimeMs ? c.hash : null;
        if (!hash) {
          try { hash = hashFile(abs); } catch { continue; } // 正在写的文件下次再说
          state.cache[key] = { size: st.size, mtime: st.mtimeMs, hash };
        }
        out[key] = { size: st.size, mtime: st.mtimeMs, hash, abs };
      }
    };
    walk(a.dir, '');
  }
  function localFiles(list = areas()) {
    const out = {};
    for (const a of list) { try { fs.mkdirSync(a.dir, { recursive: true }); } catch {} scan(a, out); }
    for (const k of Object.keys(state.cache)) if (!out[k] && areaOf(k, list)) delete state.cache[k];
    return out;
  }
  const docSig = () => sha256(Buffer.from(JSON.stringify(docs().map(d => [d.key, d.get()]))));

  // ---- 连接：第一次用这个仓库就把它变成末影箱，用过的就核对密码
  async function connect({ repo: repoIn, token, password, device, code, sync: syncOpt }) {
    if (code && String(code).trim()) {
      const r = readCode(code, password);
      if (!r) return { ok: false, message: '连接码和密码对不上。检查一下连接码有没有复制完整、密码对不对。' };
      repoIn = r.repo; token = r.token;
    }
    const repo = parseRepo(repoIn);
    token = String(token || '').trim();
    if (!repo) return { ok: false, message: '仓库填"用户名/仓库名"，比如 zhangsan/my-box。' };
    if (!token) return { ok: false, message: '还没填令牌。' };
    if (String(password || '').length < 6) return { ok: false, message: '箱子密码至少 6 位。' };
    const gh = client(repo, token, opts.proxy());
    try {
      const info = (await gh.repoInfo()).data;
      if (!info.private) return { ok: false, message: '这是公开仓库，谁都能看到。末影箱只用私有仓库，去仓库 Settings 里改成 Private 再来。' };
      if (info.permissions && info.permissions.push === false) return { ok: false, message: '令牌只能读不能写。生成令牌时 Contents 要选 Read and write。' };
      const branch = info.default_branch || 'main';
      const head = await gh.head(branch);
      let saltInfo = null;
      if (head) {
        const { entries } = await gh.treeOf(head);
        const e = entries.find(x => x.path === 'box-salt.json');
        if (e) saltInfo = JSON.parse((await gh.getBlob(e.sha)).toString('utf8'));
        else if (entries.some(x => x.path === 'box.json')) return { ok: false, message: '这个仓库里的末影箱缺了 box-salt.json，没法打开。' };
      }
      let key, newSalt = null;
      if (saltInfo) {
        const prm = { N: saltInfo.N || SCRYPT.N, r: saltInfo.r || SCRYPT.r, p: saltInfo.p || SCRYPT.p };
        key = deriveKey(password, Buffer.from(saltInfo.salt, 'base64'), prm);
        try {
          if (decrypt(key, Buffer.from(saltInfo.check, 'base64')).toString('utf8') !== CHECK_TEXT) throw new Error();
        } catch { return { ok: false, message: '箱子密码不对。这个仓库已经是末影箱了，要用第一次设的那个密码。' }; }
      } else {
        const salt = crypto.randomBytes(16);
        key = deriveKey(password, salt);
        const file = { v: 1, kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), check: encrypt(key, Buffer.from(CHECK_TEXT)).toString('base64'), note: '百宝匣·末影箱。里面的东西都加密了，不要手动修改这个仓库。' };
        await gh.putFile('box-salt.json', Buffer.from(JSON.stringify(file, null, 2)), '百宝匣：创建末影箱');
        newSalt = file;
      }
      // 换了仓库就从头对一遍
      const old = conf();
      if (!old || old.repo !== repo) { state.known = {}; state.head = null; state.remoteView = {}; state.docBase = {}; state.docSig = null; }
      const saltUsed = saltInfo || newSalt;
      opts.setConf({
        repo, token, branch, key: key.toString('base64'),
        salt: { salt: saltUsed.salt, N: saltUsed.N || SCRYPT.N, r: saltUsed.r || SCRYPT.r, p: saltUsed.p || SCRYPT.p },
        device: String(device || '').trim().slice(0, 30) || os.hostname() || '另一台电脑',
        deviceId: (old && old.deviceId) || crypto.randomBytes(6).toString('hex'),
        sync: normSync(syncOpt || (old && old.sync)),
      });
      state.head = null;
      saveState();
      status.error = '';
      return { ok: true, created: !saltInfo };
    } catch (e) {
      return { ok: false, message: e instanceof BoxError ? e.message : String(e.message || e) };
    }
  }
  const normSync = s => ({ memory: !!(s && s.memory), tools: !!(s && s.tools) });

  // 改同步哪些。关掉的那部分，这台电脑上的文件和云端的都不动，只是不再同步
  function setOptions(syncOpt) {
    const c = conf();
    if (!c) return false;
    const before = areas().map(a => a.key);
    opts.setConf({ ...c, sync: normSync(syncOpt) });
    const after = areas().map(a => a.key);
    for (const k of Object.keys(state.known)) if (!after.some(a => k.startsWith(a + '/'))) delete state.known[k];
    for (const k of Object.keys(state.remoteView)) if (!after.some(a => k.startsWith(a + '/'))) delete state.remoteView[k];
    if (!normSync(syncOpt).tools) for (const k of Object.keys(state.docBase)) if (k !== 'cfg/binder') delete state.docBase[k];
    if (!normSync(syncOpt).memory) delete state.docBase['cfg/binder'];
    state.head = null;
    saveState();
    if (J(before) !== J(after)) restartWatch();
    kick(300);
    return true;
  }

  // 连接码：把仓库名和令牌用箱子密码加密成一串字。存在手机里、发给自己都不怕被看到，
  // 到了别的电脑上，贴连接码 + 输密码就能连上，不用再去 GitHub 找令牌
  function makeCode(password) {
    const c = conf();
    if (!c || !c.salt) return { ok: false, message: '先连上末影箱。' };
    const k = deriveKey(password, Buffer.from(c.salt.salt, 'base64'), c.salt);
    if (k.toString('base64') !== c.key) return { ok: false, message: '箱子密码不对。' };
    const salt = crypto.randomBytes(16);
    const blob = encrypt(deriveKey(password, salt), Buffer.from(JSON.stringify({ repo: c.repo, token: c.token })));
    return { ok: true, code: 'BBX1.' + Buffer.concat([salt, blob]).toString('base64url') };
  }

  function disconnect() {
    opts.setConf(null);
    state = { v: 2, known: {}, cache: state.cache, remoteView: {}, docBase: {}, pull: [], drop: [] };
    status.error = '';
    status.lastSync = 0;
    saveState();
  }

  // ---- 同步
  function sync(why = '') {
    if (!connected()) return Promise.resolve({ ok: false, message: '还没连上末影箱。' });
    if (running) { again = true; return running; }
    status.syncing = true;
    running = (async () => {
      let result;
      const sum = { uploaded: 0, downloaded: 0 };
      let retries = 0;
      for (let round = 0; round < 200; round++) {
        again = false;
        try {
          result = await syncOnce(why);
          if (result.retry) { if (++retries > 4) break; continue; }  // 别的电脑同时在改，重来
          sum.uploaded += result.uploaded || 0;
          sum.downloaded += result.downloaded || 0;
          result = { ...result, ...sum, changed: sum.uploaded + sum.downloaded };
          status.error = '';
          status.lastSync = Date.now();
          if (result.changed && !result.more) status.lastChange = Date.now();
          // 文件太多，一轮只传一部分（GitHub 限制一分钟内新建的东西不能太多），歇一会儿接着传
          if (result.more) { status.progress = `还有 ${result.more} 个等着上传…`; await new Promise(r => setTimeout(r, BATCH_PAUSE)); continue; }
          if (!again) break;
        } catch (e) {
          status.error = e instanceof BoxError ? e.message : String(e.message || e);
          result = { ok: false, message: status.error };
          break;
        }
      }
      status.progress = '';
      saveState();
      return result;
    })().finally(() => { running = null; status.syncing = false; if (opts.onChange) opts.onChange(); });
    return running;
  }

  async function syncOnce() {
    const c = conf();
    const key = Buffer.from(c.key, 'base64');
    const gh = client(c.repo, c.token, opts.proxy());
    const branch = c.branch || 'main';
    const list = areas();
    const docList = docs();
    const local = localFiles(list);
    const inScope = k => !!areaOf(k, list);

    // 云端没变、本地也没变：只花一次请求
    const head = await gh.head(branch);
    if (!head) throw new BoxError('仓库是空的，box-salt.json 不见了。断开后重新连接一次。');
    const knownIn = Object.keys(state.known).filter(inScope);
    const localSame = Object.keys(local).length === knownIn.length && Object.entries(local).every(([n, f]) => state.known[n] === f.hash);
    const sig = docSig();
    if (head === state.head && localSame && sig === state.docSig && !state.pull.length && !state.drop.length) return { ok: true, changed: 0 };

    status.progress = '看看云端有什么';
    const { tree: baseTree, entries } = await gh.treeOf(head);
    const be = entries.find(x => x.path === 'box.json');
    let man = { v: 1, files: {} };
    if (be) {
      try { man = JSON.parse(decrypt(key, await gh.getBlob(be.sha)).toString('utf8')); }
      catch (e) { if (e instanceof BoxError) throw e; throw new BoxError('打不开云端的清单：密码和这个箱子对不上。断开后用正确的密码重新连接。'); }
    }
    if (!man.files) man.files = {};
    if (!man.docs) man.docs = {};
    const oldMan = JSON.parse(JSON.stringify(man));

    const remote = {}, tombs = {};
    for (const [k, e] of Object.entries(man.files)) {
      if (!inScope(k) || !safeRel(k.slice(k.indexOf('/') + 1))) continue;
      if (e.deleted) tombs[k] = e; else remote[k] = e;
    }
    const known = state.known;
    const names = new Set([...Object.keys(local), ...Object.keys(remote), ...knownIn]);
    const uploads = [];   // 名字
    const downloads = []; // [名字, 条目]
    const removes = [];   // 云端删掉了，这台电脑也删
    const newKnown = {};
    for (const k of Object.keys(known)) if (!inScope(k)) newKnown[k] = known[k]; // 没在同步的部分原样留着
    const view = {};
    const touched = new Set();
    let dirty = false;
    const taken = new Set([...Object.keys(local), ...Object.keys(remote)]);
    const conflictName = (k, dev) => {
      const slash = k.lastIndexOf('/');
      const dirPart = k.slice(0, slash + 1), n = k.slice(slash + 1);
      const ext = path.extname(n), base = n.slice(0, n.length - ext.length);
      let cand = `${dirPart}${base}（来自${dev || '另一台电脑'}）${ext}`, i = 2;
      while (taken.has(cand)) cand = `${dirPart}${base}（来自${dev || '另一台电脑'}）(${i++})${ext}`;
      taken.add(cand);
      return cand;
    };
    const tomb = n => { man.files[n] = { deleted: true, at: Date.now(), by: c.device }; dirty = true; };
    const autoOk = (n, r) => { const a = areaOf(n, list); return r.size <= a.auto || state.pull.includes(n); };
    const later = (n, r) => { view[n] = { size: r.size, mtime: r.mtime, by: r.by }; };

    for (const n of names) {
      const a = areaOf(n, list);
      let L = local[n] ? local[n].hash : null;
      const r = remote[n];
      const R = r ? r.hash : null;
      const B = known[n] || null;
      if (state.drop.includes(n)) {      // 在"只在云端"的文件上点了删除
        if (r && !L) tomb(n);
        continue;
      }
      // 新电脑上自带的默认文件（比如使用说明），云端已经有自己的版本或者删掉了：听云端的
      if (L && !B && L !== R && (r || tombs[n]) && a.isSeed && a.isSeed(n.slice(a.key.length + 1), L)) {
        if (r) { downloads.push([n, r]); continue; }
        removes.push(n); continue;
      }
      if (L === R) { if (L) newKnown[n] = L; continue; }
      if (L !== B && R === B) {          // 只有这台电脑改了
        if (L) uploads.push(n); else tomb(n);
        continue;
      }
      if (R !== B && L === B) {          // 只有云端改了
        if (!R) { removes.push(n); continue; }
        if (L || autoOk(n, r)) downloads.push([n, r]); else later(n, r);
        continue;
      }
      // 两边都改了
      if (!L) { if (autoOk(n, r)) downloads.push([n, r]); else later(n, r); continue; }
      if (!R) { uploads.push(n); continue; }
      if (!B) {
        // 这台电脑第一次同步就撞名：云端的保留原名，这台电脑的改个名字再传上去
        const alt = conflictName(n, c.device);
        const fromAbs = local[n].abs, toAbs = absOf(a, alt.slice(a.key.length + 1));
        fs.renameSync(fromAbs, toAbs);
        const st = fs.statSync(toAbs);
        local[alt] = { ...local[n], abs: toAbs, mtime: st.mtimeMs };
        state.cache[alt] = { size: st.size, mtime: st.mtimeMs, hash: local[alt].hash };
        delete local[n];
        uploads.unshift(alt);
        downloads.push([n, r]);
        touched.add(a);
        continue;
      }
      // 两份都留：这台电脑的用原名，云端那份换个名字
      const alt = conflictName(n, r.by);
      man.files[alt] = { ...r };
      dirty = true;
      uploads.unshift(n); // 冲突的先传，免得下一轮又冲突一次
      downloads.push([alt, r]);
    }

    // 云端删掉的
    for (const n of removes) {
      const a = areaOf(n, list);
      const abs = absOf(a, n.slice(a.key.length + 1));
      try { a.trash(abs, n.slice(a.key.length + 1)); } catch {}
      delete state.cache[n];
      touched.add(a);
    }

    // 下载
    fs.mkdirSync(TMP, { recursive: true });
    for (const [n, e] of downloads) {
      const a = areaOf(n, list);
      const rel = n.slice(a.key.length + 1);
      status.progress = `下载 ${rel}`;
      const tmp = path.join(TMP, crypto.randomBytes(6).toString('hex'));
      const fd = fs.openSync(tmp, 'w');
      const h = crypto.createHash('sha256');
      try {
        for (const ch of e.chunks) {
          const plain = decrypt(key, await gh.getBlob(ch.s));
          h.update(plain);
          fs.writeSync(fd, plain);
        }
      } finally { fs.closeSync(fd); }
      if (h.digest('hex') !== e.hash) { removeTree(tmp); throw new BoxError(`"${rel}"下载下来对不上，可能没下完，等会儿再同步。`); }
      const target = absOf(a, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) { try { a.trash(target, rel); } catch {} } // 被云端新版本替换的旧文件放回收站
      fs.renameSync(tmp, target);
      if (e.mtime) { try { fs.utimesSync(target, new Date(), new Date(e.mtime)); } catch {} }
      const st = fs.statSync(target);
      state.cache[n] = { size: st.size, mtime: st.mtimeMs, hash: e.hash };
      newKnown[n] = e.hash;
      touched.add(a);
    }
    state.pull = state.pull.filter(n => view[n]);

    // 上传
    const changes = [];
    let budget = BATCH_BLOBS, deferred = 0;
    for (const n of uploads) {
      const f = local[n];
      const need = Math.max(1, Math.ceil(f.size / CHUNK));
      if (budget < need && budget < BATCH_BLOBS) { deferred++; if (known[n]) newKnown[n] = known[n]; continue; }
      budget -= need;
      status.progress = `上传 ${n.slice(n.indexOf('/') + 1)}`;
      const id = crypto.randomBytes(8).toString('hex');
      const chunks = [];
      const fd = fs.openSync(f.abs, 'r');
      try {
        let k = 0;
        for (let pos = 0; pos < f.size || (f.size === 0 && k === 0); pos += CHUNK, k++) {
          const len = Math.min(CHUNK, f.size - pos);
          const buf = Buffer.alloc(len);
          if (len) fs.readSync(fd, buf, 0, len, pos);
          const p = `o/${id}-${k}`;
          const s = await gh.putBlob(encrypt(key, buf));
          changes.push({ path: p, mode: '100644', type: 'blob', sha: s });
          chunks.push({ p, s });
          if (f.size === 0) break;
        }
      } finally { fs.closeSync(fd); }
      man.files[n] = { id, size: f.size, mtime: f.mtime, hash: f.hash, chunks, by: c.device, at: Date.now() };
      newKnown[n] = f.hash;
      dirty = true;
    }

    // 设置（工具、栏目、活页）：按条目合并
    const newBase = {};
    let docsChanged = 0;
    for (const d of docList) {
      const L = d.get();
      const R = man.docs[d.key] ? man.docs[d.key].json : undefined;
      const B = state.docBase[d.key];
      let M;
      if (R === undefined) M = L;
      else if (B === undefined) M = d.pristine() ? R : d.merge(null, L, R);
      else M = d.merge(B, L, R);
      if (J(M) !== J(L)) { d.set(M); docsChanged++; }
      if (J(M) !== J(R)) { man.docs[d.key] = { json: M, at: Date.now(), by: c.device }; dirty = true; }
      newBase[d.key] = M;
    }

    // 清理过期的删除记录
    const cut = Date.now() - TOMB_DAYS * 86400000;
    for (const [k, e] of Object.entries(man.files)) if (e.deleted && e.at < cut) { delete man.files[k]; dirty = true; }

    let newHead = head;
    if (dirty) {
      status.progress = '保存到云端';
      const used = new Set();
      for (const e of Object.values(man.files)) for (const ch of e.chunks || []) used.add(ch.p);
      for (const e of Object.values(oldMan.files)) for (const ch of e.chunks || []) if (!used.has(ch.p)) { changes.push({ path: ch.p, mode: '100644', type: 'blob', sha: null }); used.add(ch.p); }
      man.v = (oldMan.v || 0) + 1;
      man.at = Date.now();
      const ms = await gh.putBlob(encrypt(key, Buffer.from(JSON.stringify(man))));
      changes.push({ path: 'box.json', mode: '100644', type: 'blob', sha: ms });
      newHead = await gh.commit({ head, baseTree, changes, branch, message: `百宝匣·${c.device}：${uploads.length - deferred} 个上传` });
      if (!newHead) {
        // 别的电脑抢先改了。已经下载的文件留着（内容和云端一样），清单下次重新对
        for (const [n] of downloads) known[n] = newKnown[n];
        for (const a of touched) if (a.changed) try { a.changed(); } catch {}
        return { retry: true };
      }
    }
    // 只在云端、不自动下载的文件
    for (const [n, e] of Object.entries(remote)) if (!local[n] && !newKnown[n] && !downloads.some(d => d[0] === n) && !view[n] && !autoOk(n, e)) later(n, e);
    for (const n of Object.keys(view)) delete newKnown[n];
    state.known = newKnown;
    state.docBase = { ...state.docBase, ...newBase };
    state.docSig = docSig();
    state.drop = [];
    state.head = newHead;
    for (const k of Object.keys(state.remoteView)) if (inScope(k)) delete state.remoteView[k];
    Object.assign(state.remoteView, view);
    for (const a of touched) if (a.changed) try { a.changed(); } catch {}
    const up = uploads.length - deferred;
    return { ok: true, changed: up + downloads.length + docsChanged, uploaded: up, downloaded: downloads.length, settings: docsChanged, more: deferred };
  }

  // ---- 自动同步：每分钟一次；同步的文件夹里有变化，3 秒后同步
  let timer = null, watchers = [], debounce = null;
  function kick(delay = 3000) {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (connected()) sync('changed').catch(() => {}); }, delay);
  }
  function restartWatch() {
    for (const w of watchers) { try { w.close(); } catch {} }
    watchers = [];
    if (!connected()) return;
    for (const a of areas()) {
      try { fs.mkdirSync(a.dir, { recursive: true }); } catch {}
      // 正在下载的临时文件、回收站、索引的变化不用管
      const onEvt = (_e, f) => { if (f && /(^|[\\/])\./.test(String(f))) return; kick(); };
      try { watchers.push(fs.watch(a.dir, { recursive: !!a.deep }, onEvt)); }
      catch { try { watchers.push(fs.watch(a.dir, onEvt)); } catch {} }
    }
  }
  function start() {
    stop();
    if (!connected()) return;
    timer = setInterval(() => sync('timer').catch(() => {}), 60000);
    restartWatch();
    kick(500);
  }
  function stop() {
    clearInterval(timer); timer = null;
    clearTimeout(debounce);
    for (const w of watchers) { try { w.close(); } catch {} }
    watchers = [];
  }

  function info() {
    const c = conf();
    return {
      connected: connected(),
      repo: c && c.repo || '', device: c && c.device || '',
      sync: normSync(c && c.sync),
      syncing: status.syncing, progress: status.progress,
      lastSync: status.lastSync, lastChange: status.lastChange || 0, error: status.error,
    };
  }

  // 某个文件夹的列表：本地文件 + 只在云端的文件。rel 是相对那个文件夹的路径
  function list(areaKey = 'pocket') {
    const a = areas().find(x => x.key === areaKey);
    if (!a) return [];
    const local = localFiles([a]);
    const on = connected();
    const pre = areaKey + '/';
    const items = Object.entries(local).map(([k, f]) => ({
      name: k.slice(pre.length), size: f.size, mtime: f.mtime,
      sync: !on ? '' : state.known[k] === f.hash ? 'synced' : 'pending',
    }));
    if (on) for (const [k, e] of Object.entries(state.remoteView)) if (k.startsWith(pre) && !local[k]) items.push({ name: k.slice(pre.length), size: e.size, mtime: e.mtime, by: e.by, sync: state.pull.includes(k) ? 'pulling' : 'cloud' });
    return items.sort((x, y) => y.mtime - x.mtime);
  }
  // 云端有、这台电脑没有的（不自动下载的那些）
  function cloudOnly(prefix) {
    return Object.entries(state.remoteView).filter(([k]) => k.startsWith(prefix)).map(([k, e]) => ({ key: k, size: e.size, mtime: e.mtime, by: e.by, pulling: state.pull.includes(k) }));
  }
  function cloudHas(k) { return !!state.remoteView[k]; }

  function pull(k) {
    if (!state.remoteView[k]) return false;
    if (!state.pull.includes(k)) state.pull.push(k);
    saveState();
    kick(0);
    return true;
  }
  function dropRemote(k) {
    if (!state.remoteView[k]) return false;
    if (!state.drop.includes(k)) state.drop.push(k);
    delete state.remoteView[k];
    saveState();
    kick(0);
    return true;
  }

  return { connect, makeCode, setOptions, disconnect, sync, start, stop, info, list, cloudOnly, cloudHas, pull, dropRemote, kick, connected };
}

module.exports = { createBox, parseRepo, deriveKey, encrypt, decrypt, sha256, hashFile, mergeMap, mergeList, AUTO_LIMIT };
