/**
 * "In use" / "Pinned" tags and the pin toggle for one credential, shared by
 * the Ledger, Compact and Cards layouts. State comes from QuotaPage through
 * context so the layouts don't thread extra props.
 */

import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import type { QuotaFileEntry } from '../logic';
import { RoutingContext } from '../routingContext';
import styles from './AccountRouting.module.scss';

export function AccountRouting({ entry }: { entry: QuotaFileEntry }) {
  const { t } = useTranslation();
  const routing = useContext(RoutingContext);
  if (!routing || entry.file.disabled) return null;

  const requests = routing.inUse.get(entry.file.name);
  const pinnedName = routing.pinned.get(entry.type);
  const isPinned = pinnedName === entry.file.name;

  return (
    <span className={styles.routing}>
      {requests !== undefined && (
        <span
          className={`${styles.tag} ${styles.inUse}`}
          title={t('quota_management.routing_in_use_hint', { count: requests })}
        >
          {t('quota_management.routing_in_use')}
        </span>
      )}
      {isPinned && (
        <span
          className={`${styles.tag} ${styles.pinned}`}
          title={t('quota_management.routing_pinned_hint')}
        >
          {t('quota_management.routing_pinned')}
        </span>
      )}
      <button
        type="button"
        className={styles.toggle}
        disabled={!routing.canEdit || routing.busy}
        onClick={() => (isPinned ? routing.onUnpin(entry.type) : routing.onPin(entry))}
        title={t(
          isPinned ? 'quota_management.routing_unpin_hint' : 'quota_management.routing_pin_hint'
        )}
      >
        {t(isPinned ? 'quota_management.routing_unpin' : 'quota_management.routing_pin')}
      </button>
    </span>
  );
}
