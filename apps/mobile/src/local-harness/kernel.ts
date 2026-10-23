import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from "@/auth/authOwnerGeneration";
import { requireOptionalNativeModule } from "expo-modules-core";

export type Protocol = "openai" | "responses" | "anthropic" | "google" | "apple";
export type Model = {
  provider: string;
  model: string;
  protocol: Protocol;
  context_bytes: number;
};
export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  source: string;
  revision: string;
  writes: boolean;
};
export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type Message = {
  client_id?: string;
  created_at: number;
  role: string;
  text: string;
  calls?: ToolCall[];
  call_id?: string;
  is_error: boolean;
};
export type Effect =
  | {
      kind: "model";
      id: string;
      model: Model;
      body: Record<string, unknown>;
      compact: boolean;
    }
  | { kind: "approval" | "tool"; id: string; call: ToolCall; tool: Tool };
export type Session = {
  id: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
  title: string;
  model: Model;
  messages: Message[];
  tools: Tool[];
  status: string;
  effect: Effect | null;
  error: string | null;
};
export type SessionRow = Pick<Session, "id" | "title" | "model" | "status" | "created_at" | "updated_at" | "metadata"> & {
  messages: number;
};
export type WorkspaceFile = { name: string; directory: boolean };

interface NativeHarness {
  startOAuthCallback(state: string): Promise<string>;
  waitOAuthCallback(): Promise<string>;
  cancelOAuthCallback(): Promise<void>;
  verifyRS256(input: string, signature: string, modulus: string, exponent: string): Promise<boolean>;
  call(owner: string, input: string): Promise<string>;
  localModelAvailability(): Promise<string>;
  generateLocal(id: string, body: string): Promise<string>;
  cancelLocal(id: string): Promise<void>;
}
export const nativeHarness =
  requireOptionalNativeModule<NativeHarness>("CindyMobileHarness");
export function harnessOwner(): string {
  const owner = getMobileAuthOwner();
  if (owner.switching) throw new Error("ACCOUNT_REQUIRED");
  return owner.accountKey || "device-local-v1";
}
export async function kernel<T = Session>(
  command: Record<string, unknown>,
): Promise<T> {
  if (!nativeHarness) throw new Error("NATIVE_UPDATE_REQUIRED");
  const owner = getMobileAuthOwner();
  const scope = harnessOwner();
  const reply = JSON.parse(
    await nativeHarness.call(scope, JSON.stringify(command)),
  ) as { ok: boolean; value: T; error: string };
  if (!isMobileAuthOwnerCurrent(owner)) throw new Error("ACCOUNT_CHANGED");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
