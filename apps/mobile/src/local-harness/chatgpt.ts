import { Platform } from 'react-native';
/** OpenAI's public OSS Sign in with ChatGPT flow; no Codex credential borrowing. */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetch } from 'expo/fetch';
import { nativeHarness } from './kernel';
import { localScope } from './storage';

const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function decodeJson(value: string): Record<string, unknown> {
  const base = value.replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base + '='.repeat((4 - base.length % 4) % 4)), c => c.charCodeAt(0))));
}
export type ChatGPTCredential = {
  clientId: string; subject: string; email: string; accessToken: string; refreshToken: string;
  idToken: string; expiresAt: number; scopes: string[]; hostId: string;
};
type TokenReply = { access_token: string; refresh_token?: string; id_token?: string; expires_in: number; scope?: string; token_type: string };
async function jsonRequest(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), ...init, redirect: 'error', credentials: 'omit' });
  if (!response.ok) throw new Error(`OAUTH_HTTP_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_OAUTH_RESPONSE');
  const decoder = new TextDecoder(); let text = ''; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new Error('OAUTH_RESPONSE_TOO_LARGE'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
async function exchange(params: Record<string, string>): Promise<TokenReply> {
  const result = await jsonRequest(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }) as TokenReply;
  if (typeof result.access_token !== 'string' || !result.access_token || result.token_type?.toLowerCase() !== 'bearer' || !(result.expires_in > 0)) throw new Error('INVALID_OAUTH_RESPONSE');
  return result;
}
async function validateIdToken(token: string, clientId: string, nonce?: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('INVALID_ID_TOKEN');
  const header = decodeJson(parts[0]); const claims = decodeJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('INVALID_ID_TOKEN');
  const doc = await jsonRequest(`${ISSUER}/.well-known/openid-configuration`) as { issuer: string; jwks_uri: string };
  const uri = new URL(doc.jwks_uri);
  if (doc.issuer !== ISSUER || uri.origin !== ISSUER || uri.username || uri.password) throw new Error('INVALID_OIDC_CONFIGURATION');
  const jwks = await jsonRequest(uri.href) as { keys: Array<{ kid: string; kty: string; alg?: string; use?: string; n: string; e: string }> };
  const key = jwks.keys?.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
  if (!key || !await nativeHarness?.verifyRS256(`${parts[0]}.${parts[1]}`, parts[2], key.n, key.e)) throw new Error('INVALID_ID_TOKEN');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId)
    || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() || typeof claims.sub !== 'string'
    || (nonce !== undefined && claims.nonce !== nonce)) throw new Error('INVALID_ID_TOKEN');
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : 'ChatGPT' };
}
const credentialKey = (scope: ReturnType<typeof localScope>, id: string) => `${scope.key}.oauth.${id}`;
const credentialOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
let signingIn = false;
export async function signInChatGPT(id: string): Promise<{ name: string }> {
  if (signingIn) throw new Error('OAUTH_BUSY');
  if (!nativeHarness) throw new Error('NATIVE_UPDATE_REQUIRED');
  const native = nativeHarness; const scope = localScope(); const key = credentialKey(scope, id);
  signingIn = true;
  try {
    const oldRaw = await SecureStore.getItemAsync(key); scope.assert();
    const old = oldRaw ? JSON.parse(oldRaw) as ChatGPTCredential : null;
    const hostKey = `${scope.key}.openai-host`;
    let hostId = await AsyncStorage.getItem(hostKey); scope.assert();
    if (!hostId) { hostId = `urn:uuid:${Crypto.randomUUID()}`; await AsyncStorage.setItem(hostKey, hostId); scope.assert(); }
    const state = toBase64Url(Crypto.getRandomBytes(32));
    const nonce = toBase64Url(Crypto.getRandomBytes(32));
    const verifier = toBase64Url(Crypto.getRandomBytes(32));
    const challenge = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    scope.assert();
    const redirect = await native.startOAuthCallback(state);
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    const params: Record<string, string> = { client_id: old?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect, scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge };
    if (old) params.id_token_hint = old.idToken; else params.agent_name_hint = 'Cindy';
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const waiting = native.waitOAuthCallback();
    // Safari view keeps the loopback host alive; credentials never enter a WebView.
    const browser = WebBrowser.openBrowserAsync(url.href).then(() => { if (Platform.OS === 'ios') void native.cancelOAuthCallback(); }, () => { void native.cancelOAuthCallback(); });
    const callback = new URL(await waiting.finally(() => { if (Platform.OS === 'ios') WebBrowser.dismissBrowser(); }));
    await browser; scope.assert();
    if (callback.origin + callback.pathname !== redirect || callback.searchParams.get('state') !== state) throw new Error('INVALID_OAUTH_CALLBACK');
    if (callback.searchParams.has('error')) throw new Error('OAUTH_DECLINED');
    const clientId = callback.searchParams.get('client_id') ?? old?.clientId;
    const code = callback.searchParams.get('code');
    if (!code || !clientId || clientId === 'dynamic_agent_client' || (old && clientId !== old.clientId)) throw new Error('INVALID_OAUTH_CALLBACK');
    const tokens = await exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE });
    if (!tokens.id_token || !tokens.refresh_token) throw new Error('INVALID_OAUTH_RESPONSE');
    const identity = await validateIdToken(tokens.id_token, clientId, nonce); scope.assert();
    if (old && identity.subject !== old.subject) throw new Error('OAUTH_ACCOUNT_MISMATCH');
    const scopes = (tokens.scope ?? '').split(' ');
    if (!scopes.includes(PLAN_SCOPE)) throw new Error('CHATGPT_PLAN_PERMISSION_REQUIRED');
    const value: ChatGPTCredential = { clientId, ...identity, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, expiresAt: Date.now() + tokens.expires_in * 1000, scopes, hostId };
    await SecureStore.setItemAsync(key, JSON.stringify(value), credentialOptions); scope.assert();
    return { name: `ChatGPT · ${identity.email}` };
  } finally { await native.cancelOAuthCallback(); signingIn = false; }
}
const refreshes = new Map<string, Promise<string>>();
export async function chatGPTAccessToken(id: string): Promise<string> {
  const scope = localScope(); const key = credentialKey(scope, id);
  if (refreshes.has(key)) return refreshes.get(key)!;
  const promise = (async () => {
    const raw = await SecureStore.getItemAsync(key); scope.assert();
    if (!raw) throw new Error('OAUTH_LOGIN_REQUIRED');
    const current = JSON.parse(raw) as ChatGPTCredential;
    if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
    const tokens = await exchange({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken });
    scope.assert();
    if (tokens.id_token) {
      const identity = await validateIdToken(tokens.id_token, current.clientId);
      if (identity.subject !== current.subject) throw new Error('OAUTH_ACCOUNT_MISMATCH');
    }
    const scopes = tokens.scope?.split(' ') ?? current.scopes;
    if (!scopes.includes(PLAN_SCOPE)) throw new Error('CHATGPT_PLAN_PERMISSION_REQUIRED');
    scope.assert();
    if (await SecureStore.getItemAsync(key) !== raw) throw new Error('OAUTH_CREDENTIAL_CHANGED');
    scope.assert();
    await SecureStore.setItemAsync(key, JSON.stringify({ ...current, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? current.refreshToken, idToken: tokens.id_token ?? current.idToken, expiresAt: Date.now() + tokens.expires_in * 1000, scopes }), credentialOptions);
    scope.assert(); return tokens.access_token;
  })();
  refreshes.set(key, promise);
  try { return await promise; } finally { if (refreshes.get(key) === promise) refreshes.delete(key); }
}
export async function disconnectChatGPT(id: string) {
  const scope = localScope(); await SecureStore.deleteItemAsync(credentialKey(scope, id)); scope.assert();
}
export async function chatGPTModels(id: string): Promise<Array<{ id: string; name: string }>> {
  const token = await chatGPTAccessToken(id);
  const response = await jsonRequest(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } }) as { models: Array<{ slug: string; display_name: string; visibility: string }> };
  if (!Array.isArray(response.models)) throw new Error('INVALID_MODEL_CATALOG');
  return response.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string').map(m => ({ id: m.slug, name: m.display_name || m.slug }));
}
