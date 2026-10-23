import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import { registerExtension } from "./driver";
import { pluginTools, type LocalPlugin } from "./plugins";
import { kernel } from "./kernel";

type Pending = {
  callId: string;
  sessionId: string;
  effectId: string;
  signal: AbortSignal;
  abort: () => void;
  requests: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};
const escaped = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c");
export function PluginHost({ plugin }: { plugin: LocalPlugin }) {
  const web = useRef<WebView>(null);
  const pending = useRef<Pending | null>(null);
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const tools = useMemo(() => pluginTools(plugin), [plugin]);
  const html = useMemo(() => {
    const nonce = Crypto.randomUUID();
    // The sandbox has no native filesystem, cookies, direct network or eval.
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><script nonce="${nonce}">
      const post = v => window.ReactNativeWebView.postMessage(JSON.stringify(v));
      const callbacks = new Map(); let sequence = 0; let listener;
      const rpc = (kind, args) => new Promise(resolve => { const id = String(++sequence); callbacks.set(id, resolve); post({type:'rpc',id,kind,args}); });
      window.cindy = Object.freeze({ onHostMessage: fn => { listener = fn; }, send: async v => post(v), fetch: args => rpc('fetch', args), fs: args => rpc('fs', args), request: args => rpc('request', args) });
      window.__cindyDispatch = msg => { if(msg.type==='rpc-result') {callbacks.get(msg.id)?.(msg.result); callbacks.delete(msg.id);} else Promise.resolve(listener?.(msg)).catch(()=>post({type:'tool-result',callId:msg.callId,ok:false})); };
      window.addEventListener('error',()=>post({type:'failed'}));
    </script><script nonce="${nonce}">${plugin.source.replace(/<\/script/gi, "<\\/script")}</script><script nonce="${nonce}">post({type:'ready'});</script>`;
  }, [plugin]);
  useEffect(() => {
    if (!ready || !plugin.enabled) return;
    return registerExtension(plugin.manifest.id, {
      tools,
      execute: (call, signal, context) =>
        new Promise((resolve, reject) => {
          if (pending.current) {
            reject(new Error("PLUGIN_BUSY"));
            return;
          }
          if (signal.aborted) {
            reject(new Error("CANCELLED"));
            return;
          }
          const callController = new AbortController();
          const reset = () => {
            callController.abort();
            pending.current = null;
            setReady(false);
            setGeneration((x) => x + 1);
          };
          const cancel = () => {
            reset();
            reject(new Error("CANCELLED"));
          };
          signal.addEventListener("abort", cancel, { once: true });
          pending.current = {
            callId: call.id,
            ...context,
            signal: callController.signal,
            abort: () => callController.abort(),
            requests: 0,
            resolve: (value) => {
              signal.removeEventListener("abort", cancel);
              callController.abort();
              pending.current = null;
              resolve(value);
            },
            reject: (error) => {
              signal.removeEventListener("abort", cancel);
              reset();
              reject(error);
            },
          };
          const index = tools.findIndex((t) => t.name === call.name);
          web.current?.injectJavaScript(
            `window.__cindyDispatch(${escaped({ type: "tool-call", callId: call.id, tool: plugin.manifest.tools![index].name, args: call.arguments })});true;`,
          );
        }),
    });
  }, [ready, plugin, tools]);
  useEffect(
    () => () => {
      pending.current?.reject(new Error("PLUGIN_UNLOADED"));
    },
    [],
  );
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
    >
      <WebView
        key={generation}
        ref={web}
        source={{ html }}
        originWhitelist={["about:blank"]}
        javaScriptEnabled
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        incognito
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank"
        }
        onContentProcessDidTerminate={() => {
          pending.current?.reject(new Error("PLUGIN_TERMINATED"));
          setReady(false);
          setGeneration((x) => x + 1);
        }}
        onMessage={(event) => {
          if (event.nativeEvent.data.length > 2_000_000) {
            pending.current?.reject(new Error("PLUGIN_OUTPUT_TOO_LARGE"));
            return;
          }
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(event.nativeEvent.data);
          } catch {
            return;
          }
          if (msg.type === "ready") {
            setReady(true);
            return;
          }
          const active = pending.current;
          if (!active || active.signal.aborted) return;
          if (msg.type === "failed") {
            active.reject(new Error("PLUGIN_FAILED"));
            return;
          }
          if (msg.type === "tool-result" && msg.callId === active.callId) {
            if (active.requests) {
              active.reject(new Error("PLUGIN_UNFINISHED_REQUESTS"));
              return;
            }
            if (msg.ok === false) active.reject(new Error("PLUGIN_FAILED"));
            else active.resolve(JSON.stringify(msg.result ?? null));
          } else if (msg.type === "rpc" && typeof msg.id === "string") {
            if (active.requests >= 4) {
              active.reject(new Error("PLUGIN_REQUEST_LIMIT"));
              return;
            }
            active.requests += 1;
            void hostRequest(msg, active).then((result) => {
              active.requests -= 1;
              if (pending.current !== active || active.signal.aborted) return;
              web.current?.injectJavaScript(
                `window.__cindyDispatch(${escaped({ type: "rpc-result", id: msg.id, result })});true;`,
              );
            });
          }
        }}
      />
    </View>
  );
}
async function hostRequest(
  msg: Record<string, unknown>,
  active: Pending,
): Promise<unknown> {
  try {
    const args = msg.args as Record<string, unknown>;
    if (!args || args.callId !== active.callId) throw new Error("INVALID_CALL");
    if (msg.kind === "fs") {
      if (
        args.root !== "workdir" ||
        typeof args.path !== "string" ||
        typeof args.content !== "string"
      )
        throw new Error("UNSUPPORTED_FILE_OPERATION");
      await kernel({
        op: "extension_file",
        id: active.sessionId,
        effect_id: active.effectId,
        path: args.path,
        content: args.content,
      });
      return { ok: true, path: args.path };
    }
    if (
      msg.kind !== "fetch" ||
      typeof args.url !== "string" ||
      (args.as && args.as !== "text")
    )
      throw new Error("UNSUPPORTED_CAPABILITY");
    const url = new URL(args.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      throw new Error("INVALID_URL");
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
      throw new Error("INVALID_METHOD");
    const body = typeof args.body === "string" ? args.body : undefined;
    if (body && body.length > 256_000) throw new Error("REQUEST_TOO_LARGE");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      (args.headers ?? {}) as Record<string, unknown>,
    )) {
      if (
        ["accept", "content-type"].includes(name.toLowerCase()) &&
        typeof value === "string"
      )
        headers[name] = value;
    }
    const response = await fetch(url.href, {
      method,
      headers,
      body,
      signal: active.signal,
      credentials: "omit",
      redirect: "error",
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    if (reader)
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 1_000_000) {
            await reader.cancel();
            throw new Error("RESPONSE_TOO_LARGE");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    return {
      ok: true,
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") },
      body: text + decoder.decode(),
    };
  } catch {
    return {
      ok: false,
      message: "MOBILE_CAPABILITY_UNAVAILABLE_OR_REQUEST_FAILED",
    };
  }
}
