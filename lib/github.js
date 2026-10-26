// 百宝匣：从 GitHub 下载项目、检查更新（不需要装 git，也不用 GitHub 接口，不受次数限制）
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('./net.js');
const { readZip } = require('./docs.js');

// 认出各种写法：https://github.com/作者/项目、github.com/作者/项目/tree/分支、作者/项目
function parseRepo(input) {
  let s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let m = /github\.com[/:]([\w.-]+)\/([\w.-]+)(?:\/tree\/([^?#]+))?/i.exec(s);
  if (!m) m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), branch: m[3] ? decodeURIComponent(m[3]) : '' };
}

function repoUrl(r) {
  return `https://github.com/${r.owner}/${r.repo}`;
}

// 最新版本号（提交编号）
async function latestSha(r, proxy) {
  const res = await net.request(`https://github.com/${r.owner}/${r.repo}.git/info/refs?service=git-upload-pack`, { timeout: 30000, proxy });
  if (res.status === 404 || res.status === 401) throw new Error('找不到这个项目，可能地址写错了，或者是私有项目。');
  if (res.status !== 200) throw new Error(`GitHub 返回了 ${res.status}`);
  const text = res.body.toString('latin1');
  const want = r.branch ? `refs/heads/${r.branch}` : 'HEAD';
  for (const line of text.split('\n')) {
    const m = /([0-9a-f]{40}) ([^\0\s]+)/.exec(line);
    if (m && m[2] === want) return m[1];
  }
  throw new Error(r.branch ? `这个项目没有叫"${r.branch}"的分支。` : '读不到项目的最新版本。');
}

// 下载并解压到 dest。update=true 时只覆盖压缩包里有的文件，不删你本地多出来的东西（比如 node_modules、数据）
async function download(r, dest, { proxy = '', update = false } = {}) {
  const ref = r.branch ? `refs/heads/${encodeURIComponent(r.branch)}` : 'HEAD';
  const url = r.branch ? `https://codeload.github.com/${r.owner}/${r.repo}/zip/${ref}` : `https://github.com/${r.owner}/${r.repo}/archive/HEAD.zip`;
  const res = await net.request(url, { timeout: 120000, proxy });
  if (res.status === 404) throw new Error('找不到这个项目，可能地址写错了，或者是私有项目。');
  if (res.status !== 200) throw new Error(`下载失败，GitHub 返回了 ${res.status}`);
  const zip = readZip(res.body);
  const sha = /^[0-9a-f]{40}$/.test(zip.comment.trim()) ? zip.comment.trim() : '';
  if (!update && fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`文件夹已经存在而且不是空的：${dest}`);
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const name of zip.names()) {
    const rel = name.split('/').slice(1).join('/'); // 去掉最外面那层"项目-分支/"
    if (!rel || rel.endsWith('/')) continue;
    const target = path.resolve(dest, rel);
    if (!target.startsWith(path.resolve(dest) + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zip.get(name));
    count++;
  }
  return { sha, count, size: res.body.length };
}

module.exports = { parseRepo, repoUrl, latestSha, download };
