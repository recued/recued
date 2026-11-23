import { expect, type Page } from '@playwright/test';
import { HARNESS_URL } from './full-app.js';

type Reply = { result?: unknown; error?: { code: string; message: string } } | undefined;
interface RecoveryFixture {
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  held: string[];
  failNextRead: boolean;
  failAfterDecision: boolean;
  pending(method: string): number;
  release(method: string, error?: boolean): void;
}
declare global { interface Window { __preapprovalRecovery: RecoveryFixture } }
export const preapproval = (page: Page) => page.locator('[data-recued-preapproval-route]');
export const refreshReview = (page: Page) => preapproval(page).getByRole('button', { name: 'Refresh', exact: true });
export const approveReview = (page: Page) => preapproval(page).getByRole('button', { name: 'Say yes and schedule it', exact: true });
export const openPreapproval = async (page: Page, options: { continuation?: boolean; resources?: boolean; serverProfiles?: boolean; activation?: boolean; held?: string[]; failAfterDecision?: boolean } = {}) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.addInitScript(options => {
    const waiting = new Map<string, Array<(reply: Reply) => void>>();
    const fixture: RecoveryFixture = {
      calls: [], held: options.held ?? [], failNextRead: false, failAfterDecision: options.failAfterDecision ?? false,
      pending: method => waiting.get(method)?.length ?? 0,
      release(method, error) {
        const callbacks = waiting.get(method) ?? [];
        if (!callbacks.length) throw new Error(`No pending ${method}`);
        waiting.delete(method);
        for (const finish of callbacks) finish(error ? { error: { code: 'UNAVAILABLE', message: 'Review request unavailable. Try again.' } } : undefined);
      },
    };
    Object.assign(window, { __preapprovalRecovery: fixture,
      __connectionsFixture: async (method: string, args: Record<string, unknown>): Promise<Reply> => {
        if (!method.startsWith('preapproval.')) return undefined;
        fixture.calls.push({ method, args });
        if (method === 'preapproval.get' && fixture.failNextRead) {
          fixture.failNextRead = false;
          return { error: { code: 'UNAVAILABLE', message: 'Current status unavailable.' } };
        }
        const reply = fixture.held.includes(method) ? await new Promise<Reply>(resolve => {
          waiting.set(method, [...waiting.get(method) ?? [], resolve]);
        }) : undefined;
        if (method === 'preapproval.decide' && fixture.failAfterDecision && !reply) fixture.failNextRead = true;
        return reply;
      },
    });
  }, options);
  const id = options.continuation ? 'pap_11111111-1111-4111-8111-111111111111' : 'pap_browser';
  const destination = options.activation ? '&recipes=installed&automation=rules&run_palette=autorun&preapproval_automation=1#automation/auto-run/dsh_autorun-live-1' : `#approvals/preapproval/${id}`;
  await page.goto(`${HARNESS_URL}?settle_reads=1&preapproval=${options.continuation ? 'continuation' : options.resources ? 'resources' : '1'}${options.serverProfiles ? '&server_profiles=multiple' : ''}${destination}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (options.activation) return;
  await expect(preapproval(page)).toBeVisible();
  if (!options.held?.includes('preapproval.get')) await expect(preapproval(page)).toContainText('Execution:');
};
