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
