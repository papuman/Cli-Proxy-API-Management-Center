import type { QuotaProviderType } from './providers/types';

/** tab 顺序 = 旧页五分区的纵向顺序，'全部' tab 下卡片也按此分组排列。 */
export const QUOTA_TAB_ORDER: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
];

export type QuotaTabId = 'all' | QuotaProviderType;

/** 页级分页固定 20/页，同时把「刷新全部」的上游并发限制在 20。 */
export const QUOTA_PAGE_SIZE = 20;

/**
 * Credential order. 'remaining' (the initial mode) puts the most headline quota
 * left first, 'soonest' the earliest recovery, 'default' keeps provider order.
 */
export const QUOTA_SORT_MODES = ['remaining', 'soonest', 'default'] as const;

export type QuotaSortMode = (typeof QUOTA_SORT_MODES)[number];

/** Ledger rows (the initial layout) or the upstream card grid with its timeline. */
export const QUOTA_LAYOUTS = ['ledger', 'compact', 'cards'] as const;

export type QuotaLayout = (typeof QUOTA_LAYOUTS)[number];

/** 与 useRevealGroup 的 GROUP_MAX_TOTAL 一致：卡片级联总预算 360ms。 */
export const CARD_ENTRANCE_BUDGET_MS = 360;
