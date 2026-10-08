import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  anthropicResetGrantBlocker,
  claimClaudeResetGrant,
  clearClaudeProxyCooldown,
  readClaudeOrganization,
  readClaudeResetGrants,
  type AnthropicResetSettledCode,
} from '@/services/api/claudeResetGrants';

export const RETRY_WINDOW_MS = 10 * 60 * 1000;
type Operation = {
  grantId: string;
  organization: string;
  requestId: string;
  createdAt: number;
  code?: AnthropicResetSettledCode;
};
const defaultDependencies = {
  revision: () => apiClient.getConnectionRevision(),
  readStatus: readClaudeResetGrants,
  readOrganization: readClaudeOrganization,
  claim: claimClaudeResetGrant,
  clearCooldown: clearClaudeProxyCooldown,
  now: () => Date.now(),
  requestId: () => crypto.randomUUID() as string,
};

/** A 429 on Anthropic's per-account usage/profile read gets its own message. */
async function read<T>(load: () => Promise<T>): Promise<T> {
  const result = await load().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  if (result.ok) return result.value;
  if (result.error instanceof AnthropicResetGrantError && result.error.code === 'rate_limited') {
    throw new Error('blocked:rate_limited');
  }
  throw result.error;
}

/** Tab-memory journal: survives dialog/card unmounts, never crosses connections.
 * No automatic retry. Expired ambiguous operations stay blocked until session end.
 * This is not a cross-tab or durable backend spending ledger.
 */
export function createResetGrantOperations(deps = defaultDependencies) {
  /** Best effort: the reset already happened upstream; a failed clear must not hide that. */
  const clearCooldown = async (authIndex: string) => {
    try {
      await deps.clearCooldown(authIndex);
      return true;
    } catch {
      return false;
    }
  };
  let revision = deps.revision();
  const operations = new Map<string, Operation>();
  const busy = new Set<string>();
  const syncSession = () => {
    if (revision !== deps.revision()) {
      revision = deps.revision();
      operations.clear();
      busy.clear();
    }
    return revision;
  };
  return {
    inspect(key: string) {
      syncSession();
      return operations.get(key);
    },
    async run(key: string, authIndex: string, grantId: string) {
      const session = syncSession();
      const assertSession = () => {
        if (deps.revision() !== session) throw new Error('session');
      };
      if (busy.has(key)) throw new Error('busy');
      busy.add(key);
      try {
        let operation = operations.get(key);
        if (operation?.code) operation = undefined;
        if (
          operation &&
          (operation.grantId !== grantId || deps.now() - operation.createdAt >= RETRY_WINDOW_MS)
        )
          throw new Error('expired');
        const wasRetry = Boolean(operation);
        const organization = await read(() => deps.readOrganization(authIndex));
        assertSession();
        if (operation && operation.organization !== organization) throw new Error('identity');
        if (!operation) {
          const status = await read(() => deps.readStatus(authIndex));
          assertSession();
          const grant = status.grants.find((item) => item.id === grantId);
          const now = deps.now();
          const blocker = anthropicResetGrantBlocker(status, grantId);
          // Anthropic says the account is usable (e.g. reset elsewhere): spend nothing,
          // just drop the proxy's stale cooldown so it routes to the account again.
          if (blocker === 'not_limited') {
            return {
              code: 'not_limited' as const,
              unresolved: false,
              cleared: await clearCooldown(authIndex),
            };
          }
          if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) {
            throw new Error('blocked:cooldown');
          }
          if (
            blocker ||
            !grant ||
            (grant.startsAt && Date.parse(grant.startsAt) > now) ||
            (grant.endsAt && Date.parse(grant.endsAt) <= now)
          ) {
            throw new Error(`blocked:${blocker === 'ineligible' ? 'ineligible' : 'grant'}`);
          }
          operation = { grantId, organization, requestId: deps.requestId(), createdAt: now };
          operations.set(key, operation);
        }
        // Re-check immediately before dispatch; never send against a replacement connection.
        assertSession();
        if (wasRetry && deps.now() - operation.createdAt >= RETRY_WINDOW_MS) {
          throw new Error('expired');
        }
        const code = await deps.claim(authIndex, organization, grantId, operation.requestId);
        assertSession();
        // A refusal on a retry cannot prove that the earlier ambiguous POST did not spend.
        if (!wasRetry || code === 'reset' || code === 'already_used') operation.code = code;
        const cleared =
          code === 'reset' || code === 'already_used' || code === 'not_limited'
            ? await clearCooldown(authIndex)
            : false;
        return { code, unresolved: !operation.code, cleared };
      } finally {
        if (deps.revision() === session) busy.delete(key);
      }
    },
  };
}

export const resetGrantOperations = createResetGrantOperations();
