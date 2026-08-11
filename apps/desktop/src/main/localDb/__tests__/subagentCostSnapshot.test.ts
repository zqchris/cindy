import { describe, expect, it } from 'vitest';

import type { ModelPriceQuote } from '../../../shared/regionalMoney.js';
import { computeSubagentCostSnapshot } from '../subagentCostSnapshot.js';

const quote: ModelPriceQuote = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet-5',
  currency: 'USD',
  source: 'provider-reference',
  approximate: false,
  inputPerMtok: 3,
  outputPerMtok: 15,
  cacheReadPerMtok: 0.3,
  cacheCreatePerMtok: 3.75,
};

describe('computeSubagentCostSnapshot', () => {
  it('reports a provider-billed amount as actual', () => {
    const snapshot = computeSubagentCostSnapshot({
      provider: 'pi',
      totalTokens: 1_000,
      reportedCost: { amount: 0.0421, currency: 'USD' },
    });

    expect(snapshot).toMatchObject({
      costQuality: 'actual',
      costAmount: 0.0421,
      costCurrency: 'USD',
      costApproximate: false,
    });
  });

  it('prices a split token count against the model rate card', () => {
    const snapshot = computeSubagentCostSnapshot({
      provider: 'claude-code',
      priceQuote: quote,
      totalTokens: 1_300_000,
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 100_000,
    });

    // 1M in @ $3 + 200k out @ $15 + 100k cache-read @ $0.30
    expect(snapshot.costAmount).toBe(6.03);
    expect(snapshot).toMatchObject({
      costQuality: 'estimated',
      costCurrency: 'USD',
      // A rate card is a list price, never a settled bill.
      costApproximate: true,
    });
  });

  it('keeps tokens but claims no price when only an aggregate count is known', () => {
    const snapshot = computeSubagentCostSnapshot({
      provider: 'codex',
      priceQuote: quote,
      totalTokens: 20_000,
    });

    // Input and output differ ~5x in price; splitting an aggregate by an assumed
    // ratio would look precise while being arbitrarily wrong.
    expect(snapshot).toMatchObject({
      costQuality: 'unavailable',
      costTotalTokens: 20_000,
      costAmount: null,
      costCurrency: null,
    });
  });

  it('claims no price when the model has no reachable rate card', () => {
    const snapshot = computeSubagentCostSnapshot({
      provider: 'claude-code',
      totalTokens: 1_000,
      inputTokens: 800,
      outputTokens: 200,
    });

    expect(snapshot).toMatchObject({
      costQuality: 'unavailable',
      costInputTokens: 800,
      costOutputTokens: 200,
      costAmount: null,
    });
  });

  it('stamps every snapshot so a frozen row can be recognised', () => {
    const snapshot = computeSubagentCostSnapshot({ provider: 'codex' });
    expect(snapshot.costQuality).toBe('unavailable');
    expect(snapshot.costFrozenAt).toBeGreaterThan(0);
  });
});
