import { describe, expect, it } from 'vitest';
import {
  buildOpenerRelayRedirectUri,
  type OAuthAppConfigSnapshot,
  type OAuthAppConfigStatus,
} from '@recued/contracts';
import { e } from '../template.js';

import {
  ACCOUNT_LANES,
  ACCOUNT_SLUG_REGEX,
  findAccountLane,
  findAccountProvider,
  initialAccountsPanelState,
  isOAuthAccountTransport,
  renderAccountsPanel,
  seedAccountFormValues,
  splitAccountList,
  validateAccountForm,
  type AccountFormValues,
  type AccountLaneId,
  type AccountProvider,
  type AccountsPanelState,
} from '../accounts/page.js';

const imap = (): AccountProvider =>
  findAccountProvider(findAccountLane('mail')!, 'imap')!;
const fs = (): AccountProvider =>
  findAccountProvider(findAccountLane('file')!, 'fs')!;
const s3 = (): AccountProvider =>
  findAccountProvider(findAccountLane('file')!, 's3')!;

const withSeed = (
  p: AccountProvider,
  over: AccountFormValues,
): AccountFormValues => ({ ...seedAccountFormValues(p), ...over });

describe('ACCOUNT_LANES structure', () => {
  it('exposes the four-lane top split with the locked providers', () => {
    expect(ACCOUNT_LANES.map((l) => l.id)).toEqual(['mail', 'calendar', 'file']);
    // Mail = IMAP + Gmail/Microsoft OAuth (Slice 2c); Calendar = none yet
    // (pending); Files = fs + s3 (no ext-downloads in the manual picker).
    expect(findAccountLane('mail')!.providers.map((p) => p.id)).toEqual([
      'imap',
      'gmail',
      'graph',
    ]);
    expect(findAccountLane('mail')!.pending).toBeUndefined();
    // Calendar = Google + Microsoft OAuth + CalDAV (Slice 2d).
    expect(findAccountLane('calendar')!.providers.map((p) => p.id)).toEqual([
      'gcal',
      'graph',
      'caldav',
    ]);
    expect(findAccountLane('calendar')!.pending).toBeUndefined();
    expect(findAccountLane('file')!.providers.map((p) => p.id)).toEqual(['fs', 's3']);
  });

  it('isOAuthAccountTransport flags only the OAuth transports', () => {
    expect(isOAuthAccountTransport('mail-oauth')).toBe(true);
    expect(isOAuthAccountTransport('mail-imap')).toBe(false);
    expect(isOAuthAccountTransport('file-enroll')).toBe(false);
  });

  it('seeds boolean / port / folder defaults', () => {
    const seeded = seedAccountFormValues(imap());
    expect(seeded['port']).toBe('993');
    expect(seeded['secure']).toBe('true');
    expect(seeded['folders']).toBe('INBOX');
    // No default for an un-seeded text field.
    expect(seeded['host']).toBeUndefined();
  });
});

describe('validateAccountForm', () => {
  it('passes a complete IMAP form', () => {
    const v = withSeed(imap(), {
      name: 'fastmail',
      host: 'imap.fastmail.com',
      username: 'me@fastmail.com',
      password: 'pw',
    });
    expect(validateAccountForm(imap(), v)).toBeNull();
  });

  it('rejects a missing required field', () => {
    const v = withSeed(imap(), { name: 'fastmail', username: 'u', password: 'p' });
    expect(validateAccountForm(imap(), v)).toMatch(/IMAP Host is required/);
  });

  it('rejects an invalid slug', () => {
    const v = withSeed(imap(), {
      name: 'Bad Name',
      host: 'h',
      username: 'u',
      password: 'p',
    });
    expect(validateAccountForm(imap(), v)).toMatch(/lowercase/);
  });

  it('rejects an out-of-range port', () => {
    const v = withSeed(imap(), {
      name: 'm',
      host: 'h',
      username: 'u',
      password: 'p',
      port: '70000',
    });
    expect(validateAccountForm(imap(), v)).toMatch(/between 1 and 65535/);
  });

  it('rejects a non-integer port', () => {
    const v = withSeed(imap(), {
      name: 'm',
      host: 'h',
      username: 'u',
      password: 'p',
      port: 'abc',
    });
    expect(validateAccountForm(imap(), v)).toMatch(/whole number/);
  });

  it('rejects blank folders as required', () => {
    const v = withSeed(imap(), {
      name: 'm',
      host: 'h',
      username: 'u',
      password: 'p',
      folders: '   ',
    });
    expect(validateAccountForm(imap(), v)).toMatch(/Folders is required/);
  });

  it('rejects a non-blank folders value that splits to zero entries', () => {
    const v = withSeed(imap(), {
      name: 'm',
      host: 'h',
      username: 'u',
      password: 'p',
      folders: ',,',
    });
    expect(validateAccountForm(imap(), v)).toMatch(/at least one entry/);
  });

  it('requires SMTP Host when any SMTP sibling is filled (Codex MED-1)', () => {
    const base = withSeed(imap(), {
      name: 'm',
      host: 'h',
      username: 'u',
      password: 'p',
    });
    // The seeded smtp_secure toggle alone does NOT trip the rule.
    expect(validateAccountForm(imap(), base)).toBeNull();
    expect(
      validateAccountForm(imap(), { ...base, smtp_password: 'sp' }),
    ).toMatch(/SMTP Host is required/);
    expect(
      validateAccountForm(imap(), { ...base, smtp_from: 'me@x.com' }),
    ).toMatch(/SMTP Host is required/);
    // With the host, a filled sibling is fine.
    expect(
      validateAccountForm(imap(), { ...base, smtp_host: 's', smtp_password: 'sp' }),
    ).toBeNull();
  });

  it('passes fs + s3 with required config', () => {
    expect(
      validateAccountForm(fs(), { slug: 'docs', path: '/srv/docs' }),
    ).toBeNull();
    expect(
      validateAccountForm(s3(), {
        slug: 'arc',
        bucket: 'b',
        region: 'us-east-1',
        access_key: 'AK',
        secret_key: 'SK',
      }),
    ).toBeNull();
  });
});

describe('splitAccountList', () => {
  it('splits on commas and newlines, trimming + dropping empties', () => {
    expect(splitAccountList('INBOX, Sent ,, \nArchive')).toEqual([
      'INBOX',
      'Sent',
      'Archive',
    ]);
    expect(splitAccountList('')).toEqual([]);
    expect(splitAccountList(undefined)).toEqual([]);
  });
});

describe('ACCOUNT_SLUG_REGEX', () => {
  it('accepts the server slug grammar and rejects others', () => {
    expect(ACCOUNT_SLUG_REGEX.test('fastmail')).toBe(true);
    expect(ACCOUNT_SLUG_REGEX.test('hub-sandbox_2')).toBe(true);
    expect(ACCOUNT_SLUG_REGEX.test('-bad')).toBe(false);
    expect(ACCOUNT_SLUG_REGEX.test('Bad')).toBe(false);
    expect(ACCOUNT_SLUG_REGEX.test('a'.repeat(65))).toBe(false);
  });
});

describe('project()', () => {
  it('IMAP coerces types + omits the smtp block when host is blank', () => {
    const out = imap().project(
      withSeed(imap(), {
        name: 'fastmail',
        host: 'imap.fastmail.com',
        username: 'me@fastmail.com',
        password: 'pw',
        port: '993',
        secure: 'true',
        folders: 'INBOX, Sent',
      }),
    );
    expect(out).toEqual({
      name: 'fastmail',
      host: 'imap.fastmail.com',
      port: 993,
      secure: true,
      username: 'me@fastmail.com',
      password: 'pw',
      folders: ['INBOX', 'Sent'],
    });
    expect('smtp' in out).toBe(false);
  });

  it('IMAP builds the smtp block (send-capable) when host is set', () => {
    const out = imap().project(
      withSeed(imap(), {
        name: 'm',
        host: 'h',
        username: 'u',
        password: 'p',
        smtp_host: 'smtp.x.com',
        smtp_port: '465',
        smtp_secure: 'false',
        smtp_password: 'sp',
      }),
    );
    expect(out['smtp']).toEqual({
      host: 'smtp.x.com',
      port: 465,
      secure: false,
      password: 'sp',
    });
  });

  it('fs projects an adapter_type + config.path', () => {
    expect(fs().project({ slug: 'docs', path: '/srv/docs' })).toEqual({
      slug: 'docs',
      adapter_type: 'fs',
      config: { path: '/srv/docs' },
    });
  });

  it('s3 projects required keys + only the supplied optionals', () => {
    const minimal = s3().project({
      slug: 'arc',
      bucket: 'b',
      region: 'us-east-1',
      access_key: 'AK',
      secret_key: 'SK',
    });
    expect(minimal).toEqual({
      slug: 'arc',
      adapter_type: 's3',
      config: { access_key: 'AK', secret_key: 'SK', region: 'us-east-1', bucket: 'b' },
    });
    const full = s3().project(
      withSeed(s3(), {
        slug: 'arc',
        bucket: 'b',
        region: 'auto',
        access_key: 'AK',
        secret_key: 'SK',
        endpoint: 'https://x.r2.cloudflarestorage.com',
        use_path_style: 'true',
      }),
    );
    expect((full['config'] as Record<string, unknown>)['endpoint']).toBe(
      'https://x.r2.cloudflarestorage.com',
    );
    expect((full['config'] as Record<string, unknown>)['use_path_style']).toBe(true);
  });
});

describe('renderAccountsPanel', () => {
  const base = (over: Partial<AccountsPanelState> = {}): AccountsPanelState => ({
    ...initialAccountsPanelState('mail'),
    loading: false,
    ...over,
  });

  it('renders the list stage with an Add button + no tab bar', () => {
    const html = renderAccountsPanel({ state: base({ rows: [] }) });
    expect(html).toContain('data-accounts-lane="mail"');
    expect(html).toContain('data-action="accounts-open-add"');
    // Mail OAuth is buildable now (Slice 2c) — no pending note.
    expect(html).not.toContain('Gmail and Microsoft');
    // The unified tab bar lives in the route, not this panel.
    expect(html).not.toContain('accounts-pick-lane');
  });

  it('renders a lane pending note when one is set (file)', () => {
    const html = renderAccountsPanel({ state: base({ rows: [], lane: 'file' }) });
    expect(html).toContain('Google Drive'); // file lane pending note
  });

  it('renders a row with provider badge + status + escapes the slug', () => {
    const html = renderAccountsPanel({
      state: base({
        rows: [
          {
            slug: 'fast<x>mail',
            adapterType: 'imap',
            authState: 'healthy',
            sendCapable: true,
            lastSyncedAt: null,
          },
        ],
      }),
    });
    expect(html).toContain('data-action="accounts-open-detail"');
    expect(html).toContain('IMAP / SMTP');
    expect(html).toContain('Connected');
    expect(html).toContain('can send');
    expect(html).toContain('fast&lt;x&gt;mail');
    expect(html).not.toContain('fast<x>mail');
  });

  it('renders the IMAP form on the form stage', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'imap', values: seedAccountFormValues(imap()) }),
    });
    expect(html).toContain('data-action="accounts-submit-form"');
    expect(html).toContain('data-acct-field="host"');
    expect(html).toContain('data-acct-field="folders"');
  });

  it('renders a Connect button (not a field-submit) for the Gmail OAuth form', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'gmail', values: { name: 'work' } }),
    });
    // OAuth providers drive the popup, not the field-submit path.
    expect(html).toContain('data-action="accounts-oauth-connect"');
    expect(html).not.toContain('data-action="accounts-submit-form"');
    expect(html).toContain('Connect Gmail');
    // The slug + send-toggle fields are still part of the form.
    expect(html).toContain('data-acct-field="name"');
    expect(html).toContain('data-acct-field="send_enabled"');
  });

  it('renders a Connect button for the Google Calendar OAuth form', () => {
    const html = renderAccountsPanel({
      state: base({ lane: 'calendar', stage: 'form', providerId: 'gcal', values: { name: 'work' } }),
    });
    expect(html).toContain('data-action="accounts-oauth-connect"');
    expect(html).not.toContain('data-action="accounts-submit-form"');
    expect(html).toContain('Connect Google');
  });

  it('renders a field-form (not a Connect button) for the CalDAV form', () => {
    const html = renderAccountsPanel({
      state: base({ lane: 'calendar', stage: 'form', providerId: 'caldav', values: {} }),
    });
    // CalDAV is basic-auth → the normal field-submit, not the OAuth popup.
    expect(html).toContain('data-action="accounts-submit-form"');
    expect(html).not.toContain('data-action="accounts-oauth-connect"');
    expect(html).toContain('data-acct-field="server_url"');
    expect(html).toContain('data-acct-field="password"');
    expect(html).toContain('data-acct-field="calendar_home_url"');
  });

  it('shows a loading note for a deep-linked detail before the list arrives', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'detail', detailSlug: 'x', loading: true, rows: [] }),
    });
    expect(html).toContain('Loading account…');
    const gone = renderAccountsPanel({
      state: base({ stage: 'detail', detailSlug: 'x', loading: false, rows: [] }),
    });
    expect(gone).toContain('Account not found');
  });

  it('the Files lane shows two providers in the picker stage', () => {
    const html = renderAccountsPanel({
      state: base({ lane: 'file', stage: 'provider-picker' }),
    });
    expect(html).toContain('data-provider="fs"');
    expect(html).toContain('data-provider="s3"');
    expect(html).toContain('Local folder');
    expect(html).toContain('S3 bucket');
  });

  // ── Operator redirect-URI hint (Setup-instruction UX) ──
  it('shows the exact OAuth redirect URI to register on the Gmail form', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        appOrigin: 'https://app.recued.com',
      }),
    });
    expect(html).toContain('accounts-oauth-redirect');
    // Tied to the contract builder the flow itself uses (HTML-escaped as the
    // renderer emits it) — guards against drifting from the wire value.
    expect(html).toContain(e(buildOpenerRelayRedirectUri('https://app.recued.com')));
    // The app.recued.com PWA IS the cloud callback host → same-origin, so no
    // opener_origin param (byte-identical to the pre-R26.2 URL).
    expect(html).toContain('https://app.recued.com/oauth-callback?recued_relay=opener');
    expect(html).not.toContain('opener_origin');
  });

  it('shows the cloud callback + opener_origin for a self-served (cross-origin) PWA', () => {
    // A PWA served from the user's own LAN box — providers reject its
    // http://192.168.x.x origin as a redirect, so R26.2 Option A keeps the
    // redirect on the cloud host and rides the PWA origin as opener_origin.
    const html = renderAccountsPanel({
      state: base({
        lane: 'calendar',
        stage: 'form',
        providerId: 'gcal',
        values: { name: 'work' },
        appOrigin: 'http://192.168.1.50',
      }),
    });
    expect(html).toContain(e(buildOpenerRelayRedirectUri('http://192.168.1.50')));
    // Redirect host is still the cloud callback, with the cross-origin param.
    expect(html).toContain('https://app.recued.com/oauth-callback');
    expect(html).toContain('opener_origin=http%3A%2F%2F192.168.1.50');
  });

  it('omits the redirect URI hint when appOrigin is unknown', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'gmail', values: { name: 'work' } }),
    });
    expect(html).not.toContain('oauth-callback?recued_relay=opener');
    expect(html).not.toContain('accounts-oauth-redirect');
  });

  it('never shows the redirect URI hint on non-OAuth forms (IMAP, CalDAV, fs)', () => {
    const nonOAuthForms: ReadonlyArray<{
      lane: AccountLaneId;
      providerId: string;
      values: AccountFormValues;
    }> = [
      { lane: 'mail', providerId: 'imap', values: seedAccountFormValues(imap()) },
      { lane: 'calendar', providerId: 'caldav', values: {} },
      { lane: 'file', providerId: 'fs', values: {} },
    ];
    for (const form of nonOAuthForms) {
      const html = renderAccountsPanel({
        state: base({
          lane: form.lane,
          stage: 'form',
          providerId: form.providerId,
          values: form.values,
          appOrigin: 'https://app.recued.com',
        }),
      });
      // Neither the URI fragment nor the hint element/class leaks onto a
      // field-form transport.
      expect(html).not.toContain('oauth-callback?recued_relay=opener');
      expect(html).not.toContain('accounts-oauth-redirect');
    }
  });

  it('OAuth "Signing in…" overlay renders with an immediate escape; hides the form', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'gmail', oauthFinishing: true }),
    });
    expect(html).toContain('Signing in');
    expect(html).toContain('Connecting your Gmail account');
    // Escape present immediately.
    expect(html).toContain('data-action="accounts-oauth-dismiss"');
    // The OAuth form (Connect button + redirect hint) is hidden while signing in.
    expect(html).not.toContain('data-action="accounts-oauth-connect"');
    expect(html).not.toContain('accounts-oauth-redirect');
  });

  it('OAuth finishing: falls back to a generic label when the provider is unknown', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: null, oauthFinishing: true }),
    });
    expect(html).toContain('Connecting your account');
  });

  // ── BYO OAuth-app credentials: rendered INLINE on the provider form ──
  const status = (
    over: Partial<OAuthAppConfigStatus> = {},
  ): OAuthAppConfigStatus => ({
    client_id: null,
    has_secret: false,
    source: null,
    ...over,
  });
  const cfg = (
    google: OAuthAppConfigStatus,
    microsoft: OAuthAppConfigStatus = status(),
  ): OAuthAppConfigSnapshot => ({ google, microsoft });

  it('OAuth form renders the inline client_id + secret fields, redirect URI + guide', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        appOrigin: 'https://app.recued.com',
        oauthAppConfig: cfg(status({ source: null })),
      }),
    });
    expect(html).toContain('data-action="accounts-oauth-connect"');
    expect(html).toContain('Your Google sign-in app');
    expect(html).toContain('data-oauth-cred-field="client_id"');
    expect(html).toContain('data-oauth-cred-field="client_secret"');
    // The exact redirect URI to register + the per-issuer guide are inline.
    expect(html).toContain(e(buildOpenerRelayRedirectUri('https://app.recued.com')));
    expect(html).toContain('How to create a Google OAuth app');
    expect(html).toContain('One Google app covers both Gmail and Google Calendar');
    // No separate setup stage / Set up / Manage gating any more.
    expect(html).not.toContain('accounts-oauth-open-setup');
    expect(html).not.toContain('accounts-oauth-setup');
  });

  it('OAuth form, unknown config (null): still renders Connect + the inline fields', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        oauthAppConfig: null,
      }),
    });
    expect(html).toContain('data-action="accounts-oauth-connect"');
    expect(html).toContain('data-oauth-cred-field="client_id"');
  });

  it('OAuth form, configured (stored): saved client_id + a "leave blank to reuse" note', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        oauthCredValues: { client_id: 'SAVED-CID', client_secret: '' },
        oauthAppConfig: cfg(status({ client_id: 'SAVED-CID', has_secret: true, source: 'stored' })),
      }),
    });
    expect(html).toContain('value="SAVED-CID"');
    expect(html).toContain('Your Google app is saved');
    expect(html).toContain('leave blank to reuse');
  });

  it('OAuth form, configured via env: notes sign-in is configured on the server', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        oauthAppConfig: cfg(status({ client_id: 'ENV-CID', has_secret: true, source: 'env' })),
      }),
    });
    expect(html).toContain('Google sign-in is configured on this server');
  });

  it('OAuth form, env client_id but NO secret: no reuse note (still prompts for entry)', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        // source set but has_secret false → NOT reusable without entering a secret.
        oauthAppConfig: cfg(status({ client_id: 'ENV-CID', has_secret: false, source: 'env' })),
      }),
    });
    expect(html).not.toContain('Leave the fields blank');
    expect(html).toContain('Stored encrypted on your server');
  });

  it('Calendar OAuth (graph) renders the microsoft app section + Entra guide', () => {
    const html = renderAccountsPanel({
      state: base({
        lane: 'calendar',
        stage: 'form',
        providerId: 'graph',
        values: { name: 'work' },
        oauthAppConfig: cfg(
          status({ client_id: 'G', has_secret: true, source: 'stored' }), // google
          status({ source: null }),                                       // microsoft
        ),
      }),
    });
    expect(html).toContain('Your Microsoft sign-in app');
    expect(html).toContain('How to create a Microsoft OAuth app');
    expect(html).toContain('One Microsoft app covers both Outlook mail and calendar');
    expect(html).toContain('data-action="accounts-oauth-connect"');
  });

  it('Microsoft form on a loopback origin shows a BARE redirect URI (Entra rejects query strings)', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'graph',
        values: { name: 'work' },
        appOrigin: 'http://localhost:7843',
        oauthAppConfig: cfg(status({ source: null })),
      }),
    });
    // The Microsoft redirect URI drops the recued_relay marker on loopback.
    expect(html).toContain(e(buildOpenerRelayRedirectUri('http://localhost:7843', true)));
    expect(html).not.toContain('recued_relay=opener');
  });

  it('Google form on a loopback origin keeps the recued_relay marker', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        appOrigin: 'http://localhost:7843',
        oauthAppConfig: cfg(status({ source: null })),
      }),
    });
    expect(html).toContain(e(buildOpenerRelayRedirectUri('http://localhost:7843')));
    expect(html).toContain('recued_relay=opener');
  });

  it('the secret field hint reflects whether a secret is already saved', () => {
    const saved = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        oauthAppConfig: cfg(status({ client_id: 'C', has_secret: true, source: 'stored' })),
      }),
    });
    expect(saved).toContain('leave blank to reuse');
    const fresh = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'gmail', oauthAppConfig: cfg(status({ source: null })) }),
    });
    expect(fresh).toContain('Stored encrypted on your server');
  });

  it('non-OAuth forms (IMAP) render NO inline credential section', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'imap', values: seedAccountFormValues(imap()) }),
    });
    expect(html).not.toContain('data-oauth-cred-field');
    expect(html).not.toContain('sign-in app');
  });
});
