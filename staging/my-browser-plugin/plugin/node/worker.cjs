'use strict';
// cindy-browser 的 Node 工作进程 —— 本机 bridge。
//
// 它是浏览器扩展的对端:扩展长轮询领任务、执行、回传;main.js 经 JSON-RPC 派活。
// 全程只监听 127.0.0.1,不对外暴露任何端口,也不外联。
//
// 为什么必须是 node 槽:插件的浏览器沙箱零网络直连,cindy.fetch 又限定"仅 https、
// 默认端口",够不到 loopback。只有 node 槽能开本机端口给扩展来连。
//
// 零依赖(只用 node 内置模块),所以不需要 esbuild 打包,worker.cjs 就是源码本身。

const http = require('node:http');
const readline = require('node:readline');
const path = require('node:path');

const HOST = '127.0.0.1';
// 端口段刻意避开 18790-18799:那一段被一些自建的本地浏览器 bridge 占着,
// 撞上去会让两边的扩展互相抢连接,而且症状很隐蔽(连上了但拿到的是别人的任务)。
const PORT_MIN = 18810;
const PORT_MAX = 18819;

const POLL_HOLD_MS = 20000;   // 长轮询挂起
const ACK_GRACE_MS = 8000;    // 取走后必须 ack 的宽限
const WORK_LEASE_MS = 45000;  // ack 之后允许干活的时长
const JOB_TIMEOUT_MS = 90000; // 单个任务整体上限

// 扩展目录:worker 跑在安装后的插件目录里,所以这个绝对路径就是用户要在
// chrome://extensions 里「加载已解压」的目录,不需要把文件复制到别处。
const EXTENSION_DIR = path.join(__dirname, '..', 'extension');

// ── 策略 ────────────────────────────────────────────────────────────────
// 读 = 黑名单(默认放行),交互 = 白名单(默认全禁),粒度按站点(注册域 + 子域)。
// 搜索算交互:它要往输入框打字再回车,和"点发送"是同一套 DOM 原语,而 DOM 上
// 无法可靠区分一个 button 是"下一页"还是"确认支付"。按原语切,不按语义猜。
// 判不出来一律拒(fail-closed)。
const READ_ACTIONS = new Set(['tabs', 'navigate', 'snapshot', 'extract', 'text', 'screenshot']);
const INTERACT_ACTIONS = new Set(['click', 'type', 'press', 'select', 'hover', 'scroll']);

const DEFAULT_BLOCK = [
  'mail.google.com', 'outlook.com', 'outlook.live.com', 'mail.qq.com', 'mail.163.com',
  '1password.com', 'lastpass.com', 'bitwarden.com', 'accounts.google.com',
  'login.microsoftonline.com', 'appleid.apple.com',
  'paypal.com', 'stripe.com', 'alipay.com', 'cmbchina.com', 'icbc.com.cn',
  'bankofamerica.com', 'chase.com', 'coinbase.com', 'binance.com',
  'console.aws.amazon.com', 'console.cloud.google.com', 'portal.azure.com',
];

let policy = { read: { block: DEFAULT_BLOCK.slice() }, interact: { allow: [] } };

function hostMatches(host, pattern) {
  let p = String(pattern || '').toLowerCase().trim();
  if (!p) return false;
  if (p.startsWith('=')) return host === p.slice(1);
  if (p.startsWith('*.')) p = p.slice(2);
  return host === p || host.endsWith('.' + p);
}

function checkPolicy(action, url) {
  if (action === 'tabs') return { ok: true };
  const tier = READ_ACTIONS.has(action) ? 'read' : INTERACT_ACTIONS.has(action) ? 'interact' : null;
  if (!tier) return { ok: false, reason: `unknown action ${action}` };

  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, reason: 'cannot parse URL' }; }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  const host = u.hostname.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: 'only http/https allowed' };
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return { ok: false, reason: 'refusing to operate on local addresses' };
  }

  if (tier === 'interact') {
    const allow = (policy.interact && policy.interact.allow) || [];
    const block = (policy.interact && policy.interact.block) || [];
    if (!allow.some((p) => hostMatches(host, p))) {
      return { ok: false, code: 'interact-not-allowed', host,
               reason: `${host} is not on the interact allow list. Interacting is off by default; ` +
                       `ask the user whether to allow this site, then use browser_policy allow_interact.` };
    }
    if (block.some((p) => hostMatches(host, p))) return { ok: false, host, reason: `${host} is excluded` };
    return { ok: true };
  }

  const block = (policy.read && policy.read.block) || [];
  if (block.some((p) => hostMatches(host, p))) {
    return { ok: false, code: 'read-blocked', host, reason: `${host} is on the read block list` };
  }
  return { ok: true };
}

// ── 任务中转 ────────────────────────────────────────────────────────────
// take() 只是"租"给扩展,不是给出去:MV3 的 service worker 随时会被浏览器回收,
// 取走后没按时 ack 的任务必须能重投,否则调用方只能干等到超时。
let seq = 0;
const pending = [];
const inflight = new Map();
const logs = [];
let lastPollAt = 0;
let waiters = [];

function addLog(src, msg, extra) {
  logs.push({ t: Date.now(), src, msg: String(msg).slice(0, 300), extra: extra || null });
  if (logs.length > 300) logs.shift();
}

function pushJob(job) {
  pending.push(job);
  const w = waiters.shift();
  if (w) w();
}

function submit(action, payload) {
  return new Promise((resolve) => {
    const job = {
      id: 'j' + (++seq), action, payload,
      leaseUntil: 0, attempts: 0, done: false,
      finish(result) {
        if (job.done) return;
        job.done = true;
        clearTimeout(job.timer);
        inflight.delete(job.id);
        resolve(result);
      },
    };
    job.timer = setTimeout(() => {
      addLog('bridge', 'job timeout', { id: job.id, action });
      job.finish({
        error: 'timeout',
        message: 'The Chrome extension did not respond in time.',
        hint: extensionAlive()
          ? 'The extension is connected but this step stalled.'
          : 'The extension is not connected. Check it is installed and enabled in Chrome.',
      });
    }, JOB_TIMEOUT_MS);
    inflight.set(job.id, job);
    addLog('bridge', 'submit ' + action, { id: job.id, url: payload && payload.url });
    pushJob(job);
  });
}

setInterval(() => {
  const now = Date.now();
  for (const job of [...inflight.values()]) {
    if (job.done || !job.leaseUntil || now <= job.leaseUntil) continue;
    if (job.attempts >= 3) continue;   // 交给整体超时收尾
    job.leaseUntil = 0;
    addLog('bridge', 'requeue (lease expired, worker likely recycled)', { id: job.id });
    pushJob(job);
  }
}, 2000).unref();

function takeJob() {
  lastPollAt = Date.now();
  const job = pending.shift();
  if (!job) return null;
  job.attempts += 1;
  job.leaseUntil = Date.now() + ACK_GRACE_MS;
  return job;
}

function extensionAlive() { return Date.now() - lastPollAt < 60000; }

async function dispatch(action, payload) {
  const gate = checkPolicy(action, payload && payload.url);
  if (!gate.ok) {
    addLog('policy', 'deny ' + action, { url: payload && payload.url, reason: gate.reason });
    return { error: gate.code || 'policy-denied', action, host: gate.host, message: gate.reason };
  }
  return await submit(action, payload || {});
}

// ── 给扩展的 HTTP 面(loopback only)───────────────────────────────────────
let server = null;
let boundPort = 0;

function send(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8',
                               'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;

      if (req.method === 'GET' && p === '/health') {
        return send(res, { ok: true, extension: extensionAlive(), pending: pending.length,
                           inflight: inflight.size, port: boundPort });
      }
      if (req.method === 'GET' && p === '/_ext/policy') return send(res, policy);
      if (req.method === 'GET' && p === '/_ext/poll') {
        lastPollAt = Date.now();
        const job = takeJob();
        if (job) return send(res, { job: { id: job.id, action: job.action, ...job.payload } });
        // 没活就挂起,有活立刻唤醒——避免空转轮询
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          waiters = waiters.filter((w) => w !== finish);
          const j = takeJob();
          send(res, { job: j ? { id: j.id, action: j.action, ...j.payload } : null });
        };
        const t = setTimeout(finish, POLL_HOLD_MS);
        waiters.push(finish);
        req.on('close', () => { done = true; clearTimeout(t); waiters = waiters.filter((w) => w !== finish); });
        return;
      }
      if (req.method === 'POST' && p === '/_ext/ack') {
        const b = await readBody(req);
        const job = inflight.get(b.id);
        if (job) job.leaseUntil = Date.now() + WORK_LEASE_MS;
        lastPollAt = Date.now();
        return send(res, { ok: !!job });
      }
      if (req.method === 'POST' && p === '/_ext/result') {
        const b = await readBody(req);
        const job = inflight.get(b.id);
        lastPollAt = Date.now();
        if (job) job.finish(b.result || {});
        return send(res, { ok: !!job });
      }
      if (req.method === 'POST' && p === '/_ext/log') {
        const b = await readBody(req);
        addLog('ext', b.msg, b.extra);
        return send(res, { ok: true });
      }
      send(res, { error: 'not found' }, 404);
    });
    srv.on('error', reject);
    srv.listen(port, HOST, () => resolve(srv));
  });
}

async function ensureServer() {
  if (server) return boundPort;
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    try {
      server = await startServer(port);
      boundPort = port;
      addLog('bridge', 'listening', { port });
      return port;
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') continue;
      throw e;
    }
  }
  throw new Error(`no free loopback port in ${PORT_MIN}-${PORT_MAX}`);
}

// ── JSON-RPC(给 main.js)────────────────────────────────────────────────
const HANDLERS = {
  async status() {
    const port = await ensureServer();
    return {
      ok: true,
      port,
      endpoint: `http://${HOST}:${port}`,
      extension_connected: extensionAlive(),
      extension_dir: EXTENSION_DIR,
      policy: { read_block: policy.read.block, interact_allow: policy.interact.allow },
    };
  },
  async setPolicy(params) {
    const p = params && params.policy;
    if (!p || !p.read || !p.interact) return { ok: false, error: 'bad policy shape' };
    policy = {
      read: { block: (p.read.block || []).map(String) },
      interact: { allow: (p.interact.allow || []).map(String),
                  block: (p.interact.block || []).map(String) },
    };
    addLog('policy', 'updated', { interact: policy.interact.allow.length });
    return { ok: true, policy };
  },
  async act(params) {
    await ensureServer();
    return await dispatch(params.action, params.payload || {});
  },
  async diagnostics() {
    return { extension_connected: extensionAlive(), logs: logs.slice(-80) };
  },
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  const h = HANDLERS[req.method];
  if (!h) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id,
      error: { code: -32601, message: 'Method not found: ' + req.method } }) + '\n');
    return;
  }
  try {
    const result = await h(req.params || {});
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id,
      error: { code: -32000, message: String((e && e.message) || e) } }) + '\n');
  }
});
