import { localScope } from "./storage";
import { File, Directory, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { unzipSync, strFromU8 } from "fflate";
import {
  validateGhostManifest,
  type GhostManifest,
} from "@cindy/plugin-protocol/manifest";
import type { Tool } from "./kernel";

export type LocalPlugin = {
  manifest: GhostManifest;
  source: string;
  revision: string;
  enabled: boolean;
  generation?: number;
};
const listeners = new Set<() => void>();
export const subscribePlugins = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const root = () => new Directory(Paths.document, "mobile-harness-plugins", localScope().key);
export function installedPlugins(): LocalPlugin[] {
  const dir = root();
  if (!dir.exists) return [];
  const snapshots = dir
    .list()
    .filter((x) => x instanceof File && x.name.endsWith(".json"))
    .flatMap((file) => {
      try {
        const plugin = JSON.parse((file as File).textSync()) as LocalPlugin;
        const result = validateGhostManifest(plugin.manifest);
        if (
          !result.ok ||
          typeof plugin.source !== "string" ||
          typeof plugin.revision !== "string" ||
          typeof plugin.enabled !== "boolean"
        )
          return [];
        return [plugin];
      } catch {
        return [];
      }
    });
  const latest = new Map<string, LocalPlugin>();
  for (const plugin of snapshots) {
    const old = latest.get(plugin.manifest.id);
    if (!old || (plugin.generation ?? 0) > (old.generation ?? 0))
      latest.set(plugin.manifest.id, plugin);
  }
  return [...latest.values()];
}
export async function inspectPlugin(uri: string): Promise<LocalPlugin> {
  const file = new File(uri);
  if (file.size > 4_000_000) throw new Error("PLUGIN_TOO_LARGE");
  let total = 0;
  const zip = unzipSync(await file.bytes(), {
    filter: (entry) => {
      total += entry.originalSize;
      if (
        total > 8_000_000 ||
        entry.name.startsWith("/") ||
        entry.name.split("/").includes("..")
      )
        throw new Error("INVALID_PLUGIN_ARCHIVE");
      return true;
    },
  });
  if (!zip["ghost.json"]) throw new Error("INVALID_PLUGIN_MANIFEST");
  const result = validateGhostManifest(
    JSON.parse(strFromU8(zip["ghost.json"])),
  );
  if (!result.ok) throw new Error("INVALID_PLUGIN_MANIFEST");
  const manifest = result.manifest;
  // The package stays portable. Capabilities requiring a desktop process are
  // identified at installation; existing desktop installs are never modified.
  if (manifest.node) throw new Error("PLUGIN_REQUIRES_DESKTOP");
  if (!manifest.tools?.length || !zip[manifest.entry])
    throw new Error("PLUGIN_HAS_NO_MOBILE_TOOLS");
  if (
    manifest.network?.secrets?.length ||
    manifest.network?.connections?.length
  )
    throw new Error("PLUGIN_REQUIRES_CREDENTIAL_ADAPTER");
  const source = strFromU8(zip[manifest.entry]);
  if (source.length > 2_000_000) throw new Error("PLUGIN_TOO_LARGE");
  const revision = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify(manifest) + "\n" + source,
  );
  return { manifest, source, revision, enabled: true };
}
export function savePlugin(plugin: LocalPlugin): void {
  const result = validateGhostManifest(plugin.manifest);
  if (!result.ok) throw new Error("INVALID_PLUGIN_MANIFEST");
  const dir = root();
  dir.create({ intermediates: true, idempotent: true });
  const id = result.manifest.id;
  const previous = installedPlugins().find((p) => p.manifest.id === id);
  const generation = (previous?.generation ?? 0) + 1;
  // Expo move does not atomically replace an existing file. Commit to a fresh
  // generation, then reclaim older snapshots; an interrupted update keeps one
  // complete version available and never removes the only committed copy.
  const file = new File(dir, `${id}.${generation}.json`);
  const pending = new File(dir, `${id}.${generation}.pending`);
  pending.write(JSON.stringify({ ...plugin, generation }));
  pending.move(file);
  for (const old of dir.list()) {
    if (
      old instanceof File &&
      old.uri !== file.uri &&
      (old.name === `${id}.json` ||
        old.name === `${id}.pending` ||
        old.name.startsWith(`${id}.`))
    ) {
      try {
        old.delete();
      } catch {
        /* The new snapshot is already committed. */
      }
    }
  }
  for (const listener of listeners) listener();
}
export function pluginTools(plugin: LocalPlugin): Tool[] {
  return (plugin.manifest.tools ?? []).map((tool, index) => ({
    name: `p_${plugin.manifest.id.replaceAll("-", "_")}_${index}`,
    description: `${plugin.manifest.name}: ${tool.description}`,
    parameters: tool.parameters ?? { type: "object", properties: {} },
    source: plugin.manifest.id,
    revision: plugin.revision,
    writes: true,
  }));
}
