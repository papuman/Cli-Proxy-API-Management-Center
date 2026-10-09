import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '../src/types';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import {
  PIN_PRIORITY,
  buildRoutingState,
  pinPatches,
  unpinPatches,
} from '../src/features/quota/routing';

const idle = Array.from({ length: 20 }, () => ({ success: 0, failed: 0 }));
const withRecent = (counts: number[]) => [
  ...idle.slice(counts.length),
  ...counts.map((n) => ({ success: n, failed: 0 })),
];

const entry = (type: string, file: Partial<AuthFileItem> & { name: string }): QuotaFileEntry =>
  ({ type, file: { recentRequests: idle, ...file } }) as unknown as QuotaFileEntry;

describe('buildRoutingState', () => {
  test('a stray request or two next to a busy account is not "in use"', () => {
    const state = buildRoutingState([
      entry('claude', { name: 'busy', recentRequests: withRecent([582, 106]) }),
      entry('claude', { name: 'stray', recentRequests: withRecent([4, 0]) }),
      entry('claude', { name: 'shared', recentRequests: withRecent([100, 20]) }),
      entry('codex', { name: 'alone', recentRequests: withRecent([0, 3]) }),
    ]);
    expect([...state.inUse.keys()].sort()).toEqual(['alone', 'busy', 'shared']);
  });

  test('a blocked account or one with only failed requests is not in use', () => {
    const failedOnly = [...idle.slice(1), { success: 0, failed: 2 }];
    const state = buildRoutingState([
      entry('claude', { name: 'blocked', recentRequests: withRecent([0, 5]), unavailable: true }),
      entry('claude', { name: 'rejected', recentRequests: failedOnly }),
      entry('claude', { name: 'serving', recentRequests: withRecent([0, 1]) }),
    ]);
    expect([...state.inUse]).toEqual([['serving', 1]]);
  });

  test('marks accounts with requests in the last two buckets as in use', () => {
    const state = buildRoutingState([
      entry('claude', { name: 'a', recentRequests: withRecent([0, 5]) }),
      entry('claude', { name: 'b', recentRequests: withRecent([3, 0]) }),
      entry('claude', { name: 'c', recentRequests: withRecent([9, 0, 0]) }),
      entry('claude', { name: 'd', recentRequests: withRecent([4]), disabled: true }),
    ]);
    expect([...state.inUse]).toEqual([
      ['a', 5],
      ['b', 3],
    ]);
  });

  test('pins the single top-priority account per provider, never a tie', () => {
    const state = buildRoutingState([
      entry('claude', { name: 'a', priority: PIN_PRIORITY }),
      entry('claude', { name: 'b' }),
      entry('codex', { name: 'x', priority: 5 }),
      entry('codex', { name: 'y', priority: 5 }),
    ]);
    expect(state.pinned.get('claude')).toBe('a');
    expect(state.pinned.has('codex')).toBe(false);
  });
});

describe('pin patches', () => {
  const entries = [
    entry('claude', { name: 'a', priority: PIN_PRIORITY }),
    entry('claude', { name: 'b' }),
    entry('claude', { name: 'c', priority: 3 }),
    entry('codex', { name: 'x', priority: 7 }),
  ];

  test('moves the pin within the provider and leaves other providers alone', () => {
    expect(pinPatches(entries, entries[1]).map(({ name, priority }) => [name, priority])).toEqual([
      ['a', null],
      ['b', PIN_PRIORITY],
      ['c', null],
    ]);
  });

  test('unpin resets only that provider', () => {
    expect(unpinPatches(entries, 'claude').map(({ name }) => name)).toEqual(['a', 'c']);
    expect(unpinPatches([entry('claude', { name: 'z', priority: 0 })], 'claude')).toHaveLength(1);
  });
});
