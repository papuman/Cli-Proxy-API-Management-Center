/**
 * Which account the proxy is routing to, and pinning one ("use this account").
 *
 * In use: the proxy keeps per-account request counts in 10-minute buckets,
 * oldest first, the last one being the current bucket. An account with
 * requests in the current or previous bucket counts as in use.
 *
 * Pinned: the proxy routes to the highest `priority` tier first and only
 * falls back to lower tiers when every account in it is unavailable. Pinning
 * puts one account alone in the top tier; unpinning returns all to 0.
 */

import type { AuthFileItem } from '@/types';
import type { QuotaFileEntry } from './logic';

export const PIN_PRIORITY = 100;
const IN_USE_BUCKETS = 2;

export type RoutingState = {
  /** Requests in the last ~20 minutes, by credential name. */
  inUse: Map<string, number>;
  /** Pinned credential name per provider type. */
  pinned: Map<string, string>;
};

const buckets = (file: AuthFileItem) => file.recentRequests ?? file.recent_requests ?? [];

export function recentRequestCount(file: AuthFileItem): number {
  return buckets(file)
    .slice(-IN_USE_BUCKETS)
    .reduce((sum, bucket) => sum + bucket.success + bucket.failed, 0);
}

export function buildRoutingState(entries: QuotaFileEntry[]): RoutingState {
  const inUse = new Map<string, number>();
  const pinned = new Map<string, string>();
  const top = new Map<string, { name: string; priority: number; tie: boolean }>();
  for (const { type, file } of entries) {
    if (file.disabled) continue;
    const count = recentRequestCount(file);
    if (count > 0) inUse.set(file.name, count);
    const priority = file.priority ?? 0;
    if (priority <= 0) continue;
    const current = top.get(type);
    if (!current || priority > current.priority)
      top.set(type, { name: file.name, priority, tie: false });
    else if (priority === current.priority) current.tie = true;
  }
  for (const [type, { name, tie }] of top) if (!tie) pinned.set(type, name);
  return { inUse, pinned };
}

/** Field patches that leave `target` alone in the top tier of its provider. */
export function pinPatches(entries: QuotaFileEntry[], target: QuotaFileEntry) {
  return entries
    .filter((entry) => entry.type === target.type)
    .map((entry) => ({
      name: entry.file.name,
      priority: entry.file.name === target.file.name ? PIN_PRIORITY : 0,
      current: entry.file.priority ?? 0,
    }))
    .filter((patch) => patch.priority !== patch.current);
}

/** Field patches that put every account of the provider back at priority 0. */
export function unpinPatches(entries: QuotaFileEntry[], type: string) {
  return entries
    .filter((entry) => entry.type === type && (entry.file.priority ?? 0) !== 0)
    .map((entry) => ({ name: entry.file.name, priority: 0, current: entry.file.priority ?? 0 }));
}
