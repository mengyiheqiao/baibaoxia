// 末影箱：把随身口袋里的东西加密后存进你自己的 GitHub 私有仓库，换一台电脑也能拿到。
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

// ---------------------------------------------------------------- 末影箱本体

function createBox(opts) {
  // opts: dir（口袋文件夹）、stateDir、getConf()、setConf(patch|null)、proxy()、trash(file, name)、onChange()
  const { dir, stateDir } = opts;
  const STATE = path.join(stateDir, 'state.json');
  const TMP = path.join(stateDir, '下载中');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  let state = readState();
  let running = null;           // 正在进行的同步
  let again = false;            // 同步时又有变化，结束后再来一次
  const status = { syncing: false, lastSync: state.lastSync || 0, error: '', progress: '' };
  let remoteView = state.remoteView || {}; // 云端有、这台电脑没有的大文件

  function readState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
  }
  function saveState() {
    state.remoteView = remoteView;
    state.lastSync = status.lastSync;
    const tmp = STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE);
  }
  if (!state.known) state.known = {};
  if (!state.cache) state.cache = {};
  if (!state.pull) state.pull = [];
  if (!state.drop) state.drop = [];

  const conf = () => opts.getConf() || null;
  const connected = () => { const c = conf(); return !!(c && c.repo && c.token && c.key); };

  // ---- 本地文件：只看口袋最外层的文件，点开头的是百宝匣自己用的
  function localFiles() {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      if (n.startsWith('.') || n.startsWith('~$')) continue;
      let st;
      try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
      if (!st.isFile()) continue;
      const c = state.cache[n];
      let hash = c && c.size === st.size && c.mtime === st.mtimeMs ? c.hash : null;
      if (!hash) {
        try { hash = hashFile(path.join(dir, n)); } catch { continue; } // 正在写的文件下次再说
        state.cache[n] = { size: st.size, mtime: st.mtimeMs, hash };
      }
      out[n] = { size: st.size, mtime: st.mtimeMs, hash };
    }
    for (const n of Object.keys(state.cache)) if (!out[n]) delete state.cache[n];
    return out;
  }

  // ---- 连接：第一次用这个仓库就把它变成末影箱，用过的就核对密码
  async function connect({ repo: repoIn, token, password, device, code }) {
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
      if (!old || old.repo !== repo) { state.known = {}; state.head = null; remoteView = {}; }
      const saltUsed = saltInfo || JSON.parse(JSON.stringify(newSalt));
      opts.setConf({
        repo, token, branch, key: key.toString('base64'),
        salt: { salt: saltUsed.salt, N: saltUsed.N || SCRYPT.N, r: saltUsed.r || SCRYPT.r, p: saltUsed.p || SCRYPT.p },
        device: String(device || '').trim().slice(0, 30) || os.hostname() || '另一台电脑',
        deviceId: (old && old.deviceId) || crypto.randomBytes(6).toString('hex'),
      });
      state.head = null;
      saveState();
      status.error = '';
      return { ok: true, created: !saltInfo };
    } catch (e) {
      return { ok: false, message: e instanceof BoxError ? e.message : String(e.message || e) };
    }
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
    state = { known: {}, cache: state.cache, pull: [], drop: [] };
    remoteView = {};
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

  async function syncOnce(why) {
    const c = conf();
    const key = Buffer.from(c.key, 'base64');
    const gh = client(c.repo, c.token, opts.proxy());
    const branch = c.branch || 'main';
    const local = localFiles();

    // 云端没变、本地也没变：只花一次请求
    const head = await gh.head(branch);
    if (!head) throw new BoxError('仓库是空的，box-salt.json 不见了。断开后重新连接一次。');
    const localSame = Object.keys(local).length === Object.keys(state.known).length
      && Object.entries(local).every(([n, f]) => state.known[n] === f.hash);
    if (head === state.head && localSame && !state.pull.length && !state.drop.length) return { ok: true, changed: 0 };

    status.progress = '看看云端有什么';
    const { tree: baseTree, entries } = await gh.treeOf(head);
    const be = entries.find(x => x.path === 'box.json');
    let man = { v: 1, files: {} };
    if (be) {
      try { man = JSON.parse(decrypt(key, await gh.getBlob(be.sha)).toString('utf8')); }
      catch (e) { if (e instanceof BoxError) throw e; throw new BoxError('打不开云端的清单：密码和这个箱子对不上。断开后用正确的密码重新连接。'); }
    }
    if (!man.files) man.files = {};
    const oldMan = JSON.parse(JSON.stringify(man));

    const P = 'pocket/';
    const remote = {};
    for (const [k, e] of Object.entries(man.files)) if (k.startsWith(P) && !e.deleted) remote[k.slice(P.length)] = e;
    const known = state.known;
    const names = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(known)]);
    const uploads = [];   // 名字
    const downloads = []; // [名字, 条目, 存成什么名字]
    const newKnown = {};
    const view = {};
    let dirty = false;
    const taken = new Set([...Object.keys(local), ...Object.keys(remote)]);
    const conflictName = (n, dev) => {
      const ext = path.extname(n), base = n.slice(0, n.length - ext.length);
      let cand = `${base}（来自${dev || '另一台电脑'}）${ext}`, i = 2;
      while (taken.has(cand)) cand = `${base}（来自${dev || '另一台电脑'}）(${i++})${ext}`;
      taken.add(cand);
      return cand;
    };
    const tomb = n => { man.files[P + n] = { deleted: true, at: Date.now(), by: c.device }; dirty = true; };
    const wantsPull = n => state.pull.includes(n);

    for (const n of names) {
      const L = local[n] ? local[n].hash : null;
      const r = remote[n];
      const R = r ? r.hash : null;
      const B = known[n] || null;
      if (state.drop.includes(n)) {      // 在"只在云端"的文件上点了删除
        if (r && !L) tomb(n);
        continue;
      }
      if (L === R) { if (L) newKnown[n] = L; continue; }
      if (L !== B && R === B) {          // 只有这台电脑改了
        if (L) uploads.push(n); else tomb(n);
        continue;
      }
      if (R !== B && L === B) {          // 只有云端改了
        if (!R) { opts.trash(path.join(dir, n), n); continue; }
        if (L || r.size <= AUTO_LIMIT || wantsPull(n)) downloads.push([n, r, n]);
        else view[n] = { size: r.size, mtime: r.mtime, by: r.by };
        continue;
      }
      // 两边都改了
      if (!L) { if (r.size <= AUTO_LIMIT || wantsPull(n)) downloads.push([n, r, n]); else view[n] = { size: r.size, mtime: r.mtime, by: r.by }; continue; }
      if (!R) { uploads.push(n); continue; }
      // 两份都留：这台电脑的用原名，云端那份换个名字
      const alt = conflictName(n, r.by);
      man.files[P + alt] = { ...r };
      dirty = true;
      uploads.unshift(n); // 冲突的先传，免得下一轮又冲突一次
      downloads.push([alt, r, alt]);
    }

    // 下载
    fs.mkdirSync(TMP, { recursive: true });
    for (const [n, e, saveAs] of downloads) {
      status.progress = `下载 ${n}`;
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
      if (h.digest('hex') !== e.hash) { removeTree(tmp); throw new BoxError(`"${n}"下载下来对不上，可能没下完，等会儿再同步。`); }
      const target = path.join(dir, saveAs);
      if (fs.existsSync(target)) opts.trash(target, saveAs); // 被云端新版本替换的旧文件放回收站
      fs.renameSync(tmp, target);
      if (e.mtime) { try { fs.utimesSync(target, new Date(), new Date(e.mtime)); } catch {} }
      const st = fs.statSync(target);
      state.cache[saveAs] = { size: st.size, mtime: st.mtimeMs, hash: e.hash };
      newKnown[saveAs] = e.hash;
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
      status.progress = `上传 ${n}`;
      const id = crypto.randomBytes(8).toString('hex');
      const chunks = [];
      const fd = fs.openSync(path.join(dir, n), 'r');
      try {
        let k = 0;
        for (let pos = 0; pos < f.size || (f.size === 0 && k === 0); pos += CHUNK, k++) {
          const len = Math.min(CHUNK, f.size - pos);
          const buf = Buffer.alloc(len);
          if (len) fs.readSync(fd, buf, 0, len, pos);
          const blob = encrypt(key, buf);
          const p = `o/${id}-${k}`;
          const s = await gh.putBlob(blob);
          changes.push({ path: p, mode: '100644', type: 'blob', sha: s });
          chunks.push({ p, s });
          if (f.size === 0) break;
        }
      } finally { fs.closeSync(fd); }
      man.files[P + n] = { id, size: f.size, mtime: f.mtime, hash: f.hash, chunks, by: c.device, at: Date.now() };
      newKnown[n] = f.hash;
      dirty = true;
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
        return { retry: true };
      }
    }
    // 只在云端的文件也可能是之前就知道的
    for (const [n, e] of Object.entries(remote)) if (!local[n] && !newKnown[n] && !downloads.some(d => d[2] === n) && !view[n] && e.size > AUTO_LIMIT) view[n] = { size: e.size, mtime: e.mtime, by: e.by };
    state.known = newKnown;
    for (const n of Object.keys(view)) delete state.known[n];
    state.drop = [];
    state.head = newHead;
    remoteView = view;
    const up = uploads.length - deferred;
    return { ok: true, changed: up + downloads.length, uploaded: up, downloaded: downloads.length, more: deferred };
  }

  // ---- 自动同步：每分钟一次；口袋里有变化，3 秒后同步
  let timer = null, watcher = null, debounce = null;
  function kick(delay = 3000) {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (connected()) sync('changed').catch(() => {}); }, delay);
  }
  function start() {
    stop();
    if (!connected()) return;
    timer = setInterval(() => sync('timer').catch(() => {}), 60000);
    try { watcher = fs.watch(dir, () => kick()); } catch {}
    kick(500);
  }
  function stop() {
    clearInterval(timer); timer = null;
    clearTimeout(debounce);
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  }

  function info() {
    const c = conf();
    return {
      connected: connected(),
      repo: c && c.repo || '', device: c && c.device || '',
      syncing: status.syncing, progress: status.progress,
      lastSync: status.lastSync, error: status.error,
    };
  }

  // 口袋列表：本地文件 + 只在云端的大文件
  function list() {
    const local = localFiles();
    const on = connected();
    const items = Object.entries(local).map(([name, f]) => ({
      name, size: f.size, mtime: f.mtime,
      sync: !on ? '' : state.known[name] === f.hash ? 'synced' : 'pending',
    }));
    if (on) for (const [name, e] of Object.entries(remoteView)) if (!local[name]) items.push({ name, size: e.size, mtime: e.mtime, by: e.by, sync: state.pull.includes(name) ? 'pulling' : 'cloud' });
    return items.sort((a, b) => b.mtime - a.mtime);
  }

  function pull(name) {
    if (!remoteView[name]) return false;
    if (!state.pull.includes(name)) state.pull.push(name);
    saveState();
    kick(0);
    return true;
  }
  function dropRemote(name) {
    if (!remoteView[name]) return false;
    if (!state.drop.includes(name)) state.drop.push(name);
    delete remoteView[name];
    saveState();
    kick(0);
    return true;
  }

  return { connect, makeCode, disconnect, sync, start, stop, info, list, pull, dropRemote, kick, connected };
}

module.exports = { createBox, parseRepo, deriveKey, encrypt, decrypt, sha256, AUTO_LIMIT };
