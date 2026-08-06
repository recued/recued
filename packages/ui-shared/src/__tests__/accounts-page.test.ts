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
      state: base({ error: 'This lane is not available on this server yet.' }),
    });
    expect(html).toContain('This lane is not available');
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
      'Recued can search and use these mailboxes in your work.',
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
    expect(retry).toContain('Restart sign-in');
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
