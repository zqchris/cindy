// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  router: { replace: vi.fn(), setParams: vi.fn() },
  auth: { user: { id: 'owner' }, accountGeneration: 1 },
  link: { invoke: vi.fn(), connectionEpoch: 1, status: 'online', onRemoteResourceChanged: vi.fn(() => () => {}), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useFocusEffect: useEffect,
    useLocalSearchParams: () => ({ resourceCollectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot' }),
    useRouter: () => h.router,
  };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: h.get }));
vi.mock('@/device-link/remoteResourceCache', () => ({ markRemoteResourceRead: vi.fn() }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {} }));
import { useRemoteResourceSession } from '@/session/useRemoteResourceSession';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
function Probe() { useRemoteResourceSession('mac', 'My Mac', 'task-1'); return null; }
async function render() {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Probe)));
}
beforeEach(() => { vi.clearAllMocks(); h.auth.accountGeneration = 1; });
afterEach(() => { act(() => root?.unmount()); root = undefined; });

describe('companion task visibility refresh', () => {
  it.each([Object.assign(new Error('gone'), { code: 'NOT_FOUND' }), new Error('[NOT_FOUND] resource missing')])('leaves the cached task when the host rejects the resource', async (error) => {
    h.get.mockRejectedValue(error);
    await render();
    expect(h.router.replace).toHaveBeenCalledWith({ pathname: '/resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot', deviceId: 'mac', deviceName: 'My Mac',
    } });
  });
  it('retains recovery for a transient connection failure', async () => {
    h.get.mockRejectedValue(new Error('NOT_CONNECTED'));
    await render();
    expect(h.router.replace).not.toHaveBeenCalled();
  });
  it('ignores a visibility rejection belonging to the previous account', async () => {
    let reject!: (error: Error) => void;
    h.get.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    await render();
    h.get.mockReturnValueOnce(new Promise(() => {}));
    h.auth.accountGeneration = 2;
    await render();
    await act(async () => reject(new Error('[NOT_FOUND] old owner')));
    expect(h.router.replace).not.toHaveBeenCalled();
  });
});
