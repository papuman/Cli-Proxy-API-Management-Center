import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '@/stores';
import { resetKeeperApi, type ResetKeeperStatus } from '@/services/api/resetKeeper';
import { formatInstantShort } from '@/utils/quota/relativeTime';
import styles from '../QuotaPage.module.scss';

/**
 * Auto/Manual switch and totals of the reset-keeper helper (Claude only). Per-account
 * reasoning is shown on each account row instead, so nothing here repeats the rows.
 */
export function ResetKeeperPanel(props: {
  status: ResetKeeperStatus | null;
  unreachable: boolean;
  onStatus: (status: ResetKeeperStatus) => void;
}) {
  const { status, unreachable, onStatus } = props;
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [saving, setSaving] = useState(false);

  const setAuto = async (auto: boolean) => {
    if (!status || status.auto === auto || saving) return;
    setSaving(true);
    try {
      onStatus(await resetKeeperApi.setAuto(auto));
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

  const resetsLeft = status.accounts.reduce((sum, account) => sum + account.resets_left, 0);
  const lastSpend = status.spends[status.spends.length - 1];

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
        <span
          className={styles.nowUsingMode}
          title={status.spends
            .map(
              (spend) =>
                `${formatInstantShort(Date.parse(spend.at))} ${spend.account}: ${spend.result} (${spend.why})`
            )
            .join('\n')}
        >
          {lastSpend
            ? t('reset_keeper.last_spend', {
                when: formatInstantShort(Date.parse(lastSpend.at)),
                account: lastSpend.account,
                result: lastSpend.result,
              })
            : t('reset_keeper.no_spends')}
        </span>
        {unreachable && <span className={styles.nowUsingMode}>{t('reset_keeper.stale')}</span>}
      </div>
    </div>
  );
}
