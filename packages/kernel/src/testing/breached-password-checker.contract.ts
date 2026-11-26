import { describe, expect, it } from 'vitest';
import type { BreachedPasswordChecker } from '../breached-passwords.ts';

export interface BreachedPasswordCheckerHarness {
  checker: BreachedPasswordChecker;
  /** A password the source lists as breached. */
  breached: string;
  /** A password the source does not list. */
  clear: string;
  /** The same checker with its source unreachable. */
  unavailable(): BreachedPasswordChecker;
}

/**
 * Shared contract every BreachedPasswordChecker adapter must pass (ADR-0078): the in-memory fake,
 * and the Pwned Passwords adapter against a stand-in for the service.
 */
export function breachedPasswordCheckerContract(
  name: string,
  makeHarness: () => Promise<BreachedPasswordCheckerHarness>,
): void {
  describe(`BreachedPasswordChecker contract: ${name}`, () => {
    it('has a stable adapter name', async () => {
      expect((await makeHarness()).checker.name).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('reports a listed password as breached and an unlisted one as clear', async () => {
      const h = await makeHarness();
      expect(await h.checker.check(h.breached)).toBe('breached');
      expect(await h.checker.check(h.clear)).toBe('clear');
    });

    it('is exact: a listed password with one character changed is clear', async () => {
      const h = await makeHarness();
      expect(await h.checker.check(`${h.breached}x`)).toBe('clear');
    });

    it('answers unknown, never throws, when the source is unreachable', async () => {
      const h = await makeHarness();
      await expect(h.unavailable().check(h.breached)).resolves.toBe('unknown');
    });
  });
}
