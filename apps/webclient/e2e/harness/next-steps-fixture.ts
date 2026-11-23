import type { ChatMessage } from '@recued/contracts';

/** D-404 slice B1 — `&chat_steps=1` on `?chat=session`: the owner asked about their passport, and the
 *  answer offers a thing to add (Passport) and a pack (Rental Book). What has landed is the page's to
 *  set (`window.__chatStepsLanded`); what Ask again sends is kept (`window.__chatStepsSent`).
 *  D-405 slice 7 — `&chat_steps=mail`: the owner asked what Anna sent them, with no mailbox connected,
 *  and the answer offers to connect one. */
export const nextStepsChatFixture = (now: number, variant: string | null = null): { messages: ChatMessage[] } => {
  const base = { session_id: 'chat_1', turn_id: 'turn_steps', target_server: 'self' as const,
    picker_at_send: { display_name: 'This server', signature: { server_kind: 'recued' as const, version: '1.0.0', instance_id: 'steps-fixture' } },
    model_used: { provider: 'local', model_id: 'fixture' } };
  if (variant === 'mail') {
    return {
      messages: [
        { ...base, id: 'message_mail_request', role: 'user', contributor: 'user', content: 'What did Anna send me last week?', ts: now - 61_000 },
        { ...base, id: 'message_mail_answer', role: 'assistant', contributor: 'model', ts: now - 60_000,
          content: 'No mailbox of yours is connected, so I could not read any mail from Anna.',
          fixes: [{ kind: 'feature', feature: 'mail' }] },
      ] as ChatMessage[],
    };
  }
  return {
    messages: [
      { ...base, id: 'message_steps_request', role: 'user', contributor: 'user', content: 'When does my passport expire?', ts: now - 61_000 },
      { ...base, id: 'message_steps_answer', role: 'assistant', contributor: 'model', ts: now - 60_000,
        content: 'I don\'t have a passport on file for you yet. You can add one in the app under Assets.',
        fixes: [{ kind: 'thing', type_id: 'passport', type_name: 'Passport' }],
        install_offers: [{ kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: [] },
          { kind: 'recipe', slug: 'summarize-pdf', name: 'Summarize a PDF', publisher: 'recued-core', recipes: ['Summarize a PDF'] }] },
    ] as ChatMessage[],
  };
};

/** A hint set aside, as `chat.hints.*` keeps it. */
interface HintSetAside { key: string; label: string; until: number }

/** The fixture's rpcs: which steps landed, as the page set them, and the sends it kept; and (D-405
 *  slice 3) the hints set aside, which the page may set before it loads (`window.__chatHintsNotNow`). */
export const nextStepsRpc = (method: string, args: unknown): { result: unknown } | undefined => {
  const page = window as unknown as { __chatStepsLanded?: unknown[]; __chatStepsSent?: unknown[]; __chatHintsNotNow?: HintSetAside[] };
  if (method === 'chat.next_steps.state') return { result: { landed: page.__chatStepsLanded ?? [] } };
  if (method === 'chat.hints.list') return { result: { not_now: page.__chatHintsNotNow ?? [] } };
  if (method === 'chat.hints.not_now') {
    const { key, label } = args as { key: string; label: string };
    const row: HintSetAside = { key, label, until: Date.now() + 30 * 86_400_000 };
    page.__chatHintsNotNow = [...(page.__chatHintsNotNow ?? []).filter((held) => held.key !== key), row];
    return { result: row };
  }
  if (method === 'chat.hints.restore') {
    const { key } = args as { key: string };
    const before = page.__chatHintsNotNow ?? [];
    page.__chatHintsNotNow = before.filter((held) => held.key !== key);
    return { result: { restored: page.__chatHintsNotNow.length !== before.length } };
  }
  if (method === 'chat.send') { page.__chatStepsSent = [...(page.__chatStepsSent ?? []), args]; }
  return undefined;
};
