/** D-339 slice 21 (D-339 §6; 2026-11-19, the owner: "do the smaller setup items") — connect Apple
 *  Health from a Body's page.
 *
 *  The guide's section 3 had the owner make the webhook by hand: Connections → Webhooks, Make a webhook, a name, the
 *  static header token, a header name and a token of their own, note the address, Let messages in; then install the
 *  pack and choose that webhook; then carry the address, the header, the token and the Body's id into the Shortcut.
 *  Here one step makes the webhook as Recued's own drives do (`scripts/drives/d-339-body-backfill-live.mjs`):
 *  - **"Apple Health on my iPhone"**, the static header token profile, the header `X-Recued-Token` and a token made
 *    on this device (32 random bytes, base64url), which the page shows once: the profile's token is the owner's
 *    (`source: 'owner'`), so the server cannot make one and never returns it.
 *  - **registered by hand** (the Shortcut is the sender, so there is nothing to register at), then **letting
 *    messages in**. When the server cannot take posts from a phone yet (no public https address, the path not
 *    public, the vault locked…), the webhook is still made, and its own readiness says why.
 *  - The pack's install then chooses it by itself: it is the only webhook that fits (`packs-panel.ts`,
 *    `webhookChoicesFor`). The install stays the owner's review, never done from here.
 *  A webhook half made (its keys missing: a locked vault) or not letting messages in is finished by the same step;
 *  one already letting messages in is left alone. The webhook is found again by its name and profile, newest first. */
import type { PacksListResult, WebhookIngressListResponse, WebhookIngressReadinessBlocker, WebhookIngressView } from '@recued/contracts';

export const APPLE_HEALTH_PACK = 'body-signals-apple-health';
export const APPLE_HEALTH_WEBHOOK_NAME = 'Apple Health on my iPhone';
export const APPLE_HEALTH_PROFILE = 'generic.static-header-token.v1';
export const APPLE_HEALTH_HEADER = 'X-Recued-Token';

export interface AppleHealthWebhook {
  ingress_id: string;
  /** Where the Shortcut posts; null while the server has no public https address. */
  address: string | null;
  /** It lets messages in now. */
  open: boolean;
  /** Its keys are written. */
  keyed: boolean;
  /** Why it cannot let messages in, by the server's names: only what the owner must mend elsewhere (a public https
   *  address, the vault…), never what this step does itself (its keys, its address confirmed). */
  blockers: readonly WebhookIngressReadinessBlocker[];
  /** When a post last came, if one has. */
  last_post_at: number | null;
}

export interface AppleHealthState {
  webhook?: AppleHealthWebhook;
  /** Body signals from Apple Health is installed. */
  installed: boolean;
}

export interface AppleHealthPrepared {
  webhook: AppleHealthWebhook;
  /** The token written now, shown this once; absent when the webhook already had its keys. */
  token?: string;
}

export interface AppleHealthConnect {
  state(): Promise<AppleHealthState>;
  /** Make the webhook, or finish the one found: its keys, its address confirmed, letting messages in. */
  prepare(existing?: string): Promise<AppleHealthPrepared>;
}

/** The calls it makes, all the owner's own over the pair connection. */
export type AppleHealthMethod = 'webhook.ingress.list' | 'webhook.ingress.get' | 'webhook.ingress.create' | 'webhook.ingress.credentials.write'
  | 'webhook.ingress.manual.confirm' | 'webhook.ingress.enable' | 'packs.list';
type Call = (method: AppleHealthMethod, params?: unknown) => Promise<unknown>;

/** 32 random bytes as base64url: 43 printable characters, well inside the profile's 8 KB. */
export const newWebhookToken = (fill: (bytes: Uint8Array) => Uint8Array = bytes => globalThis.crypto.getRandomValues(bytes)): string => {
  let text = '';
  for (const byte of fill(new Uint8Array(32))) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const OPEN_STATES = new Set<WebhookIngressView['intake_state']>(['enabled', 'degraded']);
/** What `prepare` mends itself, so never listed for the owner: the webhooks page words them for a sender the owner
 *  registers by hand ("Say you have set it up at the other service"), which a Shortcut is not. */
const MENDED_HERE = new Set<WebhookIngressReadinessBlocker>(['credentials_incomplete', 'registration_incomplete', 'registration_endpoint_changed']);

export const appleHealthWebhookOf = (ingress: WebhookIngressView): AppleHealthWebhook => ({
  ingress_id: ingress.ingress_id,
  address: ingress.endpoint_url,
  open: OPEN_STATES.has(ingress.intake_state),
  keyed: ingress.readiness.credentials_complete,
  blockers: ingress.readiness.blockers.filter(blocker => !MENDED_HERE.has(blocker)),
  last_post_at: ingress.health.last_delivery_at,
});

export const createAppleHealthConnect = ({ call, token = () => newWebhookToken() }: { call: Call; token?: () => string }): AppleHealthConnect => {
  const find = async (): Promise<WebhookIngressView | undefined> => {
    const { ingresses } = await call('webhook.ingress.list') as WebhookIngressListResponse;
    return ingresses.filter(row => row.profile_id === APPLE_HEALTH_PROFILE && row.display_name === APPLE_HEALTH_WEBHOOK_NAME && row.intake_state !== 'retired')
      .sort((a, b) => b.created_at - a.created_at)[0];
  };
  const read = async (ingress_id: string): Promise<WebhookIngressView> => {
    const { ingress } = await call('webhook.ingress.get', { ingress_id }) as { ingress: WebhookIngressView | null };
    if (!ingress) throw new Error('The webhook is gone. Open Connect Apple Health again');
    return ingress;
  };
  return {
    async state() {
      const [webhook, packs] = await Promise.all([find(), call('packs.list') as Promise<PacksListResult>]);
      return { ...(webhook ? { webhook: appleHealthWebhookOf(webhook) } : {}),
        installed: packs.packs.some(pack => pack.slug === APPLE_HEALTH_PACK && pack.installed) };
    },
    async prepare(existing) {
      let ingress = existing ? await read(existing) : (await call('webhook.ingress.create', { display_name: APPLE_HEALTH_WEBHOOK_NAME,
        profile_id: APPLE_HEALTH_PROFILE, environment: 'live', registration_mode: 'manual', selected_event_types: ['delivery'] }) as { ingress: WebhookIngressView }).ingress;
      let secret: string | undefined;
      if (!ingress.readiness.credentials_complete) {
        secret = token();
        ingress = (await call('webhook.ingress.credentials.write', { ingress_id: ingress.ingress_id,
          credentials: { header_name: APPLE_HEALTH_HEADER, header_token: secret } }) as { ingress: WebhookIngressView }).ingress;
      }
      // Confirming the address and letting messages in can each be refused while the server cannot take a post from
      // a phone; the webhook's readiness, read after, says why, so neither refusal stops the step.
      if (!ingress.readiness.registration_complete || ingress.readiness.blockers.includes('registration_endpoint_changed')) {
        await call('webhook.ingress.manual.confirm', { ingress_id: ingress.ingress_id }).catch(() => undefined);
      }
      if (!OPEN_STATES.has(ingress.intake_state)) await call('webhook.ingress.enable', { ingress_id: ingress.ingress_id }).catch(() => undefined);
      return { webhook: appleHealthWebhookOf(await read(ingress.ingress_id)), ...(secret ? { token: secret } : {}) };
    },
  };
};
