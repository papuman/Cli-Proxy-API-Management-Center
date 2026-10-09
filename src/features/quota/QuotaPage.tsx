/**
 * 额度查询页：提供商 tabs + 统一卡网格。
 *
 * 保留的行为契约（重设计不改）：
 * - 现有提供商保持点击加载；Devin 首次可见时主动查询一次，不轮询；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QuotaHeader, QuotaHeaderSearch, QuotaHeaderToggle } from './components/QuotaHeader';
import { QuotaCard } from './components/QuotaCard';
import { QuotaLedger } from './components/QuotaLedger';
import { QuotaCompact } from './components/QuotaCompact';
import { QuotaTimeline } from './components/QuotaTimeline';
import { ResetKeeperPanel } from './components/ResetKeeperPanel';
import { useResetKeeper } from './hooks/useResetKeeper';
import { ResetKeeperContext, isRoutineKeeperNote } from './resetKeeperContext';
import { RoutingContext, type RoutingContextValue } from './routingContext';
import {
  CARD_ENTRANCE_BUDGET_MS,
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaLayout,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';
import {
  autoLoadTargets,
  buildTabCounts,
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { headlineRemaining, ledgerMeters } from './ledger';
import { nextRecoveryMs } from './resetSchedule';
import {
  accountAlias,
  accountFallbackName,
  buildRoutingState,
  inUseEntries,
  pinPatches,
  unpinPatches,
} from './routing';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { applyLiveSignals } from './providers/claude/liveSignals';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import {
  readQuotaUiState,
  writeQuotaUiState,
  readSavedQuotaLayout,
  saveQuotaLayout,
} from './uiState';
import styles from './QuotaPage.module.scss';

const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER];
const SKELETON_CARD_COUNT = 6;
/** List-only refresh for the "In use" tags; never fetches quota. */
// Local call to the proxy only; also carries the live rate-limit headers for the Claude bars.
const ROUTING_POLL_MS = 5_000;
/** Quota re-read for in-use/pinned accounts; Anthropic rate-limits it per account. */
const IN_USE_QUOTA_POLL_MS = 5 * 60_000;

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'remaining'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [layout, setLayout] = useState<QuotaLayout>(
    () => readQuotaUiState()?.layout ?? readSavedQuotaLayout() ?? 'ledger'
  );
  // Never persisted, so emails are masked again whenever the page is reopened.
  const [showEmails, setShowEmails] = useState(false);
  // 页头 + tabs 的入场级联（标题 → meta → 动作 → tabs，级差 70ms）
  const revealRef = useRevealGroup<HTMLDivElement>();

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // Only the soonest-recovery order depends on the clock. Ungated, pageItems
  // would change identity every minute and keep re-running the refresh-all
  // loading edge effect below.
  const tick = useNow(sortMode === 'soonest');
  const sortNow = sortMode === 'soonest' ? tick : 0;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);

  // Every file-list poll (30 s) carries the proxy's live rate-limit headers; apply
  // them to the Claude bars whenever they are newer than the last usage read.
  useEffect(() => {
    const nowMs = Date.now();
    useQuotaStore.getState().setClaudeQuota((previous) => {
      let next: typeof previous | null = null;
      for (const entry of entries) {
        if (entry.type !== 'claude') continue;
        const key = getQuotaCacheKey(entry.file);
        const updated = applyLiveSignals(previous[key], entry.file, nowMs);
        if (updated) (next ??= { ...previous })[key] = updated;
      }
      return next ?? previous;
    });
  }, [entries]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  const filteredEntries = useMemo(
    () => filterEntriesBySearch(filterEntriesByTab(entries, tab), search),
    [entries, tab, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const sortKeyFor = useCallback(
    (entry: QuotaFileEntry) =>
      sortMode === 'soonest'
        ? nextRecoveryMs(entry.type, getQuota(entry), sortNow)
        : headlineRemaining(entry.type, ledgerMeters(entry.type, getQuota(entry), t)),
    [getQuota, sortMode, sortNow, t]
  );
  // 排序在分页之前：否则排序只在当前页内成立。
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, sortKeyFor),
    [filteredEntries, sortMode, sortKeyFor]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    setPage(1);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const handleLayoutChange = useCallback((next: string) => {
    setLayout(next as QuotaLayout);
    writeQuotaUiState({ layout: next as QuotaLayout });
    saveQuotaLayout(next as QuotaLayout);
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  const layoutOptions = useMemo(
    () => [
      { value: 'ledger', label: t('quota_management.ledger_view') },
      { value: 'compact', label: t('quota_management.compact_view') },
      { value: 'cards', label: t('quota_management.ledger_cards') },
    ],
    [t]
  );

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    entries.forEach((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status === 'success') loaded += 1;
      else if (status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [entries, quotaByType]);

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota, refreshQuietly } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先重取文件列表，待其落定（loading 下降沿）再批量拉当前页额度
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(pageItems);
    }
  }, [disableControls, error, filesGeneration, loading, loadQuota, pageItems, sessionGeneration]);

  // Auto-load once per visit and session: when the first file list settles,
  // fetch the visible credentials that have no quota yet.
  const autoLoadedSessionRef = useRef<number | null>(null);
  useEffect(() => {
    if (loading || error || disableControls) return;
    if (filesGeneration !== sessionGeneration) return;
    if (autoLoadedSessionRef.current === sessionGeneration) return;
    autoLoadedSessionRef.current = sessionGeneration;
    const targets = autoLoadTargets(pageItems, (entry) => Boolean(getQuota(entry)));
    if (targets.length > 0) void loadQuota(targets);
  }, [
    disableControls,
    error,
    filesGeneration,
    getQuota,
    loading,
    loadQuota,
    pageItems,
    sessionGeneration,
  ]);

  useDevinQuotaAutoLoad(
    pageItems,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- Routing: which account is in use, pin one ---------- */

  const showNotification = useNotificationStore((state) => state.showNotification);
  const [routingBusy, setRoutingBusy] = useState(false);

  // Keep the "In use" tags current without the skeleton or any quota calls.
  useEffect(() => {
    if (disableControls) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const requestId = listRequestRef.current;
      authFilesApi
        .list()
        .then((data) => {
          if (requestId === listRequestRef.current && data?.files) setFiles(data.files);
        })
        .catch(() => {});
    }, ROUTING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [disableControls]);

  const applyPriorities = useCallback(
    async (patches: Array<{ name: string; priority: number | null }>, done: string) => {
      setRoutingBusy(true);
      try {
        for (const patch of patches) {
          await authFilesApi.patchFields(patch.name, { priority: patch.priority });
        }
        showNotification(done, 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        showNotification(t('quota_management.routing_failed', { message }), 'error');
      } finally {
        setRoutingBusy(false);
        void loadFiles();
      }
    },
    [loadFiles, showNotification, t]
  );

  const renameAccount = useCallback(
    async (entry: QuotaFileEntry, alias: string) => {
      try {
        await authFilesApi.patchFields(entry.file.name, { note: alias });
        showNotification(t('quota_management.routing_alias_done'), 'success');
        void loadFiles();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        showNotification(t('quota_management.routing_failed', { message }), 'error');
        throw err;
      }
    },
    [loadFiles, showNotification, t]
  );

  const routingState = useMemo(() => buildRoutingState(entries), [entries]);

  // Bars of the account doing the work move without a manual refresh.
  const quotaTargets = useMemo(
    () =>
      entries.filter(
        (entry) =>
          !entry.file.disabled &&
          (routingState.inUse.has(entry.file.name) ||
            routingState.pinned.get(entry.type) === entry.file.name)
      ),
    [entries, routingState]
  );
  const quotaTargetsRef = useRef<QuotaFileEntry[]>([]);
  useEffect(() => {
    quotaTargetsRef.current = quotaTargets;
  }, [quotaTargets]);
  useEffect(() => {
    if (disableControls) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshQuietly(quotaTargetsRef.current);
    }, IN_USE_QUOTA_POLL_MS);
    return () => window.clearInterval(timer);
  }, [disableControls, refreshQuietly]);

  const accountLabel = (entry: QuotaFileEntry) =>
    accountAlias(entry.file) || accountFallbackName(entry, showEmails);
  const nowUsing = QUOTA_TAB_ORDER.filter((type) => entries.some((entry) => entry.type === type))
    .filter((type) => tab === 'all' || tab === type)
    .map((type) => {
      const pinnedName = routingState.pinned.get(type);
      return {
        type,
        active: inUseEntries(entries, routingState, type),
        pinned: entries.find((entry) => entry.file.name === pinnedName),
      };
    });

  const routing = useMemo<RoutingContextValue>(
    () => ({
      ...routingState,
      busy: routingBusy,
      canEdit: canUseActions,
      onPin: (entry) =>
        void applyPriorities(
          pinPatches(entries, entry),
          t('quota_management.routing_pin_done', {
            name: accountAlias(entry.file) || entry.file.email || entry.file.name,
          })
        ),
      onUnpin: (type) =>
        void applyPriorities(unpinPatches(entries, type), t('quota_management.routing_unpin_done')),
      onRename: renameAccount,
    }),
    [applyPriorities, canUseActions, entries, renameAccount, routingBusy, routingState, t]
  );

  /* ---------- 首屏卡片一次性级联入场 ----------
   * 首批数据渲染后立即翻转 cardsAnimated；已挂载的卡片在挂载时捕获过自己的
   * 延迟（QuotaCard 内 useState 初始化），后续切 tab/翻页/刷新新挂载的卡片
   * 拿到 null —— 不重播。 */

  const [cardsAnimated, setCardsAnimated] = useState(false);
  const enableCardEntrance = !cardsAnimated && !loading && pageItems.length > 0;
  useEffect(() => {
    if (enableCardEntrance) {
      setCardsAnimated(true);
    }
  }, [enableCardEntrance]);
  const cardEntranceDelay = (index: number): number | null => {
    if (!enableCardEntrance) return null;
    if (pageItems.length <= 1) return 0;
    return Math.round((index / (pageItems.length - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;

  const keeper = useResetKeeper();
  const keeperNotes = useMemo(
    () =>
      new Map(
        (keeper.status?.accounts ?? [])
          .filter((account) => account.note && !isRoutineKeeperNote(account.note))
          .map((account) => [account.auth_index, account.note])
      ),
    [keeper.status]
  );

  return (
    <ResetKeeperContext.Provider value={keeperNotes}>
      <RoutingContext.Provider value={routing}>
        <div className={styles.page} ref={revealRef}>
          <QuotaHeader
            totalCount={entries.length}
            loadedCount={loadedCount}
            attentionCount={attentionCount}
            refreshing={loading || batchLoading}
            disableControls={disableControls}
            onRefreshAll={handleRefreshAll}
            actions={
              <>
                <QuotaHeaderSearch value={search} onChange={handleSearchChange} />
                {layout !== 'cards' && (
                  <QuotaHeaderToggle
                    pressed={showEmails}
                    onToggle={() => setShowEmails(!showEmails)}
                  >
                    {t(
                      showEmails
                        ? 'quota_management.ledger_hide_emails'
                        : 'quota_management.ledger_show_emails'
                    )}
                  </QuotaHeaderToggle>
                )}
              </>
            }
          />

          <section className={styles.workbench}>
            <div className={styles.tabsRow} data-reveal>
              <ProviderTabs
                types={TAB_IDS}
                counts={tabCounts}
                active={tab}
                resolvedTheme={resolvedTheme}
                onChange={handleTabChange}
              />
              <div className={styles.viewControls}>
                <div
                  className={styles.layoutSwitch}
                  role="group"
                  aria-label={t('quota_management.ledger_layout')}
                >
                  {layoutOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={styles.layoutOption}
                      aria-pressed={layout === option.value}
                      onClick={() => handleLayoutChange(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <Select
                  value={sortMode}
                  options={sortOptions}
                  onChange={handleSortModeChange}
                  ariaLabel={t('quota_management.sort_label')}
                  size="sm"
                  fullWidth={false}
                  className={styles.sortSelect}
                />
              </div>
            </div>

            {!loading && nowUsing.length > 0 && (
              <div className={styles.nowUsing} aria-live="polite">
                {nowUsing.map(({ type, active, pinned }) => (
                  <span key={type} className={styles.nowUsingItem}>
                    <span className={styles.nowUsingProvider}>{getTypeLabel(t, type)}</span>
                    <span className={active.length ? styles.nowUsingLive : styles.nowUsingIdle} />
                    <span className={styles.nowUsingName}>
                      {active.length
                        ? active.map(accountLabel).join(', ')
                        : t('quota_management.routing_idle')}
                    </span>
                    <span className={styles.nowUsingMode}>
                      {pinned
                        ? `${t('quota_management.routing_pinned_short')}: ${accountLabel(pinned)}`
                        : t('quota_management.routing_auto')}
                    </span>
                  </span>
                ))}
              </div>
            )}

            {(tab === 'all' || tab === 'claude') && (
              <ResetKeeperPanel
                status={keeper.status}
                unreachable={keeper.unreachable}
                onStatus={keeper.setStatus}
              />
            )}

            {error && (
              <div className={styles.errorBanner} role="alert">
                {error}
              </div>
            )}

            {loading ? (
              <div
                className={layout === 'cards' ? styles.grid : styles.ledgerSkeleton}
                aria-hidden="true"
              >
                {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) =>
                  layout === 'compact' ? (
                    <Skeleton key={index} height={30} rounded={6} />
                  ) : layout === 'ledger' ? (
                    <Skeleton key={index} height={56} rounded={10} />
                  ) : (
                    <Skeleton key={index} height={168} rounded={14} />
                  )
                )}
              </div>
            ) : isEmpty ? (
              <EmptyState
                title={
                  search.trim()
                    ? t('quota_management.search_empty_title')
                    : tab === 'all'
                      ? t('quota_management.empty_title')
                      : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
                }
                description={
                  search.trim()
                    ? t('quota_management.search_empty_desc')
                    : tab === 'all'
                      ? t('quota_management.empty_desc')
                      : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
                }
                action={
                  search.trim() ? (
                    <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                      {t('quota_management.search_clear')}
                    </Button>
                  ) : tab === 'all' ? undefined : (
                    <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                      {t('auth_files.filter_all')}
                    </Button>
                  )
                }
              />
            ) : layout === 'compact' ? (
              <QuotaCompact
                entries={pageItems}
                quotaFor={getQuota}
                showEmails={showEmails}
                canRefresh={canUseActions}
                resettingName={resettingQuotaName}
                onRefresh={(entry) => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                onReset={(entry) => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
              />
            ) : layout === 'ledger' ? (
              <QuotaLedger
                entries={pageItems}
                summaryEntries={sortedEntries}
                quotaFor={getQuota}
                resolvedTheme={resolvedTheme}
                showEmails={showEmails}
                canRefresh={canUseActions}
                resettingName={resettingQuotaName}
                onRefresh={(entry) => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                onReset={(entry) => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
              />
            ) : (
              <div className={styles.grid}>
                {pageItems.map((entry, index) => (
                  <QuotaCard
                    key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
                    entry={entry}
                    quota={getQuota(entry)}
                    resolvedTheme={resolvedTheme}
                    canRefresh={canUseActions && !entry.file.disabled}
                    resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                    entranceDelayMs={cardEntranceDelay(index)}
                    onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                    onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                  />
                ))}
              </div>
            )}

            {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('auth_files.pagination_prev')}
                </Button>
                <div className={styles.pageInfo}>
                  {t('auth_files.pagination_info', {
                    current: currentPage,
                    total: totalPages,
                    count: filteredEntries.length,
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('auth_files.pagination_next')}
                </Button>
              </div>
            )}

            {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
            {layout === 'cards' && (
              <QuotaTimeline
                entries={pageItems}
                quotaFor={getQuota}
                displayNameFor={displayNameFor}
                resolvedTheme={resolvedTheme}
              />
            )}
          </section>
        </div>
      </RoutingContext.Provider>
    </ResetKeeperContext.Provider>
  );
}
