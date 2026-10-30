import type { AssistantMessageEventStream, Usage } from '@earendil-works/pi-ai';

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
export function addUsage(total: Usage, next: Usage | undefined): boolean {
  if (!next) return false;
  let known = true;
  const amount = (raw: unknown, integer: boolean, fallback = 0): number => {
    if (
      typeof raw === 'number' &&
      raw >= 0 &&
      (integer ? Number.isSafeInteger(raw) : Number.isFinite(raw))
    )
      return raw;
    known = false;
    return fallback;
  };
  const add = (a: number, b: number, integer: boolean) => {
    const sum = a + b;
    if (integer ? Number.isSafeInteger(sum) : Number.isFinite(sum)) return sum;
    known = false;
    return a;
  };
  let tokens = 0,
    cost = 0;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const part = amount(next[key], true);
    total[key] = add(total[key], part, true);
    tokens = add(tokens, part, true);
    const price = amount(next.cost?.[key], false);
    total.cost[key] = add(total.cost[key], price, false);
    cost = add(cost, price, false);
  }
  // These are subsets of output/cacheWrite; preserve reported breakdowns without charging twice.
  for (const key of ['reasoning', 'cacheWrite1h'] as const)
    if (next[key] !== undefined) total[key] = add(total[key] ?? 0, amount(next[key], true), true);
  // Preserve known components even when a provider omits its aggregate fields.
  total.totalTokens = add(total.totalTokens, amount(next.totalTokens, true, tokens), true);
  total.cost.total = add(total.cost.total, amount(next.cost?.total, false, cost), false);
  return known;
}

/** Observe requests without consuming their stream or counting persisted entries twice. */
export function createUsageTracker() {
  const usage = emptyUsage();
  let incomplete = false;
  let pending = 0;
  return {
    track(request: () => AssistantMessageEventStream) {
      pending++;
      try {
        const stream = request();
        void stream.result().then(
          (message) => {
            pending--;
            const known = addUsage(usage, message.usage);
            incomplete ||= !known || ['error', 'aborted'].includes(message.stopReason);
          },
          () => {
            pending--;
            incomplete = true;
          },
        );
        return stream;
      } catch (error) {
        pending--;
        incomplete = true;
        throw error;
      }
    },
    snapshot: () => ({ usage: structuredClone(usage), usageIncomplete: incomplete || pending > 0 }),
  };
}
