// reset-keeper: the HomeLab helper next to the proxy that spends Claude reset grants
// (papuman/CLIProxyAPI homelab/reset-keeper). Same management key, port 8318.
import axios from 'axios';
import { apiClient } from './client';

export const RESET_KEEPER_PORT = 8318;

export interface ResetKeeperAccount {
  name: string;
  auth_index: string;
  five_hour_percent: number | null;
  five_hour_resets_at: string | null;
  weekly_percent: number | null;
  weekly_resets_at: string | null;
  resets_left: number;
  reset_expires_at: string | null;
  note: string;
  read_at: string;
}

export interface ResetKeeperSpend {
  at: string;
  rule: string;
  account: string;
  why: string;
  result: string;
  proxy_cooldown_cleared: boolean;
}

export interface ResetKeeperStatus {
  auto: boolean;
  burn_hours: number;
  burn_learned: boolean;
  accounts: ResetKeeperAccount[];
  spends: ResetKeeperSpend[];
  updated_at: string | null;
}

const url = (path: string) => apiClient.sameHostUrl(RESET_KEEPER_PORT, path);
// Plain axios on purpose: the shared client treats any 401 as "log out", and a keeper
// problem must never sign the user out of the dashboard.
const config = () => ({ headers: apiClient.managementAuthHeader(), timeout: 8000 });

export const resetKeeperApi = {
  status: async () => (await axios.get<ResetKeeperStatus>(url('/status'), config())).data,
  setAuto: async (auto: boolean) =>
    (await axios.put<ResetKeeperStatus>(url('/mode'), { auto }, config())).data,
};

export interface KeeperUsageEntry {
  read_at: string;
  usage: unknown;
  profile: unknown;
}

// One request serves every account card of a page load (they load together).
const USAGE_SHARE_MS = 5_000;
let shared: { at: number; promise: Promise<Record<string, KeeperUsageEntry>> } | null = null;

/**
 * The keeper's latest Anthropic usage answer for one account, or null when the keeper
 * is unreachable or has not read it yet. The keeper is the only scheduled reader of
 * Anthropic's per-account rate-limited usage endpoint (each account about every
 * 10 min), so any number of open dashboards adds no load there.
 */
export async function keeperUsageFor(authIndex: string): Promise<KeeperUsageEntry | null> {
  const now = Date.now();
  if (!shared || now - shared.at > USAGE_SHARE_MS) {
    const promise = axios
      .get<{ accounts: Record<string, KeeperUsageEntry> }>(url('/usage'), config())
      .then((response) => response.data?.accounts ?? {});
    shared = { at: now, promise };
    promise.catch(() => {
      if (shared?.promise === promise) shared = null;
    });
  }
  try {
    return (await shared.promise)[authIndex] ?? null;
  } catch {
    return null;
  }
}
