import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from '../src/ids.js';

describe('randomId', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is 32 lowercase hex characters and does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, randomId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('works without crypto.randomUUID (insecure contexts such as plain HTTP on a LAN host)', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function');
    });
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
