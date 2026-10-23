import { describe, expect, it, vi } from 'vitest';
import { parseListModelsResponse } from '@cindy/model-providers';
import { createCindyAIClient, cindyAIRequest } from '../local-harness/cindyAI';
import type { Effect } from '../local-harness/kernel';

// Unit: the new mobile Model Access entry, absent from desktop-only sync tests.
// Protect credentials-and-local-storage: account changes reject late credentials;
// model-catalog-maintenance: membership/visibility/protocol come from the account.
// Minimal inputs: one enabled model, one payment-only model, and a delayed account response.
const credentials = { endpoint: 'https://gateway.example.invalid/proxy', apiKey: 'invalid-test-key' };
const catalog = { schemaVersion: 5, accountTier: 'paid', models: [
  { id: 'auto', name: 'Auto', agents: ['pi'], availability: 'available', contextWindow: 128000, newSessionDefault: ['pi'], perAgent: { pi: { wireProtocol: 'anthropic-messages' } } },
  { id: 'responses', name: 'Responses', agents: ['codex'], availability: 'available', contextWindow: 128000, defaultEnabled: false, perAgent: { codex: { wireProtocol: 'openai-responses' } } },
  { id: 'paid', name: 'Paid', agents: ['pi'], availability: 'requires_payment', contextWindow: 128000, perAgent: { pi: { wireProtocol: 'anthropic-messages' } } },
  { id: 'image', name: 'Image', mode: 'image_generation', agents: [], availability: 'available' },
] };
const request = () => vi.fn(async (path: string): Promise<unknown> => path.includes('/credentials') ? credentials : catalog);
const validFixture = parseListModelsResponse(catalog);
if (!validFixture.ok) throw new Error(validFixture.error);

describe('mobile Cindy AI', () => {
  it('loads a secret-free account catalog and shares one credential request', async () => {
    const fetch = request(); const client = createCindyAIClient(fetch, () => {});
    const [provider, key] = await Promise.all([client.provider(), client.credentials()]);
    expect(provider.model).toBe('auto');
    expect(provider.models?.map(m => [m.id, m.protocol, m.catalog?.defaultEnabled])).toEqual([['auto', 'anthropic', undefined], ['responses', 'responses', false]]);
    expect(JSON.stringify(provider)).not.toContain(credentials.apiKey);
    expect(key).toEqual({ ...credentials, endpoint: `${credentials.endpoint}/v1` });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects a late response after switching accounts, including cached reads', async () => {
    let current = true; let release!: (value: unknown) => void;
    const client = createCindyAIClient(() => new Promise(resolve => { release = resolve; }), () => { if (!current) throw new Error('ACCOUNT_CHANGED'); });
    const pending = client.provider(); current = false; release(credentials);
    await expect(pending).rejects.toThrow('ACCOUNT_CHANGED');
    await expect(client.credentials()).rejects.toThrow('ACCOUNT_CHANGED');
  });
  it('refreshes paired endpoint/key and clears models on an authoritative empty list', async () => {
    const fetch = request(); const client = createCindyAIClient(fetch, () => {});
    await client.provider();
    fetch.mockImplementation(async path => path.includes('/credentials') ? { endpoint: 'https://new.example.invalid', apiKey: 'invalid-new-key' } : { ...catalog, models: [] });
    expect((await client.provider(true)).models).toEqual([]);
    expect(await client.credentials()).toEqual({ endpoint: 'https://new.example.invalid/v1', apiKey: 'invalid-new-key' });
  });
  it('rejects credential URLs that could disclose the key over plaintext transport', async () => {
    const client = createCindyAIClient(async () => ({ ...credentials, endpoint: 'http://example.invalid' }), () => {});
    await expect(client.provider()).rejects.toThrow('CINDY_AI_INVALID_ENDPOINT');
  });
  it('uses gateway Responses function tools and the Gemini gateway version without changing persisted input', () => {
    const effect: Extract<Effect, { kind: 'model' }> = { kind: 'model', id: 'effect', compact: false,
      model: { provider: 'xd', model: 'responses', protocol: 'responses', context_bytes: 100000 },
      body: { tools: [{ type: 'namespace', name: 'cindy', tools: [{ type: 'function', name: 'read' }] }], input: [{ type: 'function_call', name: 'read', namespace: 'cindy' }] } };
    const key = { ...credentials, endpoint: `${credentials.endpoint}/v1` };
    const result = cindyAIRequest(effect, key);
    expect(JSON.parse(result.body)).toEqual({ tools: [{ type: 'function', name: 'read' }], input: [{ type: 'function_call', name: 'read' }] });
    expect(effect.body.tools).toEqual([{ type: 'namespace', name: 'cindy', tools: [{ type: 'function', name: 'read' }] }]);
    expect(cindyAIRequest({ ...effect, model: { ...effect.model, protocol: 'google', model: 'gemini' } }, key).url).toBe('https://gateway.example.invalid/proxy/v1beta/models/gemini:generateContent');
  });
});
