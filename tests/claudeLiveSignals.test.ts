import { describe, expect, test } from 'bun:test';
import { applyLiveSignals } from '../src/features/quota/providers/claude/liveSignals';
import type { AuthFileItem, ClaudeQuotaState } from '../src/types';

const NOW = Date.parse('2026-10-09T00:30:00Z');
const state = (fetchedAtMs: number): ClaudeQuotaState => ({
  status: 'success',
  fetchedAtMs,
  windows: [
    { id: 'five-hour', label: '5h', usedPercent: 10, resetLabel: '' },
    { id: 'seven-day', label: '7d', usedPercent: 50, resetLabel: '' },
    { id: 'seven-day-fable', label: 'fable', usedPercent: 20, resetLabel: '' },
  ],
});
const file = (observedAt: string, five = '0.42', week = '0.97', resetSec = NOW / 1000 + 3600) =>
  ({
    name: 'a',
    quota: {
      observed_at: observedAt,
      signals: {
        'Anthropic-Ratelimit-Unified-5h-Utilization': five,
        'Anthropic-Ratelimit-Unified-5h-Reset': String(resetSec),
        'Anthropic-Ratelimit-Unified-7d-Utilization': week,
        'Anthropic-Ratelimit-Unified-7d-Reset': String(resetSec + 86400),
      },
    },
  }) as unknown as AuthFileItem;

describe('applyLiveSignals', () => {
  test('newer proxy headers move the 5-hour and weekly bars only', () => {
    const next = applyLiveSignals(state(NOW - 300_000), file('2026-10-09T00:29:00Z'), NOW);
    expect(next?.windows.map((w) => w.usedPercent)).toEqual([42, 97, 20]);
    expect(next?.liveAtMs).toBe(Date.parse('2026-10-09T00:29:00Z'));
  });

  test('headers older than the usage read, or already applied, change nothing', () => {
    expect(applyLiveSignals(state(NOW), file('2026-10-09T00:29:00Z'), NOW)).toBeNull();
    const once = applyLiveSignals(state(NOW - 300_000), file('2026-10-09T00:29:00Z'), NOW);
    expect(applyLiveSignals(once!, file('2026-10-09T00:29:00Z'), NOW)).toBeNull();
  });

  test('a window that already rolled over keeps the usage read', () => {
    const next = applyLiveSignals(
      state(NOW - 300_000),
      file('2026-10-09T00:29:00Z', '0.9', '0.9', NOW / 1000 - 60),
      NOW
    );
    expect(next?.windows.map((w) => w.usedPercent)).toEqual([10, 90, 20]);
  });

  test('no signals or no success state: nothing to do', () => {
    expect(applyLiveSignals(undefined, file('2026-10-09T00:29:00Z'), NOW)).toBeNull();
    expect(applyLiveSignals(state(0), { name: 'a' } as AuthFileItem, NOW)).toBeNull();
  });
});
