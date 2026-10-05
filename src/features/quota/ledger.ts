/**
 * Ledger view model: every provider's quota reduced to the percent of each
 * window that is still available, so accounts from one provider can be summed
 * and compared.
 *
 * Providers disagree about what they report (percent used, percent remaining,
 * a 0..1 fraction, raw counts). Every conversion to "remaining" lives here and
 * nowhere else in the ledger. Unknown stays null all the way to the screen; it
 * is never coerced to 0 or 100.
 *
 * React-free and SCSS-free, consumed directly by tests/quotaLedger.test.ts.
 */

import type { TFunction } from 'i18next';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaRow,
  KimiQuotaState,
  MetaQuotaState,
  XaiQuotaState,
} from '@/types';
import {
  formatKimiResetHint,
  formatQuotaResetTime,
  parseIsoToMs,
  resolveResetMs,
} from '@/utils/quota';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import {
  ANTIGRAVITY_GROUP_LABEL_KEYS,
  getAntigravityPlanLabel,
  translateAntigravityQuotaLabel,
} from './providers/antigravity/data';
import { codexPlanLabel } from './providers/codex/data';

export interface LedgerMeter {
  /** Stable window id, shared across accounts of one provider. */
  id: string;
  label: string;
  /** Percent of the window still available, 0..100. Null when unknown. */
  remaining: number | null;
  resetAtMs: number | null;
  /** Fetch-time absolute label, used when there is no instant to format. */
  resetLabel: string | null;
}

const clampPercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

export function remainingFromUsed(used: unknown): number | null {
  const clamped = clampPercent(used);
  return clamped === null ? null : 100 - clamped;
}

/** Same formula as KimiQuotaBody: a zero limit with usage reads as exhausted. */
const kimiRemaining = (row: KimiQuotaRow): number | null =>
  row.limit > 0
    ? Math.max(0, Math.min(100, Math.round(((row.limit - row.used) / row.limit) * 100)))
    : row.used > 0
      ? 0
      : null;

const usableLabel = (label: string | null | undefined): string | null => {
  const trimmed = label?.trim();
  return trimmed && trimmed !== '-' ? trimmed : null;
};

interface UsedPercentWindow {
  id: string;
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent: number | null;
  resetLabel: string;
  resetAtMs?: number | null;
}

const usedPercentMeters = (windows: readonly UsedPercentWindow[], t: TFunction): LedgerMeter[] =>
  windows.map((window) => ({
    id: window.id,
    label: window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label,
    remaining: remainingFromUsed(window.usedPercent),
    resetAtMs: window.resetAtMs ?? null,
    resetLabel: usableLabel(window.resetLabel),
  }));

const xaiMeters = (quota: XaiQuotaState, t: TFunction): LedgerMeter[] => {
  const billing = quota.billing;
  if (!billing || billing.mode === 'paid-health') return [];

  // Visibility rules mirror XaiQuotaBody so the ledger never shows a window the card hides.
  const hasWeekly =
    billing.periodType === 'weekly' &&
    (billing.usagePercent !== null ||
      Boolean(billing.periodEnd) ||
      billing.productUsage.length > 0);
  const hasMonthly =
    (billing.monthlyLimitCents !== null ||
      billing.usedCents !== null ||
      Boolean(billing.billingPeriodEnd)) &&
    !(hasWeekly && billing.monthlyLimitCents === 0 && billing.usedCents === 0);

  const meters: LedgerMeter[] = [];
  if (hasWeekly) {
    meters.push({
      id: 'weekly',
      label: t('xai_quota.weekly_limit'),
      remaining: remainingFromUsed(billing.usagePercent),
      resetAtMs: billing.resetAtMs ?? null,
      resetLabel: usableLabel(formatQuotaResetTime(billing.periodEnd)),
    });
  }
  if (hasMonthly) {
    meters.push({
      id: 'monthly',
      label: t('xai_quota.monthly_credits'),
      remaining: remainingFromUsed(billing.usedPercent),
      resetAtMs: parseIsoToMs(billing.billingPeriodEnd),
      resetLabel: usableLabel(formatQuotaResetTime(billing.billingPeriodEnd)),
    });
  }
  return meters;
};

const kimiMeters = (quota: KimiQuotaState, t: TFunction): LedgerMeter[] =>
  quota.rows.map((row) => ({
    id: row.id,
    label: row.labelKey ? t(row.labelKey, row.labelParams ?? {}) : (row.label ?? ''),
    remaining: kimiRemaining(row),
    resetAtMs: row.resetAtMs ?? null,
    resetLabel: row.resetAtMs == null ? usableLabel(formatKimiResetHint(t, row.resetHint)) : null,
  }));

/** One meter per group: the group is only as available as its most exhausted bucket. */
const antigravityMeters = (quota: AntigravityQuotaState, t: TFunction): LedgerMeter[] =>
  quota.groups.flatMap((group) => {
    const tightest = group.buckets.reduce<(typeof group.buckets)[number] | null>(
      (min, bucket) =>
        min === null || bucket.remainingFraction < min.remainingFraction ? bucket : min,
      null
    );
    if (!tightest) return [];
    return [
      {
        id: group.id,
        label: translateAntigravityQuotaLabel(group.label, ANTIGRAVITY_GROUP_LABEL_KEYS, t),
        remaining: clampPercent(tightest.remainingFraction * 100),
        resetAtMs: tightest.resetAtMs ?? null,
        resetLabel: null,
      },
    ];
  });

const devinMeters = (quota: DevinQuotaState, t: TFunction): LedgerMeter[] =>
  quota.windows.map((window) => ({
    id: window.id,
    label: t(`devin_quota.${window.id}`),
    remaining: clampPercent(window.remainingPercent),
    resetAtMs: window.resetAtMs,
    resetLabel: null,
  }));

const metaMeters = (quota: MetaQuotaState, t: TFunction): LedgerMeter[] =>
  (quota.data?.windows ?? []).map((window) => ({
    id: window.id,
    label:
      window.id === 'window' && window.durationMinutes
        ? t('meta_quota.window_duration', { minutes: window.durationMinutes })
        : t(`meta_quota.${window.id}`),
    remaining: remainingFromUsed(window.usedPercent),
    // Meta reports Unix seconds.
    resetAtMs:
      typeof window.resetAt === 'number' && Number.isFinite(window.resetAt)
        ? window.resetAt * 1000
        : null,
    resetLabel: null,
  }));

/* Each reader receives a success state of its own provider; the registry erases that. */
const METERS: Record<QuotaProviderType, (quota: QuotaCardState, t: TFunction) => LedgerMeter[]> = {
  claude: (quota, t) => usedPercentMeters((quota as ClaudeQuotaState).windows, t),
  codex: (quota, t) => usedPercentMeters((quota as CodexQuotaState).windows, t),
  xai: (quota, t) => xaiMeters(quota as XaiQuotaState, t),
  kimi: (quota, t) => kimiMeters(quota as KimiQuotaState, t),
  antigravity: (quota, t) => antigravityMeters(quota as AntigravityQuotaState, t),
  devin: (quota, t) => devinMeters(quota as DevinQuotaState, t),
  meta: (quota, t) => metaMeters(quota as MetaQuotaState, t),
};

export function ledgerMeters(
  type: QuotaProviderType,
  quota: QuotaCardState | undefined,
  t: TFunction
): LedgerMeter[] {
  return quota?.status === 'success' ? METERS[type](quota, t) : [];
}

/**
 * Windows worth summing across accounts, headline first. Claude's headline is
 * the account-wide weekly limit, which is what makes an account unavailable for
 * routing; the model-specific Fable window stays secondary. Kimi's weekly row
 * is named 'summary' by buildKimiQuotaRows.
 */
export const SUMMARY_WINDOW_IDS: Record<QuotaProviderType, readonly string[]> = {
  claude: ['seven-day', 'seven-day-fable'],
  codex: ['weekly', 'monthly'],
  xai: ['weekly', 'monthly'],
  kimi: ['summary', 'monthly'],
  devin: ['weekly'],
  meta: ['weekly'],
  antigravity: [],
};

export interface LedgerSummaryWindow {
  id: string;
  label: string;
  /** Sum of each known account's rounded remaining percent; null when none is known. */
  remaining: number | null;
  /** 100 per account in the group, known or not. */
  capacity: number;
  /** Each account's remaining in row order; null renders as an empty track. */
  segments: (number | null)[];
  nextResetAtMs: number | null;
}

/** `[headline, ...secondary]`; empty when no account has loaded a window yet. */
export function summarizeLedger(
  type: QuotaProviderType,
  accounts: readonly LedgerMeter[][],
  nowMs: number
): LedgerSummaryWindow[] {
  const has = (id: string) => accounts.some((meters) => meters.some((meter) => meter.id === id));
  const present = SUMMARY_WINDOW_IDS[type].filter(has);
  const fallback = accounts.find((meters) => meters.length > 0)?.[0].id;
  const ids = present.length > 0 ? present : fallback === undefined ? [] : [fallback];

  return ids.map((id) => {
    const meters = accounts.map((account) => account.find((meter) => meter.id === id));
    const segments = meters.map((meter) => meter?.remaining ?? null);
    const known = segments.filter((value): value is number => value !== null);
    const upcoming = meters
      .map((meter) => meter?.resetAtMs ?? null)
      .filter((ms): ms is number => ms !== null && ms > nowMs);
    return {
      id,
      label: meters.find((meter) => meter !== undefined)?.label ?? '',
      // Rounded per account so the total equals the sum of the row percentages on screen.
      remaining: known.length > 0 ? known.reduce((sum, value) => sum + Math.round(value), 0) : null,
      capacity: 100 * accounts.length,
      segments,
      nextResetAtMs: upcoming.length > 0 ? Math.min(...upcoming) : null,
    };
  });
}

/**
 * Column order shared by every row of a provider: each window any account
 * reports, headline first, then windows that are not summed, then the
 * secondary summed windows. A row missing a window leaves its column empty, so
 * the same window always lines up down the group.
 */
export function ledgerColumns(
  accounts: readonly LedgerMeter[][],
  summary: readonly LedgerSummaryWindow[]
): string[] {
  const ids = [...new Set(accounts.flatMap((meters) => meters.map((meter) => meter.id)))];
  const summaryIds = summary.map((window) => window.id);
  const [headlineId, ...secondaryIds] = summaryIds;
  return [
    ...ids.filter((id) => id === headlineId),
    ...ids.filter((id) => !summaryIds.includes(id)),
    ...secondaryIds.filter((id) => ids.includes(id)),
  ];
}

/** Sort key for "most remaining": the account's own headline window. */
export function headlineRemaining(
  type: QuotaProviderType,
  meters: readonly LedgerMeter[]
): number | null {
  const headline =
    SUMMARY_WINDOW_IDS[type]
      .map((id) => meters.find((meter) => meter.id === id))
      .find((meter) => meter !== undefined) ?? meters[0];
  return headline?.remaining ?? null;
}

export interface LedgerPlan {
  label: string;
  /** Subscription renewal instant, when the provider reports one. */
  renewsAtMs: number | null;
}

const plan = (label: string | null | undefined, renewsAtMs: number | null = null) =>
  label ? { label, renewsAtMs } : null;

const PLANS: Record<QuotaProviderType, (quota: QuotaCardState, t: TFunction) => LedgerPlan | null> =
  {
    claude: (quota, t) => {
      const planType = (quota as ClaudeQuotaState).planType;
      return plan(planType ? t(`claude_quota.${planType}`) : null);
    },
    codex: (quota, t) => {
      const codex = quota as CodexQuotaState;
      return plan(
        codexPlanLabel(codex.planType, t),
        resolveResetMs([codex.subscriptionActiveUntil])
      );
    },
    xai: (quota) => plan((quota as XaiQuotaState).billing?.planLabel),
    kimi: () => null,
    antigravity: (quota, t) =>
      plan(getAntigravityPlanLabel((quota as AntigravityQuotaState).subscription, t)),
    devin: (quota) => plan((quota as DevinQuotaState).plan),
    meta: (quota) => plan((quota as MetaQuotaState).data?.planName),
  };

export function ledgerPlan(
  type: QuotaProviderType,
  quota: QuotaCardState | undefined,
  t: TFunction
): LedgerPlan | null {
  return quota?.status === 'success' ? PLANS[type](quota, t) : null;
}

export interface LedgerManualResets {
  available: number;
  /** The available credit that expires first, numbered as the card lists it. */
  next: { number: number; expiresAtMs: number | null; expiresLabel: string } | null;
  /** Every credit in the card's order, so each one's expiry can be managed. */
  credits: { number: number; status: string; expiresAtMs: number | null; expiresLabel: string }[];
}

export function codexManualResets(quota: QuotaCardState | undefined): LedgerManualResets | null {
  if (quota?.status !== 'success') return null;
  const codex = quota as CodexQuotaState;
  const available = codex.rateLimitResetCreditsAvailableCount ?? null;
  if (available === null) return null;

  let next: LedgerManualResets['next'] = null;
  const credits: LedgerManualResets['credits'] = [];
  for (const [index, credit] of (codex.rateLimitResetCredits ?? []).entries()) {
    const expiresAtMs = parseIsoToMs(credit.expiresAt);
    credits.push({
      number: index + 1,
      status: credit.status,
      expiresAtMs,
      expiresLabel: credit.expiresAt,
    });
    if (credit.status !== 'available') continue;
    const sooner =
      next === null ||
      (expiresAtMs !== null && (next.expiresAtMs === null || expiresAtMs < next.expiresAtMs));
    if (sooner) next = { number: index + 1, expiresAtMs, expiresLabel: credit.expiresAt };
  }
  return { available, next, credits };
}

/**
 * Hide the email inside a credential name, keeping what tells accounts apart
 * at a glance: the provider prefix, Codex's 8-hex account segment, the first
 * letter of the mailbox and domain, and the top-level domain with the file
 * suffix. `claude-theo@lastname.dev.json` becomes `claude-t•••@l•••.dev.json`.
 */
export function maskCredentialName(name: string, type: QuotaProviderType): string {
  const prefixPattern = new RegExp(`^${type}-(?:[0-9a-f]{8}-)?`);
  return name.replace(/([^\s@]+)@([^\s@]+)/g, (_match, local: string, domain: string) => {
    const prefix = local.match(prefixPattern)?.[0] ?? '';
    const mailbox = local.slice(prefix.length);
    const suffix = domain.endsWith('.json') ? '.json' : '';
    const host = domain.slice(0, domain.length - suffix.length);
    const lastDot = host.lastIndexOf('.');
    const topLevel = lastDot > 0 ? host.slice(lastDot) : '';
    return `${prefix}${mailbox.slice(0, 1)}•••@${host.slice(0, 1)}•••${topLevel}${suffix}`;
  });
}

/**
 * Time left until `atMs`, as short as a dense table needs: `42m`, `3h57m`, `7h`,
 * `2d5h`, `16d`. Null for an unknown or past instant.
 */
export function formatCompactDuration(atMs: number | null, nowMs: number): string | null {
  if (atMs === null || !Number.isFinite(atMs) || atMs <= nowMs) return null;
  const minutes = Math.max(1, Math.round((atMs - nowMs) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  return `${mins}m`;
}
