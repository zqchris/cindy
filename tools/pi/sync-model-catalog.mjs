#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyKnownXaiCorrections, preferredDefaultEffort } from './xai-catalog-corrections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG_PATH = path.join(ROOT, 'packages/model-providers/catalog/providers.json');
const SNAPSHOT_PATH = path.join(ROOT, 'packages/model-providers/catalog/pi-model-catalog.json');
const PI_CATALOG_BASE = 'https://pi.dev/api/models/providers';
const PI_VERSION_PATH = path.join(ROOT, 'tools/pi/latest.json');
const PI_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Presets only retain a small, hand-authored Pi runtime hint. The complete Pi model directory is
// generated below and never copied into providers.json (which is also consumed as the public
// Cindy catalog). A similar model family or compatible wire protocol is not enough evidence.
const PRESET_PROVIDER_MAP = {
  deepseek: { providerId: 'deepseek', sourceAgent: 'codex' },
  'moonshot-kimi-cn': { providerId: 'moonshotai-cn', sourceAgent: 'codex' },
  'moonshot-kimi-global': { providerId: 'moonshotai', sourceAgent: 'codex' },
  'moonshot-kimi-code': { providerId: 'kimi-coding', sourceAgent: 'claude-code' },
  'minimax-cn': { providerId: 'minimax-cn', sourceAgent: 'claude-code' },
  'minimax-global': { providerId: 'minimax', sourceAgent: 'claude-code' },
  'aliyun-bailian-token-plan-cn': { providerId: 'qwen-token-plan-cn', sourceAgent: 'codex' },
  'aliyun-bailian-token-plan-team-cn': { providerId: 'qwen-token-plan-cn', sourceAgent: 'codex' },
  'zhipu-coding-plan-cn': { providerId: 'zai-coding-cn', sourceAgent: 'codex' },
  'zai-coding-plan-global': { providerId: 'zai', sourceAgent: 'codex' },
  'xiaomi-mimo-api-cn': { providerId: 'xiaomi', sourceAgent: 'codex' },
  'xiaomi-mimo-token-plan-cn': { providerId: 'xiaomi-token-plan-cn', sourceAgent: 'codex' },
};

function stableModelSort(models) {
  return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

function validateProviderModels(providerId, models) {
  const seen = new Set();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`Pi catalog '${providerId}' contains duplicate model '${model.id}'`);
    seen.add(model.id);
  }
  return stableModelSort(models);
}

function contentHash(providers) {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([providerId, models]) => [providerId, stableModelSort(models)]),
    ),
  );
  return `sha256-${createHash('sha256').update(canonical).digest('hex')}`;
}

function parseProviderIds(value) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('Pi provider index must be a non-empty string array');
  }
  return [...new Set(value)].sort();
}

function catalogEntries(providerId, value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.models)
      ? value.models
      : value && typeof value === 'object'
        ? Object.values(value)
        : null;
  if (!entries) throw new Error(`Pi catalog '${providerId}' is not an array or model map`);
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      throw new Error(`Pi catalog '${providerId}' contains an invalid model`);
    }
    if (entry.provider !== providerId) {
      throw new Error(`Pi catalog '${providerId}' model '${entry.id}' has provider '${entry.provider}'`);
    }
    return entry;
  });
}

function supportedEfforts(model) {
  if (model.reasoning !== true || !model.thinkingLevelMap) return [];
  return PI_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== undefined && mapped !== null;
  });
}

function defaultEffort(efforts) {
  if (efforts.length === 0) return undefined;
  const requested = PI_LEVELS.indexOf('medium');
  for (let i = requested; i < PI_LEVELS.length; i += 1) {
    if (efforts.includes(PI_LEVELS[i])) return PI_LEVELS[i];
  }
  for (let i = requested - 1; i >= 0; i -= 1) {
    if (efforts.includes(PI_LEVELS[i])) return PI_LEVELS[i];
  }
  return efforts[0];
}

function runtimeWireProtocol(providerId, models) {
  const apis = [...new Set(models.map((model) => model.api))];
  if (apis.length !== 1) {
    throw new Error(`Pi catalog '${providerId}' does not have one runtime protocol`);
  }
  switch (apis[0]) {
    case 'anthropic-messages':
      return 'anthropic-messages';
    case 'openai-responses':
      return 'openai-responses';
    case 'openai-completions':
      return 'openai-chat';
    default:
      throw new Error(`Pi catalog '${providerId}' has unsupported api '${apis[0]}'`);
  }
}

function xaiCatalogModel(model, index) {
  const efforts = supportedEfforts(model);
  const piApi = model.api === 'openai-completions'
    ? 'openai-completions'
    : model.api === 'openai-responses'
      ? 'openai-responses'
      : model.api === 'anthropic-messages'
        ? 'anthropic-messages'
        : undefined;
  return {
    // Pi uses provider provenance, so its xAI model ids stay identical to Pi's official catalog.
    // Claude/Codex keep the historical xai/ namespace in their own per-agent lists.
    id: model.id,
    name: model.name ?? model.id,
    ...(piApi ? { piApi } : {}),
    group: 'grok',
    sortOrder: 49 + index,
    contextWindow: model.contextWindow,
    ...(Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? { maxOutput: model.maxTokens } : {}),
    efforts,
    defaultEffort: preferredDefaultEffort(model.id, efforts, defaultEffort) ?? null,
    status: 'active',
    ...(Array.isArray(model.input) && model.input.includes('image') ? { supportsImageInput: true } : {}),
    ...(model.cost ? { cost: model.cost } : {}),
  };
}

async function main() {
  const providers = {};
  let newestModified = 0;
  let sourceRevision = null;
  const pinned = JSON.parse(await fs.readFile(PI_VERSION_PATH, 'utf8'));
  const pinnedVersion = pinned.version;
  if (typeof pinnedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinnedVersion)) {
    throw new Error(`Invalid pinned Pi version in ${PI_VERSION_PATH}`);
  }
  const inputIndex = process.argv.indexOf('--input');
  const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
  const generatedAtIndex = process.argv.indexOf('--generated-at');
  const generatedAtArg = generatedAtIndex >= 0 ? process.argv[generatedAtIndex + 1] : undefined;
  if (inputPath) {
    const input = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8'));
    const inputProviders = input.providers ?? input;
    const providerIds = parseProviderIds(input.providerIds ?? Object.keys(inputProviders));
    sourceRevision = input.sourceRevision ?? `fixture:${pinnedVersion}`;
    for (const providerId of providerIds) {
      if (!(providerId in inputProviders)) throw new Error(`Input catalog lacks provider '${providerId}'`);
      providers[providerId] = validateProviderModels(
        providerId,
        catalogEntries(providerId, inputProviders[providerId]),
      );
    }
  } else {
    const indexResponse = await fetch(PI_CATALOG_BASE, {
      headers: { accept: 'application/json', 'user-agent': `cindy-pi-catalog-sync/${pinnedVersion}` },
    });
    if (!indexResponse.ok) throw new Error(`Pi provider index returned HTTP ${indexResponse.status}`);
    const providerIds = parseProviderIds(await indexResponse.json());
    sourceRevision = indexResponse.headers.get('x-pi-model-catalog-revision');
    if (!sourceRevision) throw new Error('Pi provider index lacks x-pi-model-catalog-revision');
    const minimumVersion = indexResponse.headers.get('x-pi-model-catalog-minimum-version');
    if (minimumVersion && minimumVersion.localeCompare(pinnedVersion, undefined, { numeric: true }) > 0) {
      throw new Error(`Pi catalog requires ${minimumVersion}, pinned binary is ${pinnedVersion}`);
    }
    for (const providerId of providerIds) {
      const response = await fetch(`${PI_CATALOG_BASE}/${encodeURIComponent(providerId)}`, {
        headers: { accept: 'application/json', 'user-agent': `cindy-pi-catalog-sync/${pinnedVersion}` },
      });
      if (!response.ok) throw new Error(`Pi catalog '${providerId}' returned HTTP ${response.status}`);
      const modified = Date.parse(response.headers.get('last-modified') ?? '');
      if (!Number.isNaN(modified)) newestModified = Math.max(newestModified, modified);
      const revision = response.headers.get('x-pi-model-catalog-revision');
      if (revision && revision !== sourceRevision) {
        throw new Error(`Pi catalog '${providerId}' revision differs from provider index`);
      }
      providers[providerId] = validateProviderModels(providerId, catalogEntries(providerId, await response.json()));
    }
  }
  if (providers.xai) providers.xai = applyKnownXaiCorrections(providers.xai);

  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8'));
  for (const preset of catalog.presets ?? []) {
    const mapping = PRESET_PROVIDER_MAP[preset.id];
    if (!mapping) {
      // Remove only Pi runtimes previously generated by this script. Hand-authored/generic Pi
      // runtimes have no catalog marker and remain untouched.
      if (preset.runtimes?.pi?.piCatalogProviderId) delete preset.runtimes.pi;
      continue;
    }
    const source = preset.runtimes?.[mapping.sourceAgent];
    if (!source) throw new Error(`Preset '${preset.id}' lacks source runtime '${mapping.sourceAgent}'`);
    // Keep the existing small preset model list as UI seed data. Runtime Pi model existence and
    // capabilities come from the pinned snapshot, never from the Codex/Claude source list.
    preset.runtimes.pi = {
      ...(preset.runtimes.pi ?? {}),
      baseUrl: source.baseUrl,
      wireProtocol: runtimeWireProtocol(mapping.providerId, providers[mapping.providerId]),
      ...(source.modelsUrl ? { modelsUrl: source.modelsUrl } : {}),
      piCatalogProviderId: mapping.providerId,
    };
  }

  const xai = (catalog.providers ?? []).find((provider) => provider.id === 'xai');
  if (!xai) throw new Error('Catalog lacks builtin xai provider');
  if (!xai.agents.includes('pi')) xai.agents.push('pi');
  xai.routing.pi = {
    upstream: 'https://api.x.ai/v1',
    // The sync currently requires one provider-wide Pi protocol and fails closed on mixed
    // model.api values. Per-model piApi records the exact model protocol, but supporting a
    // mixed-protocol xAI catalog requires a separate sync-script change first.
    wireProtocol: runtimeWireProtocol('xai', providers.xai),
    authStrategy: 'provider-oauth-header',
    headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
  };
  xai.models.pi = providers.xai.map(xaiCatalogModel);

  const generatedAt = generatedAtArg
    ? new Date(generatedAtArg).toISOString()
    : new Date(newestModified || Date.now()).toISOString();
  await fs.writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  await fs.writeFile(
    SNAPSHOT_PATH,
    `${JSON.stringify({
      schemaVersion: 1,
      piVersion: pinnedVersion,
      sourceRevision,
      contentHash: contentHash(providers),
      generatedAt,
      providers,
    }, null, 2)}\n`,
  );
  console.log(`Synced ${Object.keys(providers).length} Pi providers at ${generatedAt} (Pi ${pinnedVersion}, ${sourceRevision})`);
}

await main();
