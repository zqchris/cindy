// cindy-browser 的电子脑。
//
// 沙箱侧只负责编排:把策略从 /kv 读出来推给 node worker,把工具调用翻译成
// worker 的动作请求,把结果整理给 agent。真正开端口、跟扩展说话的是 worker
// (沙箱零网络直连,cindy.fetch 只能 https + 默认端口,够不到 loopback)。

const CHANNEL = 'my-browser';
let policyPushed = false;

async function node(method, params) {
  const r = await cindy.node.request({ method, params: params || {}, timeoutMs: 100000 });
  if (!r.ok) return { error: 'bridge-unavailable', message: r.message };
  return r.result;
}

async function loadPolicy() {
  try {
    const cfg = await (await fetch('/kv')).json();
    if (cfg && cfg.policy) return cfg.policy;
  } catch (e) { /* 没配过就用默认 */ }
  return null;
}

async function savePolicy(policy) {
  const cfg = await (await fetch('/kv')).json().catch(() => ({}));
  await fetch('/kv', { method: 'PUT', body: JSON.stringify({ ...cfg, policy }) });
  await node('setPolicy', { policy });
  policyPushed = true;
}

/** worker 是 on-demand 拉起的,每次派活前确保它拿到的是最新策略 */
async function syncPolicy(force) {
  if (policyPushed && !force) return;
  const p = await loadPolicy();
  if (p) await node('setPolicy', { policy: p });
  policyPushed = true;
}

function normalizeHost(h) {
  return String(h || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

const NOT_CONNECTED_HINT =
  'The Chrome extension is not connected. Tell the user to open chrome://extensions, ' +
  'turn on Developer mode, click "Load unpacked", and select the folder shown by browser_status.';

async function handleTool(name, args) {
  await syncPolicy(false);

  if (name === 'browser_status') {
    const s = await node('status');
    if (s.error) return s;
    return {
      ...s,
      how_to_install: s.extension_connected ? null : {
        step1: 'Open chrome://extensions in the browser you actually use',
        step2: 'Turn on Developer mode (top right)',
        step3: 'Click "Load unpacked" and pick this folder:',
        folder: s.extension_dir,
        note: 'This installs into your normal Chrome, so the agent reuses the sessions ' +
              'you are already logged into. No second login, nothing leaves this machine.',
      },
      note: 'Reading is allowed by default except for blocked sites. Interacting ' +
            '(click / type / search) is denied everywhere until the user allows a site.',
    };
  }

  if (name === 'browser_policy') {
    const action = args.action;
    const current = (await loadPolicy()) ||
      { read: { block: (await node('status')).policy?.read_block || [] }, interact: { allow: [] } };
    if (action === 'get') {
      const s = await node('status');
      return {
        read_block: current.read.block,
        interact_allow: current.interact.allow,
        extension_connected: s.extension_connected,
        note: 'Interacting is off by default. Adding a site to interact_allow lets the agent ' +
              'press any button and submit any form on it — confirm with the user first.',
      };
    }
    const host = normalizeHost(args.host);
    if (!host) return { error: 'host is required' };
    const next = {
      read: { block: [...current.read.block] },
      interact: { allow: [...current.interact.allow], block: [...(current.interact.block || [])] },
    };
    if (action === 'allow_interact' && !next.interact.allow.includes(host)) next.interact.allow.push(host);
    if (action === 'block_read' && !next.read.block.includes(host)) next.read.block.push(host);
    if (action === 'remove') {
      next.interact.allow = next.interact.allow.filter((h) => h !== host);
      next.read.block = next.read.block.filter((h) => h !== host);
    }
    await savePolicy(next);
    return { ok: true, action, host, read_block: next.read.block, interact_allow: next.interact.allow };
  }

  if (name === 'browser_tabs') {
    const r = await node('act', { action: 'tabs', payload: {} });
    if (r.error) return { ...r, hint: r.error === 'timeout' ? NOT_CONNECTED_HINT : undefined };
    const pol = (await loadPolicy()) || { read: { block: [] } };
    const blocked = (u) => {
      try {
        const h = new URL(u).hostname.toLowerCase();
        return (pol.read.block || []).some((p) => {
          const q = p.startsWith('*.') ? p.slice(2) : p;
          return h === q || h.endsWith('.' + q);
        });
      } catch (e) { return true; }
    };
    return { tabs: (r.tabs || []).map((t) => (blocked(t.url)
      ? { id: t.id, redacted: true, reason: 'on the read block list' } : t)) };
  }

  if (name === 'browser_read') {
    const mode = args.mode || 'snapshot';
    const nav = await node('act', { action: 'navigate', payload: { url: args.url } });
    if (nav.error) return { ...nav, hint: nav.error === 'timeout' ? NOT_CONNECTED_HINT : undefined };
    if (mode === 'extract') {
      return await node('act', { action: 'extract', payload: {
        url: args.url, fields: args.fields || {}, from: args.from || null,
        multiple: !!args.multiple, limit: Math.min(Math.max(args.limit || 50, 1), 500) } });
    }
    return await node('act', { action: mode === 'text' ? 'text' : 'snapshot', payload: {
      url: args.url, selector: args.selector || null,
      interactive: mode !== 'text', maxChars: 6000 } });
  }

  if (name === 'browser_act') {
    const r = await node('act', { action: args.kind, payload: {
      url: args.url, kind: args.kind, ref: args.ref || null, selector: args.selector || null,
      text: args.text || null, key: args.key || null, values: args.values || null,
      submit: !!args.submit } });
    if (r.error === 'interact-not-allowed') {
      return { ...r, what_to_tell_the_user:
        `The agent needs permission to click and type on ${r.host}. ` +
        'Adding it means the agent can press any button and submit any form on that site. ' +
        'Ask them, and only if they agree call browser_policy with action=allow_interact.' };
    }
    return r;
  }

  return { error: 'unknown tool: ' + name };
}

cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'tool-call') return;
  let result;
  try {
    result = await handleTool(msg.name, msg.args || {});
  } catch (e) {
    result = { error: 'plugin-exception', message: String((e && e.message) || e) };
  }
  cindy.reply({ callId: msg.callId, result });
});

// 设置页是零网络沙箱,拿不到 worker;它经这个频道找我们代办
const bc = new BroadcastChannel(CHANNEL);
bc.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.type === 'status-request') {
    await syncPolicy(true);
    const s = await node('status');
    bc.postMessage({ type: 'status-result', payload: { ...s, policy: await loadPolicy() } });
  } else if (m.type === 'save-request') {
    await savePolicy(m.policy);
    bc.postMessage({ type: 'save-result', payload: { ok: true } });
  }
};
