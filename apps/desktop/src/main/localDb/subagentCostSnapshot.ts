/**
 * Prices one Subagent run for the sidebar, once, when the run finishes.
 *
 * The guiding rule is that a number shown next to a task must be defensible.
 * Three quality levels exist for exactly that reason:
 *
 *  - `actual`      the provider billed this amount for this child
 *  - `estimated`   real per-token rates for the model the child actually ran,
 *                  applied to observed token counts
 *  - `unavailable` anything less
 *
 * Notably, a plain `totalTokens` figure with no input/output split does **not**
 * qualify as an estimate: input and output differ by roughly 5x in price, so
 * splitting an aggregate by an assumed ratio produces a precise-looking number
 * whose error is unbounded. Showing nothing is more honest than showing that.
 */

import type { ModelPriceQuote } from '../../shared/regionalMoney.js';

export interface SubagentCostSnapshotInput {
  provider: 'claude-code' | 'codex' | 'pi';
  /** Per-token rates for the model this child actually ran, when resolvable. */
  priceQuote?: ModelPriceQuote;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** Provider-billed amount, when the harness reports one for this child. */
  reportedCost?: { amount: number; currency: 'CNY' | 'USD' };
}

export interface SubagentCostSnapshotColumns {
  costQuality: 'actual' | 'estimated' | 'unavailable';
  costTotalTokens: number | null;
  costInputTokens: number | null;
  costOutputTokens: number | null;
  costCacheReadTokens: number | null;
  costCacheCreateTokens: number | null;
  costAmount: number | null;
  costCurrency: string | null;
  costApproximate: boolean | null;
  costFrozenAt: number;
}

/** Sub-cent amounts still matter when a task fans out to many children. */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function nonNegativeInt(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function tokenColumns(
  input: SubagentCostSnapshotInput,
): Pick<
  SubagentCostSnapshotColumns,
  | 'costTotalTokens'
  | 'costInputTokens'
  | 'costOutputTokens'
  | 'costCacheReadTokens'
  | 'costCacheCreateTokens'
> {
  return {
    costTotalTokens: nonNegativeInt(input.totalTokens),
    costInputTokens: nonNegativeInt(input.inputTokens),
    costOutputTokens: nonNegativeInt(input.outputTokens),
    costCacheReadTokens: nonNegativeInt(input.cacheReadTokens),
    costCacheCreateTokens: nonNegativeInt(input.cacheCreateTokens),
  };
}

export function computeSubagentCostSnapshot(
  input: SubagentCostSnapshotInput,
): SubagentCostSnapshotColumns {
  const costFrozenAt = Date.now();
  const tokens = tokenColumns(input);

  const reported = input.reportedCost;
  if (reported && Number.isFinite(reported.amount) && reported.amount >= 0) {
    return {
      costQuality: 'actual',
      ...tokens,
      costAmount: roundCost(reported.amount),
      costCurrency: reported.currency,
      costApproximate: false,
      costFrozenAt,
    };
  }

  // An estimate needs both a rate card for the model that ran and a split of
  // input vs output tokens. Missing either one degrades to unavailable rather
  // than to a guess.
  const quote = input.priceQuote;
  const inputTokens = tokens.costInputTokens;
  const outputTokens = tokens.costOutputTokens;
  if (quote && inputTokens !== null && outputTokens !== null) {
    const cacheRead = tokens.costCacheReadTokens ?? 0;
    const cacheCreate = tokens.costCacheCreateTokens ?? 0;
    const amount =
      (inputTokens / 1_000_000) * quote.inputPerMtok +
      (outputTokens / 1_000_000) * quote.outputPerMtok +
      (cacheRead / 1_000_000) * (quote.cacheReadPerMtok ?? 0) +
      (cacheCreate / 1_000_000) * (quote.cacheCreatePerMtok ?? 0);
    return {
      costQuality: 'estimated',
      ...tokens,
      costAmount: roundCost(amount),
      costCurrency: quote.currency,
      // A rate card is a list price, not a bill: promotions, tiering and
      // subscription bundling all move the real figure.
      costApproximate: true,
      costFrozenAt,
    };
  }

  // Token counts are still worth keeping even when they cannot be priced —
  // the sidebar shows usage without claiming a cost.
  return {
    costQuality: 'unavailable',
    ...tokens,
    costAmount: null,
    costCurrency: null,
    costApproximate: null,
    costFrozenAt,
  };
}
