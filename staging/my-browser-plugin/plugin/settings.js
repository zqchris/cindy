// 设置页。零网络沙箱——所有和 bridge 有关的事都经 BroadcastChannel 交给 main.js。

const $ = (s) => document.querySelector(s);
const bc = new BroadcastChannel('my-browser');

const STRINGS = {
  'zh-CN': {
    installTitle: '第一步：把扩展装进你日常用的浏览器',
    installBody: '打开 chrome://extensions → 右上角开「开发者模式」→ 点「加载已解压的扩展程序」→ 选下面这个目录。装进你平常用的那个浏览器，agent 才能复用你已经登录的会话；不会产生新登录，也不会把任何东西发出这台机器。',
    copy: '复制路径',
    copied: '已复制',
    interactTitle: '允许交互的网站',
    interactBody: '只有这些站点，agent 才能点击、输入、搜索。默认一个都没有。加一个站等于允许 agent 在上面按任何按钮、提交任何表单——包括发送、删除、支付。',
    readTitle: '禁止读取的网站',
    readBody: '这些站点连读都不允许（网银、邮箱、密码管理器）。其余站点默认可读。出厂清单只是起点，一定不完整。',
    hostPlaceholder: '例如 example.com（含子域）',
    add: '添加', save: '保存', saving: '保存中…', saved: '已保存',
    emptyInteract: '（空 —— agent 目前在任何网站都不能点击或输入）',
    ready: '扩展已连接，可以用了。',
    noExt: '扩展还没连上。按下面的说明装一次。',
    noBridge: '本机服务没起来。试试在设置里重新启用本插件。',
  },
  en: {
    installTitle: 'Step 1 — install the extension in the browser you actually use',
    installBody: 'Open chrome://extensions, turn on Developer mode, click "Load unpacked", and pick the folder below. Installing it in your everyday browser is what lets the agent reuse the sessions you are already signed into. It creates no new login and sends nothing off this machine.',
    copy: 'Copy path',
    copied: 'Copied',
    interactTitle: 'Sites the agent may interact with',
    interactBody: 'Only these sites allow clicking, typing, and searching. Empty by default. Adding a site lets the agent press any button and submit any form on it — including send, delete, and pay.',
    readTitle: 'Sites the agent may not read',
    readBody: 'These sites cannot even be read (banking, mail, password managers). Everything else is readable by default. The shipped list is a starting point and is certainly incomplete.',
    hostPlaceholder: 'e.g. example.com (includes subdomains)',
    add: 'Add', save: 'Save', saving: 'Saving…', saved: 'Saved',
    emptyInteract: '(empty — the agent cannot click or type anywhere)',
    ready: 'Extension connected. Ready to use.',
    noExt: 'Extension not connected yet. Install it using the steps below.',
    noBridge: 'The local service is not running. Try re-enabling this plugin in settings.',
  },
};

// 语言只跟随 Cindy 宿主(主机会设 <html lang>)。绝不读 navigator.language 或系统语言
// ——那会让插件和宿主界面说两种话,仓库门禁也会直接拦下。
const lang = String(document.documentElement.lang || 'en');
const T = STRINGS[lang] || (lang.startsWith('zh') ? STRINGS['zh-CN'] : STRINGS.en);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T[el.dataset.i18n] || '';
for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = T[el.dataset.i18nPh] || '';

let state = { read: { block: [] }, interact: { allow: [] } };

function chip(host, onRemove) {
  const d = document.createElement('span');
  d.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:3px 8px;margin:0 6px 6px 0;' +
    'border-radius:999px;font-size:12px;background:var(--surface,#f2f2ef);' +
    'border:1px solid var(--border-default,#e4e4e0)';
  const t = document.createElement('span'); t.textContent = host;
  const x = document.createElement('span'); x.textContent = '×';
  x.style.cssText = 'cursor:pointer;opacity:.6;font-size:14px;line-height:1';
  x.onclick = onRemove;
  d.append(t, x);
  return d;
}

function render() {
  const il = $('#interact-list'); il.textContent = '';
  const allow = state.interact.allow || [];
  if (!allow.length) {
    const e = document.createElement('span');
    e.style.cssText = 'font-size:12px;opacity:.55'; e.textContent = T.emptyInteract;
    il.append(e);
  } else {
    allow.forEach((h) => il.append(chip(h, () => {
      state.interact.allow = allow.filter((x) => x !== h); render();
    })));
  }
  const rl = $('#read-list'); rl.textContent = '';
  (state.read.block || []).forEach((h) => rl.append(chip(h, () => {
    state.read.block = state.read.block.filter((x) => x !== h); render();
  })));
}

const norm = (v) => String(v || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

$('#interact-add').onclick = () => {
  const v = norm($('#interact-input').value);
  if (v && !state.interact.allow.includes(v)) state.interact.allow.push(v);
  $('#interact-input').value = ''; render();
};
$('#read-add').onclick = () => {
  const v = norm($('#read-input').value);
  if (v && !state.read.block.includes(v)) state.read.block.push(v);
  $('#read-input').value = ''; render();
};
$('#interact-input').onkeydown = (e) => { if (e.key === 'Enter') $('#interact-add').click(); };
$('#read-input').onkeydown = (e) => { if (e.key === 'Enter') $('#read-add').click(); };
$('#save').onclick = () => {
  $('#hint').textContent = T.saving;
  bc.postMessage({ type: 'save-request', policy: state });
};
$('#copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#extdir').textContent);
    $('#copy').textContent = T.copied;
    setTimeout(() => { $('#copy').textContent = T.copy; }, 1500);
  } catch (e) { /* 剪贴板被拒时用户可以手动选中复制 */ }
};

bc.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'status-result') {
    const p = m.payload || {};
    if (p.error) { $('#status').textContent = T.noBridge; return; }
    $('#status').textContent = p.extension_connected ? T.ready : T.noExt;
    $('#install').style.display = p.extension_connected ? 'none' : '';
    $('#extdir').textContent = p.extension_dir || '';
    if (p.policy) state = { read: { block: p.policy.read.block || [] },
                            interact: { allow: p.policy.interact.allow || [] } };
    else if (p.policy_defaults) state = p.policy_defaults;
    render();
  } else if (m.type === 'save-result') {
    $('#hint').textContent = T.saved;
    bc.postMessage({ type: 'status-request' });
  }
};

bc.postMessage({ type: 'status-request' });
// 电子脑是按需拉起的,首帧可能还没醒
let tries = 0;
const t = setInterval(() => {
  if (++tries > 3) { clearInterval(t); return; }
  bc.postMessage({ type: 'status-request' });
}, 1500);
render();
