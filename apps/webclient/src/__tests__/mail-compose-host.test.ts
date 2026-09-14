/** D-145 PA7 / D-172 P2 — the pure halves of the mail compose host.
 *
 *  The DOM half is verified in a real browser (see the verify drive) because
 *  this repo has no jsdom/happy-dom and the webclient's fake-document double
 *  cannot exercise `closest` / `innerHTML` / delegated listeners — the exact
 *  machinery this host is made of. What IS testable without a DOM is pinned
 *  here: the two mappings where a wrong field is silent rather than loud.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_COMPOSE_REWRITE_ACTIONS,
  REWRITE_COMPOSED_MAIL_RECIPE_ID,
  SEND_COMPOSED_MAIL_RECIPE_ID,
  composeRewriteRecipeConfig,
  composePayloadToSendRecipeConfig,
  type ComposeMailSendPayload,
  type MailSenderSourceOption,
} from '@recued/contracts';

import {
  mailComposeOpenSender,
  mailComposeReadinessFromInstances,
  mailComposeSubmitOutcomeFromExecuteResponse,
  mailDraftContentFromCompose,
  mailSendReadinessFromInstances,
  rewrittenMailBodyFromExecuteResponse,
  senderOptionFromInstance,
} from '../mail/mail-compose-host.js';

describe('mail compose send dispatch result', () => {
  it('distinguishes a durable approval hold from a completed send', () => {
    expect(mailComposeSubmitOutcomeFromExecuteResponse({
      success: false,
      awaiting_approval: true,
    })).toBe('held');
    expect(mailComposeSubmitOutcomeFromExecuteResponse({
      success: true,
    })).toBe('sent');
  });

  it('fails closed on terminal failures and contradictory response shapes', () => {
    for (const response of [
      { success: false, errors: ['no checkpoint'] },
      { success: true, awaiting_approval: true },
      { awaiting_approval: true },
      null,
      [],
    ]) {
      expect(mailComposeSubmitOutcomeFromExecuteResponse(response)).toBeNull();
    }
  });
});

describe('mail compose governed body rewrite', () => {
  it('maps each supported action to the hidden recipe without exposing non-body draft fields', () => {
    const values = {
      ...EMPTY_MAIL_COMPOSE_VALUES,
      body: 'Hello bob@example.com',
      subject: 'Private subject',
      to: ['bob@example.com'],
      cc: ['copy@example.com'],
      bcc: ['blind@example.com'],
      attachments: ['file:secret'],
      in_reply_to: 'mail:thread',
      sender_source: 'work',
    };
    for (const action of MAIL_COMPOSE_REWRITE_ACTIONS) {
      const config = composeRewriteRecipeConfig({
        values,
        sender_email: 'owner@example.com',
      }, action);
      expect(config.body).toBe(values.body);
      expect(config.sender_email).toBe('owner@example.com');
      expect(config.to).toEqual(values.to);
      expect(config.style).toEqual(expect.any(String));
      expect(config.instructions).toContain('Return only the rewritten email body');
      expect(config).not.toHaveProperty('subject');
      expect(config).not.toHaveProperty('attachments');
      expect(config).not.toHaveProperty('in_reply_to');
      expect(config).not.toHaveProperty('sender_source');
    }
    expect(REWRITE_COMPOSED_MAIL_RECIPE_ID).toBe('rewrite-composed-mail');
  });

  it('copies recipient arrays before handing config to execute', () => {
    const to = ['bob@example.com'];
    const config = composeRewriteRecipeConfig({
      values: { body: 'Hi', to, cc: [], bcc: [] },
      sender_email: 'owner@example.com',
    }, 'polish');
    to.push('mutated@example.com');
    expect(config.to).toEqual(['bob@example.com']);
  });

  it('accepts only non-empty text from a successful terminal execute response', () => {
    expect(rewrittenMailBodyFromExecuteResponse({
      success: true,
      output: { render: [{ type: 'summary', data: {} }, { type: 'text', data: 'Better body' }] },
    })).toBe('Better body');
    expect(rewrittenMailBodyFromExecuteResponse({
      success: true,
      awaiting_approval: true,
      output: { render: [{ type: 'text', data: 'not terminal' }] },
    })).toBeNull();
    expect(rewrittenMailBodyFromExecuteResponse({
      success: false,
      output: { render: [{ type: 'text', data: 'failed' }] },
    })).toBeNull();
    expect(rewrittenMailBodyFromExecuteResponse({
      success: true,
      output: { render: [{ type: 'text', data: '   ' }] },
    })).toBeNull();
  });
});

describe('mail compose send readiness', () => {
  it('distinguishes no mailbox from connected read-only mail', () => {
    expect(mailSendReadinessFromInstances([])).toEqual({ status: 'none' });

    const readiness = mailSendReadinessFromInstances([{
      slug: 'archive',
      adapter_type: 'imap',
      send_capable: false,
      draft_capable: false,
      account_email: 'archive@example.com',
    }]);
    expect(readiness.status).toBe('read_only');
    if (readiness.status === 'read_only') {
      expect(readiness.mailboxes).toHaveLength(1);
      expect(readiness.mailboxes[0]?.mail_instance_slug).toBe('archive');
    }
  });

  it('is ready when at least one mailbox can send without hiding read-only peers', () => {
    const readiness = mailSendReadinessFromInstances([
      {
        slug: 'archive', adapter_type: 'imap', send_capable: false,
        draft_capable: false, account_email: 'archive@example.com',
      },
      {
        slug: 'work', adapter_type: 'gmail', send_capable: true,
        draft_capable: false, account_email: 'work@example.com',
      },
    ]);
    expect(readiness.status).toBe('ready');
    if (readiness.status === 'ready') {
      expect(readiness.mailboxes.map((mailbox) => mailbox.id)).toEqual([
        'archive',
        'work',
      ]);
    }
  });
});

describe('D-127 — mail instance row → sender option', () => {
  it('carries the row slug as mail_instance_slug', () => {
    const opt = senderOptionFromInstance({
      slug: 'work',
      adapter_type: 'imap',
      send_capable: true,
      account_email: 'alice@example.com',
    });
    // ⛔ The slug is the ROW's, never derived from the id/label. The contract
    // note on MailSenderSourceOption records why: a trailing-segment heuristic
    // collapsed `recued.mail_message` and `hubspot.<conn>.mail_message`.
    expect(opt.mail_instance_slug).toBe('work');
    expect(opt.id).toBe('work');
    expect(opt.account_email).toBe('alice@example.com');
    expect(opt.send_capable).toBe(true);
  });

  it('labels the known adapter kinds and passes an unknown one through', () => {
    const label = (adapter_type: string): string =>
      senderOptionFromInstance({
        slug: 's', adapter_type, send_capable: true, account_email: 'a@b.test',
      }).label;
    expect(label('gmail')).toBe('a@b.test (Gmail)');
    expect(label('graph')).toBe('a@b.test (Outlook)');
    expect(label('imap')).toBe('a@b.test (IMAP)');
    // An adapter we have no copy for must still produce a usable label rather
    // than "undefined" — the picker is how the owner tells accounts apart.
    expect(label('exchange-2003')).toBe('a@b.test (exchange-2003)');
  });

  it('falls back to the slug when the account email is blank', () => {
    const opt = senderOptionFromInstance({
      slug: 'work', adapter_type: 'imap', send_capable: true, account_email: '',
    });
    expect(opt.label).toBe('work (IMAP)');
    // ⚠ account_email stays empty — the LABEL degrades, the DATA does not get
    // a fabricated address. The self-loop guard compares against this field.
    expect(opt.account_email).toBe('');
  });

  it('preserves send_capable: false so the dialog can filter it out', () => {
    expect(senderOptionFromInstance({
      slug: 'ro', adapter_type: 'imap', send_capable: false, account_email: 'a@b.test',
    }).send_capable).toBe(false);
  });
});

describe('D-177 N.12 — send payload → execute config', () => {
  const base: ComposeMailSendPayload = {
    instance: 'work',
    to: ['bob@elsewhere.test'],
    subject: 'hello',
    body_text: 'body',
  };

  it('renames the two fields that differ between the rpc and ingredient shapes', () => {
    const config = composePayloadToSendRecipeConfig(base);
    // `instance` → `sender_mail_instance` and `body_text` → `body` +
    // `body_format`. Hand-mapping this per call site is how a field goes
    // missing on one surface and not another.
    expect(config).toEqual({
      sender_mail_instance: 'work',
      to: ['bob@elsewhere.test'],
      subject: 'hello',
      body: 'body',
      body_format: 'text',
    });
  });

  it('omits empty optionals rather than sending them empty', () => {
    const config = composePayloadToSendRecipeConfig({
      ...base, cc: [], bcc: [], attachments: [], references: [],
    });
    for (const key of ['cc', 'bcc', 'attachments', 'references']) {
      expect(Object.hasOwn(config, key), key).toBe(false);
    }
  });

  it('carries attachments through as ids', () => {
    const config = composePayloadToSendRecipeConfig({
      ...base, attachments: ['file:a', 'file:b'],
    });
    expect(config.attachments).toEqual(['file:a', 'file:b']);
  });

  it('carries threading fields when present', () => {
    const config = composePayloadToSendRecipeConfig({
      ...base, in_reply_to: '<mid@x>', references: ['<mid@x>'], cc: ['c@x.test'],
    });
    expect(config.in_reply_to).toBe('<mid@x>');
    expect(config.references).toEqual(['<mid@x>']);
    expect(config.cc).toEqual(['c@x.test']);
  });

  it('copies arrays instead of aliasing the payload', () => {
    const attachments = ['file:a'];
    const config = composePayloadToSendRecipeConfig({ ...base, attachments });
    attachments.push('file:mutated');
    // The config is durable input to a gated run — it must not change under a
    // caller that reuses its array afterwards.
    expect(config.attachments).toEqual(['file:a']);
  });

  it('names the recipe the route dispatches', () => {
    expect(SEND_COMPOSED_MAIL_RECIPE_ID).toBe('send-composed-mail');
  });
});


describe('D-264 — saving a draft uses the DRAFT gate', () => {
  /** The one line that makes draft-only compose work, and the one whose
   *  removal is silent: without `'draft'` the save path runs the SEND rule and
   *  a draft-only mailbox fails `sender_source` instead of saving. */
  const option = (over: Partial<MailSenderSourceOption>): MailSenderSourceOption => ({
    id: 'work',
    label: 'me@example.com (IMAP)',
    account_email: 'me@example.com',
    send_capable: false,
    draft_capable: false,
    mail_instance_slug: 'work',
    ...over,
  });
  const values = {
    ...EMPTY_MAIL_COMPOSE_VALUES,
    sender_source: 'work',
    to: ['them@example.com'],
    subject: 'Subject',
    body: 'Body',
  };
  const hooks = (source: MailSenderSourceOption) => ({
    resolveContactEmail: (ref: string) => ref,
    findSenderSource: (id: string) => (id === source.id ? source : null),
  });

  it('saves against a mailbox that can draft but cannot send', () => {
    const result = mailDraftContentFromCompose(values, hooks(option({ draft_capable: true })));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.sender_mail_instance).toBe('work');
      expect(result.content.subject).toBe('Subject');
    }
  });

  it('still refuses a mailbox that can do neither', () => {
    const result = mailDraftContentFromCompose(values, hooks(option({})));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.sender_source).toBeDefined();
  });

  it('carries reply-thread fields the compose form does not own', () => {
    const prior = {
      sender_mail_instance: 'work', to: ['them@example.com'],
      subject: 'Earlier', body: 'Earlier', body_format: 'text' as const,
      references: ['<a@example.com>'], reply_to: 'other@example.com',
    };
    const result = mailDraftContentFromCompose(
      values, hooks(option({ draft_capable: true })), prior,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.references).toEqual(['<a@example.com>']);
      expect(result.content.reply_to).toBe('other@example.com');
    }
  });
});


describe('D-264 — readiness has a third tier, and the axis is not mirrored', () => {
  const row = (over: Partial<{
    slug: string; adapter_type: string; send_capable: boolean;
    draft_capable: boolean; account_email: string;
  }> = {}) => ({
    slug: 'archive', adapter_type: 'imap', send_capable: false,
    draft_capable: false, account_email: 'archive@example.com', ...over,
  });

  it('is draft_only — NOT read_only — when a mailbox can draft but none can send', () => {
    const readiness = mailComposeReadinessFromInstances([row({ draft_capable: true })]);
    expect(readiness.status).toBe('draft_only');
  });

  it('stays read_only when no mailbox can do either', () => {
    expect(mailComposeReadinessFromInstances([row()]).status).toBe('read_only');
  });

  it('prefers ready over draft_only — one sending mailbox makes the surface whole', () => {
    const readiness = mailComposeReadinessFromInstances([
      row({ slug: 'imap', draft_capable: true }),
      row({ slug: 'work', adapter_type: 'gmail', send_capable: true }),
    ]);
    expect(readiness.status).toBe('ready');
  });

  it('never derives draft capability from send capability', () => {
    // Independent grants: `gmail.send` without `gmail.modify` sends and cannot
    // draft. Mirroring one into the other would offer draft-only compose
    // against a mailbox that cannot hold a draft.
    const readiness = mailComposeReadinessFromInstances([
      row({ send_capable: true, draft_capable: false }),
    ]);
    expect(readiness.status).toBe('ready');
    if (readiness.status === 'ready') {
      expect(readiness.mailboxes[0]?.send_capable).toBe(true);
      expect(readiness.mailboxes[0]?.draft_capable).toBe(false);
    }
  });

  it('reads an ABSENT axis as false — an older server answers without the field', () => {
    const legacy = { slug: 'archive', adapter_type: 'imap', send_capable: true,
      account_email: 'a@example.com' } as never;
    const readiness = mailComposeReadinessFromInstances([legacy]);
    expect(readiness.status).toBe('ready');
    if (readiness.status === 'ready') {
      expect(readiness.mailboxes[0]?.draft_capable).toBe(false);
    }
  });
});


describe('D-264 — compose OPENS for a draft-only mailbox', () => {
  /** The join Codex found dead: readiness said `draft_only`, both entry points
   *  passed it through, and the open gate still demanded `ready` plus a
   *  SEND-capable sender. It returned false, both callers ignore that, and New
   *  mail silently did nothing for exactly the users D-264 exists for. */
  const option = (over: Partial<MailSenderSourceOption>): MailSenderSourceOption => ({
    id: 'imap', label: 'me@example.com (IMAP)', account_email: 'me@example.com',
    send_capable: false, draft_capable: false, mail_instance_slug: 'imap', ...over,
  });

  it('opens on draft_only, defaulting to the draft-capable sender', () => {
    const draftOnly = option({ draft_capable: true });
    const sender = mailComposeOpenSender({ status: 'draft_only', mailboxes: [draftOnly] }, [draftOnly]);
    expect(sender?.id).toBe('imap');
  });

  it('prefers a send-capable sender on a mixed install', () => {
    // Opening in the most restricted state when a fully usable mailbox exists
    // would disable Send for no reason.
    const sources = [option({ draft_capable: true }), option({ id: 'gmail', send_capable: true })];
    expect(mailComposeOpenSender({ status: 'ready', mailboxes: sources }, sources)?.id).toBe('gmail');
  });

  it('stays shut on every status that is not openable', () => {
    const draftOnly = option({ draft_capable: true });
    for (const status of ['loading', 'none', 'unavailable'] as const) {
      expect(mailComposeOpenSender({ status }, [draftOnly])).toBeNull();
    }
    expect(mailComposeOpenSender({ status: 'read_only', mailboxes: [] }, [])).toBeNull();
  });

  it('stays shut when readiness says openable but no source can do anything', () => {
    // Defence in depth against the two halves disagreeing — which is how this
    // was broken in the first place, from the other direction.
    const inert = option({});
    expect(mailComposeOpenSender({ status: 'draft_only', mailboxes: [inert] }, [inert])).toBeNull();
  });
});
