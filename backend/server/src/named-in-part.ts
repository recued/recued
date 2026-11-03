/** D-336 slice U, then spec §48 — a record the user named only in part may be someone else.
 *
 *  The chat's privacy layer hands the model every name as an alias (`pii.Person1`), so it
 *  cannot tell that "Mia" is only part of "Mia Whitfield". Live, told "My niece Mia was born on
 *  2 June 2015." beside a contact Mia Whitfield, it changed her birthday in 6 of 6 runs; told
 *  "Update Mia's phone in HubSpot to +1 555 0100." beside a HubSpot contact Mia Whitfield, it
 *  changed her phone in HubSpot in 6 of 6, and in the owner's own chat no approval was raised.
 *  So the server reads the conversation's real words and the record's real name, and refuses
 *  the call once, before it changes anything, so that the model asks. */

import {
  CANONICAL_OP_TOOL_PREFIX,
  CONNECTION_VENDOR_ENTITIES,
  composeVendorEntityScope,
  isProseFunctionWord,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type CrmConnectionFreshness,
  type RecipeDefinition,
} from '@recued/contracts';

import type { ChatToolHandlerDeps } from './chat-tool-handlers.js';
import { wordSet } from './chat-prefetch-score.js';
import { buildPackOpResolution } from './pack-inventory.js';
import { recordIdsChangedBeforeRun } from './record-connection-settle.js';

/** The words of a conversation: the user's own, and every one said in it. */
export interface ConversationWords {
  readonly user: ReadonlySet<string>;
  readonly all: ReadonlySet<string>;
}

/** D-336 slice U — the words of the conversation a call came from, the user's and its replies',
 *  as the owner reads them (names, never aliases). `undefined` where there is none to read: an
 *  AI app's call over MCP. */
export const conversationWords = async (
  deps: Pick<ChatToolHandlerDeps, 'getChatStore'>,
  ctx: ChatDispatchContext,
): Promise<ConversationWords | undefined> => {
  const source = ctx.execution_source;
  if (source?.channel === 'mcp') return undefined;
  const session = source?.channel === 'chat' ? source.chat_session_id : ctx.session_id;
  const chat = deps.getChatStore?.();
  if (session === undefined || session === '' || chat === undefined) return undefined;
  let messages: Awaited<ReturnType<typeof chat.listMessages>>;
  try { messages = await chat.listMessages(session); } catch { return undefined; }
  const user = new Set<string>();
  const all = new Set<string>();
  for (const message of messages) {
    if (typeof message.content !== 'string' || (message.role !== 'user' && message.role !== 'assistant')) continue;
    for (const word of wordSet(message.content)) {
      all.add(word);
      if (message.role === 'user') user.add(word);
    }
  }
  return { user, all };
};

/** D-336 slice U (the owner, 2026-11-02: "AI asks once") — the user named only part of this
 *  name: a word of it, but never the whole name, said by them or by a reply. They may mean
 *  someone else of that name, and the model, which reads each name as an alias, cannot tell. A
 *  reply that asks by the full name answers it. */
export const namedInPart = (
  name: string | undefined,
  words: ConversationWords,
): boolean => {
  // A one-word name the user said is the whole name, so it never asks.
  const parts = [...wordSet(name ?? '')].filter((word) => !isProseFunctionWord(word));
  return parts.some((word) => words.user.has(word)) && !parts.every((word) => words.all.has(word));
};

/** The connected CRM contact kind a record id names (D-190: `<vendor>_<entity>_<connection>_`),
 *  read from the CRM connections serving contacts, so a pack-declared CRM is read too. */
const crmContactConnectionOf = (deps: ChatToolHandlerDeps, id: string): CrmConnectionFreshness | undefined =>
  (deps.getCrmConnectionFreshness?.('contact') ?? [])
    .find((c) => id.startsWith(`${c.vendor}_${c.entity}_${c.connection_name}_`));

/** What the user would call the CRM kind: "HubSpot Contact". */
const crmKindName = (c: CrmConnectionFreshness): string =>
  CONNECTION_VENDOR_ENTITIES.find((entry) => entry.vendor === c.vendor && entry.entity === c.entity)?.display_name
    ?? `${c.vendor} ${c.entity}`;

/** D-336 (spec §49) — `contact.write` given a CRM record's id. It changes the user's own
 *  address book, and the id names a contact in a connected CRM: the mirror of D-254 cell A,
 *  denied naming the record as the CRM's. Live, the model passed HubSpot's id here first in 5 of
 *  5 turns that changed a HubSpot contact, and was told contact.search had not returned it.
 *  ⚠ Model-facing. The CRM's tool is named only where this conversation is offered it. */
export const crmRecordGivenAsContact = (deps: ChatToolHandlerDeps, id: string): string | undefined => {
  const of = crmContactConnectionOf(deps, id);
  if (of === undefined) return undefined;
  const offered = (deps.getCanonicalOpTools?.() ?? [])
    .some((tool) => tool.opId === 'contact.update' && tool.connections.includes(of.connection_name));
  return `contact.write: ${id} is a ${crmKindName(of)} in the user's CRM, not a contact in their address book, `
    + 'and contact.write changes only the address book. '
    + (offered
      ? `To change it in the CRM, call ${CANONICAL_OP_TOOL_PREFIX}contact.update with connection '${of.connection_name}' and this id`
      : 'This conversation has no tool that changes it in the CRM');
};

/** D-336 (spec §49, D-254 cell A: "deny, naming the record as local") — a CRM change given a
 *  contact of the user's address book as its record: an address, or a Recued contact id. Sent on,
 *  it reached HubSpot as `PATCH /contacts/mia.whitfield%40…`, which HubSpot does not take as an
 *  id. ⚠ Model-facing. */
const addressBookIdGivenAsRecord = (deps: ChatToolHandlerDeps, tool: string, id: string): string | undefined => {
  if (crmContactConnectionOf(deps, id) !== undefined) return undefined;
  const contacts = deps.getContactStore();
  if (contacts === undefined) return undefined;
  let named: boolean;
  try {
    named = id.includes('@')
      ? Boolean(contacts.get(contacts.resolveCanonicalEmail(id).canonical_email))
      : /^[0-9a-f]{32}$/.test(id) && Boolean(contacts.getByContactIdResolved(id));
  } catch {
    return undefined;
  }
  if (!named) return undefined;
  const example = (deps.getCrmConnectionFreshness?.('contact') ?? [])[0];
  return `${tool}: ${id} is a contact in the user's address book, not a record in their CRM. Pass the CRM record's `
    + 'own id: the target_id contact.search returned for them from the CRM'
    + (example !== undefined ? ` (it starts with ${example.vendor}_${example.entity}_${example.connection_name}_)` : '');
};

/** D-336 (spec §48, the owner: "go ahead" on asking once) — the name of a CRM contact a run
 *  would change that the user named only in part: a vendor-neutral `update` or `delete`, or a
 *  vendor's write, whose record id is known before the run (`recordIdsChangedBeforeRun`), on a
 *  contact of a connected CRM, by its name in the CRM mirror. `undefined` when there is none,
 *  or no conversation to read. A record the mirror does not hold yet is not asked about. */
export const crmContactNamedInPart = async (
  deps: ChatToolHandlerDeps,
  recipe: RecipeDefinition,
  input: {
    readonly config?: Readonly<Record<string, unknown>> | undefined;
    readonly context?: Readonly<Record<string, unknown>> | undefined;
  },
  ctx: ChatDispatchContext,
): Promise<string | undefined> => {
  const mirror = deps.getCrmRecordMirror?.();
  const contacts = deps.getCrmConnectionFreshness?.('contact') ?? [];
  if (mirror === undefined || contacts.length === 0) return undefined;
  const manifests = deps.getExecutorConfig().manifests;
  const packs = deps.scanInstalledPacks;
  const ids = recordIdsChangedBeforeRun(recipe, { config: input.config ?? {}, context: input.context }, {
    manifests,
    ...(packs !== undefined ? { packs: buildPackOpResolution(packs, (slug) => manifests.get(slug)) } : {}),
  });
  if (ids.length === 0) return undefined;
  const words = await conversationWords(deps, ctx);
  if (words === undefined) return undefined;
  for (const id of ids) {
    const name = crmContactNameOf(deps, id);
    if (name !== undefined && namedInPart(name, words)) return name;
  }
  return undefined;
};

/** A connected CRM's contact, by its name in the CRM mirror, from its record id (D-190: the id
 *  names its vendor, its kind of record and its connection). `undefined` for any other id, or a
 *  contact the mirror does not hold yet. */
const crmContactNameOf = (deps: ChatToolHandlerDeps, id: string): string | undefined => {
  const of = crmContactConnectionOf(deps, id);
  if (of === undefined) return undefined;
  // The connection's rows from this id on: the record, and any whose id extends it.
  const row = deps.getCrmRecordMirror?.()?.listForConnection(composeVendorEntityScope(of.vendor, of.entity), id)
    .find((candidate) => candidate.target_id === id);
  const name = (row?.meta as Readonly<Record<string, unknown>> | undefined)?.['name'];
  return typeof name === 'string' ? name : undefined;
};

/** D-336 (spec §53) — the same question where the run finds the contact itself: a search, then
 *  a change of what it found. Its id is not known before the run, so a chat run carries this
 *  look to each record change it makes (`ExecutionContext.recordChangeCheck`), and the change
 *  of a CRM contact the user named only in part is refused at the call with the same words.
 *  The conversation is read once, at the first change it looks at. */
export const crmContactChangeCheck = (
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
  tool: string,
): ((call: { readonly operation_id: string; readonly record_id: string }) => Promise<string | undefined>) => {
  let words: Promise<ConversationWords | undefined> | undefined;
  return async ({ record_id }) => {
    const name = crmContactNameOf(deps, record_id);
    if (name === undefined) return undefined;
    words ??= conversationWords(deps, ctx);
    const read = await words;
    return read !== undefined && namedInPart(name, read) ? crmContactNamedInPartWords(tool, name) : undefined;
  };
};

/** ⚠ Model-facing — the refusal that makes the model ask (slice U's, for a CRM contact). The
 *  name reaches the model as an alias and the user as the full name, so the question is to
 *  write it as given. */
export const crmContactNamedInPartRefusal = (tool: string, name: string): ChatDispatchResult => ({
  ok: false,
  reason: 'invalid_args',
  detail: crmContactNamedInPartWords(tool, name),
});

/** The refusal's words: a chat door's, and a run's at the change it would have made (spec §53). */
const crmContactNamedInPartWords = (tool: string, name: string): string =>
  `${tool}: the user named only part of ${name}'s name, so they may mean someone else. `
    + `Ask them whether they mean ${name}, writing it as it is here so that they see the full name, before `
    + 'changing this contact; call again once they say so';

/** D-336 (spec §49) — a CRM change given a person's NAME as its record id. The model reads each
 *  name as an alias (`pii.Person1`), and an alias it passes is restored to the name: live, told
 *  "Yes, Mia Whitfield.", it sent `contact_id: Mia Whitfield`, which reached HubSpot as
 *  `PATCH /contacts/Mia%20Whitfield`, and it told the user the contact had been deleted or
 *  merged. A name is read as one only where a record has it: in the CRM mirror or the address
 *  book. ⚠ Model-facing; the user reads the name, the model its alias. */
const nameGivenAsRecord = (deps: ChatToolHandlerDeps, tool: string, id: string): string | undefined => {
  const name = id.trim().toLowerCase();
  if (name === '' || crmContactConnectionOf(deps, id) !== undefined) return undefined;
  const connections = deps.getCrmConnectionFreshness?.('contact') ?? [];
  const mirror = deps.getCrmRecordMirror?.();
  const same = (value: unknown): boolean => typeof value === 'string' && value.trim().toLowerCase() === name;
  let isName = false;
  try {
    isName = connections.some((c) => (mirror?.list(composeVendorEntityScope(c.vendor, c.entity), { name_contains: id.trim(), limit: 5 }) ?? [])
      .some((row) => same((row.meta as Readonly<Record<string, unknown>> | undefined)?.['name'])))
      || (deps.getContactStore()?.list({ name_contains: id.trim() }) ?? []).slice(0, 20).some((contact) => same(contact.name));
  } catch {
    return undefined;
  }
  if (!isName) return undefined;
  const example = connections[0];
  return `${tool}: "${id}" is a person's name, not a record id. Pass the CRM record's own id: the target_id `
    + 'contact.search returned for them from the CRM'
    + (example !== undefined ? ` (it starts with ${example.vendor}_${example.entity}_${example.connection_name}_)` : '');
};

/** D-336 (spec §48–§49) — why a chat CRM change is refused before it runs, or undefined to run
 *  it: a contact of the address book, or a person's name, given as its record (D-254 cell A), or
 *  a CRM contact the user named only in part. All read the record ids the run knows before it
 *  starts. */
export const crmChangeRefusal = async (
  deps: ChatToolHandlerDeps,
  recipe: RecipeDefinition,
  input: {
    readonly config?: Readonly<Record<string, unknown>> | undefined;
    readonly context?: Readonly<Record<string, unknown>> | undefined;
  },
  ctx: ChatDispatchContext,
  tool: string,
): Promise<ChatDispatchResult | undefined> => {
  if ((deps.getCrmConnectionFreshness?.('contact') ?? []).length === 0) return undefined;
  const manifests = deps.getExecutorConfig().manifests;
  const packs = deps.scanInstalledPacks;
  const ids = recordIdsChangedBeforeRun(recipe, { config: input.config ?? {}, context: input.context }, {
    manifests,
    ...(packs !== undefined ? { packs: buildPackOpResolution(packs, (slug) => manifests.get(slug)) } : {}),
  });
  for (const id of ids) {
    const notRecord = addressBookIdGivenAsRecord(deps, tool, id) ?? nameGivenAsRecord(deps, tool, id);
    if (notRecord !== undefined) return { ok: false, reason: 'invalid_args', detail: notRecord };
  }
  const partly = await crmContactNamedInPart(deps, recipe, input, ctx);
  return partly === undefined ? undefined : crmContactNamedInPartRefusal(tool, partly);
};
