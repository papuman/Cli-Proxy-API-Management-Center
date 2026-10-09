import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore } from '@/stores';
import { resetKeeperApi, type ResetKeeperStatus } from '@/services/api/resetKeeper';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota/relativeTime';
import styles from '../QuotaPage.module.scss';

const POLL_MS = 60_000;

/** Auto/Manual switch and per-account reasoning of the reset-keeper helper (Claude only). */
export function ResetKeeperPanel() {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [status, setStatus] = useState<ResetKeeperStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await resetKeeperApi.status());
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const setAuto = async (auto: boolean) => {
    if (!status || status.auto === auto || saving) return;
    setSaving(true);
    try {
      setStatus(await resetKeeperApi.setAuto(auto));
      showNotification(t(auto ? 'reset_keeper.now_auto' : 'reset_keeper.now_manual'), 'success');
    } catch {
      showNotification(t('reset_keeper.save_failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (unreachable && !status) {
    return <div className={styles.keeper}>{t('reset_keeper.unreachable')}</div>;
  }
  if (!status) return null;

  const when = (iso: string | null) => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms)
      ? `${formatRelativeInstant(ms, now, i18n.resolvedLanguage)} (${formatInstantShort(ms)})`
      : '-';
  };
  const resetsLeft = status.accounts.reduce((sum, account) => sum + account.resets_left, 0);

  return (
    <div className={styles.keeper}>
      <div className={styles.keeperHead}>
        <span className={styles.nowUsingProvider}>{t('reset_keeper.title')}</span>
        <div className={styles.layoutSwitch} role="group" aria-label={t('reset_keeper.title')}>
          {[true, false].map((auto) => (
            <button
              key={String(auto)}
              type="button"
              className={styles.layoutOption}
              aria-pressed={status.auto === auto}
              disabled={saving}
              onClick={() => void setAuto(auto)}
            >
              {t(auto ? 'reset_keeper.auto' : 'reset_keeper.manual')}
            </button>
          ))}
        </div>
        <span className={styles.nowUsingMode}>
          {t(status.auto ? 'reset_keeper.auto_hint' : 'reset_keeper.manual_hint')}
        </span>
        <span className={styles.nowUsingMode}>
          {t('reset_keeper.summary', {
            left: resetsLeft,
            hours: Math.round(status.burn_hours),
            learning: status.burn_learned ? '' : t('reset_keeper.learning'),
          })}
        </span>
        <button type="button" className={styles.layoutOption} onClick={() => setOpen(!open)}>
          {t(open ? 'reset_keeper.hide' : 'reset_keeper.show')}
        </button>
      </div>
      {unreachable && <div className={styles.nowUsingMode}>{t('reset_keeper.stale')}</div>}
      {open && (
        <>
          <table className={styles.keeperTable}>
            <thead>
              <tr>
                <th>{t('reset_keeper.account')}</th>
                <th>{t('reset_keeper.weekly')}</th>
                <th>{t('reset_keeper.weekly_refill')}</th>
                <th>{t('reset_keeper.resets')}</th>
                <th>{t('reset_keeper.decision')}</th>
              </tr>
            </thead>
            <tbody>
              {status.accounts.map((account) => (
                <tr key={account.auth_index}>
                  <td>{account.name.replace(/^[0-9a-f]{8}-/, '')}</td>
                  <td>{account.weekly_percent ?? '-'}%</td>
                  <td>{when(account.weekly_resets_at)}</td>
                  <td>
                    {account.resets_left}
                    {account.reset_expires_at && account.resets_left > 0
                      ? ` · ${t('reset_keeper.expires', { when: when(account.reset_expires_at) })}`
                      : ''}
                  </td>
                  <td>{account.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.nowUsingMode}>
            {status.spends.length
              ? status.spends
                  .slice()
                  .reverse()
                  .map(
                    (spend) =>
                      `${formatInstantShort(Date.parse(spend.at))} ${spend.account}: ${spend.result} (${spend.why})`
                  )
                  .join(' · ')
              : t('reset_keeper.no_spends')}
          </div>
        </>
      )}
    </div>
  );
}
