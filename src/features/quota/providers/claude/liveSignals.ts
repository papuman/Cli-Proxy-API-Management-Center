import type { AuthFileItem, ClaudeQuotaState } from '@/types';
import { formatQuotaResetTime } from '@/utils/quota/formatters';

/**
 * The proxy keeps Anthropic's rate-limit headers from every response it relays
 * (`quota.signals`, with `quota.observed_at`). Those are newer than the usage
 * endpoint, which this page reads only every few minutes (and is rate-limited per
 * account), so they keep the 5-hour and weekly bars in step with real traffic.
 * A 429 does not refresh them, so a fresher usage read always wins.
 */
const WINDOWS = [
  { id: 'five-hour', prefix: 'Anthropic-Ratelimit-Unified-5h-' },
  { id: 'seven-day', prefix: 'Anthropic-Ratelimit-Unified-7d-' },
] as const;

type LiveQuota = { observed_at?: unknown; signals?: Record<string, unknown> };

/** The state with live numbers applied, or null when they are not newer. */
export function applyLiveSignals(
  state: ClaudeQuotaState | undefined,
  file: AuthFileItem,
  nowMs: number
): ClaudeQuotaState | null {
  if (state?.status !== 'success') return null;
  const live = file.quota as LiveQuota | undefined;
  const observedMs = typeof live?.observed_at === 'string' ? Date.parse(live.observed_at) : NaN;
  if (!Number.isFinite(observedMs) || !live?.signals) return null;
  if (observedMs <= Math.max(state.fetchedAtMs ?? 0, state.liveAtMs ?? 0)) return null;
  const signal = (key: string) => {
    const value = Number(live.signals?.[key]);
    return Number.isFinite(value) ? value : null;
  };
  let changed = false;
  const windows = state.windows.map((window) => {
    const spec = WINDOWS.find((item) => item.id === window.id);
    if (!spec) return window;
    const used = signal(`${spec.prefix}Utilization`);
    const resetSec = signal(`${spec.prefix}Reset`);
    if (used === null || resetSec === null || resetSec * 1000 <= nowMs) return window;
    changed = true;
    return {
      ...window,
      usedPercent: Math.round(used * 100),
      resetAtMs: resetSec * 1000,
      resetLabel: formatQuotaResetTime(new Date(resetSec * 1000).toISOString()),
    };
  });
  return changed ? { ...state, windows, liveAtMs: observedMs } : null;
}
