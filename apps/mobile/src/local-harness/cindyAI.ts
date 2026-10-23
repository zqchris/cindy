import { MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION, parseListModelsResponse } from '@cindy/model-providers';
import type { AgentKind, ModelCatalogEntry, ModelCatalogEntryV5 } from '@cindy/model-providers';
import type { Provider } from './providers';
import type { Protocol } from './kernel';

type Credentials = { endpoint: string; apiKey: string };
type Snapshot = { provider: Provider; credentials: Credentials };
export type CindyAIClient = ReturnType<typeof createCindyAIClient>;

/** Uses the same authenticated Model Access contract as Desktop. Secrets stay in memory. */
export function createCindyAIClient(request: (path: string) => Promise<unknown>, assertCurrent: () => void) {
  let snapshot: Snapshot | null = null;
  let expires = 0;
  let flight: Promise<Snapshot> | null = null;
  async function load(refresh = false): Promise<Snapshot> {
    assertCurrent();
    if (!refresh && snapshot && Date.now() < expires) return snapshot;
    if (!flight) {
      flight = (async () => {
        const credentials = await request('/api/model-access/credentials');
        assertCurrent();
        if (!credentials || typeof credentials !== 'object') throw new Error('CINDY_AI_INVALID_CREDENTIALS');
        const { endpoint, apiKey } = credentials as Partial<Credentials>;
        if (typeof endpoint !== 'string' || typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('CINDY_AI_INVALID_CREDENTIALS');
        const url = new URL(endpoint);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('CINDY_AI_INVALID_ENDPOINT');
        const raw = await request(`/api/model-access/models?schemaVersion=${MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION}`);
        assertCurrent();
        const parsed = parseListModelsResponse(raw);
        if (!parsed.ok || parsed.value.schemaVersion !== MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION) throw new Error('CINDY_AI_INVALID_CATALOG');
        const models = parsed.value.models.flatMap(m => {
          if ((m as ModelCatalogEntryV5).availability !== 'available' || (m.mode && m.mode !== 'chat')) return [];
          const route = routeFor(m);
          if (!route) return [];
          return [{
            id: m.id, name: m.name || m.id, protocol: route.protocol,
            contextBytes: Math.max(4096, Math.min(4_000_000, (route.contextWindow ?? m.contextWindow ?? 32_000) * 3)),
            catalog: { id: m.id, name: m.name || m.id, description: m.description, group: m.group,
              contextWindow: route.contextWindow ?? m.contextWindow ?? 32_000, maxOutputTokens: m.maxOutputTokens,
              defaultEnabled: route.defaultEnabled ?? m.defaultEnabled, sortOrder: m.sortOrder,
              newSessionDefault: m.newSessionDefault?.length ? ['cindy'] as AgentKind[] : undefined,
              efforts: [], defaultEffort: null, supportsFastMode: false },
          }];
        }).sort((a, b) => (a.catalog.sortOrder ?? 0) - (b.catalog.sortOrder ?? 0));
        const first = models.find(m => m.catalog.defaultEnabled !== false && m.catalog.newSessionDefault)
          ?? models.find(m => m.catalog.defaultEnabled !== false);
        const base = url.href.replace(/\/$/, '').replace(/\/v1$/, '');
        const next: Snapshot = { credentials: { endpoint: `${base}/v1`, apiKey }, provider: {
          id: 'xd', name: 'Cindy AI', auth: 'cindy', protocol: first?.protocol ?? 'anthropic',
          endpoint: `${base}/v1`, model: first?.id ?? '', models, contextBytes: first?.contextBytes ?? 96_000,
        } };
        snapshot = next;
        expires = Date.now() + 300_000;
        return next;
      })().finally(() => { flight = null; });
    }
    return flight;
  }
  return {
    async provider(refresh = false) { return (await load(refresh)).provider; },
    async credentials(refresh = false) { return (await load(refresh)).credentials; },
  };
}
function routeFor(model: ModelCatalogEntry): { protocol: Protocol; contextWindow?: number; defaultEnabled?: boolean } | null {
  for (const agent of ['pi', 'claude-code', 'codex'] as const) {
    if (!model.agents?.includes(agent)) continue;
    const override = model.perAgent?.[agent];
    const wire = override?.wireProtocol ?? (agent === 'codex' ? 'openai-responses' : 'anthropic-messages');
    const protocol: Protocol = ({ 'openai-completions': 'openai', 'openai-responses': 'responses', 'anthropic-messages': 'anthropic', 'google-generative-ai': 'google' } as const)[wire];
    if (protocol) return { ...override, protocol };
  }
  return null;
}

let active: CindyAIClient | null = null;
export function bindCindyAI(client: CindyAIClient): () => void {
  active = client;
  return () => { if (active === client) active = null; };
}
export async function cindyAIProvider(): Promise<Provider | null> {
  return active ? active.provider() : null;
}
export async function refreshCindyAI(): Promise<Provider> {
  if (!active) throw new Error('CINDY_LOGIN_REQUIRED');
  return active.provider(true);
}
export async function cindyAICredentials(refresh = false): Promise<Credentials> {
  if (!active) throw new Error('CINDY_LOGIN_REQUIRED');
  return active.credentials(refresh);
}

/** Gateway uses ordinary function tools; ChatGPT's namespace extension stays on its own adapter. */
export function cindyAIRequest(effect: Extract<import('./kernel').Effect, { kind: 'model' }>, credentials: Credentials) {
  const base = credentials.endpoint.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` };
  let url: string;
  let body = effect.body;
  switch (effect.model.protocol) {
    case 'anthropic': headers['anthropic-version'] = '2023-06-01'; url = `${base}/messages`; break;
    case 'google': url = `${base.replace(/\/v1$/, '/v1beta')}/models/${encodeURIComponent(effect.model.model)}:generateContent`; break;
    case 'responses': {
      url = `${base}/responses`;
      const input = Array.isArray(body.input) ? body.input.map(item => {
        if (!item || typeof item !== 'object' || !('namespace' in item)) return item;
        const { namespace: _namespace, ...rest } = item; return rest;
      }) : body.input;
      const tools = Array.isArray(body.tools) ? body.tools.flatMap(tool => tool.type === 'namespace' ? tool.tools : [tool]) : undefined;
      body = { ...body, input, ...(tools ? { tools } : {}) };
      break;
    }
    default: url = `${base}/chat/completions`;
  }
  return { url, headers, body: JSON.stringify(body) };
}
