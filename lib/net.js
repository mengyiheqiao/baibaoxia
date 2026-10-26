// 百宝匣：联网请求。支持跟随跳转、超时，以及可选的 HTTP 代理（比如 Clash 的 http://127.0.0.1:7890）。
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

// 通过 HTTP 代理建立到目标网站的隧道
function tunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxy);
    const headers = { Host: `${host}:${port}` };
    if (p.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
    const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${host}:${port}`, headers, timeout });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`代理拒绝连接（${res.statusCode}）`)); }
      // 隧道断开时的错误会由上层请求报告，这里只防止程序崩溃
      socket.on('error', () => {});
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('连接代理超时')));
    req.on('error', e => reject(new Error('连不上代理：' + e.message)));
    req.end();
  });
}

/**
 * 发请求。返回 { status, headers, body(Buffer), url }
 * opts: method, headers, body, timeout(毫秒), proxy, maxBytes, redirects
 */
async function request(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, body = null, timeout = 30000, proxy = '', maxBytes = 300 * 1024 * 1024 } = opts;
  let redirects = opts.redirects === undefined ? 6 : opts.redirects;
  let url = new URL(urlStr);
  for (;;) {
    const isHttps = url.protocol === 'https:';
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const reqOpts = {
      method,
      host: url.hostname,
      port,
      path: url.pathname + url.search,
      headers: { 'User-Agent': 'Baibaoxia/0.7', ...headers },
      timeout,
    };
    if (body) reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
    const useProxy = proxy && !/^(127\.|localhost$)/.test(url.hostname);
    if (useProxy) {
      const socket = await tunnel(proxy, url.hostname, port, timeout);
      if (isHttps) {
        reqOpts.createConnection = () => tls.connect({ socket, servername: url.hostname });
      } else {
        reqOpts.createConnection = () => socket;
      }
      reqOpts.agent = false;
    }
    const res = await new Promise((resolve, reject) => {
      const lib = isHttps ? https : http;
      const req = lib.request(reqOpts, resolve);
      req.on('timeout', () => req.destroy(new Error('等太久没有回应')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
      res.resume();
      url = new URL(res.headers.location, url);
      redirects--;
      continue;
    }
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) { res.destroy(new Error('文件太大了')); return; }
        chunks.push(c);
      });
      res.on('end', resolve);
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('下载中断了')));
    });
    return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: url.href };
  }
}

async function getJson(url, opts = {}) {
  const r = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  let data = null;
  try { data = JSON.parse(r.body.toString('utf8')); } catch {}
  return { status: r.status, data, text: r.body.toString('utf8') };
}

async function postJson(url, payload, opts = {}) {
  const body = JSON.stringify(payload);
  const r = await request(url, { ...opts, method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  let data = null;
  try { data = JSON.parse(r.body.toString('utf8')); } catch {}
  return { status: r.status, data, text: r.body.toString('utf8') };
}

// 把联网错误翻译成人话
function netError(e, proxy) {
  const m = String(e && e.message || e);
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return '找不到这个网站，检查一下网络。';
  if (/ECONNREFUSED/.test(m)) return proxy ? '连不上代理，代理软件开着吗？' : '对方拒绝连接。';
  if (/ETIMEDOUT|太久|timeout/i.test(m)) return proxy ? '连接超时。代理软件开着吗？' : '连接超时。如果是 GitHub 这类国外网站，可能要在设置里填上代理地址。';
  if (/ECONNRESET|socket hang up/i.test(m)) return '连接被断开了。国外网站可能需要在设置里填上代理地址。';
  if (/certificate|CERT/i.test(m)) return '网站证书有问题，连不上。';
  return m;
}

module.exports = { request, getJson, postJson, netError };
