import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  nextGrantExpiryMs,
  readClaudeResetGrantsShared,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import { resetGrantOperations, RETRY_WINDOW_MS } from './resetGrantOperations';
import { selectResetGrant } from './selectResetGrant';

/**
 * Recent reads per account. Anthropic rate-limits the usage endpoint per
 * account, so switching layouts or re-rendering must not re-read; a refresh
 * after the TTL, or after a claim, reads again.
 */
const READ_TTL_MS = 15 * 60_000;
const recentReads = new Map<string, { at: number; status: AnthropicResetGrantStatus }>();

/** Card-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [status, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    const cacheKey = `${session}:${key}`;
    const cached = recentReads.get(cacheKey);
    if (cached && reload === 0 && Date.now() - cached.at < READ_TTL_MS) {
      setStatus(cached.status);
      setMessage('');
      return;
    }
    let cancelled = false;
    const current = () =>
      !cancelled && version === generation.current && session === apiClient.getConnectionRevision();
    void readClaudeResetGrantsShared(authIndex).then(
      (result) => {
        recentReads.set(cacheKey, { at: Date.now(), status: result });
        if (current()) {
          setStatus(result);
          setMessage('');
        }
      },
      (error: unknown) => {
        if (!current()) return;
        setMessage(
          error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
            ? 'read_rate_limited'
            : 'read_error'
        );
      }
    );
    return () => {
      cancelled = true;
      generation.current += 1;
    };
  }, [authIndex, key, enabled, disabled, sessionActive, session, refreshToken, reload]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const selected = pending?.grantId ?? (status ? selectResetGrant(status, now)?.id : undefined);
  const blocked = disabled || !sessionActive || !authIndex || busy || expired || !selected;
  const confirm = () => {
    if (blocked || lock.current || !selected || !authIndex) return;
    const version = generation.current;
    const current = () =>
      session === apiClient.getConnectionRevision() && version === generation.current;
    showConfirmation({
      title: t('claude_reset.title'),
      message: t(pending ? 'claude_reset.retry_confirm' : 'claude_reset.confirm_text', {
        name: file.name,
      }),
      confirmText: t(pending ? 'claude_reset.retry' : 'claude_reset.confirm'),
      variant: 'primary',
      onConfirm: async () => {
        if (!current() || lock.current || useAuthStore.getState().connectionStatus !== 'connected')
          return;
        lock.current = true;
        setBusy(true);
        try {
          const answer = await resetGrantOperations.run(key, authIndex, selected);
          if (!current()) return;
          const text = t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`);
          showNotification(
            answer.cleared ? `${text} ${t('claude_reset.proxy_cleared')}` : text,
            answer.cleared ||
              (!answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used'))
              ? 'success'
              : 'error'
          );
        } catch (error) {
          if (!current()) return;
          const unresolved = resetGrantOperations.inspect(key);
          const reason = error instanceof Error ? error.message.replace(/^blocked:/, '') : '';
          showNotification(
            t(
              `claude_reset.${
                unresolved && !unresolved.code
                  ? 'unknown'
                  : ['rate_limited', 'cooldown', 'ineligible'].includes(reason)
                    ? reason
                    : 'blocked'
              }`
            ),
            'error'
          );
        } finally {
          lock.current = false;
          // A concurrent page-wide refresh can invalidate this read generation.
          // Release the local lock regardless, but never refresh a replacement account.
          setBusy(false);
          setReload((value) => value + 1);
          if (current()) onRefresh();
        }
      },
    });
  };
  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    expiresAtMs: status ? nextGrantExpiryMs(status.grants, now) : null,
    grants: status?.grants ?? [],
    busy,
    blocked,
    confirm,
    message: pending ? (expired ? 'expired' : 'unknown') : message,
    buttonLabel: pending ? 'retry' : 'use',
  };
}
