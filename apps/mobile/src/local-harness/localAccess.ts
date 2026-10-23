import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { nativeHarness } from './kernel';

const key = 'cindy.mobile.local-access.v1';
let snapshot = { ready: false, enabled: false };
const listeners = new Set<() => void>();
const publish = (enabled: boolean) => {
  snapshot = { ready: true, enabled: !!nativeHarness && enabled };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => snapshot;
let loading: Promise<void> | undefined;
export function loadLocalAccess() {
  return loading ??= AsyncStorage.getItem(key).then(value => publish(value === 'true'), () => publish(false));
}
export async function enableLocalAccess() {
  if (!nativeHarness) throw new Error('NATIVE_UPDATE_REQUIRED');
  await loadLocalAccess();
  await AsyncStorage.setItem(key, 'true');
  publish(true);
}
export const useLocalAccess = () => useSyncExternalStore(subscribe, read);
