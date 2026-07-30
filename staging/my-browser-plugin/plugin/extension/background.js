// chrome-bridge 扩展的 service worker。
//
// 长轮询 bridge 领 job → 在日常 Chrome 里操作页面 → 回传结果 + 全程诊断上报。
//
// 三条设计纪律(都是上一版 xhs 扩展踩出来的):
//   1. **不用动态 import**。上一版用 import(chrome.runtime.getURL(...)) 拿注入函数,
//      抓取直接超时且毫无线索。注入函数一律内联在本文件里,少一个变量。
//   2. **每一步都上报 /_ext/log**。扩展跑在用户的 Chrome 里,agent 看不到这个
//      service worker 的控制台——不自己吐日志就等于瞎调。
//   3. **策略本地再判一次**。bridge 侧是权威判定,这里是纵深防御:万一有人绕过
//      MCP 直接打 bridge,或 bridge 有 bug,这一层还能兜住。

// 插件的 node worker 在下面这段里挑第一个空闲端口开服,所以这边要探测。
// 探到的端口缓存起来,连不上时再重新探——用户重启 Cindy 后端口可能变。
// 必须与 node/worker.cjs 的端口段一致,且避开 18790-18799(见那边的注释)。
const PORT_MIN = 18810;
const PORT_MAX = 18819;
let BRIDGE = null;

async function findBridge() {
  if (BRIDGE) return BRIDGE;
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    const base = 'http://127.0.0.1:' + port;
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 800);
      const r = await fetch(base + '/health', { signal: c.signal });
      clearTimeout(t);
      if (r.ok) { BRIDGE = base; return base; }
    } catch (e) { /* 这个端口不是我们的,继续 */ }
  }
  return null;
}
const LOAD_TIMEOUT_MS = 20000;

let chainRunning = false;
let policyCache = { at: 0, data: null };

function headers() {
  return { 'Content-Type': 'application/json' };
}

async function log(msg, extra) {
  try {
    await fetch((await findBridge()) + '/_ext/log', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ msg, extra: extra ?? null }),
    });
  } catch (e) { /* 日志失败不能影响主流程 */ }
}

// ── 策略(policy.py 的镜像,纵深防御用)──────────────────────────────────
async function getPolicy() {
  if (policyCache.data && Date.now() - policyCache.at < 10000) return policyCache.data;
  const base = await findBridge();
  if (!base) throw new Error('bridge not found');
  const r = await fetch(base + '/_ext/policy', { headers: headers() });
  if (!r.ok) throw new Error('policy fetch ' + r.status);
  policyCache = { at: Date.now(), data: await r.json() };
  return policyCache.data;
}

const READ_ACTIONS = new Set(['tabs', 'navigate', 'snapshot', 'extract', 'screenshot']);
const INTERACT_ACTIONS = new Set(['click', 'type', 'press', 'select', 'hover', 'scroll']);

function hostMatches(host, pattern) {
  let p = String(pattern || '').toLowerCase().trim();
  if (!p) return false;
  if (p.startsWith('=')) return host === p.slice(1);
  if (p.startsWith('*.')) p = p.slice(2);
  return host === p || host.endsWith('.' + p);
}

async function checkPolicy(action, url) {
  if (action === 'tabs') return { ok: true };
  let host = '';
  let scheme = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    scheme = u.protocol.replace(':', '').toLowerCase();
  } catch (e) {
    return { ok: false, reason: 'URL 解析失败,fail-closed' };
  }
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: '只允许 http/https' };
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
    return { ok: false, reason: '拒绝操作本机地址' };
  }
  const tier = READ_ACTIONS.has(action) ? 'read' : INTERACT_ACTIONS.has(action) ? 'interact' : null;
  if (!tier) return { ok: false, reason: '未知动作,fail-closed' };

  const cfg = (await getPolicy())[tier] || {};
  const allow = cfg.allow || [];
  const block = cfg.block || [];
  if (cfg.mode === 'allowlist') {
    if (!allow.some((p) => hostMatches(host, p))) {
      return { ok: false, reason: host + ' 不在 ' + tier + ' 白名单' };
    }
    if (block.some((p) => hostMatches(host, p))) {
      return { ok: false, reason: host + ' 命中白名单内排除项' };
    }
    return { ok: true };
  }
  if (block.some((p) => hostMatches(host, p))) {
    return { ok: false, reason: host + ' 在 ' + tier + ' 黑名单' };
  }
  return { ok: true };
}

// ── tab 生命周期 ────────────────────────────────────────────────────────
//
// 2026-07-30 事故后重写。原来两个缺陷:
//   1. **完全没有回收**——每个 URL 开一个标签,永不关闭。xhs 版本本来有
//      finally{closeTab},写通用版时为了支持复用把它删了,却没补上任何替代回收。
//   2. **复用判定按当前 URL 比对**,而站点会改写地址(小红书 navigate 后被追加
//      &type=51),于是每次调用都判定"没有可复用的",新开一个。两个缺陷叠加 =
//      标签只增不减。
//
// 现在:自己维护一本**只记录"我开的"标签**的账。
//   - 复用按**请求时的 URL**匹配自己的账本,不看站点改写后的当前地址
//   - 硬上限 MAX_OWNED_TABS,超了按最久未用关掉最老的
//   - 只关账本里的标签,**永远不碰用户自己开的标签**
const MAX_OWNED_TABS = 3;
const owned = new Map(); // requestedUrl -> { tabId, lastUsed }

async function forgetTab(url) {
  const rec = owned.get(url);
  owned.delete(url);
  if (!rec) return;
  try {
    await chrome.tabs.remove(rec.tabId);
  } catch (e) { /* 用户可能已手动关掉 */ }
}

async function evictIfNeeded() {
  while (owned.size > MAX_OWNED_TABS) {
    let oldestUrl = null;
    let oldestAt = Infinity;
    for (const [u, r] of owned) {
      if (r.lastUsed < oldestAt) { oldestAt = r.lastUsed; oldestUrl = u; }
    }
    if (!oldestUrl) break;
    await log('evict tab (超过上限)', { url: oldestUrl, cap: MAX_OWNED_TABS });
    await forgetTab(oldestUrl);
  }
}

/** 账本里那个标签还活着吗(用户可能手动关了) */
async function ownedTabAlive(url) {
  const rec = owned.get(url);
  if (!rec) return null;
  try {
    const t = await chrome.tabs.get(rec.tabId);
    return t ? rec.tabId : null;
  } catch (e) {
    owned.delete(url);
    return null;
  }
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      // SPA 首屏还要一点时间;这里给固定缓冲,不用 networkidle(拿不到)
      setTimeout(() => resolve(why), 1200);
    };
    const timer = setTimeout(() => finish('timeout'), LOAD_TIMEOUT_MS);
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') finish('complete');
    }
    chrome.tabs.onUpdated.addListener(onUpd);
    // 可能已经加载完了,补查一次
    chrome.tabs.get(tabId, (t) => {
      if (!chrome.runtime.lastError && t && t.status === 'complete') finish('already');
    });
  });
}

async function ensureTab(url, reuse, background) {
  if (reuse) {
    const alive = await ownedTabAlive(url);
    if (alive !== null) {
      owned.get(url).lastUsed = Date.now();
      await log('reuse tab', { tabId: alive, url });
      return { tabId: alive, reused: true };
    }
  }
  const tab = await chrome.tabs.create({ url, active: background === false });
  owned.set(url, { tabId: tab.id, lastUsed: Date.now() });
  await log('created tab', { tabId: tab.id, url, ownedCount: owned.size });
  const why = await waitForLoad(tab.id);
  await log('tab loaded', { tabId: tab.id, why });
  await evictIfNeeded();
  return { tabId: tab.id, reused: false };
}

// 用户手动关掉我们开的标签时,同步账本,别留下指向死 tab 的记录
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [u, r] of owned) {
    if (r.tabId === tabId) { owned.delete(u); break; }
  }
});

async function inject(tabId, func, args) {
  const out = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return out && out[0] ? out[0].result : null;
}

// ── 注入函数(全部内联;只能用参数和页面全局,不能闭包外部变量)───────────
function fnSnapshot(interactive, compact, selector, maxChars) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: 'selector 没匹配到元素: ' + selector };

  const SEL = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=tab],[contenteditable=true],[onclick]';
  const nodes = interactive ? root.querySelectorAll(SEL) : root.querySelectorAll('*');
  const lines = [];
  let n = 0;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // 不可见的不给 ref
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;

    n += 1;
    const ref = 'r' + n;
    el.setAttribute('data-cb-ref', ref); // act 靠这个属性回找元素

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    let name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
                el.getAttribute('title') || el.value || el.innerText || '').trim();
    name = name.replace(/\s+/g, ' ').slice(0, 90);
    const href = el.getAttribute('href');
    lines.push('[' + ref + '] ' + role + (name ? ' "' + name + '"' : '') +
               (href ? ' href=' + href.slice(0, 110) : ''));
    if (lines.join('\n').length > maxChars) { lines.push('… (截断)'); break; }
  }

  const text = compact ? null : (root.innerText || '').slice(0, maxChars);
  return {
    url: location.href, title: document.title,
    refCount: n, elements: lines.join('\n'),
    text,
  };
}

function fnExtract(fromSel, fields, multiple, limit) {
  const readOne = (scope) => {
    const rec = {};
    for (const k of Object.keys(fields)) {
      const spec = fields[k];
      const sel = typeof spec === 'string' ? spec : spec && spec.selector;
      const attr = typeof spec === 'object' && spec ? spec.attr : null;
      if (!sel) { rec[k] = null; continue; }
      const el = sel === ':self' ? scope : scope.querySelector(sel);
      if (!el) { rec[k] = null; continue; }
      if (attr === 'href' || attr === 'src') {
        const v = el.getAttribute(attr);
        rec[k] = v && v.startsWith('/') ? location.origin + v : v;
      } else if (attr) {
        rec[k] = el.getAttribute(attr);
      } else {
        rec[k] = (el.textContent || '').trim().replace(/\s+/g, ' ');
      }
    }
    return rec;
  };

  if (!multiple) return { url: location.href, record: readOne(document) };
  const scopes = document.querySelectorAll(fromSel || 'body');
  const out = [];
  for (const s of scopes) {
    out.push(readOne(s));
    if (out.length >= limit) break;
  }
  return { url: location.href, count: out.length, records: out };
}

function fnAct(kind, ref, selector, text, key, values, submit) {
  const find = () => {
    if (ref) return document.querySelector('[data-cb-ref="' + ref + '"]');
    if (selector) return document.querySelector(selector);
    return null;
  };

  if (kind === 'scroll') {
    window.scrollBy(0, 1200);
    return { ok: true, kind, scrollY: window.scrollY };
  }
  if (kind === 'press') {
    const el = find() || document.activeElement || document.body;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
    }
    return { ok: true, kind, key };
  }

  const el = find();
  if (!el) {
    return { error: 'ref/selector 没找到元素',
             hint: 'ref 只在同一页面状态下有效,导航或弹窗后要重新 snapshot' };
  }

  if (kind === 'click') {
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, kind, on: (el.innerText || el.value || '').trim().slice(0, 60) };
  }
  if (kind === 'hover') {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { ok: true, kind };
  }
  if (kind === 'select') {
    if (values && values.length) {
      for (const o of el.options || []) o.selected = values.includes(o.value) || values.includes(o.text);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, kind, values };
  }
  if (kind === 'type') {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', keyCode: 13, bubbles: true }));
      }
      if (el.form && typeof el.form.requestSubmit === 'function') {
        try { el.form.requestSubmit(); } catch (e) { /* 有的站禁掉了原生提交 */ }
      }
    }
    return { ok: true, kind, typed: (text || '').slice(0, 60), submitted: !!submit };
  }
  return { error: 'unknown kind: ' + kind };
}

// ── job 处理 ────────────────────────────────────────────────────────────
async function doTabs() {
  const all = await chrome.tabs.query({});
  return {
    tabs: all
      .filter((t) => t.url && /^https?:/.test(t.url))
      .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
  };
}

async function doScreenshot(job) {
  const { tabId } = await ensureTab(job.url, true, true);
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab 只能拍**当前窗口的活动标签**,所以必须临时切过去再切回来。
  // 这是唯一一个会短暂打断你视线的动作,其它操作都在后台标签完成。
  const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  await new Promise((r) => setTimeout(r, 400));
  let dataUrl = null;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
  } finally {
    if (prev && prev.id !== tabId) await chrome.tabs.update(prev.id, { active: true });
  }
  return { url: tab.url, dataUrl };
}

async function handle(job) {
  const gate = await checkPolicy(job.action, job.url);
  if (!gate.ok) {
    await log('DENY(ext) ' + job.action, { url: job.url, reason: gate.reason });
    return { error: 'policy-denied-by-extension', message: gate.reason };
  }

  if (job.action === 'tabs') return await doTabs();
  if (job.action === 'screenshot') return await doScreenshot(job);

  const { tabId } = await ensureTab(job.url, job.reuse !== false, job.background !== false);

  if (job.action === 'navigate') {
    const t = await chrome.tabs.get(tabId);
    return { tabId, url: t.url, title: t.title };
  }
  if (job.action === 'snapshot') {
    return await inject(tabId, fnSnapshot,
      [job.interactive !== false, job.compact !== false, job.selector || null, job.maxChars || 6000]);
  }
  if (job.action === 'extract') {
    return await inject(tabId, fnExtract,
      [job.from || null, job.fields || {}, !!job.multiple, job.limit || 50]);
  }
  if (INTERACT_ACTIONS.has(job.action)) {
    return await inject(tabId, fnAct,
      [job.kind || job.action, job.ref || null, job.selector || null,
       job.text || null, job.key || null, job.values || null, !!job.submit]);
  }
  return { error: 'unknown action: ' + job.action };
}

// ── 长轮询自续链 ────────────────────────────────────────────────────────
async function chain() {
  if (chainRunning) return;
  chainRunning = true;
  let idleRounds = 0;
  await log('chain start');
  try {
    for (;;) {
      let job = null;
      try {
        const base = await findBridge();
        if (!base) throw new Error('bridge not found');
        const r = await fetch(base + '/_ext/poll', { headers: headers() });
        if (!r.ok) throw new Error('poll ' + r.status);
        job = (await r.json()).job;
      } catch (e) {
        BRIDGE = null;   // 端口可能变了(Cindy 重启),下轮重新探测
        await new Promise((res) => setTimeout(res, 5000));
        continue;
      }
      if (!job) {
        // 连续空轮询 = 这一阵没活了,把自己开的标签全收掉。不留"以后可能还要用"
        // 的侥幸——标签只增不减正是 2026-07-30 那次事故的形态。
        if (++idleRounds >= 3 && owned.size) {
          await log('idle cleanup', { closing: owned.size });
          for (const u of [...owned.keys()]) await forgetTab(u);
        }
        continue;
      }
      idleRounds = 0;

      // 先 ack 再干活:bridge 只是"租"给我们这个 job。不 ack 的话,bridge 会认为
      // 这个 SW 实例已经被回收(MV3 下这事每分钟都在发生),把 job 重投给下一个实例。
      try {
        await fetch((await findBridge()) + '/_ext/ack', {
          method: 'POST', headers: headers(), body: JSON.stringify({ id: job.id }),
        });
      } catch (e) { /* ack 失败就让它重投,不影响正确性 */ }
      await log('job received', { id: job.id, action: job.action, url: job.url });
      let result;
      try {
        result = await handle(job);
      } catch (e) {
        result = { error: 'extension-exception', message: String((e && e.message) || e) };
        await log('job EXCEPTION', { id: job.id, err: result.message });
      }
      try {
        await fetch((await findBridge()) + '/_ext/result', {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ id: job.id, result }),
        });
        await log('job result sent', { id: job.id, err: result && result.error });
      } catch (e) {
        await log('job result SEND FAILED', { id: job.id });
      }
    }
  } finally {
    chainRunning = false;
  }
}

// ── SW 保活 ─────────────────────────────────────────────────────────────
// MV3 的 service worker 空闲 30s 就被回收,而**在途 fetch 并不算"不空闲"**
// (2026-07-30 实测:诊断日志里 chain start 每 ~61s 一次,正好是看门狗周期,
// 说明长轮询完全没有保活效果——job 在两次重启之间没人领,直接超时)。
//
// Chrome 会在每次**扩展 API 调用**时重置这个空闲计时器。所以每 20s 主动碰一次
// API 就能让它一直活着。这是治根;租约重投(bridge 侧)保留作为兜底,因为浏览器
// 仍可能在休眠/更新/崩溃时把它掐掉。
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer !== null) return;
  keepAliveTimer = setInterval(() => {
    // 调用哪个 API 不重要,重要的是"有调用"。getPlatformInfo 无副作用、最便宜。
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
}

chrome.alarms.create('chrome-bridge-watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'chrome-bridge-watchdog') { startKeepAlive(); chain(); }
});
chrome.runtime.onStartup.addListener(() => { startKeepAlive(); chain(); });
chrome.runtime.onInstalled.addListener(() => { startKeepAlive(); chain(); });
startKeepAlive();
chain();
