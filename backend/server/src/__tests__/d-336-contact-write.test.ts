/** D-336 slice F (§3.7) — an AI writes contacts: `contact.write`.
 *
 *  Driven through the real chat tool handlers over the real contact store on SQLite, so the
 *  contribution ladder that ranks what is written is the one that ships. What is pinned:
 *    - a birthday told in chat lands on the contact once the owner approves, at the owner's
 *      rank (`manual`), so a later sync cannot replace it, and a field it does not name keeps
 *      its source and stays the sync's to change;
 *    - a field the contact already holds is refused before the owner is asked, so nothing is
 *      re-ranked by being sent again;
 *    - a contact is added from an email, or from a name alone as a mention-only contact, and
 *      a name never merges into a contact already there;
 *    - the refusals: the owner's controls (relationship, privacy marks), fields it does not
 *      take, null, a bad date, an unknown contact, an email that is already a contact;
 *    - the gates: its own switch, reading contacts, spheres, and the owner's approval (a chat
 *      under a contract approves its own card, so it is refused before asking and at run);
 *    - the card names the contact, the guide sends a birthday here, and the rule, title and
 *      locality vocabularies know the tool. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTACT_CONTRIBUTION_SOURCES,
  CONTACT_REDIRECT_CHAIN_LIMIT,
  TIER1_CLASSIFICATIONS,
  TIER1_CONCURRENCY_SAFE,
  TIER1_TOOL_DESCRIPTORS,
  describeWriteRule,
  isOwnerDefaultOnlyEntry,
  getKernelOp,
  tier1CallDetails,
  tier1CallTitle,
  tier1WriteStaysInRecued,
  writeRuleKeyOf,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ExecutionSource,
} from '@recued/contracts';

import { buildChatTier1Handlers, buildChatToolRegistryInputs, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { CONTACT_WRITE_OP_ID, checkContactWrite, contactAskLabels } from '../contact-write-tool.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import { createContactStore, isMentionOnlyEmail } from '../storage/contact-store.js';

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach((close) => close()); });

const ownerChat: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'sess-1', user_id: 'local' };
const contractChat: ExecutionSource = {
  channel: 'chat', actor: 'contracted_user', chat_session_id: 'sess-2', user_id: 'guest', contract_id: 'household-1',
};
const door: ExecutionSource = {
  channel: 'mcp', actor: 'contracted_user', agent_id: 'agent-1', tool_call_id: 'tc-1', mcp_token_id: 'tok-1', contract_id: 'door-a',
};
/** A call as it runs: the owner said yes, so the server set `owner_approved`. */
const approved = (execution_source: ExecutionSource = ownerChat): ChatDispatchContext => ({
  channel: 'internal_function_call', session_id: 'sess-1', turn_id: 'turn-1', execution_source, owner_approved: true,
});
/** A call as it is checked, before the owner is asked. */
const asking = (execution_source: ExecutionSource = ownerChat): ChatDispatchContext => ({
  channel: 'internal_function_call', session_id: 'sess-1', turn_id: 'turn-1', execution_source,
});

const DANA = 'dana.whitfield@example.test';
const T0 = 1_000;
const NOW = 9_000;

const fixture = (opts: {
  grant?: boolean; contactsReadable?: boolean; spheres?: boolean;
  /** D-336 slice U — the conversation the call came from, as the chat keeps it. */
  conversation?: ReadonlyArray<{ role: string; content: string }>;
} = {}) => {
  const db = new Database(':memory:');
  disposals.push(() => db.close());
  const contacts = createContactStore(db);
  const contactsReadable = opts.contactsReadable ?? true;
  const checker = createReadGrantChecker(
    { isGranted: (_id, entry, authorDefault) => (entry === 'data.contact' ? contactsReadable : authorDefault) },
    'owner',
  );
  const granted: string[] = [];
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => contacts,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    getReadGrantResolver: () => ({ resolveForSource: () => checker, resolveForContract: () => checker }) as never,
    getOpAdmissionGate: () => ({
      isFrozenByPause: () => false,
      isOpGranted: (_source, op) => { if (op !== undefined) granted.push(op); return opts.grant ?? true; },
      isOwnerGoverned: () => true,
      isOwnerRecipeGranted: () => false,
    }),
    ...(opts.spheres === true
      ? { getSituationAccess: () => ({ fence: () => ({ owner: false, all_spheres: false, spheres: ['work'] }) }) as never }
      : {}),
    ...(opts.conversation !== undefined
      ? { getChatStore: () => ({ listMessages: async (session_id: string) => (session_id === 'sess-1' ? opts.conversation! : []) }) }
      : {}),
    now: () => NOW,
  };
  const handlers = buildChatTier1Handlers(deps) as Record<string, (raw: unknown, c: ChatDispatchContext) => Promise<ChatDispatchResult>>;
  const write = (args: unknown, c: ChatDispatchContext = approved()) => handlers['contact.write']!(args, c);
  const check = (args: unknown, c: ChatDispatchContext = asking()) => checkContactWrite(deps, args, c);
  // Dana, as the owner typed her into their own contacts.
  contacts.upsertManual({ email: DANA, name: 'Dana Whitfield' }, T0, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
  const dana = () => contacts.get(DANA)!;
  /** A CRM sync's value for one field of Dana, at the CRM's rank. */
  const sync = (kind: 'org' | 'title', value: string, at: number) => {
    contacts.upsertContactAttribute({
      contact_id: dana().contact_id!, kind, value, source: 'vendor_meta', source_id: 'hubspot:main', as_of: at, created_at: at,
    }, at);
    contacts.materializeContactProjection(dana().contact_id!, at);
  };
  return { db, contacts, deps, handlers, write, check, dana, sync, granted };
};

const detail = (out: ChatDispatchResult | null): string =>
  out !== null && !out.ok ? out.detail ?? '' : `(not refused: ${JSON.stringify(out)})`;

describe('D-336 slice F — a birthday told in chat lands on the contact once the owner approves', () => {
  it('checks before asking, then writes the birthday at the owner\'s rank', async () => {
    const f = fixture();
    expect(await f.check({ target_id: DANA, birthday: '--03-04' })).toBeNull();
    expect(f.dana().birthday).toBeUndefined();

    const out = await f.write({ target_id: DANA, birthday: '--03-04' });
    expect(out).toEqual({ ok: true, result: { target_id: DANA, name: 'Dana Whitfield', changed: ['birthday'] } });
    const dana = f.dana();
    expect(dana.birthday).toBe('--03-04');
    // The owner's rank: what they would have typed into their own form.
    expect(dana.projection_provenance?.birthday?.source).toBe('manual');
    expect(CONTACT_CONTRIBUTION_SOURCES[0]).toBe('manual');
    // Model-written, so the row is not user-clean any more (D-177 N.11 rule 1), and a
    // detail told to an AI is no interaction with Dana.
    expect(dana.origin_surface).toBe('engine');
    expect(dana.origin_actor).toBe('user_self');
    expect(dana.last_interaction).toBe(T0);
    expect(f.granted).toContain(CONTACT_WRITE_OP_ID);
  });

  it('writes only the fields it names, and a later sync replaces none of them', async () => {
    const f = fixture();
    f.sync('org', 'Acme Inc', 2_000);
    f.sync('title', 'Engineer', 2_000);
    expect(f.dana().company).toBe('Acme Inc');

    expect((await f.write({ target_id: DANA, phone: '+353 87 123 4567' })).ok).toBe(true);
    // A field it did not name keeps its source, and the CRM still changes it.
    expect(f.dana().projection_provenance?.org?.source).toBe('vendor_meta');
    f.sync('org', 'Acme Holdings', 3_000);
    f.sync('title', 'Lead engineer', 3_000);
    expect(f.dana().company).toBe('Acme Holdings');
    expect(f.dana().title).toBe('Lead engineer');

    // The one it names is the owner's from then on: the CRM's next value does not replace it.
    expect((await f.write({ target_id: DANA, company: 'Acme Group' })).ok).toBe(true);
    f.sync('org', 'Acme Corp', 4_000);
    expect(f.dana().company).toBe('Acme Group');
    expect(f.dana().projection_provenance?.org?.source).toBe('manual');
    expect(f.dana().phone).toBe('+353 87 123 4567');
  });

  it('refuses, before asking, a field the contact already holds, so nothing is re-ranked by being sent again', async () => {
    const f = fixture();
    f.sync('org', 'Acme Inc', 2_000);
    expect(detail(await f.check({ target_id: DANA, company: 'Acme Inc' })))
      .toBe('contact.write: Dana Whitfield already has this company. There is nothing to change');
    expect(detail(await f.check({ target_id: DANA, company: 'Acme  Inc ', birthday: '1990-03-04' })))
      .toBe('contact.write: Dana Whitfield already has this company. Leave it out, to change the rest');
    // A phone is compared by its digits.
    expect((await f.write({ target_id: DANA, phone: '+353 87 123 4567' })).ok).toBe(true);
    expect(detail(await f.check({ target_id: DANA, phone: '+353871234567' })))
      .toBe('contact.write: Dana Whitfield already has this phone. There is nothing to change');

    // Approved, then the value became the same: it is left out, and the rest is written.
    const out = await f.write({ target_id: DANA, company: 'Acme Inc', birthday: '1990-03-04' });
    expect(out).toEqual({ ok: true, result: { target_id: DANA, name: 'Dana Whitfield', changed: ['birthday'] } });
    expect(f.dana().projection_provenance?.org?.source).toBe('vendor_meta');
    const none = await f.write({ target_id: DANA, birthday: '1990-03-04' });
    expect(none.ok && (none.result as { changed: unknown[] }).changed).toEqual([]);
  });

  it('finds the contact through a merge and by its contact id', async () => {
    const f = fixture();
    const id = f.dana().contact_id!;
    expect((await f.write({ target_id: id, anniversary: '2012-06-30' })).ok).toBe(true);
    expect(f.dana().anniversary).toBe('2012-06-30');
    // Her old address, merged into her: the change lands on Dana, never on the tombstone.
    const old = 'dana.w@old-mail.test';
    f.contacts.upsertManual({ email: old, name: 'Dana W' }, T0);
    f.contacts.setMergedInto([f.contacts.get(old)!], DANA, T0);
    expect(await contactAskLabels(f.deps, { target_id: old }, asking())).toEqual({ target_id: { [old]: 'Dana Whitfield' } });
    expect(await f.write({ target_id: old, birthday: '1990-03-04' }))
      .toEqual({ ok: true, result: { target_id: DANA, name: 'Dana Whitfield', changed: ['birthday'] } });
    expect(f.dana().birthday).toBe('1990-03-04');
    expect(f.contacts.get(old)!.birthday).toBeUndefined();
    // A chain too long to follow reads the merged-away row itself, which is never written.
    const chain = Array.from({ length: CONTACT_REDIRECT_CHAIN_LIMIT + 2 }, (_, i) => `c${i}@chain.test`);
    for (const email of chain) f.contacts.upsertManual({ email, name: 'Chain' }, T0);
    chain.slice(0, -1).forEach((email, i) => f.contacts.setMergedInto([f.contacts.get(email)!], chain[i + 1]!, T0 + i));
    expect(() => f.contacts.resolveCanonicalEmail(chain[0]!)).toThrow(/chain_exceeded/);
    expect(detail(await f.write({ target_id: chain[0], phone: '+353 1 555 0100' })))
      .toMatch(/^contact\.write: no contact in the user's address book has this target_id/);
    expect(f.contacts.get(chain[0]!)!.phone).toBeUndefined();
    expect(detail(await f.check({ target_id: 'nobody@example.test', birthday: '1990-03-04' })))
      .toMatch(/^contact\.write: no contact in the user's address book has this target_id/);
  });
});

describe('D-336 slice F — adding a contact', () => {
  it('adds one from an email, and refuses an email that is already a contact', async () => {
    const f = fixture();
    const sam = 'sam.ortiz@example.test';
    expect(await f.check({ email: sam, name: 'Sam Ortiz', birthday: '1985-11-02' })).toBeNull();
    const out = await f.write({ email: 'Sam.Ortiz@Example.test', name: 'Sam Ortiz', birthday: '1985-11-02' });
    expect(out).toEqual({ ok: true, result: { target_id: sam, name: 'Sam Ortiz', added: true } });
    const row = f.contacts.get(sam)!;
    expect(row.birthday).toBe('1985-11-02');
    expect(row.projection_provenance?.name?.source).toBe('manual');
    expect(row.origin_surface).toBe('engine');

    expect(detail(await f.check({ email: DANA, name: 'Dana' })))
      .toBe(`contact.write: ${DANA} is already the contact Dana Whitfield. To change it, pass target_id "${DANA}"`);
  });

  it('adds one from a name alone, as a mention-only contact, and never merges by name', async () => {
    const f = fixture();
    const out = await f.write({ name: 'Mia', birthday: '2015-06-02' });
    expect(out.ok).toBe(true);
    const result = (out as { result: { target_id: string; name: string; added: boolean } }).result;
    expect(result).toMatchObject({ name: 'Mia', added: true });
    expect(isMentionOnlyEmail(result.target_id)).toBe(true);
    const mia = f.contacts.get(result.target_id)!;
    expect(mia.identity_status).toBe('mention_only');
    expect(mia.birthday).toBe('2015-06-02');
    expect(mia.projection_provenance?.birthday?.source).toBe('manual');

    // The AI's write, as any contact write records it: never a sync's (audit, 2026-10-31).
    expect(mia).toMatchObject({ origin_actor: 'user_self', origin_surface: 'engine' });
    const appMade = await f.write({ name: 'Ana' }, approved(door));
    const ana = f.contacts.get((appMade as { result: { target_id: string } }).result.target_id)!;
    expect(ana).toMatchObject({ origin_actor: 'contracted_user', origin_contract_id: 'door-a', origin_surface: 'engine' });

    // A second Mia is a second contact: two people can share a name (§3.7).
    const again = await f.write({ name: 'Mia' });
    expect(again.ok).toBe(true);
    expect((again as { result: { target_id: string } }).result.target_id).not.toBe(result.target_id);
    expect(f.contacts.list({ name_contains: 'Mia' })).toHaveLength(2);
  });

  it('needs an email or a name to add one', async () => {
    const f = fixture();
    expect(detail(await f.check({ birthday: '2015-06-02' })))
      .toBe('contact.write: to add a contact, pass its `email`, or its `name` for someone with no email address. '
        + 'To change one, pass its `target_id` from contact.search');
    const notOne = 'contact.write: `email` must be one email address on its own, like dana@example.com, with no name or angle brackets around it';
    expect(detail(await f.check({ email: 'not an address', name: 'X' }))).toBe(notOne);
    // Audit 2026-11-01 — taken whole, it was the contact's verified address for good.
    expect(detail(await f.check({ email: 'Mia <mia@example.test>', name: 'Mia' }))).toBe(notOne);
    expect(detail(await f.check({ email: 'Mia<mia@example.test>', name: 'Mia' }))).toBe(notOne);
    expect(await f.check({ email: 'mia@example.test', name: 'Mia' })).toBeNull();
  });
});

describe('D-336 slice F — what contact.write refuses', () => {
  it('keeps the owner\'s controls theirs, and takes only its own fields', async () => {
    const f = fixture();
    expect(detail(await f.check({ target_id: DANA, relationship: 'family' })))
      .toBe("contact.write: a contact's relationship and privacy marks are the user's to set, in Contacts. Leave `relationship` out");
    expect(detail(await f.check({ target_id: DANA, privacy_marks: ['hidden'] })))
      .toMatch(/Leave `privacy_marks` out$/);
    expect(detail(await f.check({ target_id: DANA, title: 'Engineer' })))
      .toBe('contact.write takes `target_id`, `email`, `name`, `phone`, `company`, `birthday` and `anniversary`, not `title`');
    expect(f.dana().relationship).toBeUndefined();
  });

  it('refuses null, an empty value, a bad date, and an email on a change', async () => {
    const f = fixture();
    expect(detail(await f.check({ target_id: DANA, phone: null })))
      .toBe('contact.write: `phone` is null. Leave out a field you are not changing; an AI cannot remove one');
    expect(detail(await f.check({ target_id: DANA, company: '  ' })))
      .toBe('contact.write: `company` is empty. Leave out a field you are not changing');
    expect(detail(await f.check({ target_id: DANA, birthday: 'March 4' })))
      .toBe('contact.write: `birthday` must be a date as YYYY-MM-DD, or --MM-DD when the year is not known');
    expect(detail(await f.check({ target_id: DANA, anniversary: '--02-30' }))).toMatch(/`anniversary` must be a date/);
    // A saved address is the owner's to change, on the contact's Edit form (slice R).
    expect(detail(await f.check({ target_id: DANA, email: 'dana@other.test' })))
      .toBe('contact.write: Dana Whitfield has an email address already. Only the user can change a saved one, '
        + "on the contact's Edit form in Contacts: tell them they can change it there. Leave `email` out to change the rest");
    expect(detail(await f.check({ target_id: DANA })))
      .toBe('contact.write: name what to change on Dana Whitfield: its name, phone, company, birthday and anniversary');
    expect(detail(await f.check({ target_id: '  ', birthday: '1990-03-04' })))
      .toBe('contact.write: `target_id` must be a contact.search target_id; leave it out to add a contact');
    // Nothing reached the contact.
    expect(f.dana().birthday).toBeUndefined();
  });
});

describe('D-336 slice F — who may write a contact', () => {
  it('needs its own switch, and to read contacts', async () => {
    const off = fixture({ grant: false });
    const refused = await off.check({ target_id: DANA, birthday: '1990-03-04' });
    expect(refused).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(off.granted).toEqual([CONTACT_WRITE_OP_ID]);

    const blind = fixture({ contactsReadable: false });
    expect(await blind.check({ target_id: DANA, birthday: '1990-03-04' })).toMatchObject({
      ok: false, reason: 'classification_blocked', detail: 'contact.write: this contract cannot read contacts, so it cannot write them',
    });
    const fenced = fixture({ spheres: true });
    expect(await fenced.check({ target_id: DANA, birthday: '1990-03-04' })).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(blind.dana().birthday).toBeUndefined();
  });

  it('is off for every AI app until the owner turns it on, and on for the owner', () => {
    expect(isOwnerDefaultOnlyEntry(CONTACT_WRITE_OP_ID)).toBe(true);
    expect(getKernelOp(CONTACT_WRITE_OP_ID)).toMatchObject({ native: true, risk: 'write', entity: 'contact' });
    // A `write`, so every call is put to the owner (D-329): `unknown` would run it unasked.
    expect(TIER1_CLASSIFICATIONS['contact.write']).toBe('write');
    expect(TIER1_CONCURRENCY_SAFE['contact.write']).toBe(false);
  });

  it('runs only on the owner\'s yes: a chat under a contract approves its own card', async () => {
    const f = fixture();
    const owners = "contact.write: only the owner can approve a change to their contacts, and this conversation's "
      + 'approvals are its own. Tell the user the owner can make the change in Contacts';
    expect(detail(await f.check({ target_id: DANA, birthday: '1990-03-04' }, asking(contractChat)))).toBe(owners);
    // An AI app's ask goes to the owner, so its call is put to them.
    expect(await f.check({ target_id: DANA, birthday: '1990-03-04' }, asking(door))).toBeNull();
    // And at run, nothing without the owner's approval.
    expect(detail(await f.write({ target_id: DANA, birthday: '1990-03-04' }, asking()))).toBe(owners);
    expect(detail(await f.write({ target_id: DANA, birthday: '1990-03-04' }, { ...approved(contractChat), owner_approved: undefined })))
      .toBe(owners);
    expect(f.dana().birthday).toBeUndefined();

    // An AI app's approved write keeps its contract on the row.
    expect((await f.write({ target_id: DANA, birthday: '1990-03-04' }, approved(door))).ok).toBe(true);
    expect(f.dana()).toMatchObject({ origin_actor: 'contracted_user', origin_contract_id: 'door-a', origin_surface: 'engine' });
  });
});

describe('D-336 slice F — the ask, the card and the guide', () => {
  it('names the contact by its name, a mention-only contact\'s placeholder included', async () => {
    const f = fixture();
    expect(await contactAskLabels(f.deps, { target_id: DANA, birthday: '--03-04' }, asking()))
      .toEqual({ target_id: { [DANA]: 'Dana Whitfield' } });
    const mia = await f.write({ name: 'Mia' });
    const placeholder = (mia as { result: { target_id: string } }).result.target_id;
    expect(await contactAskLabels(f.deps, { target_id: placeholder }, asking())).toEqual({ target_id: { [placeholder]: 'Mia' } });
    expect(await contactAskLabels(f.deps, { target_id: 'nobody@example.test' }, asking())).toBeUndefined();
    expect(await contactAskLabels(f.deps, { email: 'new@example.test' }, asking())).toBeUndefined();
    const blind = fixture({ contactsReadable: false });
    expect(await contactAskLabels(blind.deps, { target_id: DANA }, asking())).toBeUndefined();

    // The card: "Change a contact — Contact: Dana Whitfield, Birthday: --03-04".
    expect(tier1CallTitle('contact.write', { target_id: DANA, birthday: '--03-04' })).toBe('Change a contact');
    expect(tier1CallTitle('contact.write', { name: 'Mia' })).toBe('Add a contact');
    expect(tier1CallDetails('contact.write', { target_id: DANA, birthday: '--03-04' }, { target_id: { [DANA]: 'Dana Whitfield' } }))
      .toEqual({ args: { Contact: DANA, birthday: '--03-04' }, labels: { Contact: { [DANA]: 'Dana Whitfield' } } });
  });

  it('is wired for the check before asking and the card', () => {
    const inputs = buildChatToolRegistryInputs(fixture().deps);
    expect(typeof inputs.tier1Checks['contact.write']).toBe('function');
    expect(typeof inputs.tier1AskLabels['contact.write']).toBe('function');
  });

  it('learns adding and changing as two rules, and stays in Recued', () => {
    const add = writeRuleKeyOf(ownerChat, 'contact.write', { name: 'Mia' });
    const change = writeRuleKeyOf(ownerChat, 'contact.write', { target_id: DANA, birthday: '--03-04' });
    expect(add?.scope).toBe('add');
    expect(change?.scope).toBe('change');
    expect(describeWriteRule(add!)).toEqual({ action: 'Add a contact' });
    expect(describeWriteRule(change!)).toEqual({ action: 'Change a contact' });
    // A chat under a contract learns no rule: it holds no write a rule could stand in for.
    expect(writeRuleKeyOf(contractChat, 'contact.write', { name: 'Mia' })).toBeUndefined();
    expect(tier1WriteStaysInRecued('contact.write', { target_id: DANA })).toBe(true);
  });

  it('sends a birthday to the contact write from the relations guide', async () => {
    const f = fixture();
    const out = await f.handlers['memory.relations']!({}, asking());
    expect(out.ok && (out.result as { note: string }).note)
      .toMatch(/A birthday or an anniversary is not saved to memory: write it on the person's contact with contact\.write\.$/);
    const family = await f.handlers['memory.relations']!({ group: 'family' }, asking());
    expect(family.ok && (family.result as { how: string }).how)
      .toContain('Someone who is not a contact yet can be added with contact.write, which the user approves first; until then, write their name.');
  });

  it('slice U — memory.write itself sends a birthday to the contact, which contact.write adds when it is new', () => {
    // Told only "My niece Mia was born on 2 June 2015", the model saved the birthday as a note
    // in 6 of 12 runs: memory.write's own description invited "a lasting fact about a person".
    expect(TIER1_TOOL_DESCRIPTORS['memory.write'].description)
      .toContain("A birthday or an anniversary is not a memory: it goes on the person's contact, with contact.write.");
    expect(TIER1_TOOL_DESCRIPTORS['contact.write'].description)
      .toContain('goes here, not to memory: add the person if they are not a contact yet.');
  });
});

describe('D-336 slice M — an AI gives a contact with no address its email, once the owner approves', () => {
  const MIA = 'mia.whitfield@example.test';
  /** Mia, added from her name alone, as an AI's add makes her: keyed on a placeholder. */
  const withMia = async () => {
    const f = fixture();
    const added = await f.write({ name: 'Mia' });
    const target = (added as { ok: true; result: { target_id: string } }).result.target_id;
    expect(isMentionOnlyEmail(target)).toBe(true);
    return { f, target, mia: () => f.contacts.get(MIA) };
  };

  it('checks before asking, then keys the contact on the address and keeps the contact', async () => {
    const { f, target, mia } = await withMia();
    const before = f.contacts.get(target)!;
    expect(await f.check({ target_id: target, email: ' Mia.Whitfield@Example.TEST ' })).toBeNull();
    expect(mia()).toBeNull();
    const out = await f.write({ target_id: target, email: 'Mia.Whitfield@example.test', birthday: '2015-06-02' });
    expect(out).toEqual({ ok: true, result: { target_id: MIA, name: 'Mia', changed: ['email', 'birthday'] } });
    const now = mia()!;
    // The same contact, now with an address: what links to her by contact_id still does.
    expect(now.contact_id).toBe(before.contact_id);
    expect(now.identity_status).toBe('verified');
    expect(now.birthday).toBe('2015-06-02');
    // Her old target_id still finds her (it stays as an alias).
    expect(f.contacts.resolveCanonicalEmail(target).canonical_email).toBe(MIA);
  });

  it('names the AI\'s turn as the last write, on a contact the owner added and an address alone', async () => {
    const f = fixture();
    // Mia, as the owner's picker adds her (slice H): from their own client.
    const owned = f.contacts.createMentionOnlyContact({ name: 'Mia' }, T0, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    expect(owned.origin_surface).toBe('client_rpc');
    expect(await f.write({ target_id: owned.email, email: MIA }))
      .toEqual({ ok: true, result: { target_id: MIA, name: 'Mia', changed: ['email'] } });
    const now = f.contacts.get(MIA)!;
    expect(now.contact_id).toBe(owned.contact_id);
    // The promotion stamps no origin; the write after it does, so the row never reads as typed
    // by the owner into their own client (D-177 N.11 rule 1).
    expect(now.origin_surface).toBe('engine');
    // Nothing else was written for her.
    expect(now.birthday).toBeUndefined();
    expect(now.last_interaction).toBe(owned.last_interaction);
  });

  it('refuses an address that is not one alone, one another contact has, and one for a contact that has one', async () => {
    const { f, target } = await withMia();
    expect(detail(await f.check({ target_id: target, email: 'Mia <mia.whitfield@example.test>' })))
      .toBe('contact.write: `email` must be one email address on its own, like dana@example.com, with no name or angle brackets around it');
    expect(detail(await f.check({ target_id: target, email: DANA })))
      .toBe(`contact.write: ${DANA} is already the contact Dana Whitfield, so Mia cannot take it. `
        + 'If they are one person, tell the user they can merge them in Contacts');
    // Her own address again is a value she holds, refused before the owner is asked.
    expect(detail(await f.check({ target_id: DANA, email: DANA })))
      .toBe('contact.write: Dana Whitfield already has this email. There is nothing to change');
    expect(detail(await f.check({ target_id: DANA, email: DANA, phone: '+353 1 234 5678' })))
      .toBe('contact.write: Dana Whitfield already has this email. Leave it out, to change the rest');
    expect(f.contacts.get(target)!.identity_status).toBe('mention_only');
  });

  it('refuses at the yes when another contact took the address meanwhile, and changes nothing', async () => {
    const { f, target, mia } = await withMia();
    expect(await f.check({ target_id: target, email: MIA })).toBeNull();
    f.contacts.upsertManual({ email: MIA, name: 'Mia W.' }, NOW, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    expect(detail(await f.write({ target_id: target, email: MIA })))
      .toBe(`contact.write: ${MIA} is already the contact Mia W., so Mia cannot take it. `
        + 'If they are one person, tell the user they can merge them in Contacts');
    expect(f.contacts.get(target)!.identity_status).toBe('mention_only');
    expect(mia()!.name).toBe('Mia W.');
  });
});

describe('D-336 slice U — a contact the user named only in part is asked about once, before the owner is', () => {
  const PART = "contact.write: the user named only part of Dana Whitfield's name, so they may mean someone else. "
    + 'Ask them whether they mean Dana Whitfield, writing it as it is here so that they see the full name, before '
    + 'changing this contact; call again once they say so. If they mean someone else, leave target_id out to add that person';
  const said = (...lines: Array<[string, string]>) => lines.map(([role, content]) => ({ role, content }));

  it('a change to Dana Whitfield when the user said only "Dana" is refused before asking; never at run', async () => {
    const f = fixture({ conversation: said(['user', "Dana's birthday is March 4th."]) });
    const refused = await f.check({ target_id: DANA, birthday: '--03-04' });
    expect(refused).toMatchObject({ ok: false, reason: 'invalid_args', detail: PART });
    // The owner's yes named her on the card: the run is not asked again.
    expect(await f.write({ target_id: DANA, birthday: '--03-04' })).toMatchObject({ ok: true });
  });

  it('asked once: a reply that asked by her full name, or the user naming her in full, lets it through', async () => {
    const asked = fixture({ conversation: said(
      ['user', "Dana's birthday is March 4th."], ['assistant', 'Do you mean Dana Whitfield?'], ['user', 'Yes.'],
    ) });
    expect(await asked.check({ target_id: DANA, birthday: '--03-04' })).toBeNull();
    const full = fixture({ conversation: said(['user', "Dana Whitfield's birthday is March 4th."]) });
    expect(await full.check({ target_id: DANA, birthday: '--03-04' })).toBeNull();
  });

  it('asks nothing for a contact the user named not at all, for a one-word name, or for an AI app', async () => {
    // Only the user's own words count as naming her: a reply that said "Dana" is not theirs.
    const pronoun = fixture({ conversation: said(
      ['user', 'Anything new in my contacts?'], ['assistant', 'Dana updated her phone.'], ['user', 'Her birthday is March 4th.'],
    ) });
    expect(await pronoun.check({ target_id: DANA, birthday: '--03-04' })).toBeNull();
    const one = fixture({ conversation: said(['user', 'My niece Mia was born on 2 June 2015.']) });
    const mia = one.contacts.createMentionOnlyContact({ name: 'Mia' }, T0, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    expect(await one.check({ target_id: mia.email, birthday: '2015-06-02' })).toBeNull();
    // An AI app's call has no conversation here to read: its card is the guard.
    const app = fixture({ conversation: said(['user', "Dana's birthday is March 4th."]) });
    expect(await app.check({ target_id: DANA, birthday: '--03-04' }, asking(door))).not.toMatchObject({ detail: PART });
  });

  it('a conversation that cannot be read asks nothing', async () => {
    const f = fixture();
    const broken = { ...f.deps, getChatStore: () => ({ listMessages: async () => { throw new Error('gone'); } }) };
    expect(await checkContactWrite(broken, { target_id: DANA, birthday: '--03-04' }, asking())).toBeNull();
  });
});

describe('D-336 (spec §49) — a CRM record given as a contact says whose it is', () => {
  const ID = 'hubspot_contact_hubspot_51';
  /** One HubSpot connection serving contacts. */
  const crm = {
    getCrmConnectionFreshness: (alias: string) => (alias === 'contact'
      ? [{ connection_name: 'hubspot', vendor: 'hubspot', entity: 'contact', synced_at: 1 }]
      : []),
  };

  it("names it as the CRM's, and the CRM's tool where the conversation is offered it", async () => {
    // Live, the model passed HubSpot's id here first in 5 of 5 turns that changed a HubSpot
    // contact, and read that contact.search had not returned it.
    const f = fixture();
    const offered = { ...f.deps, ...crm, getCanonicalOpTools: () => [{ opId: 'contact.update', connections: ['hubspot'] }] } as never;
    expect(detail(await checkContactWrite(offered, { target_id: ID, phone: '+1 555 0100' }, asking()))).toBe(
      `contact.write: ${ID} is a HubSpot Contact in the user's CRM, not a contact in their address book, `
        + 'and contact.write changes only the address book. To change it in the CRM, call '
        + "recued_canonical_contact.update with connection 'hubspot' and this id");
    const notOffered = { ...f.deps, ...crm } as never;
    expect(detail(await checkContactWrite(notOffered, { target_id: ID, phone: '+1 555 0100' }, asking())))
      .toContain('This conversation has no tool that changes it in the CRM');
    // An id no connected CRM names keeps the address book's own refusal.
    expect(detail(await checkContactWrite(offered, { target_id: 'Mia Whitfield', phone: '+1 555 0100' }, asking())))
      .toContain("no contact in the user's address book has this target_id");
  });
});
