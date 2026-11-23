import { expect, type Page } from '@playwright/test';
import { HARNESS_URL } from './full-app.js';
import { ATOMIC_SET, ATOMIC_SOURCE } from '../harness/local-change-sets.js';
import { CONTINUATION_PARENT } from '../harness/preapproval-continuation.js';

type Reply = { result?: unknown; error?: { code: string; message: string } } | undefined;
export interface LocalRecoveryFixture {
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  held: string[];
  failing: string[];
  pending(method: string): number;
  release(method: string, error?: boolean): void;
}
declare global { interface Window { __localRecovery: LocalRecoveryFixture } }
export const atomic = (page: Page) => page.locator('[data-local-change-sets-route]');
export const undo = (page: Page) => page.locator('[data-local-update-undo]').first();
export const atomicApprove = (page: Page) => atomic(page).getByRole('button', { name: 'Approve changes together', exact: true });
export const atomicRefresh = (page: Page) => atomic(page).getByRole('button', { name: 'Refresh', exact: true });
export const openLocalRecovery = async (page: Page, options: {
  surface?: 'atomic' | 'approvals' | 'chat' | 'runs' | 'line' | 'migration'; held?: string[]; profiles?: boolean;
} = {}) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.addInitScript(options => {
    const waiting = new Map<string, Array<(reply: Reply) => void>>();
    const fixture: LocalRecoveryFixture = {
      calls: [], held: options.held ?? [], failing: [], pending: method => waiting.get(method)?.length ?? 0,
      release(method, error) {
        const callbacks = waiting.get(method) ?? [];
        if (!callbacks.length) throw new Error(`No pending ${method}`);
        waiting.delete(method);
        for (const finish of callbacks) finish(error ? { error: { code: 'UNAVAILABLE', message: 'Local review temporarily unavailable. Try again.' } } : undefined);
      },
    };
    Object.assign(window, { __localRecovery: fixture, __localChangeFixture: async (method: string, args: Record<string, unknown>): Promise<Reply> => {
      if (!method.startsWith('local_changes.') && !method.startsWith('local_undo.')) return undefined;
      fixture.calls.push({ method, args });
      if (fixture.failing.includes(method)) return { error: { code: 'UNAVAILABLE', message: 'Local result read unavailable. Try again.' } };
      return fixture.held.includes(method) ? new Promise<Reply>(resolve => waiting.set(method, [...waiting.get(method) ?? [], resolve])) : undefined;
    } });
  }, options);
  const address = options.surface === 'migration' ? `&preapproval=1&local_changes=1#approvals/preapproval/${ATOMIC_SOURCE}`
    : options.surface === 'approvals' ? `&preapproval=continuation&local_receipt=1#approvals/preapproval/${CONTINUATION_PARENT}`
    : options.surface === 'line' ? '&chat=session&local_mutation_receipt=line#chat/session/chat_1'
    : options.surface === 'chat' ? '&chat=session&local_mutation_receipt=1#chat/session/chat_1'
      : options.surface === 'runs' ? '&journey=verification&local_mutation_receipt=1#logs/run-verify'
        : `&local_changes=direct#approvals/local-changes/${ATOMIC_SET}`;
  await page.goto(`${HARNESS_URL}?settle_reads=1&review_clock=browser${options.profiles ? '&server_profiles=multiple' : ''}${address}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (options.surface === 'migration') await expect(page.getByRole('button', { name: 'Review as one atomic change set', exact: true })).toBeVisible();
  else if (options.surface && options.surface !== 'atomic') await expect(undo(page).getByRole('button', { name: 'Review undo', exact: true })).toBeVisible();
  else if (!options.held?.includes('local_changes.get')) await expect(atomicApprove(page)).toBeVisible();
};
