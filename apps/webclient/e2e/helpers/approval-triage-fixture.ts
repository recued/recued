import { expect, type Page } from '@playwright/test';
import type { ChatPlanRecord, ServerPendingApproval, ServerPendingAsk } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';

type Reply = { result?: unknown; error?: { code: string; message: string } };
export interface ApprovalTriageFixture {
  asks: ServerPendingAsk[];
  gates: ServerPendingApproval[];
  plans: ChatPlanRecord[];
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  expectedWrites: Array<{ method: string; args: Record<string, unknown> }>;
  held: string[];
  failing: string[];
  afterReply?: (method: string) => void;
  pending(method: string): number;
  release(method: string, outcome: 'success' | 'error'): void;
}
declare global { interface Window { __approvalTriage: ApprovalTriageFixture } }

export const triage = (page: Page) => page.locator('[data-recued-approvals-route]');
export const triageCard = (page: Page, id: string) => triage(page).locator(`[data-recued-approvals-focus="${id}"]`);
export const triageFilter = (page: Page, kind: string) => triage(page).locator(`[data-recued-approvals-filter="${kind}"]`);
export const triageSearch = (page: Page) => triage(page).getByRole('searchbox', { name: 'Search pending decisions', exact: true });
export const triageNote = (page: Page, id = 'ask-a') => triageCard(page, id).locator(`[data-recued-ask-note="${id}"]`);
export const triageSummary = (page: Page) => triage(page).locator('[data-recued-approvals-summary]');
export const triageRefresh = (page: Page) => triage(page).locator('[data-recued-approvals-refresh]');
export const triageClear = (page: Page) => triage(page).getByRole('button', { name: 'Clear filters', exact: true });
export const triageDrain = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
export const invalidateTriage = async (page: Page) => {
  const before = await page.evaluate(() => window.__app.rpcCallCount('notification.pending_asks'));
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'notification.ask', ask_id: 'fixture-update', cursor: 1000 } }));
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('notification.pending_asks'))).toBeGreaterThan(before);
};
export const triageApprove = (page: Page, id = 'ask-a') => triageCard(page, id).locator('[data-recued-ask-option="yes"]');

export const openTriage = async (page: Page, options: { width?: number; empty?: boolean; secret?: boolean; ownerReview?: boolean; serverProfiles?: boolean; held?: string[]; failing?: string[]; address?: string } = {}) => {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 });
  await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(({ now, options }) => {
    const waiting = new Map<string, Array<{ finish(outcome: 'success' | 'error'): void; released: boolean }>>();
    const fixture: ApprovalTriageFixture = {
      asks: options.empty ? [] : ['ask-a', 'ask-b'].map((id, index) => ({ ask_id: id, title: `Review customer follow-up ${index + 1}`,
        text: 'Check the requested follow-up and explain your decision.', body: 'Follow up after the additional visit.',
        options: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Reject' }], note_prompt: index === 0 ? 'required' : 'optional', created_at: now + index })),
      gates: options.empty ? [] : [{ approval_id: 'gate-a', recipe_id: 'customer-followup', step_id: 'send', ingredient_slug: 'mail.send',
        risk_tier: 'destructive', description: 'Remove the archived follow-up', resolved_input: { record: 'archived-follow-up' },
        created_at: now - 100, timeout_at: now + 3600000, initiator_instance: 'office' }],
      plans: options.empty ? [] : [{ plan: { plan_id: 'plan-a', session_id: 'session-a', turn_id: 'turn-a', tool: 'mail.send',
        tier: 2, classification: 'write', args: { subject: 'Welcome pack' }, args_hash: 'fixture-hash', status: 'proposed', created_at: now - 50 }, payload_available: true }],
      calls: [], expectedWrites: [], held: options.held ?? [], failing: options.failing ?? [],
      pending: method => (waiting.get(method) ?? []).filter(item => !item.released).length,
      release(method, outcome) {
        const items = (waiting.get(method) ?? []).filter(item => !item.released);
        if (!items.length) throw new Error(`No pending ${method}`);
        for (const item of items) { item.released = true; item.finish(outcome); }
      },
    };
    if (options.secret) {
      const ask = fixture.asks[0]!;
      delete ask.note_prompt;
      ask.title = 'Sign in for the waiting browser step';
      ask.secret_prompt = { kind: 'password', site: 'fixture.example.test', field: 'Password', remember: true, expires_at: now + 600000 };
      ask.options = [{ id: 'stop', label: 'Stop this task' }];
    }
    if (options.ownerReview) fixture.asks[0]!.owner_review = { kind: 'preapproval', proposal_id: 'proposal-a' };
    const reply = (method: string, args: Record<string, unknown>, outcome: 'success' | 'error'): Reply => {
      if (outcome === 'error') return { error: { code: 'UNAVAILABLE', message: 'Review temporarily unavailable. Try again.' } };
      if (method === 'approval.list' || method === 'approval.subscribe') return { result: { approvals: fixture.gates, seq: 0 } };
      if (method === 'notification.pending_asks') return { result: { asks: fixture.asks } };
      if (method === 'chat.plans.pending.list') return { result: { plans: fixture.plans } };
      if (method === 'recipe.list') return { result: { recipes: [{ recipe_id: 'customer-followup', name: 'Customer follow-up' }] } };
      if (method === 'pair.list') return { result: { devices: [{ instance_id: 'office', display_name: 'Office desktop' }] } };
      if (method === 'notification.giveSecret') return { result: { given: true } };
      if (method === 'notification.submitAnswer') fixture.asks = fixture.asks.filter(ask => ask.ask_id !== args.ask_id);
      if (method === 'approval.resolve') fixture.gates = fixture.gates.filter(gate => gate.approval_id !== args.approval_id);
      if (method === 'chat.plan.approve' || method === 'chat.plan.cancel') fixture.plans = fixture.plans.filter(plan => plan.plan.plan_id !== args.plan_id);
      return { result: { ok: true } };
    };
    Object.assign(window, { __approvalTriage: fixture,
      __connectionsFixture: async (method: string, args: Record<string, unknown>): Promise<Reply | undefined> => {
        if (!['approval.list', 'approval.subscribe', 'notification.pending_asks', 'chat.plans.pending.list', 'recipe.list', 'pair.list',
          'notification.submitAnswer', 'notification.giveSecret', 'approval.resolve', 'chat.plan.approve', 'chat.plan.cancel'].includes(method)) return undefined;
        fixture.calls.push({ method, args });
        if (fixture.held.includes(method)) return new Promise(resolve => {
          const items = waiting.get(method) ?? [];
          items.push({ released: false, finish: outcome => { const out = reply(method, args, outcome); fixture.afterReply?.(method); resolve(out); } }); waiting.set(method, items);
        });
        const out = reply(method, args, fixture.failing.includes(method) ? 'error' : 'success'); fixture.afterReply?.(method); return out;
      },
    });
  }, { now: FIXED_NOW, options });
  await page.goto(`${HARNESS_URL}?settle_reads=1${options.serverProfiles ? '&server_profiles=multiple' : ''}${options.address ? '&journey=verification' : ''}${options.address ?? '#approvals'}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (options.address) return;
  await expect(triage(page)).toBeVisible();
  if (!options.empty && !options.held?.includes('approval.list')) await expect(triageFilter(page, 'all')).toHaveText('All (4)');
};
