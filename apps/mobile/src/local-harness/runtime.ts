import AsyncStorage from "@react-native-async-storage/async-storage";
import { localScope } from "./storage";
import type { DeviceView, LinkAcceptPayload } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { InputProjection, PendingInteraction, QueuedRemoteMessage, RemoteMessage, RemoteSession } from '@/session/types';
import { i18n } from '@/i18n';
import { kernel, nativeHarness, type Session, type SessionRow, type WorkspaceFile } from './kernel';
import { availableTools, drive, openSession, stop, subscribe } from './driver';
import { modelOf, providers } from './providers';
import { LOCAL_DEVICE_ID } from './destination';

export const localDeviceName = () => i18n.t('session.local.device');
export const localLink: LinkAcceptPayload = { appVersion: '1', allowlistHash: 'cindy-mobile-local' };
export const localDevice = (): DeviceView => ({ deviceId: LOCAL_DEVICE_ID, name: localDeviceName(), platform: 'mobile', appVersion: '1', lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, isSelf: true });
const iso = (ms: number) => new Date(ms).toISOString();
const running = (s: Session) => ['running', 'executing'].includes(s.status);
function project(s: Session | SessionRow): RemoteSession {
  const history = Array.isArray(s.messages) ? s.messages : [];
  return {
    id: s.id, userId: getMobileAuthOwner().accountId, title: s.title, model: s.model.model,
    providerId: s.model.provider, agentKind: 'cindy', source: 'mobile', workspaceKind: 'dialogue',
    workingDir: `/tasks/${s.id}`, effort: '', fastMode: false, permissionMode: 'ask',
    status: s.metadata.status === 'archived' ? 'archived' : s.metadata.status === 'deleted' ? 'deleted' : 'active',
    pinnedAt: typeof s.metadata.pinnedAt === 'string' ? s.metadata.pinnedAt : null,
    userSendAt: history.filter(m => m.role === 'user').at(-1)?.created_at ? iso(history.filter(m => m.role === 'user').at(-1)!.created_at) : null,
    createdAt: iso(s.created_at), updatedAt: iso(s.updated_at),
    deviceLinkDeviceId: LOCAL_DEVICE_ID, deviceLinkDeviceName: localDeviceName(), canonicalDeviceId: LOCAL_DEVICE_ID,
    preview: history.at(-1)?.text ?? null,
  };
}
function messages(s: Session): RemoteMessage[] {
  return s.messages.flatMap((m, index) => {
    const id = `${s.id}:${index}`;
    const base = { id, clientId: m.client_id ?? id, sessionId: s.id, rowid: index + 1, createdAt: iso(m.created_at), agentMeta: null, toolUseId: m.call_id ?? null };
    const rows: RemoteMessage[] = m.text ? [{ ...base, role: m.call_id ? 'tool_result' : m.role === 'user' ? 'user' : 'assistant', content: m.call_id ? { content: m.text, toolUseId: m.call_id, isError: m.is_error } : m.text }] : [];
    for (const call of m.calls ?? []) rows.push({ ...base, id: call.id, clientId: call.id, role: 'tool_use', toolUseId: call.id, content: { toolUseId: call.id, toolName: call.name, input: call.arguments } });
    return rows;
  });
}
function interactions(s: Session): PendingInteraction[] {
  const e = s.effect;
  return e?.kind === 'approval' ? [{ request: { kind: 'permission', requestId: `${s.id}/${e.id}`, toolName: e.call.name, toolUseId: e.call.id, input: e.call.arguments, suggestions: [] } }] : [];
}
function projection(s: Session): InputProjection {
  return { sessionId: s.id, pendingQueue: queue(s), steeringQueueClientIds: [], queuePaused: s.metadata.queuePaused === true, queueExpanded: s.metadata.queueExpanded === true, queueInteractionLocks: locks(s, 'queueInteractionLocks'), queueEditLocks: locks(s, 'queueEditLocks'), queueAbortPending: false, error: s.error ?? (typeof s.metadata.queueError === 'string' ? s.metadata.queueError : null), errorRetryText: null, credentialSwitchWait: null, continuationTurnClientId: null };
}
const locks = (s: Session, key: string): string[] => Array.isArray(s.metadata[key]) ? (s.metadata[key] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
const queue = (s: Session): QueuedRemoteMessage[] => Array.isArray(s.metadata.queue) ? s.metadata.queue as QueuedRemoteMessage[] : [];
function publish(s: Session) {
  remoteSessionStore.batch(() => {
    remoteSessionStore.upsertDeviceSession(LOCAL_DEVICE_ID, localDeviceName(), project(s));
    remoteSessionStore.setMessages(s.id, messages(s));
    remoteSessionStore.setPendingInteractions(s.id, interactions(s));
    remoteSessionStore.setSessionRunning(s.id, running(s));
    remoteSessionStore.setInputProjection(s.id, projection(s));
  });
  return s;
}
const serial = new Map<string, Promise<unknown>>();
function exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
  const next = (serial.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
  serial.set(id, next);
  void next.finally(() => { if (serial.get(id) === next) serial.delete(id); }).catch(() => undefined);
  return next;
}
const pumps = new Set<string>();
function pump(id: string): void {
  if (pumps.has(id)) return;
  pumps.add(id);
  const owner = getMobileAuthOwner();
  void (async () => {
    while (isMobileAuthOwnerCurrent(owner)) {
      const next = await exclusive(id, async () => {
        const s = await kernel({ op: 'load', id });
        if (s.effect || s.metadata.queuePaused || s.metadata.queueError || locks(s, 'queueInteractionLocks').length || locks(s, 'queueEditLocks').length || !queue(s).length) return null;
        const item = queue(s)[0];
        // Submit is idempotent by clientId. A crash between these two commits
        // cannot repeat a model turn or its tool effects on the next resume.
        const sent = await kernel({ op: 'submit', id, client_id: item.clientId, text: item.text, model: s.model, tools: availableTools() });
        return kernel({ op: 'update', id, metadata: { queue: queue(sent).slice(1) } });
      });
      if (!next) break;
      const done = await drive(next);
      if (done.effect || done.error || done.status === 'interrupted') break;
    }
  })().catch(async () => {
    if (isMobileAuthOwnerCurrent(owner)) publish(await kernel({ op: 'update', id, metadata: { queuePaused: true, queueError: 'EXECUTION_FAILED' } }));
  }).finally(async () => {
    pumps.delete(id);
    if (!isMobileAuthOwnerCurrent(owner)) return;
    const s = await kernel({ op: 'load', id });
    if (!s.effect && !s.error && !['interrupted', 'cancelled'].includes(s.status) && !s.metadata.queuePaused && !s.metadata.queueError
      && !locks(s, 'queueInteractionLocks').length && !locks(s, 'queueEditLocks').length && queue(s).length) pump(id);
  }).catch(() => undefined);
}
export async function mountLocalRuntime(): Promise<() => void> {
  if (!nativeHarness || getMobileAuthOwner().switching) return () => {};
  const owner = getMobileAuthOwner();
  const off = subscribe(s => { if (isMobileAuthOwnerCurrent(owner)) publish(s); });
  try {
    const rows = await kernel<SessionRow[]>({ op: 'list' });
    if (isMobileAuthOwnerCurrent(owner)) remoteSessionStore.setDeviceSessions(LOCAL_DEVICE_ID, localDeviceName(), rows.map(project));
    return off;
  } catch (error) { off(); throw error; }
}
async function catalog(): Promise<{ providers: ProviderView[] }> {
  const all = await providers();
  const appleReady = await nativeHarness?.localModelAvailability() === 'available';
  return { providers: all.map(p => ({
    id: p.id, name: p.name, source: p.auth === 'cindy' ? 'builtin' : 'user', agents: ['cindy'],
    routing: { cindy: { upstream: p.endpoint, authStrategy: p.auth === 'cindy' ? 'gateway-key' : p.protocol === 'apple' ? 'none' : p.auth === 'chatgpt' ? 'oauth-token' : 'api-key-header' } },
    connected: p.protocol !== 'apple' || appleReady, auth: { method: p.protocol === 'apple' ? 'none' : p.auth === 'chatgpt' ? 'oauth' : 'apiKey' },
    models: { cindy: (p.models ?? [{ id: p.model, name: p.model }]).map(m => ({ id: m.id, name: m.name, efforts: [], defaultEffort: null, contextWindow: Math.floor((m.contextBytes ?? p.contextBytes) / 4), ...m.catalog })) },
  })) };
}
async function model(providerId: unknown, modelId: unknown) {
  const p = (await providers()).find(p => p.id === providerId && (p.model === modelId || p.models?.some(m => m.id === modelId)));
  if (!p) throw new Error('PROVIDER_UNAVAILABLE');
  return modelOf(p, String(modelId));
}
export async function invokeLocal<T>(channel: string, args: unknown[] = []): Promise<T> {
  return await dispatch(channel, args) as T;
}
async function dispatch(channel: string, args: unknown[]): Promise<unknown> {
  const id = typeof args[0] === 'string' ? args[0] : '';
  const load = () => kernel({ op: 'load', id });
  switch (channel) {
    case 'maker:list-available-agents': return ['cindy'];
    case 'maker:provider:list': return catalog();
    case 'maker:api-key:present': return { present: (await providers()).some(p => p.auth === 'cindy' && p.models?.length) };
    case 'maker:get-capabilities': return { availableModels: (await providers()).flatMap(p => (p.models ?? [{ id: p.model, name: p.model }]).map(m => ({ id: m.id, label: m.name }))), permissionModes: [{ id: 'ask', label: 'ask' }], hasFastMode: false };
    case 'maker:get-new-maker-defaults': {
      const scope = localScope(); const raw = await AsyncStorage.getItem(`${scope.key}.model-default`); scope.assert();
      const pref = raw ? JSON.parse(raw) : null; const all = await providers();
      const p = all.find(p => p.id === pref?.providerId) ?? all.find(p => p.protocol !== 'apple');
      return { agentKind: 'cindy', model: p?.id === pref?.providerId ? pref.modelId : p?.model ?? '', providerId: p?.id ?? null, permissionMode: 'ask', worktreeEnabled: false };
    }
    case 'local-db:sessions:list': return (await kernel<SessionRow[]>({ op: 'list' })).map(project).filter(s => s.status !== 'deleted');
    case 'maker:create-session': {
      const opts = args[0] as { id?: string; model: string; providerId: string; title?: string; agentKind: string };
      if (opts.agentKind !== 'cindy') throw new Error('AGENT_UNAVAILABLE');
      const s = publish(await kernel({ op: 'create', id: opts.id, title: opts.title ?? i18n.t('session.local.newTask'), model: await model(opts.providerId, opts.model) }));
      return { sessionId: s.id, agentKind: 'cindy', workDir: `/tasks/${s.id}` };
    }
    case 'local-db:sessions:get': return project(publish(await openSession(id)));
    case 'local-db:sessions:patch-meta': {
      const patch = args[1] as Record<string, unknown>;
      return project(publish(await kernel({ op: 'update', id, title: patch.title, metadata: { ...(await load()).metadata, ...patch } })));
    }
    case 'local-db:messages:list': return messages(await load());
    case 'maker:get-pending-interactions': return interactions(await load());
    case 'maker:resolve-interaction': {
      const [sessionId, effectId] = id.split('/');
      const decision = args[1] as { behavior?: string };
      const s = await exclusive(sessionId, () => kernel({ op: 'approve', id: sessionId, effect_id: effectId, allow: decision.behavior === 'allow' }));
      void drive(s).then(() => pump(sessionId)).catch(() => undefined);
      return { ok: true };
    }
    case 'maker:input:get-projection': return projection(await load());
    case 'maker:input:enqueue': {
      const item = args[1] as QueuedRemoteMessage;
      if (!item?.clientId || typeof item.text !== 'string' || !item.text.trim()) throw new Error('INVALID_INPUT');
      if (item.chatMessage?.images?.length || item.files?.length) throw new Error('ATTACHMENTS_UNSUPPORTED');
      const s = await exclusive(id, async () => {
        const old = await load();
        if (old.messages.some(m => m.client_id === item.clientId) || queue(old).some(q => q.clientId === item.clientId)) return old;
        return kernel({ op: 'update', id, metadata: { queue: [...queue(old), item], queueError: null } });
      });
      publish(s); pump(id); return projection(s);
    }
    case 'maker:input:stop': {
      await exclusive(id, () => kernel({ op: 'update', id, metadata: { queuePaused: true } }));
      return projection(publish(await stop(id)));
    }
    case 'maker:input:retry-last-error': case 'maker:input:resume': {
      const s = publish(await kernel({ op: 'update', id, metadata: { queuePaused: false, queueError: null } }));
      if (['interrupted', 'cancelled', 'error'].includes(s.status) && !queue(s).length) void kernel({ op: 'resume', id, tools: availableTools() }).then(drive).catch(() => undefined);
      else pump(id);
      return projection(s);
    }
    case 'maker:input:remove': {
      const s = await exclusive(id, async () => kernel({ op: 'update', id, metadata: { queue: queue(await load()).filter(q => q.clientId !== args[1]) } }));
      return projection(publish(s));
    }
    case 'maker:set-model': return project(publish(await kernel({ op: 'update', id, model: await model(args[2], args[1]) })));
    case 'maker:list-active': return (await kernel<SessionRow[]>({ op: 'list' })).filter(s => ['running', 'executing', 'approval'].includes(s.status)).map(s => ({ sessionId: s.id, isTurnRunning: s.status !== 'approval', agentKind: 'cindy' }));
    case 'maker:get-session-agent-switch-intent': return null;
    case 'maker:apply-new-maker-draft-pref': {
      const pref = args[0] as { active?: boolean; modelId?: string; providerId?: string };
      if (pref.active) { const scope = localScope(); await model(pref.providerId, pref.modelId); scope.assert(); await AsyncStorage.setItem(`${scope.key}.model-default`, JSON.stringify(pref)); scope.assert(); }
      return undefined;
    }
    case 'maker:set-session-model-pref': case 'maker:clear-session-attention': return undefined;
    case 'maker:usage:model-pricing': return {};
    case 'maker:list-agent-commands': case 'maker:list-agent-skills': return [];
    case 'maker:input:set-expanded': case 'maker:input:clear-error': {
      return projection(publish(await kernel({ op: 'update', id, metadata: channel.endsWith('set-expanded') ? { queueExpanded: args[1] === true } : { queueError: null } })));
    }
    case 'maker:input:set-interaction-lock': case 'maker:input:set-edit-lock': {
      const key = channel.endsWith('set-edit-lock') ? 'queueEditLocks' : 'queueInteractionLocks';
      const s = await exclusive(id, async () => {
        const values = new Set(locks(await load(), key));
        if (args[2]) values.add(String(args[1])); else values.delete(String(args[1]));
        return kernel({ op: 'update', id, metadata: { [key]: [...values] } });
      });
      publish(s); pump(id); return projection(s);
    }
    case 'maker:input:move': case 'maker:input:update-text': case 'maker:input:update-content': {
      const s = await exclusive(id, async () => {
        const items = [...queue(await load())]; const index = items.findIndex(q => q.clientId === args[1]);
        if (index < 0) throw new Error('QUEUE_ITEM_NOT_FOUND');
        if (channel.endsWith(':move')) { const [item] = items.splice(index, 1); items.splice(Math.max(0, Math.min(items.length, Number(args[2]) || 0)), 0, item); }
        else if (channel.endsWith(':update-content')) { const next = args[2] as QueuedRemoteMessage; items[index] = { ...next, clientId: items[index].clientId }; }
        else { const text = String(args[2]); items[index] = { ...items[index], text, persistedContent: text, chatMessage: { ...items[index].chatMessage, content: text } }; }
        return kernel({ op: 'update', id, metadata: { queue: items } });
      }); return projection(publish(s));
    }
    case 'ghosts:composer-list': case 'maker:model-favorites:get': return [];
    case 'worktree:detect-cwd': return { isGitRepo: false, isInsideWorktree: false, gitInstalled: false };
    case 'file-browser:remote-op': {
      const request = args[0] as { op: string; workdir: string; relPath?: string };
      const match = /^\/tasks\/([a-f0-9-]{36})$/i.exec(request.workdir);
      if (!match) throw new Error('PATH_OUTSIDE_WORKSPACE');
      const path = request.relPath || '.';
      if (request.op === 'caps') return { ok: true, completeDirectoryListing: true, fileRead: false };
      if (request.op === 'listDir') {
        const list = JSON.parse(await kernel<string>({ op: 'files', id: match[1], path })) as WorkspaceFile[];
        return list.map(f => ({ name: f.name, relPath: [request.relPath, f.name].filter(Boolean).join('/'), type: f.directory ? 'directory' : 'file', size: 0, mtimeMs: 0 }));
      }
      if (request.op === 'readFile') {
        const content = await kernel<string>({ op: 'read_file', id: match[1], path });
        return { ok: true, data: { relPath: path, content, size: new TextEncoder().encode(content).length, mtimeMs: 0 } };
      }
      throw new Error('FILE_OPERATION_UNAVAILABLE');
    }
    case 'fs:list-dir': case 'text-file:read-preview': {
      const value = args[0] as { path?: string; filePath?: string };
      const path = typeof args[0] === 'string' ? args[0] : value.path ?? value.filePath ?? '';
      const match = /^\/tasks\/([a-f0-9-]{36})(?:\/(.*))?$/i.exec(path);
      if (!match) throw new Error('PATH_OUTSIDE_WORKSPACE');
      if (channel === 'fs:list-dir') {
        const list = JSON.parse(await kernel<string>({ op: 'files', id: match[1], path: match[2] || '.' })) as WorkspaceFile[];
        return { resolvedPath: path, parent: match[2] ? path.slice(0, path.lastIndexOf('/')) : null, entries: list.map(f => ({ name: f.name, path: `${path}/${f.name}`, kind: f.directory ? 'dir' : 'file' })) };
      }
      const content = await kernel<string>({ op: 'read_file', id: match[1], path: match[2] });
      return { success: true, data: content, size: new TextEncoder().encode(content).length };
    }
    default: throw Object.assign(new Error(`[CHANNEL_NOT_ALLOWED] ${channel}`), { code: 'CHANNEL_NOT_ALLOWED' });
  }
}
