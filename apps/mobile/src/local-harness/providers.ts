import { evictDeviceProviders } from "@/device-link/deviceProvidersCache";
import { LOCAL_DEVICE_ID } from "./destination";
import { localScope } from "./storage";
import { cindyAIProvider, cindyAICredentials, cindyAIRequest } from './cindyAI';
import type { CatalogModel } from '@cindy/model-providers';
import { chatGPTAccessToken, chatGPTModels, disconnectChatGPT, signInChatGPT } from "./chatgpt";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { fetch } from "expo/fetch";
import {
  nativeHarness,
  type Effect,
  type Model,
  type Protocol,
} from "./kernel";

export type Provider = {
  id: string;
  name: string;
  protocol: Protocol;
  endpoint: string;
  model: string;
  contextBytes: number;
  auth?: "chatgpt" | "cindy";
  models?: Array<{ id: string; name: string; protocol?: Protocol; contextBytes?: number; catalog?: CatalogModel }>;
};
const metadataKey = (scope = localScope()) => `${scope.key}.providers.v1`;
export const appleProvider: Provider = {
  id: "apple",
  name: "Apple Intelligence",
  protocol: "apple",
  endpoint: "",
  model: "system",
  contextBytes: 8000,
};
const secretKey = (id: string, scope = localScope()) => `${scope.key}.key.${id}`;
export const modelOf = (p: Provider, model = p.model): Model => ({
  provider: p.id,
  model,
  protocol: p.models?.find(m => m.id === model)?.protocol ?? p.protocol,
  context_bytes: p.models?.find(m => m.id === model)?.contextBytes ?? p.contextBytes,
});
export async function providers(): Promise<Provider[]> {
  const scope = localScope();
  const raw = await AsyncStorage.getItem(metadataKey(scope));
  const cindy = await cindyAIProvider().catch(() => null);
  scope.assert();
  return [...(cindy ? [cindy] : []), appleProvider, ...(raw ? (JSON.parse(raw) as Provider[]) : [])];
}
export function validateEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("INVALID_ENDPOINT");
  return url;
}
export async function saveProvider(
  input: Omit<Provider, "id">,
  key: string,
): Promise<Provider> {
  const scope = localScope();
  validateEndpoint(input.endpoint);
  if (!input.name.trim() || !input.model.trim() || input.protocol === "apple")
    throw new Error("INVALID_PROVIDER");
  const provider = {
    ...input,
    id: Crypto.randomUUID(),
    contextBytes: Math.max(4096, Math.min(input.contextBytes, 4_000_000)),
  };
  await SecureStore.setItemAsync(secretKey(provider.id, scope), key, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  try {
    scope.assert();
    const all = (await providers()).filter((p) => p.id !== "apple" && p.auth !== 'cindy');
    scope.assert();
    await AsyncStorage.setItem(metadataKey(scope), JSON.stringify([...all, provider]));
    scope.assert();
  } catch (error) {
    await SecureStore.deleteItemAsync(secretKey(provider.id, scope));
    throw error;
  }
  evictDeviceProviders(LOCAL_DEVICE_ID);
  return provider;
}
export async function removeProvider(id: string): Promise<void> {
  if (id === 'xd' || id === 'apple') throw new Error('MANAGED_PROVIDER');
  const scope = localScope();
  const all = (await providers()).filter(p => p.id !== id && p.id !== "apple" && p.auth !== 'cindy');
  scope.assert();
  await disconnectChatGPT(id);
  scope.assert();
  await AsyncStorage.setItem(
    metadataKey(scope),
    JSON.stringify(all),
  );
  scope.assert();
  await SecureStore.deleteItemAsync(secretKey(id, scope));
  evictDeviceProviders(LOCAL_DEVICE_ID);
}
export type ModelAdapter = (
  effect: Extract<Effect, { kind: "model" }>,
  signal: AbortSignal,
) => Promise<unknown>;
const adapters = new Map<string, ModelAdapter>();
// Native model engines (e.g. a bundled llama.cpp module) register here. They do
// not need to change session persistence or the agent loop.
export function registerModelAdapter(
  protocol: string,
  adapter: ModelAdapter,
): () => void {
  if (adapters.has(protocol)) throw new Error("MODEL_ADAPTER_EXISTS");
  adapters.set(protocol, adapter);
  return () => {
    if (adapters.get(protocol) === adapter) adapters.delete(protocol);
  };
}
export async function generate(
  effect: Extract<Effect, { kind: "model" }>,
  signal: AbortSignal,
): Promise<unknown> {
  const scope = localScope();
  const adapter =
    adapters.get(effect.model.provider) ?? adapters.get(effect.model.protocol);
  if (adapter) return adapter(effect, signal);
  if (effect.model.protocol === "apple") {
    if (
      !nativeHarness ||
      (await nativeHarness.localModelAvailability()) !== "available"
    )
      throw new Error("LOCAL_MODEL_UNAVAILABLE");
    const native = nativeHarness;
    const cancel = () => {
      void native.cancelLocal(effect.id);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw new Error("CANCELLED");
      return JSON.parse(
        await nativeHarness.generateLocal(
          effect.id,
          JSON.stringify(effect.body),
        ),
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  const provider = (await providers()).find(
    (p) => p.id === effect.model.provider,
  );
  if (!provider || modelOf(provider, effect.model.model).protocol !== effect.model.protocol)
    throw new Error("PROVIDER_UNAVAILABLE");
  const gateway = provider.auth === 'cindy' ? await cindyAICredentials() : null;
  const base = validateEndpoint(gateway?.endpoint ?? provider.endpoint).href.replace(/\/$/, "");
  const key = gateway?.apiKey ?? (provider.auth === "chatgpt" ? await chatGPTAccessToken(provider.id) : await SecureStore.getItemAsync(secretKey(provider.id, scope)));
  scope.assert();
  if (signal.aborted) throw new Error("CANCELLED");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let url: string;
  switch (effect.model.protocol) {
    case "responses":
      url = `${base}/responses`;
      if (key) headers.Authorization = `Bearer ${key}`;
      break;
    case "anthropic":
      url = `${base}/messages`;
      headers["x-api-key"] = key ?? "";
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "google":
      url = `${base}/models/${encodeURIComponent(effect.model.model)}:generateContent`;
      headers["x-goog-api-key"] = key ?? "";
      break;
    default:
      url = `${base}/chat/completions`;
      if (key) headers.Authorization = `Bearer ${key}`;
  }
  const request = gateway ? cindyAIRequest(effect, gateway) : { url, headers, body: JSON.stringify(effect.body) };
  const send = (request: { url: string; headers: Record<string, string>; body: string }) => fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal,
    redirect: "error",
    credentials: "omit",
  });
  let response = await send(request);
  if (gateway && response.status === 401) {
    await response.body?.cancel();
    const fresh = await cindyAICredentials(true);
    scope.assert();
    if (signal.aborted) throw new Error('CANCELLED');
    response = await send(cindyAIRequest(effect, fresh));
  }
  if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
  // Never log HTTP bodies: providers can echo credentials or private prompts.
  if (Number(response.headers.get("content-length") ?? 0) > 4_000_000)
    throw new Error("MODEL_RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EMPTY_MODEL_RESPONSE");
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4_000_000) {
        await reader.cancel();
        throw new Error("MODEL_RESPONSE_TOO_LARGE");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    if (effect.model.protocol === 'responses') {
      for (const frame of body.replaceAll('\r\n', '\n').split('\n\n')) {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.type === 'response.completed') return event.response;
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('MODEL_RESPONSE_FAILED');
      }
      throw new Error('MODEL_STREAM_INTERRUPTED');
    }
    return JSON.parse(body);
  } finally {
    reader.releaseLock();
  }
}

export async function connectChatGPT(): Promise<Provider> {
  const scope = localScope(); const id = Crypto.randomUUID();
  try {
    const { name } = await signInChatGPT(id); scope.assert();
    const models = await chatGPTModels(id); scope.assert();
    if (!models.length) throw new Error('NO_AVAILABLE_MODELS');
    const provider: Provider = { id, name, protocol: 'responses', endpoint: 'https://api.openai.com/v1', model: models[0].id, models, auth: 'chatgpt', contextBytes: 200_000 };
    const all = (await providers()).filter(p => p.id !== 'apple' && p.auth !== 'cindy'); scope.assert();
    await AsyncStorage.setItem(metadataKey(scope), JSON.stringify([...all, provider])); scope.assert();
    evictDeviceProviders(LOCAL_DEVICE_ID);
  return provider;
  } catch (error) { scope.assert(); await disconnectChatGPT(id); throw error; }
}
