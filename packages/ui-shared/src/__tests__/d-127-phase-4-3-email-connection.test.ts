/** D-127 P4.3 — connection.notification.email schema rewrite +
 *  dynamic-options renderer.
 *
 *  Spec § A.7.3: the email subtype graduates from the SMTP-direct
 *  placeholder shape (P7.2) to a thin "send via" pointer at a
 *  `data.mail.<name>` instance. SMTP creds live on the mail
 *  collection now; this connection record carries
 *  `config.sender_mail_instance` (picked from a dynamic dropdown of
 *  send-capable mail accounts) + an optional
 *  `config.default_recipient`. Probe metadata changes from http-shape
 *  to `{ kind: 'mail', op: 'verify_send_capable' }`.
 *
 *  Coverage:
 *    1. Email schema field shape (no SMTP fields, has picker +
 *       optional default_recipient, auth.type='none').
 *    2. probe = { kind: 'mail', op: 'verify_send_capable' }.
 *    3. CONNECTION_SUBTYPE_CHOICES email label updated to plain "Email".
 *    4. options_source dynamic-options resolves from props.
 *    5. Empty options_source list renders inline guidance + disables
 *       the select + disables submit + surfaces guidance as form
 *       error.
 *    6. Populated options_source list renders one <option> per value.
 *    7. Picker filters by send_capable host-side (host responsibility;
 *       we test the renderer consumes whatever list the host supplied).
 *    8. Payload projection (config.sender_mail_instance present;
 *       blank default_recipient dropped; auth.type='none' projected).
 *    9. Probe-note reads from new kind+op shape.
 *   10. Empty list renders "No send-capable mail accounts" guidance
 *       text verbatim.
 *   11. Static-options select still renders normally (guard against
 *       options_source code path overreach). */

import { describe, expect, it } from 'vitest';
import {
  renderConnectionsPage,
  initialConnectionsPageState,
  initialConnectionsDialogState,
  projectConnectionPayload,
  validateConnectionForm,
  resolveConnectionSchema,
  CONNECTION_SUBTYPE_CHOICES,
  MAIL_SEND_CAPABLE_INSTANCES_SOURCE,
  notificationSchemas,
} from '../index.js';
import type {
  ConnectionsPageState,
  ConnectionsDialogState,
} from '../connections/index.js';
import type { ConnectionsPageProps } from '../connections/page.js';

// ────────────────────────────────────────────────────────────────
// Schema shape — no more SMTP fields
// ────────────────────────────────────────────────────────────────

describe('notificationSchemas.email — D-127 P4.3 shape', () => {
  it('exposes the spec § A.7.3 field set', () => {
    const keys = notificationSchemas.email.fields.map((f) => f.key);
    expect(keys).toEqual([
      'name',
      'display_name',
      'config.sender_mail_instance',
      'config.default_recipient',
    ]);
  });

  it('drops every SMTP credential field that lived in the P7.2 shape', () => {
    const keys = notificationSchemas.email.fields.map((f) => f.key);
    expect(keys).not.toContain('config.host');
    expect(keys).not.toContain('config.port');
    expect(keys).not.toContain('config.from');
    expect(keys).not.toContain('auth.username');
    expect(keys).not.toContain('auth.password');
  });

  it('sender_mail_instance picker carries options_source = data.mail.send_capable_instances', () => {
    const field = notificationSchemas.email.fields.find(
      (f) => f.key === 'config.sender_mail_instance',
    );
    expect(field?.type).toBe('select');
    expect(field?.options_source).toBe('data.mail.send_capable_instances');
    // Static `options` must be absent so the renderer takes the
    // dynamic path; the resolver prefers options_source when both
    // are present anyway, but absence keeps the schema honest.
    expect(field?.options).toBeUndefined();
    expect(field?.emptyGuidance).toMatch(/no send-capable mail accounts/i);
  });

  it('default_recipient is optional', () => {
    const field = notificationSchemas.email.fields.find(
      (f) => f.key === 'config.default_recipient',
    );
    expect(field?.optional).toBe(true);
    expect(field?.type).toBe('text');
  });

  it('exposes NO auth.type form field — a single-option select is dead UI; creds live on the picked mail account', () => {
    expect(notificationSchemas.email.fields.some((f) => f.key === 'auth.type')).toBe(false);
    // The record still gets auth.type='none' from the payload builder's
    // default — see the projectConnectionPayload tests below.
  });

  it('label drops "(SMTP)" qualifier — no longer SMTP-direct', () => {
    expect(notificationSchemas.email.label).toBe('Email');
  });

  it('probe metadata uses new kind+op shape', () => {
    expect(notificationSchemas.email.probe).toMatchObject({
      kind: 'mail',
      op: 'verify_send_capable',
    });
  });

  it('subtype-choices entry label is plain "Email"', () => {
    const entry = CONNECTION_SUBTYPE_CHOICES.notification.find((c) => c.subtype === 'email');
    expect(entry?.label).toBe('Email');
  });

  it('resolveConnectionSchema returns the rewritten email schema', () => {
    expect(resolveConnectionSchema('notification', 'email')).toBe(notificationSchemas.email);
  });
});

// ────────────────────────────────────────────────────────────────
// Dynamic-options rendering — sender_mail_instance picker
// ────────────────────────────────────────────────────────────────

const baseProps = (overrides: Partial<ConnectionsPageProps> = {}): ConnectionsPageProps => ({
  ...initialConnectionsPageState(),
  ...overrides,
});

const dialogShowingEmailForm = (
  overrides: Partial<ConnectionsDialogState> = {},
): ConnectionsDialogState => ({
  ...initialConnectionsDialogState(),
  stage: 'form',
  mode: 'create',
  kind: 'notification',
  subtype: 'email',
  ...overrides,
});

describe('renderConnectionsPage — email form dynamic options', () => {
  it('resolves dynamic options from props.dynamicOptions for the picker', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      dynamicOptions: {
        'data.mail.send_capable_instances': ['work-imap', 'gmail-personal'],
      },
    }));
    expect(html).toContain('value="work-imap"');
    expect(html).toContain('value="gmail-personal"');
    // Empty-state guidance is gated on isEmpty — should NOT appear
    // when the host supplied options.
    expect(html).not.toContain('No send-capable mail accounts');
  });

  it('does not visually select the first dynamic option until state has a value', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      dynamicOptions: {
        'data.mail.send_capable_instances': ['work-imap', 'gmail-personal'],
      },
    }));
    expect(html).toContain('— select —');
    expect(html).not.toMatch(/value="work-imap" selected/);
    expect(html).toMatch(
      /<button[^>]*data-action="connections-submit-form"[^>]*disabled[^>]*>/,
    );
  });

  it('renders empty-list inline guidance + disables the select when no options', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      dynamicOptions: { 'data.mail.send_capable_instances': [] },
    }));
    expect(html).toContain('No send-capable mail accounts');
    expect(html).toContain('Configure SMTP for an IMAP account');
    expect(html).toContain('grant Send permission');
    // Disabled select carries the empty placeholder.
    expect(html).toContain('— no options available —');
  });

  it('treats missing dynamicOptions entry as empty (defensive default)', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      // dynamicOptions completely omitted.
    }));
    expect(html).toContain('No send-capable mail accounts');
  });

  it('disables submit when the picker is empty (one validation surface, not two)', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      dynamicOptions: { 'data.mail.send_capable_instances': [] },
    }));
    expect(html).toMatch(
      /<button[^>]*data-action="connections-submit-form"[^>]*disabled[^>]*>/,
    );
  });

  it('renders the sender_mail_instance select even when value is preset (edit mode)', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({
        mode: 'edit',
        values: {
          name: 'newsletter',
          display_name: 'Newsletter',
          'config.sender_mail_instance': 'gmail-personal',
        },
      }),
      dynamicOptions: {
        'data.mail.send_capable_instances': ['work-imap', 'gmail-personal'],
      },
    }));
    // Selected attribute on the matched option.
    expect(html).toMatch(/value="gmail-personal" selected/);
  });

  it('reads the probe note from kind+op metadata', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      dynamicOptions: {
        'data.mail.send_capable_instances': ['work-imap'],
      },
    }));
    // Probe description picks up from the schema's `description` field
    // (preferred when present); fallback would synthesize from kind+op.
    expect(html).toContain('mail.verify_send_capable');
  });

  it('email form no longer renders an auth.type select (the dead single-option control was removed)', () => {
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      dynamicOptions: {
        'data.mail.send_capable_instances': ['work-imap'],
      },
    }));
    expect(html).not.toContain('conn-field="auth.type"');
  });

  it('re-asserts: per-host filter is the host responsibility — renderer uses whatever list the host supplied', () => {
    // Host supplies a deliberately ordered + filtered list (e.g. only
    // send-capable mail accounts via client-side filter on
    // collection.mail.list); renderer renders verbatim. This test
    // pins that contract — if a future renderer refactor smuggles
    // per-instance filtering in, this assertion fails.
    const html = renderConnectionsPage(baseProps({
      dialog: dialogShowingEmailForm({ values: { name: 'newsletter', display_name: 'Newsletter' } }),
      dynamicOptions: {
        'data.mail.send_capable_instances': ['z-last', 'a-first', 'm-middle'],
      },
    }));
    const a = html.indexOf('value="a-first"');
    const m = html.indexOf('value="m-middle"');
    const z = html.indexOf('value="z-last"');
    // Order preserved as supplied.
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(a);
    expect(a).toBeLessThan(m);
  });
});

// ────────────────────────────────────────────────────────────────
// Dynamic-options validation — sender_mail_instance membership
// ────────────────────────────────────────────────────────────────

const validEmailValues = (
  sender: string,
): ConnectionsDialogState['values'] => ({
  name: 'newsletter',
  display_name: 'Newsletter',
  'config.sender_mail_instance': sender,
  'auth.type': 'none',
});

describe('validateConnectionForm — notification/email dynamic option membership', () => {
  it('rejects a non-empty sender value that is not in the dynamic options list', () => {
    const schema = resolveConnectionSchema('notification', 'email');
    expect(schema).toBe(notificationSchemas.email);

    const error = validateConnectionForm(
      schema!,
      validEmailValues('stale-imap'),
      { [MAIL_SEND_CAPABLE_INSTANCES_SOURCE]: ['work-imap', 'gmail-send'] },
      'create',
    );

    expect(error).toBe(
      'Send from: "stale-imap" is no longer available — pick one of the listed options.',
    );
  });

  it('accepts a sender value that is present in the dynamic options list', () => {
    const schema = resolveConnectionSchema('notification', 'email');

    expect(validateConnectionForm(
      schema!,
      validEmailValues('gmail-send'),
      { [MAIL_SEND_CAPABLE_INSTANCES_SOURCE]: ['work-imap', 'gmail-send'] },
      'create',
    )).toBeNull();
  });

  it('returns the field emptyGuidance when the dynamic options list is empty', () => {
    const schema = resolveConnectionSchema('notification', 'email');
    const field = schema!.fields.find((f) => f.key === 'config.sender_mail_instance');

    expect(validateConnectionForm(
      schema!,
      validEmailValues('gmail-send'),
      { [MAIL_SEND_CAPABLE_INSTANCES_SOURCE]: [] },
      'create',
    )).toBe(field?.emptyGuidance);
  });

  it('uses the normal required-field error for an empty sender value when options exist', () => {
    const schema = resolveConnectionSchema('notification', 'email');

    expect(validateConnectionForm(
      schema!,
      validEmailValues(''),
      { [MAIL_SEND_CAPABLE_INSTANCES_SOURCE]: ['work-imap'] },
      'create',
    )).toBe('Send from is required.');
  });
});

// ────────────────────────────────────────────────────────────────
// Payload projection — email subtype maps to rpc shape
// ────────────────────────────────────────────────────────────────

describe('projectConnectionPayload — notification/email', () => {
  it('projects sender_mail_instance + default_recipient + auth.type=none', () => {
    const payload = projectConnectionPayload(
      notificationSchemas.email,
      {
        name: 'newsletter',
        display_name: 'Newsletter',
        'config.sender_mail_instance': 'gmail-personal',
        'config.default_recipient': 'list@example.com',
        'auth.type': 'none',
      },
      'notification',
      'email',
    );
    expect(payload.kind).toBe('notification');
    expect(payload.subtype).toBe('email');
    expect(payload.config).toEqual({
      sender_mail_instance: 'gmail-personal',
      default_recipient: 'list@example.com',
    });
    expect(payload.auth).toEqual({ type: 'none' });
  });

  it('drops blank optional default_recipient', () => {
    const payload = projectConnectionPayload(
      notificationSchemas.email,
      {
        name: 'newsletter',
        display_name: 'Newsletter',
        'config.sender_mail_instance': 'gmail-personal',
        'config.default_recipient': '',
        'auth.type': 'none',
      },
      'notification',
      'email',
    );
    expect(payload.config).toEqual({ sender_mail_instance: 'gmail-personal' });
    expect(payload.config).not.toHaveProperty('default_recipient');
  });

  it('does not project legacy SMTP keys (defense-in-depth — the schema removed them but stale form values must not leak)', () => {
    const payload = projectConnectionPayload(
      notificationSchemas.email,
      {
        name: 'newsletter',
        display_name: 'Newsletter',
        'config.sender_mail_instance': 'gmail-personal',
        // Stale leftover from the P7.2 shape — must not appear in
        // the projected payload because the schema doesn't enumerate it.
        'config.host': 'smtp.gmail.com',
        'config.port': '587',
        'auth.type': 'none',
        'auth.username': 'leftover',
        'auth.password': 'leftover-pw',
      },
      'notification',
      'email',
    );
    expect(payload.config).toEqual({ sender_mail_instance: 'gmail-personal' });
    expect(payload.auth).toEqual({ type: 'none' });
  });
});
