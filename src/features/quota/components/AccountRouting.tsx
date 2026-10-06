/**
 * Routing pieces shared by the Ledger, Compact and Cards layouts:
 * - `useAccountRouting`: whether the account is in use / pinned, and the row class;
 * - `AccountName`: the alias (the credential's `note`) with inline rename;
 * - `RoutingButton`: "Use this" / "Pinned" toggle for the actions column.
 * State comes from QuotaPage through context so the layouts thread no props.
 */

import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconPencil } from '@/components/ui/icons';
import type { QuotaFileEntry } from '../logic';
import { accountAlias } from '../routing';
import { useAccountRouting } from './useAccountRouting';
import styles from './AccountRouting.module.scss';

export function AccountName({
  entry,
  fallback,
  className,
}: {
  entry: QuotaFileEntry;
  /** What to show when the account has no alias (masked or full email). */
  fallback: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { routing, inUse, requests } = useAccountRouting(entry);
  const alias = accountAlias(entry.file);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (draft === null || !routing || saving) return;
    if (draft.trim() === alias) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await routing.onRename(entry, draft.trim());
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') void save();
    if (event.key === 'Escape') setDraft(null);
  };

  if (draft !== null) {
    return (
      <input
        className={styles.aliasInput}
        value={draft}
        autoFocus
        disabled={saving}
        maxLength={40}
        placeholder={t('quota_management.routing_alias_placeholder')}
        aria-label={t('quota_management.routing_alias_edit')}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void save()}
      />
    );
  }

  const tooltip = [
    alias ? fallback : null,
    inUse ? t('quota_management.routing_in_use_hint', { count: requests }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span className={`${styles.nameWrap} ${className ?? ''}`} title={tooltip || fallback}>
      <span className={`${styles.name} ${alias ? styles.alias : ''}`}>{alias || fallback}</span>
      {routing && (
        <button
          type="button"
          className={styles.rename}
          disabled={!routing.canEdit}
          onClick={() => setDraft(alias)}
          title={t('quota_management.routing_alias_edit')}
          aria-label={t('quota_management.routing_alias_edit')}
        >
          <IconPencil size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export function RoutingButton({ entry }: { entry: QuotaFileEntry }) {
  const { t } = useTranslation();
  const { routing, pinned } = useAccountRouting(entry);
  if (!routing || entry.file.disabled) return null;
  return (
    <button
      type="button"
      className={`${styles.useButton} ${pinned ? styles.useButtonPinned : ''}`}
      disabled={!routing.canEdit || routing.busy}
      aria-pressed={pinned}
      onClick={() => (pinned ? routing.onUnpin(entry.type) : routing.onPin(entry))}
      title={t(
        pinned ? 'quota_management.routing_unpin_hint' : 'quota_management.routing_pin_hint'
      )}
    >
      {t(pinned ? 'quota_management.routing_pinned' : 'quota_management.routing_pin')}
    </button>
  );
}
