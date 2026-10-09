import { useCallback, useEffect, useState } from 'react';
import { resetKeeperApi, type ResetKeeperStatus } from '@/services/api/resetKeeper';

const POLL_MS = 60_000;

/** Polls the reset-keeper helper; `unreachable` is true while the last poll failed. */
export function useResetKeeper() {
  const [status, setStatus] = useState<ResetKeeperStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
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
  return { status, setStatus, unreachable };
}
