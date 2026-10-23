import { useLocalAccess } from "./localAccess";
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useAuth } from '@/auth/AuthContext';
import { getActiveMobileSessionRealm, getMobileEndpointForRealm } from '@/config/env';
import { evictDeviceProviders } from '@/device-link/deviceProvidersCache';
import { LOCAL_DEVICE_ID } from './destination';
import { bindCindyAI, createCindyAIClient } from './cindyAI';
import { nativeHarness } from './kernel';
import { mountLocalRuntime } from './runtime';
import { installedPlugins, subscribePlugins, type LocalPlugin } from './plugins';
import { PluginHost } from './PluginHost';

/** Lives alongside the remote runtime; tasks use the same screens and store. */
export function LocalRuntimeBridge() {
  const auth = useAuth();
  const local = useLocalAccess();
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner);
  useEffect(() => {
    if (!nativeHarness || !auth.isAuthenticated || !owner.accountKey || owner.switching) return;
    const realm = getActiveMobileSessionRealm();
    let disposed = false;
    const assertCurrent = () => {
      if (disposed || !isMobileAuthOwnerCurrent(owner)) throw new Error('ACCOUNT_CHANGED');
    };
    const client = createCindyAIClient(path => auth.apiFetch(path, {
      baseUrl: getMobileEndpointForRealm(realm, 'modelAccessApiBaseUrl'),
      timeoutMs: 20_000, cache: 'no-store', assertCurrent,
      headers: { 'X-Cindy-Model-Capabilities': 'audio_speech,display_pricing' },
    }), assertCurrent);
    const unbind = bindCindyAI(client);
    void client.provider().then(() => { assertCurrent(); evictDeviceProviders(LOCAL_DEVICE_ID); }).catch(() => undefined);
    return () => { disposed = true; unbind(); evictDeviceProviders(LOCAL_DEVICE_ID); };
  }, [auth.isAuthenticated, auth.apiFetch, owner]);
  const [plugins, setPlugins] = useState<{ generation: number; items: LocalPlugin[] }>({ generation: -1, items: [] });
  useEffect(() => {
    if (!nativeHarness || owner.switching || (!owner.accountKey && !local.enabled)) { setPlugins({ generation: -1, items: [] }); return; }
    let disposed = false; let unmount = () => {};
    void mountLocalRuntime().then(off => { if (disposed) off(); else unmount = off; }).catch(() => undefined);
    const refresh = () => setPlugins({ generation: owner.generation, items: installedPlugins() });
    refresh(); const offPlugins = subscribePlugins(refresh);
    return () => { disposed = true; unmount(); offPlugins(); };
  }, [owner, local.enabled]);
  if (owner.switching || (!owner.accountKey && !local.enabled) || plugins.generation !== owner.generation) return null;
  return <>{plugins.items.filter(p => p.enabled).map(p => <PluginHost key={`${owner.generation}:${p.manifest.id}:${p.revision}`} plugin={p} />)}</>;
}
