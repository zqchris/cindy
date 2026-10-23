import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from "@/auth/authOwnerGeneration";
import { AppState } from "react-native";
import { kernel, type Session, type Tool, type ToolCall } from "./kernel";
import { generate } from "./providers";

export type Extension = {
  tools: Tool[];
  execute(
    call: ToolCall,
    signal: AbortSignal,
    context: { sessionId: string; effectId: string },
  ): Promise<string>;
};
const extensions = new Map<string, Extension>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<(session: Session) => void>();
export const subscribe = (listener: (session: Session) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(session: Session): Session {
  for (const listener of listeners) listener(session);
  return session;
}
export function registerExtension(
  source: string,
  extension: Extension,
): () => void {
  if (
    extensions.has(source) ||
    extension.tools.some((t) => t.source !== source)
  )
    throw new Error("EXTENSION_EXISTS");
  extensions.set(source, extension);
  return () => {
    if (extensions.get(source) === extension) extensions.delete(source);
  };
}
export const availableTools = () =>
  [...extensions.values()].flatMap((x) => x.tools);
export async function openSession(id: string): Promise<Session> {
  return kernel({ op: controllers.has(id) ? "load" : "recover", id });
}
export async function stop(id: string): Promise<Session> {
  controllers.get(id)?.abort();
  return publish(await kernel({ op: "cancel", id }));
}
// Mobile suspension is explicit interruption; there is no promise of an
// immortal process. The next launch recovers the committed session instead.
AppState.addEventListener("change", (state) => {
  if (state === "background")
    for (const id of controllers.keys()) void stop(id).catch(() => undefined);
});
export async function drive(initial: Session): Promise<Session> {
  if (controllers.has(initial.id)) throw new Error("SESSION_BUSY");
  const owner = getMobileAuthOwner();
  const assertOwner = () => { if (!isMobileAuthOwnerCurrent(owner)) throw new Error("ACCOUNT_CHANGED"); };
  const controller = new AbortController();
  const offOwner = subscribeMobileAuthOwner(() => { if (!isMobileAuthOwnerCurrent(owner)) controller.abort(); });
  controllers.set(initial.id, controller);
  let current = publish(initial);
  try {
    while (
      current.effect &&
      current.effect.kind !== "approval" &&
      !controller.signal.aborted
    ) {
      assertOwner();
      const effect = current.effect;
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        if (effect.kind === "model") {
          const response = await generate(effect, controller.signal);
          if (controller.signal.aborted) break;
          current = await kernel({
            op: "model_result",
            id: current.id,
            effect_id: effect.id,
            response,
          });
        } else if (effect.tool.source === "core") {
          current = await kernel({
            op: "execute",
            id: current.id,
            effect_id: effect.id,
          });
        } else {
          const extension = extensions.get(effect.tool.source);
          if (
            !extension?.tools.some(
              (t) =>
                t.name === effect.tool.name &&
                t.revision === effect.tool.revision,
            )
          )
            throw new Error("EXTENSION_CHANGED");
          await kernel({
            op: "claim_tool",
            id: current.id,
            effect_id: effect.id,
          });
          let result: string;
          let is_error = false;
          try {
            result = await extension.execute(effect.call, controller.signal, {
              sessionId: current.id,
              effectId: effect.id,
            });
          } catch {
            result =
              "Extension execution failed. Inspect external state before retrying.";
            is_error = true;
          }
          if (controller.signal.aborted) break;
          current = await kernel({
            op: "tool_result",
            id: current.id,
            effect_id: effect.id,
            result,
            is_error,
          });
        }
        publish(current);
      } finally {
        clearTimeout(timeout);
      }
    }
    assertOwner();
    if (controller.signal.aborted)
      current = publish(await kernel({ op: "recover", id: current.id }));
    return current;
  } catch (error) {
    assertOwner();
    const loaded = await kernel({ op: "load", id: current.id });
    if (!loaded.effect || loaded.effect.id !== current.effect?.id)
      return publish(loaded);
    const code =
      error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
        ? error.message
        : "EXECUTION_FAILED";
    return publish(
      await kernel({
        op: "fail",
        id: current.id,
        effect_id: loaded.effect.id,
        code,
      }),
    );
  } finally {
    offOwner();
    if (controllers.get(initial.id) === controller)
      controllers.delete(initial.id);
  }
}
