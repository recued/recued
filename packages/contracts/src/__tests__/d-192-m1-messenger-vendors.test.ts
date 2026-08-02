/** D-192 messenger flagship (M1) — the `MessengerVendorDeclaration` registry.
 *
 *  Locks the canonical-vocabulary half of the taxonomy §0 rule
 *  (D-192 §3a): the declaration shape + validator +
 *  registry + accessors mirroring `CONNECTION_VENDOR_ENTITIES`. Tests cover:
 *    - the shipped registry is well-formed (no dup vendor, every entry valid)
 *    - both vendors carry the substrate-grounded facets (Slack HMAC /
 *      `signing_secret` / `channel_id` string-only / `profile_email`; Telegram
 *      secret-token / `webhook_secret` / `chat_id` numeric-ok / `none`)
 *    - accessors (get / list / isDeclared), incl. the axis guard that `email`
 *      (a notification channel, a different axis) is NOT a declared chat transport
 *    - the per-entry reject matrix (bad slug / surfaces / ingress-conditional /
 *      recipient / identity / projection / auth)
 *    - `build*` throws on invalid; `assertMessengerVendorRegistry` catches dups
 *    - the socket-mode extension path validates when it omits verification
 *
 *  Spec: D-192 §3a (M-1). */

import { describe, expect, it } from 'vitest';

import {
  resolveMessengerConnectionRoles,
  resolveMessengerVendorRoles,
  MESSENGER_AUTH_KINDS,
  MESSENGER_AUTH_KIND_CONNECTION_TYPES,
  MESSENGER_INGRESS_MODES,
  MESSENGER_PLATFORM_ID_SOURCES,
  MESSENGER_PROBE_AUTH_PLACEMENTS,
  MESSENGER_PROBE_METHODS,
  MESSENGER_PROBE_TOKEN_PLACEHOLDER,
  MESSENGER_SURFACES,
  MESSENGER_VENDOR_DECLARATIONS,
  MESSENGER_VENDOR_SLUGS,
  MESSENGER_VERIFICATIONS,
  assertMessengerVendorDeclarationShape,
  assertMessengerVendorDeclarationValid,
  assertMessengerVendorRegistry,
  buildMessengerVendorDeclaration,
  getMessengerVendorDeclaration,
  messengerVendorSupportsIngressMode,
  resolveMessengerConnectionIngressMode,
  isDeclaredMessengerVendor,
  listMessengerVendors,
  resolveBearerAccessToken,
  resolveMessengerSendToken,
  type ConnectionAuth,
  type MessengerHealthProbe,
  type MessengerVendorDeclaration,
} from '../index.js';

/** A minimal well-formed declaration for reject-matrix mutation.
 *
 *  ⚠ Named `testvendor`, not after a real one. This fixture WAS `discord`, and the
 *  day Discord shipped it started colliding with a live declaration — a synthetic
 *  fixture must be synthetic, or it inherits the vendor's future. Same trap as the
 *  `undeclared vendor` fixtures, from the other end. */
const validEntry = (): MessengerVendorDeclaration => ({
  vendor: 'testvendor',
  display_name: 'Test Vendor',
  surfaces: ['dm', 'channel'],
  ingress: {
    mode: 'webhook',
    supported_modes: ['webhook'],
    verification: 'hmac',
    secret_field: 'signing_secret',
    id_field: 'event_id',
  },
  recipient: { field: 'channel_id', numeric_ok: false },
  identity: { platform_id_source: 'profile_email' },
  projection: { structured_tags: false, structured_mentions: false },
  auth: 'bot_token',
  roles: { notification: true, approval: true, messenger: true },
  health_probe: {
    url: 'https://test.invalid/me',
    method: 'GET',
    auth: 'bearer_header',
  },
});

/** Mutate just the health_probe facet, keeping the rest of the entry valid. */
const withProbe = (probe: unknown): unknown => ({ ...validEntry(), health_probe: probe });

/** The health_probe issues from an otherwise-valid entry (the facet-level issue
 *  reads `field 'health_probe' …`, the field-level ones `health_probe.<f> …`). */
const probeIssues = (probe: unknown): string[] =>
  assertMessengerVendorDeclarationShape(withProbe(probe)).filter((i) => i.includes('health_probe'));

describe('D-192 M1 — MessengerVendorDeclaration registry', () => {
  describe('the shipped registry', () => {
    it('is well-formed (every entry valid, no duplicate vendor)', () => {
      expect(assertMessengerVendorRegistry(MESSENGER_VENDOR_DECLARATIONS)).toEqual([]);
    });

    it('declares exactly the shipped chat transports', () => {
      // A deliberate literal ratchet — this one SHOULD fail when a vendor ships.
      // "Who can Recued talk through" is a fact worth stating out loud rather than
      // deriving away. Contrast the `undeclared vendor` fixture below, which named
      // `whatsapp` and quietly became WRONG the day WhatsApp landed: a fixture
      // whose meaning is "a vendor we haven't built yet" has an expiry date.
      expect(listMessengerVendors()).toEqual(['slack', 'telegram', 'whatsapp', 'discord']);
    });

    it('grounds Slack in the live substrate (HMAC / signing_secret / string channel_id / profile_email)', () => {
      const slack = getMessengerVendorDeclaration('slack');
      expect(slack).not.toBeNull();
      expect(slack).toMatchObject({
        vendor: 'slack',
        display_name: 'Slack',
        ingress: {
          mode: 'socket',
          supported_modes: ['socket', 'webhook'],
          verification: 'hmac',
          secret_field: 'signing_secret',
        },
        recipient: { field: 'channel_id', numeric_ok: false },
        identity: { platform_id_source: 'profile_email' },
        auth: 'bot_token',
      });
      expect(slack?.surfaces).toEqual(['dm', 'group', 'channel', 'thread']);
    });

    it('grounds Telegram in the live substrate (secret-token / webhook_secret / numeric chat_id / no email)', () => {
      const telegram = getMessengerVendorDeclaration('telegram');
      expect(telegram).not.toBeNull();
      expect(telegram).toMatchObject({
        vendor: 'telegram',
        display_name: 'Telegram',
        ingress: {
          mode: 'poll',
          supported_modes: ['poll', 'webhook'],
          verification: 'secret_token',
          secret_field: 'webhook_secret',
        },
        recipient: { field: 'chat_id', numeric_ok: true },
        // Telegram exposes no email — the M1 link writer is a structural no-op.
        identity: { platform_id_source: 'none' },
        auth: 'bot_token',
      });
    });

    it('exposes the closed vocabularies', () => {
      expect(MESSENGER_SURFACES).toEqual(['dm', 'group', 'channel', 'thread']);
      expect(MESSENGER_INGRESS_MODES).toEqual(['webhook', 'socket', 'poll']);
      // `ed25519` is Discord's — the first ASYMMETRIC scheme, whose verification
      // material is a PUBLIC key rather than a shared secret.
      expect(MESSENGER_VERIFICATIONS).toEqual(['hmac', 'secret_token', 'ed25519']);
      expect(MESSENGER_PLATFORM_ID_SOURCES).toEqual(['profile_email', 'none']);
      expect(MESSENGER_AUTH_KINDS).toEqual(['bot_token', 'oauth', 'cloud_api']);
      expect(MESSENGER_PROBE_METHODS).toEqual(['GET', 'POST']);
      // `bot_header` is Discord's, and differs from `bearer_header` by ONE word —
      // which is load-bearing: Discord reads `Bearer` as an OAuth2 user token.
      expect(MESSENGER_PROBE_AUTH_PLACEMENTS).toEqual([
        'bearer_header',
        'url_token',
        'bot_header',
      ]);
    });

    // Seam 8 — these two facets ARE the former `probeNotification`
    // `case 'slack'` / `case 'telegram'` arms, transcribed. If either drifts
    // from the vendor's real endpoint, connection health silently lies.
    it("grounds Slack's health probe in `auth.test` (POST + bearer header, no URL token)", () => {
      expect(getMessengerVendorDeclaration('slack')?.health_probe).toEqual({
        url: 'https://slack.com/api/auth.test',
        method: 'POST',
        auth: 'bearer_header',
      });
    });

    it("grounds Telegram's health probe in `getMe` (GET + the token IN the path, no header)", () => {
      const probe = getMessengerVendorDeclaration('telegram')?.health_probe;
      expect(probe).toEqual({
        url: 'https://api.telegram.org/bot{token}/getMe',
        method: 'GET',
        auth: 'url_token',
      });
      // The placeholder is the substitution contract the prober relies on.
      expect(probe?.url).toContain(MESSENGER_PROBE_TOKEN_PLACEHOLDER);
    });

    it('declares a health probe for EVERY vendor (an unprobeable vendor would report `unknown` forever)', () => {
      for (const vendor of listMessengerVendors()) {
        expect(getMessengerVendorDeclaration(vendor)?.health_probe).toBeDefined();
      }
    });
  });

  describe('accessors', () => {
    it('getMessengerVendorDeclaration returns null for an undeclared vendor', () => {
      // The fixture SELF-CHECKS. This test used to hand it the literal `whatsapp`
      // — a vendor that did not exist yet — and the day WhatsApp shipped it stopped
      // testing "an undeclared vendor" and started asserting something false. Name
      // a slug that can never BE a chat transport, and prove it is undeclared
      // rather than assuming it.
      const undeclared = 'not_a_transport';
      expect([...MESSENGER_VENDOR_SLUGS]).not.toContain(undeclared);
      expect(getMessengerVendorDeclaration(undeclared)).toBeNull();
    });

    it('isDeclaredMessengerVendor narrows known slugs', () => {
      // Every DECLARED slug narrows — iterated, so a new vendor is covered here
      // for free rather than needing a line added beside slack/telegram.
      for (const slug of MESSENGER_VENDOR_SLUGS) {
        expect(isDeclaredMessengerVendor(slug)).toBe(true);
      }
      expect(isDeclaredMessengerVendor('not_a_transport')).toBe(false);
      expect(isDeclaredMessengerVendor(42)).toBe(false);
      expect(isDeclaredMessengerVendor(null)).toBe(false);
      expect(isDeclaredMessengerVendor(undefined)).toBe(false);
    });

    it("does NOT declare `email` — a notification channel is a different axis, not a chat transport", () => {
      expect(isDeclaredMessengerVendor('email')).toBe(false);
      expect(getMessengerVendorDeclaration('email')).toBeNull();
    });

    it('accepts a caller-supplied registry (defaulted param)', () => {
      const custom = [validEntry()];
      expect(listMessengerVendors(custom)).toEqual(['testvendor']);
      expect(getMessengerVendorDeclaration('testvendor', custom)?.vendor).toBe('testvendor');
      expect(getMessengerVendorDeclaration('slack', custom)).toBeNull();
    });

    it('resolves explicit modes and preserves webhook for rows predating ingress_mode', () => {
      const slack = getMessengerVendorDeclaration('slack')!;
      expect(messengerVendorSupportsIngressMode(slack, 'socket')).toBe(true);
      expect(messengerVendorSupportsIngressMode(slack, 'poll')).toBe(false);
      expect(resolveMessengerConnectionIngressMode(slack, {})).toBe('webhook');
      expect(resolveMessengerConnectionIngressMode(slack, { ingress_mode: 'socket' })).toBe('socket');
      expect(resolveMessengerConnectionIngressMode(slack, { ingress_mode: 'poll' })).toBeNull();
    });
  });

  describe('per-entry shape validation', () => {
    it('accepts a well-formed entry', () => {
      expect(assertMessengerVendorDeclarationShape(validEntry())).toEqual([]);
    });

    it('rejects a non-object', () => {
      expect(assertMessengerVendorDeclarationShape(null)).toEqual(['expected object']);
      expect(assertMessengerVendorDeclarationShape('slack')).toEqual(['expected object']);
      expect(assertMessengerVendorDeclarationShape([])).toEqual(['expected object']);
    });

    it('rejects a malformed vendor slug', () => {
      for (const bad of ['Slack', '1slack', 'sla-ck', '', 'slack ']) {
        const issues = assertMessengerVendorDeclarationShape({ ...validEntry(), vendor: bad });
        expect(issues.some((i) => i.includes("field 'vendor'"))).toBe(true);
      }
    });

    it('rejects an empty display_name', () => {
      const issues = assertMessengerVendorDeclarationShape({ ...validEntry(), display_name: '' });
      expect(issues.some((i) => i.includes("field 'display_name'"))).toBe(true);
    });

    it('rejects empty / non-array / unknown / duplicate surfaces', () => {
      expect(
        assertMessengerVendorDeclarationShape({ ...validEntry(), surfaces: [] }).some((i) =>
          i.includes("field 'surfaces'"),
        ),
      ).toBe(true);
      expect(
        assertMessengerVendorDeclarationShape({ ...validEntry(), surfaces: 'dm' }).some((i) =>
          i.includes("field 'surfaces'"),
        ),
      ).toBe(true);
      expect(
        assertMessengerVendorDeclarationShape({ ...validEntry(), surfaces: ['dm', 'inbox'] }).some(
          (i) => i.includes('surfaces[1]'),
        ),
      ).toBe(true);
      expect(
        assertMessengerVendorDeclarationShape({ ...validEntry(), surfaces: ['dm', 'dm'] }).some((i) =>
          i.includes('duplicate'),
        ),
      ).toBe(true);
    });

    it('rejects a bad ingress object / mode', () => {
      expect(
        assertMessengerVendorDeclarationShape({ ...validEntry(), ingress: null }).some((i) =>
          i.includes("field 'ingress'"),
        ),
      ).toBe(true);
      expect(
        assertMessengerVendorDeclarationShape({
          ...validEntry(),
          ingress: { mode: 'carrier_pigeon', supported_modes: ['webhook'], id_field: 'id' },
        }).some((i) => i.includes('ingress.mode')),
      ).toBe(true);
    });

    it('requires verification + secret_field when ingress.mode is webhook', () => {
      const noVerify = assertMessengerVendorDeclarationShape({
        ...validEntry(),
        ingress: { mode: 'webhook', supported_modes: ['webhook'], secret_field: 'signing_secret', id_field: 'id' },
      });
      expect(noVerify.some((i) => i.includes('ingress.verification'))).toBe(true);

      const noSecret = assertMessengerVendorDeclarationShape({
        ...validEntry(),
        ingress: { mode: 'webhook', supported_modes: ['webhook'], verification: 'hmac', id_field: 'id' },
      });
      expect(noSecret.some((i) => i.includes('ingress.secret_field'))).toBe(true);

      const badVerify = assertMessengerVendorDeclarationShape({
        ...validEntry(),
        ingress: { mode: 'webhook', supported_modes: ['webhook'], verification: 'md5', secret_field: 's', id_field: 'id' },
      });
      expect(badVerify.some((i) => i.includes('ingress.verification'))).toBe(true);
    });

    it('allows a socket-mode entry that omits verification + secret_field (the extension path)', () => {
      const socket = assertMessengerVendorDeclarationShape({
        ...validEntry(),
        ingress: { mode: 'socket', supported_modes: ['socket'], id_field: 'event_id' },
      });
      expect(socket).toEqual([]);
    });

    it('rejects verification / secret_field on a non-webhook mode', () => {
      const issues = assertMessengerVendorDeclarationShape({
        ...validEntry(),
        ingress: { mode: 'poll', supported_modes: ['poll'], verification: 'hmac', secret_field: 's', id_field: 'id' },
      });
      expect(issues.some((i) => i.includes('only valid when webhook is supported'))).toBe(true);
    });

    it('rejects a bad recipient', () => {
      expect(
        assertMessengerVendorDeclarationShape({
          ...validEntry(),
          recipient: { field: '', numeric_ok: false },
        }).some((i) => i.includes('recipient.field')),
      ).toBe(true);
      expect(
        assertMessengerVendorDeclarationShape({
          ...validEntry(),
          recipient: { field: 'chat_id', numeric_ok: 'yes' },
        }).some((i) => i.includes('recipient.numeric_ok')),
      ).toBe(true);
    });

    it('rejects a bad identity.platform_id_source', () => {
      const issues = assertMessengerVendorDeclarationShape({
        ...validEntry(),
        identity: { platform_id_source: 'ldap' },
      });
      expect(issues.some((i) => i.includes('identity.platform_id_source'))).toBe(true);
    });

    it('rejects a non-boolean projection flag', () => {
      const issues = assertMessengerVendorDeclarationShape({
        ...validEntry(),
        projection: { structured_tags: 'no', structured_mentions: false },
      });
      expect(issues.some((i) => i.includes('projection.structured_tags'))).toBe(true);
    });

    it('rejects a bad auth kind', () => {
      const issues = assertMessengerVendorDeclarationShape({ ...validEntry(), auth: 'api_key' });
      expect(issues.some((i) => i.includes("field 'auth'"))).toBe(true);
    });

    it('accumulates multiple issues on a thoroughly broken entry', () => {
      const issues = assertMessengerVendorDeclarationShape({
        vendor: 'BAD',
        display_name: '',
        surfaces: [],
        ingress: { mode: 'nope' },
        recipient: {},
        identity: {},
        projection: {},
        auth: 'x',
      });
      expect(issues.length).toBeGreaterThan(4);
    });
  });

  // Seam 8 — the probe carries the vendor's bot credential (in a header, or in
  // the URL path itself), so the validator is the thing standing between a
  // fat-fingered entry and a leaked / unauthenticated probe.
  describe('health_probe validation', () => {
    it('accepts a well-formed probe of either placement', () => {
      expect(probeIssues({
        url: 'https://slack.com/api/auth.test',
        method: 'POST',
        auth: 'bearer_header',
      })).toEqual([]);
      expect(probeIssues({
        url: 'https://api.telegram.org/bot{token}/getMe',
        method: 'GET',
        auth: 'url_token',
      })).toEqual([]);
    });

    it('requires the facet (a missing probe is not a silent `unknown`, it is a boot failure)', () => {
      const { health_probe: _dropped, ...without } = validEntry();
      const issues = assertMessengerVendorDeclarationShape(without);
      expect(issues.some((i) => i.includes("field 'health_probe'"))).toBe(true);
      expect(() => buildMessengerVendorDeclaration(without as MessengerVendorDeclaration)).toThrow(
        /health_probe/,
      );
    });

    it('rejects a non-object / empty url / bad method / bad placement', () => {
      expect(probeIssues(null).some((i) => i.includes('must be an object'))).toBe(true);
      expect(probeIssues({ ...validEntry().health_probe, url: '' }).some((i) =>
        i.includes('health_probe.url must be a non-empty string'),
      )).toBe(true);
      expect(probeIssues({ ...validEntry().health_probe, method: 'DELETE' }).some((i) =>
        i.includes('health_probe.method'),
      )).toBe(true);
      expect(probeIssues({ ...validEntry().health_probe, auth: 'query_param' }).some((i) =>
        i.includes('health_probe.auth'),
      )).toBe(true);
    });

    it('rejects a non-absolute or plaintext-http probe url (it carries the credential)', () => {
      expect(probeIssues({ ...validEntry().health_probe, url: '/api/users/@me' }).some((i) =>
        i.includes('absolute URL'),
      )).toBe(true);
      expect(probeIssues({
        url: 'http://discord.com/api/v10/users/@me',
        method: 'GET',
        auth: 'bearer_header',
      }).some((i) => i.includes('https'))).toBe(true);
    });

    // The biconditional, both ways — each direction is a real, silent bug.
    it('rejects a url_token placement whose url has no {token} placeholder (would probe unauthenticated)', () => {
      const issues = probeIssues({
        url: 'https://api.telegram.org/bot/getMe',
        method: 'GET',
        auth: 'url_token',
      });
      expect(issues.some((i) => i.includes('must contain the {token} placeholder'))).toBe(true);
    });

    it('rejects a bearer_header placement whose url HAS a {token} placeholder (would ship the literal)', () => {
      const issues = probeIssues({
        url: 'https://slack.com/api/{token}/auth.test',
        method: 'POST',
        auth: 'bearer_header',
      });
      expect(issues.some((i) => i.includes('must not contain the {token} placeholder'))).toBe(true);
    });

    it('is enforced at build time, so a bad entry fails at module load', () => {
      const bad: MessengerHealthProbe = {
        url: 'https://api.telegram.org/botX/getMe',
        method: 'GET',
        auth: 'url_token',
      };
      expect(() =>
        buildMessengerVendorDeclaration({ ...validEntry(), health_probe: bad }),
      ).toThrow(/health_probe\.url/);
    });
  });

  describe('build + registry validators', () => {
    it('buildMessengerVendorDeclaration throws on an invalid entry', () => {
      expect(() =>
        buildMessengerVendorDeclaration({ ...validEntry(), vendor: 'BAD' }),
      ).toThrow(/invalid MessengerVendorDeclaration/);
    });

    it('buildMessengerVendorDeclaration returns a valid entry unchanged', () => {
      const entry = validEntry();
      expect(buildMessengerVendorDeclaration(entry)).toBe(entry);
    });

    it('assertMessengerVendorDeclarationValid throws with the joined issues', () => {
      expect(() =>
        assertMessengerVendorDeclarationValid({ ...validEntry(), auth: 'x' } as unknown as MessengerVendorDeclaration),
      ).toThrow(/field 'auth'/);
    });

    it('assertMessengerVendorRegistry catches a duplicate vendor slug', () => {
      const dup = [validEntry(), validEntry()];
      const issues = assertMessengerVendorRegistry(dup);
      expect(issues.some((i) => i.includes("duplicate vendor 'testvendor'"))).toBe(true);
    });

    it('assertMessengerVendorRegistry prefixes per-entry issues with the index', () => {
      const registry = [validEntry(), { ...validEntry(), vendor: 'BAD' }];
      const issues = assertMessengerVendorRegistry(registry as MessengerVendorDeclaration[]);
      expect(issues.some((i) => i.startsWith('[1] ') && i.includes("field 'vendor'"))).toBe(true);
    });
  });

  /** D-192 CORE #6 make-live — credential DELIVERABILITY.
   *
   *  The registry declares an auth KIND (`bot_token` / `oauth` / `cloud_api`);
   *  the connection row stores an auth SHAPE (`bearer` / `oauth2_refresh` / …).
   *  Nothing bridged the two, so `oauth` was a declared, probe-supported auth kind
   *  that could never actually deliver a message — and nothing anywhere said so.
   *  `MESSENGER_AUTH_KIND_CONNECTION_TYPES` is that bridge and the single
   *  authority; these lock it. */
  describe('credential deliverability (make-live)', () => {
    const oauthRefresh: ConnectionAuth = {
      type: 'oauth2_refresh',
      refresh_token: 'rt',
      client_id: 'cid',
      token_endpoint: 'https://example.test/token',
      current_access_token: 'looks-perfectly-healthy',
    };

    it('every declared vendor names an auth kind the send path can deliver', () => {
      // The invariant the registry's boot check enforces by throwing. Asserted
      // here too, because a boot check only fires for the CURRENT registry — this
      // states the rule a new vendor has to satisfy.
      for (const entry of MESSENGER_VENDOR_DECLARATIONS) {
        expect(MESSENGER_AUTH_KIND_CONNECTION_TYPES[entry.auth].length).toBeGreaterThan(0);
      }
    });

    it('every shape the map permits is one the send seam actually resolves', () => {
      // The RELATIONSHIP, not a literal. The map (which the enroll gate reads) and
      // the seam (which the send path reads) are two halves of one fact; a map
      // entry naming a shape the seam returns undefined for would re-open the exact
      // hole this closes — enrollable, and still mute.
      for (const types of Object.values(MESSENGER_AUTH_KIND_CONNECTION_TYPES)) {
        for (const type of types) {
          const auth = (type === 'bearer'
            ? { type: 'bearer', token: 'tok' }
            : oauthRefresh) as ConnectionAuth;
          expect(resolveMessengerSendToken(auth)).toBeDefined();
        }
      }
    });

    it('resolves a bearer bot token, and refuses a blank one', () => {
      expect(resolveMessengerSendToken({ type: 'bearer', token: 'xoxb-real' })).toBe('xoxb-real');
      expect(resolveMessengerSendToken({ type: 'bearer', token: '' })).toBeUndefined();
    });

    it('refuses every shape a chat transport cannot send with', () => {
      const undeliverable: ConnectionAuth[] = [
        { type: 'none' },
        { type: 'basic', username: 'u', password: 'p' },
        { type: 'header', headers: [{ header_name: 'X-Key', value: 'v' }] },
        { type: 'query', param_name: 'k', value: 'v' },
      ];
      for (const auth of undeliverable) {
        expect(resolveMessengerSendToken(auth)).toBeUndefined();
      }
    });

    it('diverges from resolveBearerAccessToken on oauth2_refresh — and THAT was the bug', () => {
      // This one assertion IS the defect, in two lines. The health probe reads the
      // credential through `resolveBearerAccessToken`, which happily hands back
      // `current_access_token` — so an oauth2_refresh chat-transport row probed
      // GREEN. The send path could not use it and dropped every message in silence.
      // Green, ready, and mute. The two seams are SUPPOSED to disagree here, and
      // the enroll gate is what makes the disagreement unreachable rather than fatal.
      expect(resolveBearerAccessToken(oauthRefresh)).toBe('looks-perfectly-healthy');
      expect(resolveMessengerSendToken(oauthRefresh)).toBeUndefined();
    });

    it('is not wired for oauth — deliberately, and the map says so out loud', () => {
      // Not an oversight to be "fixed" by adding 'oauth2_refresh' here. Wiring oauth
      // needs a notification-kind token refresher (both refreshers are hard-scoped
      // to kind: 'api') and an enroll card carrying the OAuth fields. Until then the
      // empty list is what keeps the boot check honest.
      expect(MESSENGER_AUTH_KIND_CONNECTION_TYPES.oauth).toEqual([]);
    });
  });

  describe('per-mode role narrowing', () => {
    const discord = getMessengerVendorDeclaration('discord')!;

    it('resolves Discord conversational on Gateway and notify+approve on webhook', () => {
      expect(resolveMessengerVendorRoles(discord, 'socket')).toEqual({
        notification: true,
        approval: true,
        messenger: true,
      });
      expect(resolveMessengerVendorRoles(discord, 'webhook')).toEqual({
        notification: true,
        approval: true,
        messenger: false,
      });
    });

    it('falls to the floor when the mode is unknown', () => {
      // An unresolvable mode is not evidence of a capability. The floor is what
      // holds in EVERY supported mode, so the narrowed axis goes off.
      expect(resolveMessengerVendorRoles(discord, null).messenger).toBe(false);
      expect(resolveMessengerVendorRoles(discord, null).approval).toBe(true);
    });

    it('resolves a stored row through its config, defaulting legacy rows to webhook', () => {
      expect(resolveMessengerConnectionRoles(discord, { ingress_mode: 'socket' }).messenger)
        .toBe(true);
      expect(resolveMessengerConnectionRoles(discord, { ingress_mode: 'webhook' }).messenger)
        .toBe(false);
      // Pre-upgrade row: no `ingress_mode` resolves to webhook, so it keeps the
      // notify+approve shape Discord actually shipped with.
      expect(resolveMessengerConnectionRoles(discord, {}).messenger).toBe(false);
      // An explicit BAD value resolves to null upstream ⇒ floor, not ceiling.
      expect(resolveMessengerConnectionRoles(discord, { ingress_mode: 'nonsense' }).messenger)
        .toBe(false);
    });

    it('leaves every vendor whose roles do not move untouched', () => {
      // The invariant that keeps this facet honest: Discord is the ONLY entry
      // that narrows. A future vendor adding one has to come through here.
      const narrowing = MESSENGER_VENDOR_DECLARATIONS
        .filter((d) => d.ingress.mode_roles !== undefined)
        .map((d) => d.vendor);
      expect(narrowing).toEqual(['discord']);
      for (const declaration of MESSENGER_VENDOR_DECLARATIONS) {
        if (declaration.ingress.mode_roles !== undefined) continue;
        for (const mode of declaration.ingress.supported_modes) {
          expect(resolveMessengerVendorRoles(declaration, mode)).toEqual(declaration.roles);
        }
      }
    });

    it('refuses a mode_roles entry that grants, repeats, or empties a role', () => {
      const base = MESSENGER_VENDOR_DECLARATIONS.find((d) => d.vendor === 'discord')!;
      const withOverride = (mode_roles: unknown): unknown =>
        ({ ...base, ingress: { ...base.ingress, mode_roles } });

      // Granting a role the vendor does not declare would make `roles` stop
      // being the answer to "can this channel do X".
      expect(assertMessengerVendorDeclarationShape(
        withOverride({ webhook: { messenger: true } }),
      )).toContainEqual(expect.stringContaining('repeats the ceiling'));
      // A mode outside supported_modes is dead configuration.
      expect(assertMessengerVendorDeclarationShape(
        withOverride({ poll: { messenger: false } }),
      )).toContainEqual(expect.stringContaining('not one of ingress.supported_modes'));
      // An empty override reads as intent that is not there.
      expect(assertMessengerVendorDeclarationShape(
        withOverride({ webhook: {} }),
      )).toContainEqual(expect.stringContaining('declares no narrowing'));
      // A mode that gives up everything is an inert mode.
      expect(assertMessengerVendorDeclarationShape(
        withOverride({ webhook: { notification: false, approval: false, messenger: false } }),
      )).toContainEqual(expect.stringContaining('no role at all'));
      // ...and the shipped declaration itself is clean.
      expect(assertMessengerVendorDeclarationShape(base)).toEqual([]);
    });
  });
});
