/**
 * Which account the proxy is routing to, and pinning one ("use this account").
 *
 * In use: the proxy keeps per-account request counts in 10-minute buckets,
 * oldest first, the last one being the current bucket. An account with
 * requests in the current or previous bucket counts as in use.
 *
 * Pinned: the proxy routes to the highest `priority` tier first and only
 * falls back to lower tiers when every account in it is unavailable. Pinning
 * puts one account alone in the top tier; unpinning clears the field again.
 */

import type { AuthFileItem } from '@/types';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { maskCredentialName } from './ledger';
import type { QuotaFileEntry } from './logic';

export const PIN_PRIORITY = 100;
const IN_USE_BUCKETS = 2;
/** Below this share of the busiest account's traffic, an account is not "in use" (a stray request or two). */
const IN_USE_MIN_SHARE = 0.1;

export type RoutingState = {
  /** Requests in the last ~20 minutes, by credential name. */
  inUse: Map<string, number>;
  /** Pinned credential name per provider type. */
  pinned: Map<string, string>;
};

const buckets = (file: AuthFileItem) => file.recentRequests ?? file.recent_requests ?? [];

/** Requests the account actually served lately; failures (e.g. the 429 that blocked it) don't count. */
export function recentRequestCount(file: AuthFileItem): number {
  return buckets(file)
    .slice(-IN_USE_BUCKETS)
    .reduce((sum, bucket) => sum + bucket.success, 0);
}

export function buildRoutingState(entries: QuotaFileEntry[]): RoutingState {
  const counts = new Map<string, { type: string; count: number }>();
  const busiest = new Map<string, number>();
  const pinned = new Map<string, string>();
  const top = new Map<string, { name: string; priority: number; tie: boolean }>();
  for (const { type, file } of entries) {
    if (file.disabled) continue;
    // A blocked account (cooldown, quota) is not taking traffic, whatever it did minutes ago.
    const count = file.unavailable ? 0 : recentRequestCount(file);
    if (count > 0) {
      counts.set(file.name, { type, count });
      busiest.set(type, Math.max(busiest.get(type) ?? 0, count));
    }
    const priority = file.priority ?? 0;
    if (priority <= 0) continue;
    const current = top.get(type);
    if (!current || priority > current.priority)
      top.set(type, { name: file.name, priority, tie: false });
    else if (priority === current.priority) current.tie = true;
  }
  for (const [type, { name, tie }] of top) if (!tie) pinned.set(type, name);
  const inUse = new Map<string, number>();
  for (const [name, { type, count }] of counts)
    if (count >= (busiest.get(type) ?? 0) * IN_USE_MIN_SHARE) inUse.set(name, count);
  return { inUse, pinned };
}

/** Field patches that leave `target` alone in the top tier of its provider. */
export function pinPatches(entries: QuotaFileEntry[], target: QuotaFileEntry) {
  return entries
    .filter((entry) => entry.type === target.type)
    .map((entry) => ({
      name: entry.file.name,
      priority: entry.file.name === target.file.name ? PIN_PRIORITY : null,
      current: entry.file.priority ?? null,
    }))
    .filter((patch) => patch.priority !== patch.current);
}

/** Field patches that clear the priority of every account of the provider. */
export function unpinPatches(entries: QuotaFileEntry[], type: string) {
  return entries
    .filter((entry) => entry.type === type && entry.file.priority !== undefined)
    .map((entry) => ({ name: entry.file.name, priority: null, current: entry.file.priority }));
}

/** The user's alias for an account; stored in the credential's `note`. */
export const accountAlias = (file: AuthFileItem): string =>
  typeof file.note === 'string' ? file.note.trim() : '';

/** Busiest in-use account first, so the summary names the main one. */
export function inUseEntries(entries: QuotaFileEntry[], state: RoutingState, type: string) {
  return entries
    .filter((entry) => entry.type === type && state.inUse.has(entry.file.name))
    .sort((a, b) => (state.inUse.get(b.file.name) ?? 0) - (state.inUse.get(a.file.name) ?? 0));
}

/** Name shown when there is no alias: the account email, masked unless emails are shown. */
export function accountFallbackName(entry: QuotaFileEntry, showEmails: boolean): string {
  const base = entry.file.email?.trim() || getQuotaDisplayName(entry.file);
  return showEmails ? base : maskCredentialName(base, entry.type);
}
