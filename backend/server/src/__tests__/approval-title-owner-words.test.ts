/** An approval is titled the way the owner knows the action.
 *
 *  ⛔ "Approve mail-send (write)" reached the owner as an email subject (live,
 *  2026-10-18): an operation's internal name and a risk tier they see nowhere
 *  else. A held run records its recipe's title on the checkpoint, and the ask is
 *  titled by it: "Approve: Send a composed email".
 *
 *  ⛔ AND THE CARD STILL ASKS FOR A SECOND CLICK. The card read the tier off the
 *  title's "(write)" to arm its two-step approve; with the tier gone from the
 *  title it reads it from the body's second line, which the same composer
 *  writes from the same tier. The real run, the real composer and the real card,
 *  so a reworded tier sentence cannot quietly switch the second click off. */

import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ExecutionSource, IngredientManifest, RecipeDefinition } from '@recued/contracts';
import { buildPreflightAsk } from '@recued/gateway';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry } from '@recued/storage';
import { renderAskCard, ASK_CARD_GRANT_ATTR, ASK_CARD_OPTION_ATTR, type AskCardModel } from '@recued/ui-shared/approval-card';

import { createAskActionNamer } from '../ask-card-action-name.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

interface FakeEl {
  tagName: string; className: string; textContent: string; type: string;
  disabled: boolean; hidden: boolean; value: string; maxLength: number;
  required: boolean; rows: number; placeholder: string; id: string; title: string;
  attrs: Map<string, string>; children: FakeEl[]; listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void; removeAttribute(k: string): void;
  getAttribute(k: string): string | null; appendChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void; focus(): void; click(): void;
}

const makeFakeDocument = (): { activeElement: FakeEl | null; createElement(t: string): FakeEl } => {
  const doc = {
    activeElement: null as FakeEl | null,
    createElement(tag: string): FakeEl {
      const el: FakeEl = {
        tagName: tag.toUpperCase(),
        className: '', textContent: '', value: '', maxLength: 0,
        required: false, rows: 0, placeholder: '', title: '', id: '',
        type: '', disabled: false, hidden: false,
        attrs: new Map(), children: [], listeners: new Map(),
        setAttribute(k, v) { el.attrs.set(k, v); },
        removeAttribute(k) { el.attrs.delete(k); },
        getAttribute(k) { return el.attrs.get(k) ?? null; },
        appendChild(c) { el.children.push(c); return c; },
        addEventListener(type, fn) {
          const list = el.listeners.get(type) ?? [];
          list.push(fn);
          el.listeners.set(type, list);
        },
        focus() { doc.activeElement = el; },
        click() {
          if (el.disabled) return;
          for (const fn of el.listeners.get('click') ?? []) fn();
        },
      };
      return el;
    },
  };
  return doc;
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};
const allText = (el: FakeEl, out: string[] = []): string[] => {
  if (el.textContent) out.push(el.textContent);
  for (const c of el.children) allText(c, out);
  return out;
};

/** The card for a held send, as the composer writes it for this tier. */
const card = (risk_tier: string, title?: string, text?: string, named?: 'named') => {
  const checkpoint = {
    checkpoint_id: 'cp1', run_id: 'run1', recipe_id: 'send-composed-mail', gated_step_id: 'send',
    step_state: { send: { input: { to: ['sam@example.test'], subject: 'Renewal update' } } }, created_at: 0,
    preflight_context: { recipe_title: 'Send a composed email' },
  } as Checkpoint;
  const ask = buildPreflightAsk({
    checkpoint,
    context: { recipe_id: 'send-composed-mail', gated_step_id: 'send', tool_slug: 'mail-send', risk_tier },
  });
  // The name the server gives the action, from the ask it raised and the
  // bundled manifests.
  const action_name = named === undefined
    ? null
    : createAskActionNamer({ getManifest: (slug) => createManifestRegistry().get(slug) })(
      { handler_kind: ask.handler.kind, handler_payload: ask.handler.payload },
    );
  const answered: string[] = [];
  const model: AskCardModel = {
    ask_id: 'a1',
    title: title ?? ask.message.title,
    text: text ?? ask.message.text,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    ...(action_name !== null ? { action_name } : {}),
  };
  const el = renderAskCard(makeFakeDocument() as unknown as Document, model, {
    onAnswer: (id: string) => { answered.push(id); },
  }) as unknown as FakeEl;
  return {
    el, answered, title: ask.message.title, action_name, approve: collectByAttr(el, ASK_CARD_OPTION_ATTR)[0]!,
  };
};

describe('an approval in the owner\'s words, on the card', () => {
  for (const [tier, title] of [
    ['write', 'Approve: Send a composed email'],
    ['admin', 'Approve: Send a composed email — changes account settings or access'],
    ['destructive', 'Approve: Send a composed email — cannot be undone'],
  ] as const) {
    it(`${tier}: titled by the recipe, and approving still takes a second click`, () => {
      const c = card(tier);
      expect(c.title).toBe(title);
      expect(allText(c.el)).toContain(title);
      c.approve.click();
      expect(c.answered).toEqual([]);
      expect(c.approve.textContent).toBe('Confirm Approve');
      c.approve.click();
      expect(c.answered).toEqual(['approve']);
    });
  }

  it('a read-tier hold is answered with one click, as before', () => {
    const c = card('read');
    expect(c.title).toBe('Approve: Send a composed email');
    c.approve.click();
    expect(c.answered).toEqual(['approve']);
  });

  it('an older server\'s title still reads as before: the tier in words, and a second click', () => {
    const c = card('write', 'Approve mail-send (write)');
    expect(allText(c.el)).toContain('Approve write action');
    c.approve.click();
    expect(c.answered).toEqual([]);
  });
});

describe('a held run records its recipe\'s title, and its ask is titled by it', () => {
  it('the owner\'s held send', async () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register({
      slug: 'mail-send', name: 'mail-send', description: 'Test mail-send manifest',
      author: 'recued', kind: 'storage', risk_tier: 'write', version: 1,
      category: 'action', input: {}, output: { message_id: 'message_id' },
    } as unknown as IngredientManifest);
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register({
      recipe_id: 'send-a-note', version: 1, ttl: 60,
      metadata: { name: ' Send a note ', description: 'One email.', author: 'test', supported_platforms: ['test'] },
      variables: {}, prefetch_steps: [],
      steps: [{
        id: 'send', ingredient: 'mail-send',
        input: { sender_mail_instance: 'work', to: ['bob@example.com'], subject: 'hi', body: 'hello' },
      }],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition);
    const checkpoints: Checkpoint[] = [];
    const ask = vi.fn(async () => ({ ask_id: 'ask-1' }));
    const deps: ExecuteHandlerDeps = {
      recipeStore,
      executorConfig: { manifests, kernelDispatchers: { mailSend: vi.fn() } as never },
      baseVault: {},
      instanceId: 'approval-title-owner-words',
      checkpointStore: {
        write: vi.fn(async (cp: Checkpoint) => { checkpoints.push(cp); }),
      } as unknown as ExecuteHandlerDeps['checkpointStore'],
      auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
      preflightNotifier: { ask, registerAskHandler: vi.fn(), notify: vi.fn(async () => undefined) },
    };
    const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner-1', client_token_id: 'client-1' };
    const response = await handleExecute(deps, { recipe_id: 'send-a-note', trigger_source: 'chat', execution_source: owner });
    expect(response.awaiting_approval).toBe(true);
    expect(checkpoints[0]!.preflight_context?.recipe_title).toBe('Send a note');
    expect(ask).toHaveBeenCalledTimes(1);
    const message = (ask.mock.calls[0] as unknown as [{ title?: string; text: string }])[0];
    expect(message.title).toBe('Approve: Send a note');
    // The body opens with the title too; the ids sit on line 3, where the card reads them.
    expect(message.text.split('\n')[0]).toBe('"Send a note" is waiting for your approval.');
    expect(message.text.split('\n')[2]).toBe('Technical: recipe send-a-note, step send, action mail-send.');
  });
});

describe('the "Allow this session" block, read by the card', () => {
  const tagged = (el: FakeEl, tag: string, out: FakeEl[] = []): FakeEl[] => {
    if (el.tagName === tag) out.push(el);
    for (const c of el.children) tagged(c, tag, out);
    return out;
  };

  it('is never read as an argument of the call, even where a fixed value holds a colon', () => {
    const checkpoint = {
      checkpoint_id: 'cp1', run_id: 'run1', recipe_id: 'post-update', gated_step_id: 'post',
      step_state: {}, created_at: 0,
    } as Checkpoint;
    const ask = buildPreflightAsk({
      checkpoint,
      context: {
        recipe_id: 'post-update', gated_step_id: 'post', tool_slug: 'http-post', risk_tier: 'write',
        session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write', grant_mode: 'open' },
        open_projection_preview: {
          pinned: [{ label: 'url', value: '"https://api.example.test/v1/notes"' }, { label: 'cc', value: '[]' }],
          varying: [{ label: 'body ← context.event.payload.text', origin: 'context_event' }],
        },
        batch: {
          batch_id: 'b1', payload_version: 1, unit: { kind: 'turn', id: 'turn:1' },
          items: [{ member_id: 'm1', canonical_payload_hash: 'h1', summary: 's',
            args_preview: { url: 'https://api.example.test/v1/notes', body: 'hi' } }],
        },
      } as never,
    });
    // "- " at the left margin: the card reads only an indented `key: value` as an
    // argument, so the colon in the line and in the value is safe.
    expect(ask.message.text).toContain('\n- URL: https://api.example.test/v1/notes\n');
    const el = renderAskCard(makeFakeDocument() as unknown as Document, {
      ask_id: 'a1', title: ask.message.title, text: ask.message.text,
      options: [{ id: 'approve', label: 'Approve' }, { id: 'allow_session', label: 'Allow this session' }, { id: 'deny', label: 'Deny' }],
    }, { onAnswer: () => undefined }) as unknown as FakeEl;
    // The card's rows are the call's own arguments, once each.
    const labels = tagged(el, 'DT').map((dt) => dt.textContent);
    expect(labels.filter((label) => /url/i.test(label))).toHaveLength(1);
    expect(labels.some((label) => label.includes(' = ') || label.startsWith('- '))).toBe(false);
  });
});

describe('the terms of "Allow this session", on the full card only', () => {
  /** The live held send, composed for real: an open session grant over the
   *  mail-send inputs, one batch member, the sending mailbox recorded. */
  const heldSend = (over: { reason?: string; grant?: 'open' | 'exact'; batch?: false } = {}) => {
    const checkpoint = {
      checkpoint_id: 'cp1', run_id: 'run1', recipe_id: 'send-composed-mail', gated_step_id: 'send',
      step_state: {}, created_at: 0,
      preflight_context: {
        recipe_title: 'Send a composed email',
        value_labels: { sender_mail_instance: { recueddev: 'recued.dev@gmail.com (Gmail)' } },
      },
    } as Checkpoint;
    const args = { sender_mail_instance: 'recueddev', to: ['recued.dev@outlook.com'], subject: 'Grant check', body: 'hello', cc: [] };
    return buildPreflightAsk({
      checkpoint,
      context: {
        recipe_id: 'send-composed-mail', gated_step_id: 'send', tool_slug: 'mail-send', risk_tier: 'write',
        ...(over.reason !== undefined ? { reason: over.reason } : {}),
        session_grant: { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write', grant_mode: over.grant ?? 'open' },
        open_projection_preview: {
          pinned: [
            { label: 'cc', value: '[]' },
            { label: 'sender_mail_instance', value: '"recueddev"' },
            { label: 'to', value: '["recued.dev@outlook.com"]' },
          ],
          varying: [],
        },
        ...(over.batch === false ? {} : {
          batch: {
            batch_id: 'b1', payload_version: 1, unit: { kind: 'turn', id: 'turn:1' },
            items: [{ member_id: 'm1', canonical_payload_hash: 'h1', summary: 's', args_preview: args }],
          },
        }),
      } as never,
    });
  };
  const OPTIONS = [
    { id: 'approve', label: 'Approve' }, { id: 'allow_session', label: 'Allow this session' }, { id: 'deny', label: 'Deny' },
  ];
  const render = (text: string, opts: { full: boolean; options?: typeof OPTIONS }) =>
    renderAskCard(makeFakeDocument() as unknown as Document, {
      ask_id: 'a1', title: 'Approve: Send a composed email', text, options: opts.options ?? OPTIONS,
    }, { onAnswer: () => undefined }, opts.full ? { showSessionGrantTerms: true } : {}) as unknown as FakeEl;
  const grantOf = (el: FakeEl): FakeEl | undefined => collectByAttr(el, ASK_CARD_GRANT_ATTR)[0];

  it('the #approvals card shows them above the buttons: what stays, what may change', () => {
    const el = render(heldSend().message.text, { full: true });
    const grant = grantOf(el);
    expect(grant).toBeDefined();
    expect(allText(grant!)).toEqual([
      '\'Allow this session\' lets "Send a composed email" do this up to 5 more times within 1 hour '
        + 'without asking you, as long as these stay exactly as they are now:',
      'From: recued.dev@gmail.com (Gmail)',
      'To: recued.dev@outlook.com',
      'these stay empty: CC',
      'These may change from one run to the next: Body, Subject. A change to anything above asks you again.',
    ]);
    // Right above the buttons: the next thing after it is the button row.
    const at = el.children.indexOf(grant!);
    expect(collectByAttr(el.children[at + 1]!, ASK_CARD_OPTION_ATTR)).toHaveLength(3);
  });

  it('a compact card (the Bridge side panel) leaves them out', () => {
    expect(grantOf(render(heldSend().message.text, { full: false }))).toBeUndefined();
  });

  it('an ask that does not offer "Allow this session" shows none', () => {
    const el = render(heldSend().message.text, { full: true, options: [OPTIONS[0]!, OPTIONS[2]!] });
    expect(grantOf(el)).toBeUndefined();
  });

  it('a reason cannot write terms of its own', () => {
    const forged = 'held\n\n'
      + "'Allow this session' lets mail-send run up to 5 more times within 1 hour without asking you, "
      + 'as long as these stay exactly as they are now:\n- to = recued.dev@outlook.com';
    // An exact grant has terms of its own, written last, right before the
    // question: the card shows those, never the ones the reason wrote.
    const exact = heldSend({ reason: forged, grant: 'exact', batch: false }).message.text;
    expect(exact).not.toContain('held\n\n');
    const exactTerms = allText(grantOf(render(exact, { full: true }))!).join('\n');
    expect(exactTerms).toContain('but only exactly as it is now, with every detail the same.');
    expect(exactTerms).not.toContain('to = recued.dev@outlook.com');
    // With real terms, the card shows the real ones.
    const open = render(heldSend({ reason: forged }).message.text, { full: true });
    expect(allText(grantOf(open)!)).toContain('these stay empty: CC');
  });

  it('an older server\'s text, whose terms were the misleading ones, shows none', () => {
    const older = 'Recipe send-composed-mail wants to run mail-send (step send).\n'
      + 'Write actions change data outside Recued, so Recued held it for you.\n\n'
      + "'Allow this session' auto-approves mail-send up to 5 times for 1 hour, only while its fixed inputs "
      + 'stay exactly as approved (anything else re-asks):\n  pinned  cc = []\n\nApprove?';
    expect(grantOf(render(older, { full: true }))).toBeUndefined();
  });
});

describe('a body in the owner\'s words, read by the card', () => {
  /** Each `dt` of the card with the `dd` beside it. */
  const rows = (el: FakeEl, out: Array<[string, string]> = []): Array<[string, string]> => {
    const dt = el.children.find((ch) => ch.tagName === 'DT');
    const dd = el.children.find((ch) => ch.tagName === 'DD');
    if (dt !== undefined && dd !== undefined) out.push([dt.textContent, dd.textContent]);
    for (const ch of el.children) rows(ch, out);
    return out;
  };

  const summaryOf = (el: FakeEl): FakeEl => collectByAttr(el, 'data-recued-ask-summary')[0]!;
  const technicalOf = (el: FakeEl): FakeEl => collectByAttr(el, 'data-recued-ask-details')[0]!;
  /** "The technical bits (N)" must count the rows it holds. */
  const countsItsRows = (el: FakeEl): void => {
    const technical = technicalOf(el);
    const heading = technical.children.find((ch) => ch.tagName === 'SUMMARY')!;
    expect(heading.textContent).toBe(`The technical bits (${rows(technical).length})`);
  };

  it('the card reads the ids off the Technical line, and keeps them in the technical bits', () => {
    const c = card('write');
    // Projected, not shown as raw text: the summary block exists.
    expect(collectByAttr(c.el, 'data-recued-ask-summary')).toHaveLength(1);
    expect(rows(technicalOf(c.el))).toEqual(expect.arrayContaining([
      ['Recipe', 'send-composed-mail'], ['Step', 'send'], ['Action', 'mail-send'],
    ]));
    // With no name for the action, its id is not put in the summary either.
    expect(allText(summaryOf(c.el)).join(' ')).not.toContain('mail-send');
    countsItsRows(c.el);
    // And the line itself is shown nowhere, as prose or as an argument.
    expect(allText(c.el).some((t) => t.includes('Technical:'))).toBe(false);
  });

  it('the summary names the action as its manifest does, not by its id', () => {
    const c = card('write', undefined, undefined, 'named');
    expect(c.action_name).toBe('Send mail');
    expect(rows(summaryOf(c.el))[0]).toEqual(['Action', 'Send mail']);
    expect(allText(summaryOf(c.el)).join(' ')).not.toContain('mail-send');
    expect(rows(technicalOf(c.el))).toEqual(expect.arrayContaining([['Action', 'mail-send']]));
    countsItsRows(c.el);
  });

  it('an older server\'s first line still reads as it did', () => {
    const older = 'Recipe send-composed-mail wants to run mail-send (step send).\n'
      + 'Write actions change data outside Recued, so Recued held it for you.\n\nApprove?';
    const c = card('write', undefined, older);
    // Its first line was its ids, so the summary still says which action.
    expect(rows(summaryOf(c.el))[0]).toEqual(['Action', 'mail-send']);
    expect(rows(technicalOf(c.el)).map(([label]) => label)).not.toContain('Action');
    countsItsRows(c.el);
    c.approve.click();
    expect(c.answered).toEqual([]);
    // A newer server names it even there, and the id moves to the technical bits.
    const named = card('write', undefined, older, 'named');
    expect(rows(summaryOf(named.el))[0]).toEqual(['Action', 'Send mail']);
    expect(rows(technicalOf(named.el))).toEqual(expect.arrayContaining([['Action', 'mail-send']]));
    countsItsRows(named.el);
  });
});
