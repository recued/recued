/** D-210 A.8 slice 3d-2b — the ask landing page's held-op details block.
 *
 *  The leaf half: `renderAskLandingHtml` gains an optional pre-formatted
 *  `details` list rendered above the options. Everything here is about the
 *  RENDER being an honest report of what it was handed — the formatting
 *  decisions themselves live server-side (`ask-landing-held-op-details.ts`)
 *  and are tested there. */

import { describe, expect, it } from 'vitest';
import {
  parseAskLandingSubmission,
  renderAskLandingHtml,
  type AskLandingDetail,
  type AskOption,
  type PendingAsk,
} from '@recued/notification';

const askOptions: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

const createPendingAsk = (overrides: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: 'ask-1',
  message: { title: 'Approve scheduling.materialize', text: 'Approve?' },
  options: askOptions,
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: 'cp-1' },
  fanout_channels: ['email'],
  status: 'open',
  created_at: 1234,
  ...overrides,
});

const DETAILS: readonly AskLandingDetail[] = [
  { label: 'Summary', value: 'Table for four' },
  { label: 'Slot start', value: '20 Jul 2026, 19:30 GMT+2' },
  { label: 'Tell the visitor their booking is confirmed', value: 'No' },
];

const renderOpen = (
  details?: readonly AskLandingDetail[],
  details_heading?: string,
): string =>
  renderAskLandingHtml({
    ask: createPendingAsk(),
    form_nonce: 'nonce-1',
    action: '/ask/ask-1',
    ...(details !== undefined ? { details } : {}),
    ...(details_heading !== undefined ? { details_heading } : {}),
  });

describe('D-210 A.8 3d-2b — ask landing details block', () => {
  it('renders every supplied label and value on the open page', () => {
    const html = renderOpen(DETAILS);
    for (const d of DETAILS) {
      expect(html).toContain(`<dt>${d.label}</dt>`);
      expect(html).toContain(`<dd>${d.value}</dd>`);
    }
    // INSIDE the form and above the options. Both halves matter: above the
    // options so the decision is made with the values in view, and inside
    // the form because once a row is an `<input>` (3d-2c) a block outside it
    // is a set of controls the browser never submits — the owner edits the
    // slot, approves, and the ORIGINAL value lands.
    expect(html.indexOf('<form')).toBeLessThan(html.indexOf('class="details"'));
    expect(html.indexOf('class="details"')).toBeLessThan(html.indexOf('<fieldset>'));
  });

  it('uses the supplied heading, and a neutral default without one', () => {
    expect(renderOpen(DETAILS, 'Create a booking')).toContain('Create a booking');
    expect(renderOpen(DETAILS)).toContain('What this will do');
  });

  it('renders NO block for absent or empty details — never an empty frame', () => {
    // A block headed "What this will do" that lists nothing is a worse claim
    // than no block: it asserts the approval commits to nothing.
    expect(renderOpen(undefined)).not.toContain('class="details"');
    expect(renderOpen([])).not.toContain('class="details"');
    expect(renderOpen([])).not.toContain('What this will do');
  });

  it('leaves the pre-3d-2b page byte-identical when no details are passed', () => {
    // The additive half must not perturb the surface it extends.
    expect(renderOpen(undefined)).toBe(
      renderAskLandingHtml({
        ask: createPendingAsk(),
        form_nonce: 'nonce-1',
        action: '/ask/ask-1',
      }),
    );
  });

  it('never renders details on the answered page', () => {
    // Once answered the hold is consumed — there is nothing left to resolve
    // and nothing the reader can still act on.
    for (const status of ['answered', 'handled'] as const) {
      const html = renderAskLandingHtml({
        ask: createPendingAsk({
          status,
          answer: { option: 'approve', answered_at: 99 },
        }),
        details: DETAILS,
        details_heading: 'Create a booking',
        form_nonce: '',
        action: '',
      });
      expect(html).not.toContain('class="details"');
      expect(html).not.toContain('Table for four');
      expect(html).not.toContain('Create a booking');
    }
  });

  it('escapes hostile HTML in labels, values, and the heading', () => {
    const html = renderOpen(
      [{ label: '<img src=x onerror=alert(1)>', value: '</dd><script>alert(2)</script>' }],
      '<svg onload=alert(3)>',
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)');
    expect(html).not.toContain('<svg onload=');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('&lt;script&gt;alert(2)');
    expect(html).toContain('&lt;svg onload=');
  });

  it('keeps the <dl> content model valid — only dt/dd/div inside it', () => {
    // The legend is a claim the block makes about itself and must not be
    // smuggled in as a stray child of the list.
    const html = renderOpen(DETAILS, 'Create a booking');
    const dl = html.slice(html.indexOf('<dl>'), html.indexOf('</dl>'));
    expect(dl).not.toContain('details-legend');
    expect(html.indexOf('details-legend')).toBeLessThan(html.indexOf('<dl>'));
  });
});

// ────────────────────────────────────────────────────────────────
// 3d-2c — editable controls + the widened submission decoder
// ────────────────────────────────────────────────────────────────

const EDITABLE: readonly AskLandingDetail[] = [
  {
    label: 'Summary',
    value: 'Table for four',
    edit: { key: 'title', control: 'text', value: 'Table for four', required: true },
  },
  {
    label: 'Slot start',
    value: '20 Jul 2026, 19:30 CEST',
    edit: { key: 'start_at', control: 'datetime-local', value: '2026-07-20T19:30' },
  },
  {
    label: 'Tell the visitor',
    value: 'No',
    edit: { key: 'notify_visitor', control: 'checkbox', value: 'on', checked: false },
  },
];

describe('D-210 A.8 3d-2c — editable controls', () => {
  it('renders each control under the edit. namespace, INSIDE the form', () => {
    const html = renderOpen(EDITABLE);
    expect(html).toContain('name="edit.title"');
    expect(html).toContain('name="edit.start_at"');
    expect(html).toContain('name="edit.notify_visitor"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('value="2026-07-20T19:30"');
    // Controls outside the form are controls the browser never submits.
    expect(html.indexOf('<form')).toBeLessThan(html.indexOf('name="edit.title"'));
    expect(html.indexOf('name="edit.notify_visitor"')).toBeLessThan(
      html.indexOf('</form>'),
    );
  });

  it('carries checked only when the box is ticked', () => {
    expect(renderOpen(EDITABLE)).not.toContain('checked');
    const ticked = renderOpen([
      { ...EDITABLE[2]!, edit: { ...EDITABLE[2]!.edit!, checked: true } },
    ]);
    expect(ticked).toContain('checked');
  });

  it('still renders a read-only row for a detail with no edit control', () => {
    // The 3d-2b shape survives — a picker the page cannot populate stays text.
    const html = renderOpen([
      { label: 'Calendar', value: 'Work' },
      EDITABLE[0]!,
    ]);
    expect(html).toContain('<dd>Work</dd>');
    expect(html).toContain('name="edit.title"');
  });

  it('renders the refusal banner above the form when one is supplied', () => {
    const html = renderAskLandingHtml({
      ask: createPendingAsk(),
      form_nonce: 'n',
      action: '/ask/ask-1',
      details: EDITABLE,
      details_error: 'Slot start must be a date and time (in Europe/Paris).',
    });
    expect(html).toContain('Slot start must be a date and time');
    expect(html.indexOf('class="error"')).toBeLessThan(html.indexOf('<form'));
  });

  it('escapes hostile content in control keys, values, and patterns', () => {
    const html = renderOpen([
      {
        label: 'X',
        value: 'x',
        edit: {
          key: 'a" onfocus="alert(1)',
          control: 'text',
          value: '"><script>alert(2)</script>',
          pattern: '"><img src=x>',
        },
      },
    ]);
    expect(html).not.toContain('onfocus="alert(1)');
    expect(html).not.toContain('<script>alert(2)');
    expect(html).not.toContain('<img src=x>');
  });
});

describe('D-210 A.8 3d-2c — parseAskLandingSubmission with edits', () => {
  const body = (f: Record<string, string>): string =>
    Object.entries(f)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

  const base = { form_nonce: 'n1', ask_id: 'ask-1', option: 'approve' };

  it('strips the prefix and returns raw strings, un-coerced', () => {
    const out = parseAskLandingSubmission(
      body({ ...base, 'edit.title': ' spaced ', 'edit.start_at': '2026-07-20T20:00' }),
    );
    expect('error' in out).toBe(false);
    expect((out as { edits?: Record<string, string> }).edits).toEqual({
      title: ' spaced ',
      start_at: '2026-07-20T20:00',
    });
  });

  it('omits edits entirely when the body carries none', () => {
    const out = parseAskLandingSubmission(body(base));
    expect(Object.hasOwn(out as object, 'edits')).toBe(false);
  });

  it('still refuses an unknown NON-prefixed key', () => {
    // The closed allowlist stays closed; edits are admitted by prefix only.
    expect(parseAskLandingSubmission(body({ ...base, hold_id: 'cp-9' }))).toEqual({
      error: 'unknown_field',
    });
  });

  it('refuses a bare `edit.`, a prototype key, and a REPEATED key', () => {
    // A repeated key is a tampered body — silently keeping one of two
    // conflicting values for the same arg is exactly the quiet choice an
    // approval must not make.
    expect(parseAskLandingSubmission(body({ ...base, 'edit.': 'x' }))).toEqual({
      error: 'unknown_field',
    });
    expect(parseAskLandingSubmission(body({ ...base, 'edit.__proto__': 'x' }))).toEqual({
      error: 'unknown_field',
    });
    expect(
      parseAskLandingSubmission(`${body(base)}&edit.title=a&edit.title=b`),
    ).toEqual({ error: 'unknown_field' });
  });

  it('keeps an empty edit value — that is how a field is cleared', () => {
    const out = parseAskLandingSubmission(body({ ...base, 'edit.body': '' }));
    expect((out as { edits?: Record<string, string> }).edits).toEqual({ body: '' });
  });
});
