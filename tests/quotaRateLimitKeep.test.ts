import { describe, expect, test } from 'bun:test';
import { isRateLimited } from '../src/features/quota/hooks/useQuotaBatchLoader';

describe('isRateLimited', () => {
  test('429 by status or by the proxy message keeps the last numbers', () => {
    expect(isRateLimited(429, undefined)).toBe(true);
    expect(isRateLimited(undefined, '429 Rate limited. Please try again later.')).toBe(true);
  });
  test('other failures still show as errors', () => {
    expect(isRateLimited(401, 'Unauthorized')).toBe(false);
    expect(isRateLimited(undefined, 'Request failed 4290 bytes')).toBe(false);
    expect(isRateLimited(undefined, undefined)).toBe(false);
  });
});
