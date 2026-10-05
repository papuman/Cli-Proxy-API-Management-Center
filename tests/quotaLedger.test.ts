import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  KimiQuotaState,
  XaiQuotaState,
} from '../src/types';
import {
  codexManualResets,
  formatCompactDuration,
  headlineRemaining,
  ledgerMeters,
  maskCredentialName,
  ledgerColumns,
  remainingFromUsed,
  summarizeLedger,
} from '../src/features/quota/ledger';

const t = ((key: string) => key) as unknown as TFunction;

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 11, 12);

const claude = (windows: [id: string, used: number, resetAtMs: number | null][]) =>
  ({
    status: 'success',
    windows: windows.map(([id, used, resetAtMs]) => ({
      id,
      label: id,
      usedPercent: used,
      resetLabel: '-',
      resetAtMs,
    })),
  }) satisfies ClaudeQuotaState;

const codex = (weeklyUsed: number, resetAtMs: number) =>
  ({
    status: 'success',
    windows: [
      { id: 'weekly', label: 'weekly', usedPercent: weeklyUsed, resetLabel: '-', resetAtMs },
    ],
  }) satisfies CodexQuotaState;

describe('remainingFromUsed', () => {
  test('inverts percent used into percent remaining', () => {
    expect(remainingFromUsed(79)).toBe(21);
  });

  test('clamps out-of-range usage instead of reporting impossible headroom', () => {
    expect(remainingFromUsed(120)).toBe(0);
    expect(remainingFromUsed(-4)).toBe(100);
  });

  test('keeps unknown usage unknown rather than reading it as empty or full', () => {
    for (const unknown of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '50']) {
      expect(remainingFromUsed(unknown)).toBeNull();
    }
  });
});

describe('summarizeLedger', () => {
  // The five Claude accounts from the reference dashboard. Fractional usage on
  // two accounts makes summing before rounding (410) disagree with the rows (409).
  const claudeAccounts = [
    claude([
      ['five-hour', 0, null],
      ['seven-day', 21, NOW + 30 * HOUR],
      ['seven-day-fable', 41.6, NOW + 25 * HOUR],
    ]),
    claude([
      ['five-hour', 0, null],
      ['seven-day', 0, NOW + 100 * HOUR],
      ['seven-day-fable', 0, NOW + 100 * HOUR],
    ]),
    claude([
      ['five-hour', 0, null],
      ['seven-day', 0, NOW + 120 * HOUR],
      ['seven-day-fable', 0, NOW - 2 * HOUR],
    ]),
    claude([
      ['five-hour', 1, NOW + 3 * HOUR],
      ['seven-day', 25, NOW + 11 * HOUR],
      ['seven-day-fable', 48.6, NOW + 11 * HOUR],
    ]),
    claude([
      ['five-hour', 0, null],
      ['seven-day', 0, NOW + 135 * HOUR],
      ['seven-day-fable', 0, NOW + 135 * HOUR],
    ]),
  ].map((quota) => ledgerMeters('claude', quota, t));

  test('sums the rounded row percentages of every Claude account into the headline', () => {
    const [headline, secondary, ...rest] = summarizeLedger('claude', claudeAccounts, NOW);

    expect(headline.id).toBe('seven-day');
    expect(headline.remaining).toBe(454);
    expect(headline.capacity).toBe(500);
    expect(headline.segments.map((value) => Math.round(value ?? -1))).toEqual([
      79, 100, 100, 75, 100,
    ]);
    expect(secondary.id).toBe('seven-day-fable');
    expect(secondary.remaining).toBe(409);
    expect(secondary.capacity).toBe(500);
    expect(rest).toEqual([]);
  });

  test('reports the earliest reset still ahead and ignores resets already past', () => {
    const [headline, secondary] = summarizeLedger('claude', claudeAccounts, NOW);
    expect(headline.nextResetAtMs).toBe(NOW + 11 * HOUR);
    expect(secondary.nextResetAtMs).toBe(NOW + 11 * HOUR);

    const pastOnly = [ledgerMeters('claude', claude([['seven-day', 10, NOW - HOUR]]), t)];
    expect(summarizeLedger('claude', pastOnly, NOW)[0].nextResetAtMs).toBeNull();
  });

  test('sums Codex weekly windows across accounts', () => {
    const accounts = [
      codex(83, NOW + 54 * HOUR),
      codex(100, NOW + 78 * HOUR),
      codex(100, NOW + 55 * HOUR),
    ];
    const [weekly] = summarizeLedger(
      'codex',
      accounts.map((quota) => ledgerMeters('codex', quota, t)),
      NOW
    );
    expect(weekly).toMatchObject({ id: 'weekly', remaining: 17, capacity: 300 });
    expect(weekly.nextResetAtMs).toBe(NOW + 54 * HOUR);
  });

  test('heads a Codex team account with its monthly window, not its 5-hour window', () => {
    const team = {
      status: 'success',
      windows: [
        { id: 'five-hour', label: '5h', usedPercent: 10, resetLabel: '-', resetAtMs: null },
        { id: 'monthly', label: 'month', usedPercent: 70, resetLabel: '-', resetAtMs: null },
      ],
    } satisfies CodexQuotaState;
    const [headline] = summarizeLedger('codex', [ledgerMeters('codex', team, t)], NOW);
    expect(headline).toMatchObject({ id: 'monthly', remaining: 30, capacity: 100 });
  });

  test('counts unloaded accounts in capacity but never in the sum', () => {
    const accounts = [
      ledgerMeters('codex', codex(40, NOW + HOUR), t),
      ledgerMeters('codex', { status: 'loading' }, t),
      ledgerMeters('codex', undefined, t),
    ];
    const [weekly] = summarizeLedger('codex', accounts, NOW);
    expect(weekly.remaining).toBe(60);
    expect(weekly.capacity).toBe(300);
    expect(weekly.segments).toEqual([60, null, null]);
  });

  test('keeps an xAI account with unknown usage unknown while still reporting its reset', () => {
    const quota: XaiQuotaState = {
      status: 'success',
      billing: {
        mode: 'billing',
        periodType: 'weekly',
        usagePercent: null,
        periodEnd: new Date(NOW + 125 * HOUR).toISOString(),
        resetAtMs: NOW + 125 * HOUR,
        productUsage: [],
        monthlyLimitCents: null,
        usedCents: null,
        includedUsedCents: null,
        onDemandCapCents: null,
        onDemandUsedCents: null,
        onDemandUsedPercent: null,
        usedPercent: null,
      },
    };
    const summary = summarizeLedger('xai', [ledgerMeters('xai', quota, t)], NOW);
    expect(summary).toEqual([
      {
        id: 'weekly',
        label: 'xai_quota.weekly_limit',
        remaining: null,
        capacity: 100,
        segments: [null],
        nextResetAtMs: NOW + 125 * HOUR,
      },
    ]);
  });

  test('keeps the weekly headline and omits the Fable window when no account has it', () => {
    const accounts = [
      ledgerMeters(
        'claude',
        claude([
          ['five-hour', 10, null],
          ['seven-day', 30, null],
        ]),
        t
      ),
    ];
    expect(summarizeLedger('claude', accounts, NOW).map((window) => window.id)).toEqual([
      'seven-day',
    ]);
  });

  test('uses the first loaded window as the headline for providers without summed windows', () => {
    const quota: AntigravityQuotaState = {
      status: 'success',
      groups: [
        {
          id: 'gemini',
          label: 'Gemini models',
          buckets: [{ id: 'g', label: 'g', remainingFraction: 0.4 }],
        },
        {
          id: 'claude-gpt',
          label: 'Claude and GPT models',
          buckets: [{ id: 'c', label: 'c', remainingFraction: 1 }],
        },
      ],
    };
    const summary = summarizeLedger(
      'antigravity',
      [[], ledgerMeters('antigravity', quota, t)],
      NOW
    );
    expect(summary.map((window) => window.id)).toEqual(['gemini']);
    expect(summary[0]).toMatchObject({ remaining: 40, capacity: 200, segments: [null, 40] });
  });

  test('returns no windows before any account has loaded', () => {
    expect(summarizeLedger('claude', [[], []], NOW)).toEqual([]);
  });
});

describe('ledgerColumns', () => {
  test('puts the headline first and the secondary summed window last', () => {
    const meters = ledgerMeters(
      'claude',
      claude([
        ['five-hour', 0, null],
        ['seven-day', 0, null],
        ['seven-day-sonnet', 0, null],
        ['seven-day-fable', 0, null],
      ]),
      t
    );
    const summary = summarizeLedger('claude', [meters], NOW);
    expect(ledgerColumns([meters], summary)).toEqual([
      'seven-day',
      'five-hour',
      'seven-day-sonnet',
      'seven-day-fable',
    ]);
  });

  test('keeps the Fable column for every row when one account lacks that window', () => {
    const withFable = ledgerMeters(
      'claude',
      claude([
        ['five-hour', 17, null],
        ['seven-day', 79, null],
        ['seven-day-fable', 0, null],
      ]),
      t
    );
    const withoutFable = ledgerMeters(
      'claude',
      claude([
        ['five-hour', 0, null],
        ['seven-day', 100, null],
      ]),
      t
    );
    const accounts = [withoutFable, withFable];
    expect(ledgerColumns(accounts, summarizeLedger('claude', accounts, NOW))).toEqual([
      'seven-day',
      'five-hour',
      'seven-day-fable',
    ]);
  });
});

describe('headlineRemaining', () => {
  test("sorts each account by its own headline window, not the group's", () => {
    const withFable = ledgerMeters(
      'claude',
      claude([
        ['seven-day', 10, null],
        ['seven-day-fable', 70, null],
      ]),
      t
    );
    const withoutFable = ledgerMeters('claude', claude([['seven-day', 40, null]]), t);
    const fableOnly = ledgerMeters('claude', claude([['seven-day-fable', 70, null]]), t);
    expect(headlineRemaining('claude', withFable)).toBe(90);
    expect(headlineRemaining('claude', withoutFable)).toBe(60);
    expect(headlineRemaining('claude', fableOnly)).toBe(30);
    expect(headlineRemaining('claude', [])).toBeNull();
  });
});

describe('provider conversions', () => {
  test('converts Kimi used/limit counts to remaining percent', () => {
    const quota: KimiQuotaState = {
      status: 'success',
      rows: [
        { id: 'summary', label: 'weekly', used: 30, limit: 120 },
        { id: 'zero-limit-used', label: 'x', used: 5, limit: 0 },
        { id: 'zero-limit-idle', label: 'y', used: 0, limit: 0 },
      ],
    };
    expect(ledgerMeters('kimi', quota, t).map((meter) => meter.remaining)).toEqual([75, 0, null]);
  });

  test('reads an Antigravity group as its most exhausted bucket, with that bucket reset', () => {
    const quota: AntigravityQuotaState = {
      status: 'success',
      groups: [
        {
          id: 'gemini',
          label: 'Gemini models',
          buckets: [
            { id: 'daily', label: 'daily', remainingFraction: 0.8, resetAtMs: NOW + HOUR },
            { id: 'weekly', label: 'weekly', remainingFraction: 0.25, resetAtMs: NOW + 90 * HOUR },
            { id: 'five-hour', label: '5h', remainingFraction: 0.5, resetAtMs: NOW + 2 * HOUR },
          ],
        },
      ],
    };
    expect(ledgerMeters('antigravity', quota, t)).toEqual([
      {
        id: 'gemini',
        label: 'antigravity_quota.group_gemini_models',
        remaining: 25,
        resetAtMs: NOW + 90 * HOUR,
        resetLabel: null,
      },
    ]);
  });

  test('picks the available Codex reset credit that expires first', () => {
    const quota: CodexQuotaState = {
      status: 'success',
      windows: [],
      rateLimitResetCreditsAvailableCount: 2,
      rateLimitResetCredits: [
        { id: 'a', status: 'available', grantedAt: '', expiresAt: '2026-10-20T10:00:00Z' },
        { id: 'b', status: 'used', grantedAt: '', expiresAt: '2026-09-12T10:00:00Z' },
        { id: 'c', status: 'available', grantedAt: '', expiresAt: '2026-10-03T21:10:00Z' },
      ],
    };
    expect(codexManualResets(quota)).toEqual({
      available: 2,
      next: {
        number: 3,
        expiresAtMs: Date.parse('2026-10-03T21:10:00Z'),
        expiresLabel: '2026-10-03T21:10:00Z',
      },
      credits: [
        {
          number: 1,
          status: 'available',
          expiresAtMs: Date.parse('2026-10-20T10:00:00Z'),
          expiresLabel: '2026-10-20T10:00:00Z',
        },
        {
          number: 2,
          status: 'used',
          expiresAtMs: Date.parse('2026-09-12T10:00:00Z'),
          expiresLabel: '2026-09-12T10:00:00Z',
        },
        {
          number: 3,
          status: 'available',
          expiresAtMs: Date.parse('2026-10-03T21:10:00Z'),
          expiresLabel: '2026-10-03T21:10:00Z',
        },
      ],
    });
  });
});

describe('maskCredentialName', () => {
  test.each([
    ['claude', 'claude-theo@lastname.dev.json', 'claude-t•••@l•••.dev.json'],
    ['codex', 'codex-ae5d455f-theo@lastname.dev-pro.json', 'codex-ae5d455f-t•••@l•••.dev-pro.json'],
    ['codex', 'codex-theo@t3.gg-pro.json', 'codex-t•••@t•••.gg-pro.json'],
    ['claude', 'claude-a@mail.corp.example.com.json', 'claude-a•••@m•••.com.json'],
  ] as const)('masks %s %s', (type, name, masked) => {
    expect(maskCredentialName(name, type)).toBe(masked);
  });

  test('never reveals the mailbox or domain', () => {
    const masked = maskCredentialName('codex-ae5d455f-theo@lastname.dev-pro.json', 'codex');
    expect(masked).not.toContain('theo');
    expect(masked).not.toContain('lastname');
  });

  test('masks the email in a Devin display name', () => {
    const masked = maskCredentialName('devin-team.json · theo@lastname.dev', 'devin');
    expect(masked).toBe('devin-team.json · t•••@l•••.dev');
  });

  test('leaves names without an email unchanged', () => {
    expect(maskCredentialName('kimi-main.json', 'kimi')).toBe('kimi-main.json');
  });
});

describe('formatCompactDuration', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  test.each([
    [42 * 60_000, '42m'],
    [3 * 3_600_000 + 57 * 60_000, '3h57m'],
    [7 * 3_600_000, '7h'],
    [2 * 86_400_000 + 5 * 3_600_000, '2d5h'],
    [16 * 86_400_000, '16d'],
  ])('%p ms left reads %s', (delta, label) => {
    expect(formatCompactDuration(now + delta, now)).toBe(label);
  });

  test('is null for unknown or past instants', () => {
    expect(formatCompactDuration(null, now)).toBe(null);
    expect(formatCompactDuration(now - 1, now)).toBe(null);
  });
});
