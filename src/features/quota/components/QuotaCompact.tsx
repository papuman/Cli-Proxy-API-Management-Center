/**
 * Compact layout: one thin row per credential, every quota window as a small
 * bar with "% left · time to reset", banked manual resets, and the row actions.
 * Built for scanning many accounts at once; detail lives in the Ledger layout.
 *
 * Quota arrives through `quotaFor` from the page, as in the Ledger layout.
 */

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { formatInstantShort, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QUOTA_TAB_ORDER } from '../constants';
import {
  codexManualResets,
  formatCompactDuration,
  ledgerColumns,
  ledgerMeters,
  ledgerPlan,
  maskCredentialName,
  summarizeLedger,
  type LedgerMeter,
} from '../ledger';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import styles from './QuotaCompact.module.scss';

export type QuotaCompactProps = {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  showEmails: boolean;
  canRefresh: boolean;
  resettingName: string | null;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
};

const toneClass = (remaining: number | null): string =>
  remaining === null
    ? ''
    : remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
      ? styles.high
      : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
        ? styles.medium
        : styles.low;

export function QuotaCompact(props: QuotaCompactProps) {
  const { entries, quotaFor } = props;
  const { t } = useTranslation();
  const now = useNow();

  const groups = QUOTA_TAB_ORDER.map((type) => {
    const group = entries.filter((entry) => entry.type === type);
    const accounts = group.map((entry) => ledgerMeters(type, quotaFor(entry), t));
    const labels = new Map(accounts.flat().map((meter) => [meter.id, meter.label]));
    const columns = ledgerColumns(accounts, summarizeLedger(type, accounts, now));
    return { type, group, columns, labels };
  }).filter(({ group }) => group.length > 0);

  return (
    <div className={styles.compact}>
      {groups.map(({ type, group, columns, labels }) => (
        <section
          key={type}
          className={styles.table}
          style={{ '--meter-count': Math.max(columns.length, 1) } as React.CSSProperties}
        >
          <div className={`${styles.row} ${styles.head}`}>
            <span>
              {getTypeLabel(t, type)} <span className={styles.count}>{group.length}</span>
            </span>
            {columns.map((id) => (
              <span key={id} className={styles.ellipsis} title={labels.get(id)}>
                {labels.get(id)}
              </span>
            ))}
            {columns.length === 0 && <span />}
            <span>{t('codex_quota.reset_credits_label')}</span>
            <span />
          </div>
          {group.map((entry) => {
            const key = getQuotaCacheKey(entry.file);
            return (
              <CompactRow
                key={key}
                entry={entry}
                quota={quotaFor(entry)}
                columns={columns}
                showEmails={props.showEmails}
                canRefresh={props.canRefresh && !entry.file.disabled}
                resetting={props.resettingName === key}
                now={now}
                onRefresh={() => props.onRefresh(entry)}
                onReset={() => props.onReset(entry)}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}

function CompactRow(props: {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  columns: readonly string[];
  showEmails: boolean;
  canRefresh: boolean;
  resetting: boolean;
  now: number;
  onRefresh: () => void;
  onReset: () => void;
}) {
  const { entry, quota, columns, showEmails, canRefresh, resetting, now } = props;
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const claudeReset = useClaudeResetGrants(
    entry.file,
    entry.type === 'claude' && status === 'success',
    !canRefresh || loading || resetting,
    quota,
    props.onRefresh
  );

  const displayName = getQuotaDisplayName(entry.file);
  const name = showEmails ? displayName : maskCredentialName(displayName, entry.type);
  const plan = ledgerPlan(entry.type, quota, t);
  const meters = new Map(ledgerMeters(entry.type, quota, t).map((meter) => [meter.id, meter]));

  const codexResets = entry.type === 'codex' ? codexManualResets(quota) : null;
  const resets =
    entry.type === 'claude'
      ? claudeReset.count === null
        ? null
        : {
            left: claudeReset.count,
            total: claudeReset.grants.reduce((sum, grant) => sum + grant.resetsTotal, 0),
            expiresAtMs: claudeReset.expiresAtMs,
          }
      : codexResets && {
          left: codexResets.available,
          total: codexResets.credits.length || codexResets.available,
          expiresAtMs: codexResets.next?.expiresAtMs ?? null,
        };

  const reset =
    entry.type === 'claude'
      ? {
          show: resets !== null || claudeReset.buttonLabel === 'retry',
          disabled: claudeReset.blocked,
          busy: claudeReset.busy,
          onClick: claudeReset.confirm,
        }
      : {
          show: Boolean(adapter.resetQuota) && codexResets !== null,
          disabled:
            !canRefresh ||
            loading ||
            resetting ||
            quota === undefined ||
            !adapter.canResetQuota?.(quota),
          busy: resetting,
          onClick: props.onReset,
        };

  const errorMessage =
    status === 'error'
      ? resolveQuotaErrorMessage(t, quota?.errorStatus, quota?.error || t('common.unknown_error'))
      : null;

  return (
    <div className={styles.row} aria-busy={loading || undefined}>
      <div className={styles.identity} title={plan ? `${name} · ${plan.label}` : name}>
        <span
          className={`${styles.dot} ${
            status === 'error'
              ? styles.dotError
              : entry.file.unavailable
                ? styles.dotWarn
                : status === 'success'
                  ? styles.dotOk
                  : ''
          }`}
          title={entry.file.unavailable ? t('quota_management.ledger_unavailable') : undefined}
        />
        <span className={styles.name}>{name}</span>
        {plan && <span className={styles.plan}>{plan.label}</span>}
      </div>

      {status !== 'success' ? (
        <div
          className={`${styles.statusCell} ${errorMessage ? styles.error : ''}`}
          title={errorMessage ?? undefined}
        >
          {errorMessage ??
            (loading ? t(`${adapter.i18nPrefix}.loading`) : t(`${adapter.i18nPrefix}.idle`))}
        </div>
      ) : columns.length === 0 ? (
        <div className={styles.statusCell}>{t('quota_management.ledger_no_windows')}</div>
      ) : (
        columns.map((id) => <MeterCell key={id} meter={meters.get(id)} now={now} />)
      )}

      <div
        className={`${styles.resets} ${resets && resets.left > 0 ? styles.resetsLeft : ''}`}
        title={
          resets?.expiresAtMs != null
            ? `${t('quota_management.windows_credit_expires')} ${formatInstantShort(resets.expiresAtMs)}`
            : undefined
        }
      >
        {resets === null
          ? '—'
          : [
              resets.total > 0 ? `${resets.left}/${resets.total}` : String(resets.left),
              resets.left > 0 ? formatCompactDuration(resets.expiresAtMs, now) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
      </div>

      <div className={styles.actions}>
        {reset.show && (
          <button
            type="button"
            className={styles.action}
            disabled={reset.disabled}
            onClick={reset.onClick}
            title={
              reset.disabled && (resets?.left ?? 0) === 0
                ? t('quota_management.ledger_no_resets_left')
                : entry.type === 'claude'
                  ? t(`claude_reset.${claudeReset.buttonLabel}`)
                  : t('codex_quota.reset_button')
            }
          >
            {t('quota_management.compact_reset')}
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          disabled={!canRefresh || loading || resetting || claudeReset.busy}
          onClick={props.onRefresh}
          title={t('auth_files.quota_refresh_single')}
          aria-label={t('auth_files.quota_refresh_single')}
        >
          <IconRefreshCw
            size={12}
            aria-hidden="true"
            className={loading ? styles.spinning : undefined}
          />
        </button>
      </div>
    </div>
  );
}

function MeterCell({ meter, now }: { meter: LedgerMeter | undefined; now: number }) {
  if (!meter) return <div className={styles.meter} />;
  const left = meter.remaining === null ? '--' : `${Math.round(meter.remaining)}%`;
  const until = formatCompactDuration(meter.resetAtMs, now);
  return (
    <div
      className={styles.meter}
      title={`${meter.label}: ${left}${
        meter.resetAtMs !== null ? ` · ${formatInstantShort(meter.resetAtMs)}` : ''
      }`}
    >
      <span className={styles.bar}>
        <span
          className={`${styles.fill} ${toneClass(meter.remaining)}`}
          style={{ width: `${meter.remaining ?? 0}%` }}
        />
      </span>
      <span className={styles.value}>
        <span className={styles.percent}>{left}</span>
        {until && <span className={styles.until}>{until}</span>}
      </span>
    </div>
  );
}
