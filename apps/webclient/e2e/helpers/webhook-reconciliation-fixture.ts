import { expect, type Page } from '@playwright/test';
import { WEBHOOK_PROFILE_REGISTRY, type WebhookIngressView, type WebhookProfileRuntimeCapabilityView } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';

type Reply = { result?: unknown; error?: { code: string; message: string } };
export interface WebhookRecoveryFixture {
  rows: WebhookIngressView[];
  profiles: WebhookProfileRuntimeCapabilityView[];
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  held: string[];
  failing: string[];
  pending(method: string): number;
  release(method: string, error?: boolean): void;
}
declare global { interface Window { __webhookRecovery: WebhookRecoveryFixture } }

// Distinct from the harness's demo IDs: its default dispatcher cannot mutate
// these rows. This opt-in model owns only the webhook RPC results below.
export const RECOVERY_INGRESS = 'whi_recovery0123456789abcdef012345678';
export const DISABLE_WEBHOOK = 'webhook.ingress.disable';
export const RECONCILE_WEBHOOK = 'webhook.ingress.registration.reconcile';
export const RETIRE_WEBHOOK = 'webhook.ingress.retire';
export const DISMISS_STRAYS = 'webhook.ingress.strays.dismiss';
export const LIST_WEBHOOKS = 'webhook.ingress.list';
export const SET_WEBHOOK_DOOR = 'webhook.ingress.door.set';
export const recoveryRow = (overrides: Partial<WebhookIngressView> = {}): WebhookIngressView => ({
  ingress_id: RECOVERY_INGRESS, public_id: 'recoveryOpaquePublicId0123456789abcd',
  display_name: 'Customer billing and subscription events', profile_id: 'stripe.event.v1', environment: 'test',
  paired_connection_id: 'billing-team', registration_target: null, registration_mode: 'managed_endpoint',
  endpoint_url: 'https://hooks.example.test/v1/webhooks/recoveryOpaquePublicId0123456789abcd',
  remote_endpoint_id: 'we_existing_billing_endpoint', selected_event_types: ['invoice.paid'],
  registration_state: 'cleanup_pending', intake_state: 'disabled', configured_fields: ['endpoint_secret'],
  missing_required_fields: [], active_credential_versions: [],
  readiness: { credentials_complete: true, registration_complete: false, registration_endpoint_matches: true,
    event_selection_complete: true, local_configuration_complete: true, profile_runtime_available: true,
    paired_connection_available: true, listener_available: true, public_url_available: true,
    public_reachability_enabled: true, tls_ready: true, clock_ready: true, test_delivery_supported: true,
    vault_unlocked: true, server_unpaused: true, can_enable: false, blockers: ['registration_incomplete'] },
  health: { status: 'disabled', test_observed_at: null, last_delivery_at: null, last_error_code: null },
  enabled_at: null, created_at: FIXED_NOW - 86_400_000, updated_at: FIXED_NOW,
  ...overrides,
});
export const mixedStrays = () => [
  { remote_endpoint_id: 'we_proven_still_retrying', connection_id: 'previous-billing-account', given_up: false },
  { remote_endpoint_id: 'we_changed_still_looking', connection_id: 'previous-billing-account', given_up: false, unproven: true as const },
  { remote_endpoint_id: 'we_proven_stopped_retrying', connection_id: 'archived-billing-account', given_up: true },
  { remote_endpoint_id: 'we_changed_stopped_looking', connection_id: 'archived-billing-account', given_up: true, unproven: true as const },
];
export const recipeRecoveryRow = (open: boolean): WebhookIngressView => recoveryRow({
  intake_state: 'enabled', registration_state: 'registered', recipe_door_switch: true,
  recipes: ['billing-receipts', 'billing-alerts'].map(recipe_id => ({ recipe_id, name: recipe_id,
    consumer_kind: 'local_recipe', armed: true, door: open ? 'open' : 'closed' })),
});
export const webhookCard = (page: Page) => page.locator(`[data-recued-webhooks-card="${RECOVERY_INGRESS}"]`);
export const webhookAction = (page: Page, action: string) => webhookCard(page).locator(`[data-recued-webhooks-action="${action}"]`);
export const webhookWrites = (page: Page) => page.evaluate(() => window.__webhookRecovery.calls.filter(call => call.method !== 'webhook.ingress.list'));

export const openWebhookRecovery = async (page: Page, options: {
  row?: WebhookIngressView; held?: string[]; profiles?: boolean; multipleServers?: boolean;
} = {}) => {
  const profile = WEBHOOK_PROFILE_REGISTRY['stripe.event.v1'];
  await page.addInitScript(({ rows, profiles, held }) => {
    const waiting = new Map<string, Array<(failed: boolean) => void>>();
    const fixture: WebhookRecoveryFixture = {
      rows, profiles, held, calls: [], failing: [], pending: method => waiting.get(method)?.length ?? 0,
      release(method, error = false) {
        const callbacks = waiting.get(method) ?? [];
        if (!callbacks.length) throw new Error(`No pending ${method}`);
        waiting.delete(method);
        callbacks.forEach(finish => finish(error));
      },
    };
    Object.assign(window, { __webhookRecovery: fixture, __connectionsFixture: async (method: string, input: unknown): Promise<Reply | undefined> => {
      if (!method.startsWith('webhook.')) return undefined;
      const args = (input ?? {}) as Record<string, unknown>;
      fixture.calls.push({ method, args });
      const failed = fixture.failing.includes(method) || (fixture.held.includes(method)
        && await new Promise<boolean>(resolve => waiting.set(method, [...waiting.get(method) ?? [], resolve])));
      if (failed) return { error: { code: 'UNAVAILABLE', message: 'Webhook recovery is temporarily unavailable. Try again.' } };
      if (method === 'webhook.ingress.list') return { result: { ingresses: fixture.rows, profiles: fixture.profiles } };
      const row = fixture.rows.find(item => item.ingress_id === args.ingress_id);
      if (!row) return { error: { code: 'NOT_FOUND', message: 'Webhook no longer exists.' } };
      if (method === 'webhook.ingress.door.set') {
        const updated: WebhookIngressView = { ...row, recipes: (row.recipes ?? []).map(recipe => recipe.recipe_id === args.recipe_id
          ? { ...recipe, door: args.open === true ? 'open' : 'closed' } : recipe) };
        fixture.rows = fixture.rows.map(item => item === row ? updated : item);
        return { result: { ingress: updated } };
      }
      if (method === 'webhook.ingress.strays.dismiss') {
        const remaining = (row.strays ?? []).filter(stray => !stray.given_up);
        const updated = { ...row, strays: remaining, stray_endpoints_given_up: 0 };
        fixture.rows = row.intake_state === 'retired' && row.registration_state === 'retired' && remaining.length === 0
          ? fixture.rows.filter(item => item !== row) : fixture.rows.map(item => item === row ? updated : item);
        return { result: { ingress: updated } };
      }
      if (['webhook.ingress.disable', 'webhook.ingress.registration.reconcile', 'webhook.ingress.retire'].includes(method)) {
        // An acknowledged attempt can still await service cleanup. A relist,
        // rather than optimistic success, remains authoritative for the card.
        return { result: { ingress: row, dead_letters_closed: 0 } };
      }
      return { error: { code: 'FIXTURE_MISSING_METHOD', message: `Unexpected webhook method ${method}` } };
    } });
  }, { rows: [options.row ?? recoveryRow()], profiles: options.profiles === false ? [] : [{ profile_id: profile.profile_id,
    registration_modes: [...profile.registration_modes], deduplication: profile.deduplication }], held: options.held ?? [] });
  await page.goto(`${HARNESS_URL}?connection=webhooks&settle_reads=1${options.multipleServers ? '&server_profiles=multiple' : ''}#connections/webhooks`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (!options.held?.includes(LIST_WEBHOOKS)) await expect(webhookCard(page)).toBeVisible();
};
