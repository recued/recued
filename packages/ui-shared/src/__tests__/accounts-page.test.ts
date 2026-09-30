import { describe, expect, it } from 'vitest';
import {
  buildOpenerRelayRedirectUri,
  type OAuthAppConfigSnapshot,
  type OAuthAppConfigStatus,
} from '@recued/contracts';
import { e } from '../template.js';

import {
  ACCOUNTS_PANEL_STYLES,
  ACCOUNT_LANES,
  ACCOUNT_SLUG_REGEX,
  canSubmitAccountForm,
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

describe('ACCOUNTS_PANEL_STYLES', () => {
  it('contains long account identities through list, detail, and removal review', () => {
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-panel { min-width: 0; display: grid; gap: 14px; }',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-row-main {\n  box-sizing: border-box; min-width: 0; max-width: 100%;',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-row-name {\n  min-width: 0; overflow-wrap: anywhere;',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-row-sub {\n  min-width: 0; overflow-wrap: anywhere;',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      'grid-template-columns: max-content minmax(0, 1fr);',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-detail-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-delete-confirm {\n  box-sizing: border-box; min-width: 0; max-width: 100%;',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-delete-title {\n  min-width: 0; margin: 0; overflow-wrap: anywhere;',
    );
    expect(ACCOUNTS_PANEL_STYLES).toContain(
      '.accounts-delete-body {\n  min-width: 0; margin: 0; overflow-wrap: anywhere;',
    );
  });
});

const imap = (): AccountProvider =>
  findAccountProvider(findAccountLane('mail')!, 'imap')!;
const gmail = (): AccountProvider =>
  findAccountProvider(findAccountLane('mail')!, 'gmail')!;
const fs = (): AccountProvider =>
  findAccountProvider(findAccountLane('file')!, 'fs')!;
const s3 = (): AccountProvider =>
  findAccountProvider(findAccountLane('file')!, 's3')!;

const withSeed = (
  p: AccountProvider,
  over: AccountFormValues,
): AccountFormValues => ({ ...seedAccountFormValues(p), ...over });

describe('ACCOUNT_LANES structure', () => {
  it('exposes the three-lane top split with the locked providers', () => {
    expect(ACCOUNT_LANES.map((l) => l.id)).toEqual(['mail', 'calendar', 'file']);
    // Mail = IMAP + Gmail/Microsoft OAuth; Files = local fs + mutable S3
    // (OAuth document providers use connection-backed D-192 Sources + packs).
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
    expect(seedAccountFormValues(s3())['use_path_style']).toBe('true');
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
    expect(validateAccountForm(imap(), v)).toMatch(/lower-case/);
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
    ).toMatch(/you need the SMTP host too/);
    expect(
      validateAccountForm(imap(), { ...base, smtp_from: 'me@x.com' }),
    ).toMatch(/you need the SMTP host too/);
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

  it('renders an outcome-led first-run card with supported providers', () => {
    const html = renderAccountsPanel({ state: base({ rows: [] }) });
    expect(html).toContain('data-accounts-lane="mail"');
    expect(html).toContain('data-accounts-empty');
    expect(html).toContain('Connect your first mailbox');
    expect(html).toContain('Find messages in Chat');
    expect(html).toContain('Available options');
    expect(html).toContain('aria-labelledby="accounts-empty-mail-providers-label"');
    expect(html).toContain('IMAP / SMTP');
    expect(html).toContain('Gmail');
    expect(html).toContain('Microsoft');
    expect(html).toContain('data-action="accounts-open-add"');
    expect(html).toContain('Connect mailbox');
    expect(html).not.toContain('+ Connect mailbox');
    // Mail OAuth is buildable now (Slice 2c) — no pending note.
    expect(html).not.toContain('Gmail and Microsoft');
    // The unified tab bar lives in the route, not this panel.
    expect(html).not.toContain('accounts-pick-lane');
  });

  it('keeps the first action out of the loading state', () => {
    const html = renderAccountsPanel({
      state: base({ loading: true, rows: [] }),
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading mail…');
    expect(html).not.toContain('data-action="accounts-open-add"');
    expect(html).not.toContain('data-accounts-empty');
  });

  it('does not offer enrollment when the lane list is unavailable', () => {
    const html = renderAccountsPanel({
      state: base({ error: 'This server cannot do this yet.' }),
    });
    expect(html).toContain('This server cannot do this yet');
    expect(html).not.toContain('data-action="accounts-open-add"');
  });

  it('renders a lane pending note when one is set (file)', () => {
    const html = renderAccountsPanel({ state: base({ rows: [], lane: 'file' }) });
    expect(html).toContain('Using Dropbox, Google Drive, Box, or OneDrive?');
    expect(html).toContain('Data → Files');
    expect(html).toContain('more provider actions');
  });

  it('renders a row with provider badge + truthful first-sync status + escapes the slug', () => {
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
    expect(html).toContain('data-state="syncing"');
    expect(html).toContain('First sync pending');
    expect(html).toContain('can send');
    expect(html).toContain('fast&lt;x&gt;mail');
    expect(html).not.toContain('fast<x>mail');
    expect(html).toContain(
      '<h2 class="accounts-list-title">Mailboxes</h2>',
    );
    expect(html).toContain(
      'Recued can search these mailboxes and use them in your work.',
    );
    expect(html).not.toContain('Mailboxes Recued can');
    expect(html).toContain('+ Connect mailbox');
  });

  it('confirms the connected identity while the first sync is pending', () => {
    const html = renderAccountsPanel({
      state: base({
        connectionSuccess: { slug: 'work', providerId: 'gmail' },
        rows: [{
          slug: 'work',
          adapterType: 'gmail',
          authState: 'healthy',
          sublabel: 'me@example.com',
          lastSyncedAt: null,
        }],
      }),
    });

    expect(html).toContain('data-accounts-connection-success');
    expect(html).toContain('data-sync-state="pending"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('Gmail connected');
    expect(html).toContain('me@example.com');
    expect(html).toContain('First sync pending');
    expect(html).toContain('syncing continues on your server');
    expect(html).toContain('prepare a first question when this account is searchable');
    expect(html).toContain('Continue to Chat');
    expect(html).toContain('data-action="accounts-success-go-chat"');
    expect(html).toContain('data-action="accounts-success-open-lane" data-lane="calendar"');
    expect(html).toContain('data-action="accounts-success-refresh"');
    expect(html).toContain('data-action="accounts-dismiss-success"');
  });

  it('promotes the confirmation to ready only after a successful sync timestamp', () => {
    const html = renderAccountsPanel({
      state: base({
        connectionSuccess: { slug: 'work', providerId: 'gmail' },
        rows: [{
          slug: 'work',
          adapterType: 'gmail',
          authState: 'healthy',
          lastSyncedAt: 1_700_000_000_000,
        }],
      }),
    });

    expect(html).toContain('data-sync-state="ready"');
    expect(html).toContain('Gmail is ready');
    expect(html).toContain('Ready for Chat');
    expect(html).toContain('The first sync finished');
    expect(html).toContain('Ask about this account');
    expect(html).not.toContain('First sync pending');
  });

  it('keeps a saved connection recoverable when status refresh cannot confirm it', () => {
    const html = renderAccountsPanel({
      state: base({
        connectionSuccess: { slug: 'work', providerId: 'gmail' },
        // A failed post-enroll refresh must not promote from a stale row left
        // over from the pre-connect list.
        rows: [{
          slug: 'work',
          adapterType: 'gmail',
          authState: 'healthy',
          lastSyncedAt: 1_699_000_000_000,
        }],
        error: 'Server unavailable',
      }),
    });

    expect(html).toContain('data-sync-state="unknown"');
    expect(html).toContain('Connection saved');
    expect(html).toContain('could not refresh its sync status');
    expect(html).toContain('do not need to repeat the sign-in flow');
    expect(html).toContain('Check sync status');
    expect(html).not.toContain('Ready for Chat');
    expect(html).not.toContain('Connect your first mailbox');
  });

  it('surfaces an unhealthy post-connect row as attention, not ready', () => {
    const html = renderAccountsPanel({
      state: base({
        connectionSuccess: { slug: 'office', providerId: 'graph' },
        rows: [{
          slug: 'office',
          adapterType: 'graph',
          authState: 'unauthorized',
          lastSyncedAt: null,
        }],
      }),
    });

    expect(html).toContain('data-sync-state="attention"');
    expect(html).toContain('Microsoft connected, but needs attention');
    expect(html).toContain('Unauthorized');
    expect(html).toContain('data-action="accounts-open-detail"');
    expect(html).not.toContain('Ready for Chat');
  });

  it('details distinguish a pending first sync from an account that never syncs', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'detail',
        detailSlug: 'work',
        rows: [{
          slug: 'work',
          adapterType: 'gmail',
          authState: 'healthy',
          lastSyncedAt: null,
        }],
      }),
    });

    expect(html).toContain('First sync pending');
    expect(html).toContain('Waiting for first sync');
    expect(html).toContain('data-accounts-detail-heading tabindex="-1"');
    expect(html).not.toContain('>never<');
  });

  it('shows reauthorization for OAuth calendar rows, never file rows', () => {
    const calendar = renderAccountsPanel({
      state: base({
        lane: 'calendar',
        stage: 'detail',
        detailSlug: 'work',
        rows: [{
          slug: 'work',
          adapterType: 'gcal',
          authState: 'expired',
          reauthAvailable: true,
        }],
      }),
    });
    const file = renderAccountsPanel({
      state: base({
        lane: 'file',
        stage: 'detail',
        detailSlug: 'archive',
        rows: [{
          slug: 'archive',
          adapterType: 's3',
          authState: 'expired',
          // Even a malformed caller cannot revive the retired file OAuth UI.
          reauthAvailable: true,
        }],
      }),
    });

    expect(calendar).toContain('data-action="accounts-reauth"');
    expect(file).not.toContain('data-action="accounts-reauth"');
  });

  it('keeps busy account lifecycle actions focusable and announces their work', () => {
    const html = renderAccountsPanel({
      state: base({
        lane: 'calendar',
        stage: 'detail',
        detailSlug: 'work',
        rows: [{
          slug: 'work',
          adapterType: 'gcal',
          authState: 'expired',
          reauthAvailable: true,
        }],
        rowBusy: new Set(['resync:work', 'reauth:work']),
      }),
    });

    for (const action of ['accounts-resync', 'accounts-reauth']) {
      const lifecycle = html.match(
        new RegExp(`<button[^>]*data-action="${action}"[^>]*>[^<]+</button>`),
      )?.[0];
      expect(lifecycle).toBeDefined();
      expect(lifecycle).toContain('aria-disabled="true"');
      expect(lifecycle).toContain('aria-busy="true"');
      expect(lifecycle).not.toMatch(/\sdisabled(?:\s|>)/);
    }
  });

  it('renders the IMAP form on the form stage', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'imap', values: seedAccountFormValues(imap()) }),
    });
    expect(html).toContain('data-action="accounts-submit-form"');
    expect(html).toContain('data-acct-field="host"');
    expect(html).toContain('data-acct-field="folders"');
    expect(html).toContain(
      '<h2 class="accounts-form-title" data-accounts-form-heading tabindex="-1">Connect IMAP / SMTP</h2>',
    );
    expect(html).toContain('Connect account');
  });

  it('keeps a busy IMAP submit focusable while fencing another activation', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'imap',
        saving: true,
        values: {
          ...seedAccountFormValues(imap()),
          name: 'fastmail',
          host: 'imap.fastmail.com',
          username: 'me@example.com',
          password: 'app-password',
        },
      }),
    });
    const submit = html.match(
      /<button[^>]*data-action="accounts-submit-form"[^>]*>Connecting…<\/button>/,
    )?.[0];
    expect(submit).toBeDefined();
    expect(submit).toContain('aria-disabled="true"');
    expect(submit).toContain('aria-busy="true"');
    expect(submit).not.toMatch(/\sdisabled(?:\s|>)/);
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
    expect(html).toContain(
      '<h2 class="accounts-picker-title" data-accounts-picker-heading tabindex="-1">Choose a file source</h2>',
    );
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

  it('OAuth waiting state preserves work elsewhere and offers safe cancellation', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        oauthFinishing: true,
        oauthProgressStage: 'waiting_for_consent',
      }),
    });
    expect(html).toContain('Waiting for sign-in');
    expect(html).toContain('Complete sign-in for your Gmail account');
    expect(html).toContain('keep working elsewhere');
    expect(html).toContain('data-action="accounts-oauth-dismiss"');
    expect(html).toContain('>Keep working<');
    expect(html).toContain('data-action="accounts-oauth-cancel"');
    // The OAuth form (Connect button + redirect hint) is hidden while signing in.
    expect(html).not.toContain('data-action="accounts-oauth-connect"');
    expect(html).not.toContain('accounts-oauth-redirect');
  });

  it('OAuth finishing: falls back to a generic label when the provider is unknown', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: null, oauthFinishing: true }),
    });
    expect(html).toContain('Finishing connection');
    expect(html).toContain('Sign-in for your account is complete');
    expect(html).not.toContain('accounts-oauth-cancel');
  });

  it('OAuth preparation explains the blank popup without calling it consent', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        oauthFinishing: true,
        oauthProgressStage: 'preparing',
      }),
    });
    expect(html).toContain('Preparing sign-in');
    expect(html).toContain('getting sign-in for your Gmail account ready');
    expect(html).toContain('Keep the popup open');
    expect(html).toContain('accounts-oauth-cancel');
  });

  it('renders an accessible verify-before-retry reload handoff', () => {
    const checking = renderAccountsPanel({
      state: base({
        loading: true,
        oauthReloadRecovery: {
          providerLabel: 'Gmail',
          slug: 'work',
          status: 'checking',
        },
      }),
    });
    expect(checking).toContain('data-accounts-oauth-recovery');
    expect(checking).toContain('role="status"');
    expect(checking).toContain('aria-live="polite"');
    expect(checking).toContain('Checking Gmail connection');
    expect(checking).toContain('before another sign-in');
    expect(checking).not.toContain('accounts-oauth-recovery-restart');
    expect(checking).not.toContain('Loading mail');

    const retry = renderAccountsPanel({
      state: base({
        loading: false,
        oauthReloadRecovery: {
          providerLabel: 'Gmail',
          slug: 'work',
          status: 'ready_to_retry',
        },
      }),
    });
    expect(retry).toContain('Safe to restart sign-in');
    expect(retry).toContain('data-action="accounts-oauth-recovery-check"');
    expect(retry).toContain('data-action="accounts-oauth-recovery-restart"');
    expect(retry).toContain('Start signing in again');
    expect(retry.indexOf('accounts-oauth-recovery-restart')).toBeLessThan(
      retry.indexOf('accounts-oauth-recovery-check'),
    );

    const waiting = renderAccountsPanel({
      state: base({
        loading: false,
        oauthReloadRecovery: {
          providerLabel: 'Gmail',
          slug: 'work',
          status: 'check_again',
          retryAfterSeconds: 4,
        },
      }),
    });
    expect(waiting).toContain('wait about 4 seconds');
    expect(waiting).not.toContain('accounts-oauth-recovery-restart');
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

  it('OAuth form turns missing config into an ordered one-time setup checklist', () => {
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
    expect(html).toContain('data-oauth-app-state="setup"');
    expect(html).toContain('One-time server setup');
    expect(html).toContain('Set up Google sign-in');
    expect(html).toContain('data-oauth-cred-field="client_id"');
    expect(html).toContain('data-oauth-cred-field="client_secret"');
    expect(html).toContain('Save setup &amp; connect Gmail');
    expect(html).toMatch(/data-action="accounts-oauth-connect" disabled/);
    // The exact redirect URI + Copy action and the open provider guide are inline.
    expect(html).toContain(e(buildOpenerRelayRedirectUri('https://app.recued.com')));
    expect(html).toContain('data-action="accounts-copy-oauth-redirect"');
    expect(html).toContain('<summary>1. Create a Google OAuth app</summary>');
    expect(html).toContain('class="accounts-oauth-guide" open');
    expect(html).toContain('href="https://console.cloud.google.com/apis/credentials"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Open Google Cloud Console (opens in a new tab)"');
    expect(html).toContain('One Google app covers both Gmail and Google Calendar');
    // The Google guide MUST steer an External app to "In production" and say why.
    // Left in Testing status, Google issues refresh tokens that expire after 7
    // days, so mail sync dies weekly — and (before the durable sync-outcome
    // reporting) did so silently. This is a ratchet: the warning is the whole
    // reason the step exists, so losing it must break a test rather than a
    // stranger's mailbox a week after they set it up.
    expect(html).toContain('In production');
    expect(html).toMatch(/expire after 7 days/);
    expect(html).toMatch(/Do NOT leave it in Testing/);
  });

  /** ⛔ Only routes that keep working. An External app left in Testing loses
   *  its sign-ins after 7 days, so the guide warns against it and never offers
   *  it; what lasts depends on the account, and on where the page is open. */
  describe('the Google guide: routes that keep working', () => {
    const googleSetup = (appOrigin?: string): string => renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        ...(appOrigin !== undefined ? { appOrigin } : {}),
        oauthAppConfig: cfg(status({ source: null })),
      }),
    });

    it('opens with the three kinds of account and what works for each', () => {
      const html = googleSetup('https://app.recued.com');
      expect(html).toContain('First, pick the way that keeps working for your account.');
      expect(html).toContain('<strong>Google Workspace</strong>');
      expect(html).toContain('<strong>Free Gmail, and you own a web domain:</strong>');
      expect(html).toContain('<strong>Free Gmail, no domain:</strong> skip the app.');
      // The no-domain route is complete enough to follow without leaving the page.
      for (const value of ['imap.gmail.com', 'myaccount.google.com/apppasswords',
        '[Gmail]/Sent Mail', 'smtp.gmail.com']) {
        expect(html).toContain(value);
      }
      expect(html).toContain('Google Calendar has no password option');
    });

    it('never offers Testing as a way to connect', () => {
      const html = googleSetup('https://app.recued.com');
      expect(html).not.toMatch(/test users?/i);
      expect(html).not.toMatch(/reconnect/i);
      expect(html).toMatch(/Do NOT leave it in Testing/);
    });

    /** The owner went through it: "Advanced", then a link Google labels
     *  "(unsafe)". Name the exact clicks and why the label is not a reason to stop. */
    it('walks through the unverified-app screen by its real labels', () => {
      const html = googleSetup('http://127.0.0.1:7717');
      expect(html).toContain('Google hasn&rsquo;t verified this app');
      expect(html).toContain('<strong>Advanced</strong>');
      expect(html).toContain('<strong>Go to <em>your app&rsquo;s name</em> (unsafe)</strong>');
      expect(html).toContain('this one is yours and talks only to your own server');
    });

    it('says what Branding needs: a verified domain of your own, not recued.com', () => {
      const html = googleSetup('https://app.recued.com');
      expect(html).toContain('verify it in Google Search Console');
      expect(html).toContain('Do not add recued.com');
      expect(html).toContain('Leave the logo empty');
    });

    /** Its callback is on recued.com (app.recued.com itself, or a LAN address
     *  bouncing through it), and nobody but Recued can verify recued.com. */
    it('on app.recued.com or a LAN address: this page cannot connect a published app', () => {
      for (const origin of ['https://app.recued.com', 'http://192.168.1.20:7717']) {
        const html = googleSetup(origin);
        expect(html).toContain('this page cannot connect a published app');
        expect(html).toContain('http://127.0.0.1:7717/webclient');
        expect(html).toContain('ssh -L 7717:127.0.0.1:7717 you@your-server');
      }
    });

    it("at the server's own address: its callback works with a published app", () => {
      const html = googleSetup('http://127.0.0.1:7717');
      expect(html).toContain('this page is open at the server&rsquo;s own address');
      expect(html).not.toContain('this page cannot connect a published app');
    });

    /** ⛔ 2026-09-29: the server's own https address used to bounce through
     *  app.recued.com, and that page never delivered. It takes its callback
     *  itself now, so what Google allows turns on WHOSE domain it is. */
    it('at a Pro recued.net address: cannot connect a published app, and says why and where can', () => {
      const html = googleSetup('https://alice.recued.net');
      expect(html).toContain('this page cannot connect a published app');
      expect(html).toContain('recued.net, the domain of your Pro address');
      expect(html).toContain('Open Recued on your own domain instead');
      // Its callback is its own, on the server — not app.recued.com's.
      expect(html).toContain(e('https://alice.recued.net/webclient/oauth-callback.html?recued_relay=opener'));
    });

    it('on your own domain: its callback works with a published app once the domain is verified', () => {
      const html = googleSetup('https://recued.example.com');
      expect(html).toContain('this page is Recued on your own domain, so its callback (step 2 below) works with a published app');
      expect(html).toContain('Under Authorized domains in step 4');
      expect(html).not.toContain('this page cannot connect a published app');
      expect(html).toContain(e('https://recued.example.com/webclient/oauth-callback.html?recued_relay=opener'));
    });

    it('carries none of the Microsoft guide', () => {
      const html = googleSetup('https://app.recued.com');
      expect(html).not.toContain('admin consent');
      expect(html).not.toContain('http://localhost:7717/webclient');
    });
  });

  describe('the Microsoft guide: who makes the app, and where to connect', () => {
    const microsoftSetup = (appOrigin?: string): string => renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'graph',
        values: { name: 'office' },
        ...(appOrigin !== undefined ? { appOrigin } : {}),
        oauthAppConfig: cfg(status(), status({ source: null })),
      }),
    });

    it('opens with personal against work or school, and no password way', () => {
      const html = microsoftSetup('http://localhost:7717');
      expect(html).toContain('Create a Microsoft OAuth app');
      expect(html).toContain('First, check which kind of account you have.');
      expect(html).toContain('<strong>Personal account</strong>');
      expect(html).toContain('free Azure account');
      expect(html).toContain('<strong>Work or school account</strong>');
      expect(html).toContain('<strong>No password option:</strong>');
    });

    /** ⛔ The guide told EVERY account to register its own app. Since late
     *  November 2025 Microsoft's default consent setting stops a staff member
     *  approving Mail.* or Calendars.* for any app, whoever made it, so on a
     *  work account the guide ended at "Need admin approval" with nothing on
     *  screen saying why, or who could get past it. */
    it('says a work account needs an admin, named by role, once for the organization', () => {
      const html = microsoftSetup('http://localhost:7717');
      expect(html).toContain('an admin must make the app and approve it');
      for (const role of ['Global Administrator', 'Privileged Role Administrator',
        'Cloud Application Administrator', 'Application Administrator']) {
        expect(html).toContain(role);
      }
      expect(html).toContain('one app for the whole organization');
      expect(html).toContain('<strong>Grant admin consent</strong>');
      expect(html).toContain('Need admin approval');
      expect(html).toContain('Approval required');
      // A greyed-out button is the organization's policy, not Recued failing.
      expect(html).toContain('Greyed out? You do not hold one of the roles above');
    });

    it('says what the shared secret opens: nothing without each person’s own sign-in', () => {
      const html = microsoftSetup('http://localhost:7717');
      expect(html).toContain('The secret names the app, not a person');
      expect(html).toContain('without that person&rsquo;s own sign-in');
    });

    /** ⛔ It said "This page cannot connect the app" on app.recued.com too,
     *  whose callback carried `?recued_relay=opener`. That callback is bare now
     *  for Microsoft, so an app that takes personal accounts can register it. */
    it('on app.recued.com: its callback works, and it is the bare cloud URL', () => {
      const html = microsoftSetup('https://app.recued.com');
      expect(html).toContain('This page is app.recued.com, so its callback (step 2 below) works.');
      expect(html).not.toContain('This page cannot connect the app');
      expect(html).toContain('<code class="accounts-oauth-redirect">https://app.recued.com/oauth-callback</code>');
      expect(html).not.toContain('recued_relay');
    });

    /** A LAN page's callback names that page's address after a `?`, and Entra
     *  refuses a query string for an app that takes personal accounts. */
    it('on a LAN address: this page cannot connect the app, and says where can', () => {
      const html = microsoftSetup('http://192.168.1.20:7717');
      expect(html).toContain('This page cannot connect the app these steps make.');
      expect(html).toContain('Connect from app.recued.com instead');
      expect(html).toContain('http://localhost:7717/webclient');
      expect(html).toContain('ssh -L 7717:127.0.0.1:7717 you@your-server');
    });

    /** The Azure portal will not take an `http` callback at 127.0.0.1. */
    it('at 127.0.0.1: open the same server at localhost instead', () => {
      const html = microsoftSetup('http://127.0.0.1:7717');
      expect(html).toContain('Open this page at <code>http://localhost:7717/webclient</code> instead');
      expect(html).toContain('or use app.recued.com');
      expect(html).not.toContain('This page cannot connect the app');
    });

    /** ⛔ 2026-09-29: a Pro owner at their own address could not connect at
     *  all — the bounce through app.recued.com needs a query string. The
     *  server's own https address now takes a bare callback of its own. */
    it("at the server's own https address: its callback works, and it is bare", () => {
      for (const origin of ['https://alice.recued.net', 'https://recued.example.com']) {
        const html = microsoftSetup(origin);
        expect(html, origin).toContain('This page is the server&rsquo;s own https address, so its callback (step 2 below) works.');
        expect(html, origin).not.toContain('This page cannot connect the app');
        expect(html, origin).toContain(`<code class="accounts-oauth-redirect">${origin}/webclient/oauth-callback.html</code>`);
      }
    });

    it('a bare IP address cannot connect it either, and the answer names the https address that can', () => {
      const html = microsoftSetup('https://192.168.1.20:8443');
      expect(html).toContain('This page cannot connect the app these steps make.');
      expect(html).toContain('the server&rsquo;s own https address (a Pro recued.net address or your own domain)');
    });

    it('at localhost: its callback works', () => {
      const html = microsoftSetup('http://localhost:7717');
      expect(html).toContain('This page is open at <code>localhost</code>');
      expect(html).not.toContain('This page cannot connect the app');
      expect(html).not.toContain('Open this page at');
    });

    /** The callback is typed on the registration form itself, so the address
     *  has to be right before the first click in Azure. */
    it('leads with the address, before the registration that asks for the callback', () => {
      const html = microsoftSetup('http://192.168.1.20:7717');
      const steps = html.slice(html.indexOf('accounts-oauth-guide-steps'));
      expect(steps.indexOf('This page cannot connect the app')).toBeGreaterThan(-1);
      expect(steps.indexOf('This page cannot connect the app'))
        .toBeLessThan(steps.indexOf('New registration'));
    });

    it('carries none of the Google guide', () => {
      const html = microsoftSetup('https://app.recued.com');
      expect(html).not.toContain('imap.gmail.com');
      expect(html).not.toContain('Search Console');
      expect(html).not.toMatch(/Testing/);
    });
  });

  it('gives Gmail\u2019s values where the IMAP form asks for them', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'imap', values: seedAccountFormValues(imap()) }),
    });
    expect(html).toContain('myaccount.google.com/apppasswords');
    expect(html).toContain('imap.gmail.com');
    expect(html).toContain('[Gmail]/Sent Mail');
  });

  it('OAuth form, unknown config (null): preserves the legacy optional-settings path', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        oauthAppConfig: null,
      }),
    });
    expect(html).toContain('data-action="accounts-oauth-connect"');
    expect(html).toContain('data-oauth-app-state="unknown"');
    expect(html).toContain('If this server already provides Google sign-in');
    expect(html).toContain('data-oauth-cred-field="client_id"');
    expect(html).not.toContain('One-time server setup');
  });

  it('OAuth form, configured (stored): keeps credentials behind a closed manage disclosure', () => {
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
    expect(html).toContain('data-oauth-app-state="ready"');
    expect(html).toContain('Google sign-in is ready');
    expect(html).toContain('Saved securely on this server');
    expect(html).toContain('<summary>Change Google sign-in app</summary>');
    expect(html).toContain('<details class="accounts-oauth-manage">');
    expect(html).not.toContain('One-time server setup');
  });

  // 'OAuth form, configured via env: renders the same lightweight ready state'
  // was deleted with the six `RECUED_*` OAuth env vars (2026-07-28). Its whole
  // claim was that an env-sourced status renders the SAME ready state as a
  // stored one — with `source: 'env'` gone from the union, that is verbatim the
  // preceding test, not a second case. No coverage is lost.

  it('OAuth form, client_id present but NO secret: still demands the secret', () => {
    const html = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        values: { name: 'work' },
        // has_secret false → NOT reusable, whatever the client_id says. The
        // store writes id+secret atomically so the product cannot produce this
        // row, but `isReusableOAuthApp` gates on has_secret and that gate is
        // what this pins: drop the has_secret conjunct and the panel would
        // wrongly render "ready" and stop asking for a secret it does not have.
        oauthAppConfig: cfg(status({ client_id: 'STORED-CID', has_secret: false, source: 'stored' })),
      }),
    });
    expect(html).toContain('data-oauth-app-state="setup"');
    expect(html).toContain('needs a Google OAuth app');
    expect(html).toContain('Stored encrypted on your server');
    expect(html).not.toContain('Google sign-in is ready');
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
    expect(html).toContain('Set up Microsoft sign-in');
    expect(html).toContain('1. Create a Microsoft OAuth app');
    // Entra only issues a scope the app registration LISTS, so every scope
    // Recued can request must appear in this checklist. The guide previously
    // omitted Mail.Send, so anyone who followed it and then ticked "Allow
    // sending mail" had a registration that could not grant it. Ratcheted per
    // scope, because a partial list is the failure mode — it reads complete.
    for (const scope of [
      'Mail.Read',
      'offline_access',
      'User.Read',
      'Mail.Send',
      'Calendars.ReadWrite',
    ]) {
      expect(html).toContain(scope);
    }
    // offline_access is the one whose absence looks like "it worked, then died".
    expect(html).toMatch(/without offline_access there is no refresh token/);
    expect(html).toContain('href="https://entra.microsoft.com/"');
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

  it('the secret field hint distinguishes replacement from first-time setup', () => {
    const saved = renderAccountsPanel({
      state: base({
        stage: 'form',
        providerId: 'gmail',
        oauthAppConfig: cfg(status({ client_id: 'C', has_secret: true, source: 'stored' })),
      }),
    });
    expect(saved).toContain('A secret is already saved');
    const fresh = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'gmail', oauthAppConfig: cfg(status({ source: null })) }),
    });
    expect(fresh).toContain('Stored encrypted on your server');
  });

  it('OAuth submit readiness requires setup credentials only when the server needs them', () => {
    const provider = gmail();
    const configured = base({
      stage: 'form',
      providerId: 'gmail',
      values: { name: 'work' },
      oauthAppConfig: cfg(status({ client_id: 'SAVED', has_secret: true, source: 'stored' })),
    });
    expect(canSubmitAccountForm(provider, configured)).toBe(true);
    expect(canSubmitAccountForm(provider, {
      ...configured,
      oauthCredValues: { client_id: 'SAVED', client_secret: '' },
    })).toBe(true);
    expect(canSubmitAccountForm(provider, {
      ...configured,
      oauthCredValues: { client_id: 'REPLACEMENT', client_secret: '' },
    })).toBe(false);
    expect(canSubmitAccountForm(provider, {
      ...configured,
      oauthCredValues: { client_id: 'REPLACEMENT', client_secret: 'SECRET' },
    })).toBe(true);

    const unconfigured = {
      ...configured,
      oauthAppConfig: cfg(status({ source: null })),
      oauthCredValues: { client_id: '', client_secret: '' },
    };
    expect(canSubmitAccountForm(provider, unconfigured)).toBe(false);
    expect(canSubmitAccountForm(provider, {
      ...unconfigured,
      oauthCredValues: { client_id: 'NEW', client_secret: 'SECRET' },
    })).toBe(true);
    expect(canSubmitAccountForm(provider, {
      ...unconfigured,
      oauthCredValues: { client_id: '', client_secret: 'SECRET' },
    })).toBe(false);
    expect(canSubmitAccountForm(provider, {
      ...unconfigured,
      oauthCredValues: { client_id: 'NEW', client_secret: '   ' },
    })).toBe(false);
    expect(canSubmitAccountForm(provider, {
      ...unconfigured,
      oauthAppConfig: null,
      oauthCredValues: { client_id: 'DRAFT', client_secret: '' },
    })).toBe(false);
  });

  it('non-OAuth forms (IMAP) render NO inline credential section', () => {
    const html = renderAccountsPanel({
      state: base({ stage: 'form', providerId: 'imap', values: seedAccountFormValues(imap()) }),
    });
    expect(html).not.toContain('data-oauth-cred-field');
    expect(html).not.toContain('sign-in app');
  });
});
