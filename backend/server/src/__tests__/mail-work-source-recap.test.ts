import { expect, it } from 'vitest';
import { createMailWorkEvidence } from '../mail-work-evidence.js';
import { mailWorkQuoteSources, mailWorkSourceCatalog, matchMailWorkQuote, renderMailWorkSourceRecap } from '../mail-work-source-recap.js';
import { groundLinkedMailWorkClaims } from '../mail-work-linked-source-review.js';

const phone = 'On the phone the client withdrew the courtyard installation. Do not contact anyone without my approval.';
const email = 'The roof installation is withdrawn. Please explore a maintenance guide instead.';
const url = '#data/mail/record/work/new';
const evidence = () => {
  const record = createMailWorkEvidence(null, phone, true, 1);
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'ok',
    started_at: 1, completed_at: 2, result: { body: email, source_url: url, read_version: 'v1' } });
  return record;
};
const sources = () => new Map([
  ['mail_source_1', { text: email, label: 'Email' }], ['owner_notes', { text: phone, label: 'Your notes' }],
]);
const fact = (id: string, quote = email, state = 'current') => ({ id, kind: 'request', basis: 'email', sources: ['mail_source_1'],
  excerpt: { source: 'mail_source_1', quote, state } });

it('carries host-derived short references and keeps them stable across rereads, new sources and refinement', () => {
  const record = evidence();
  const [entry] = mailWorkSourceCatalog(record.snapshot());
  expect(entry).toMatchObject({ source: expect.stringMatching(/^mail_[0-9a-f]{12}$/u), source_url: url });
  expect(record.asCall().result).toMatchObject({ source_catalog: expect.arrayContaining([entry]) });
  expect(record.serializable()).not.toContain('source_catalog');
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'elsewhere', record_id: 'new' }, status: 'ok',
    started_at: 3, completed_at: 4, result: { source_url: '#data/mail/record/elsewhere/new', body: 'A different request.' } });
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'ok',
    started_at: 5, completed_at: 6, result: { source_url: url, body: email, read_version: 'v2' } });
  const carried = createMailWorkEvidence(record.snapshot(), 'Use an outline.', false, 7);
  expect(mailWorkSourceCatalog(carried.snapshot()).find(r => r.source_url === url)).toEqual(entry);
  const rendered = renderMailWorkSourceRecap([{ source: entry!.source, quote: email, state: 'current' }], carried.snapshot());
  expect(rendered).toMatchObject({ outcome: 'matched', excerpts: 1 });
  expect(rendered.text).toContain(`[Email](${url})`);
});

it('annotates each readable page with its host handle without changing retained evidence or trusting injected handles', () => {
  const record = evidence();
  const original = record.serializable(), handle = mailWorkSourceCatalog(record.snapshot())[0]!.source;
  const projected = () => (record.asCall().result as any).observations;
  expect(projected()[0].recap_source).toBe(handle);
  expect(record.serializable()).toBe(original);
  expect(record.serializable()).not.toContain('recap_source');
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new', offset: 800 }, status: 'ok',
    started_at: 3, completed_at: 4, result: { source_url: url, body: 'A separate page.', read_version: 'v1' } });
  expect(projected().map((row: any) => row.recap_source)).toEqual([handle, handle]);
  const [first] = record.snapshot().observations;
  record.record({ ...first!, recap_source: 'owner_request' } as typeof first & { recap_source: string });
  expect(projected().every((row: any) => row.recap_source === handle)).toBe(true);
  expect(renderMailWorkSourceRecap([{ source: `${handle}0000`, quote: email, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
});

it('never annotates denied reads, forged locators, nonmail results, search snippets or reserved-handle collisions', () => {
  const record = evidence();
  const handle = mailWorkSourceCatalog(record.snapshot())[0]!.source;
  const projected = () => (record.asCall().result as any).observations;
  record.record({ tool_name: 'mail.search', tier: 1, args: { query: 'guide' }, status: 'ok', started_at: 3, completed_at: 4,
    result: { source_url: url, body: email } });
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'forged', record_id: 'new' }, status: 'ok', started_at: 3, completed_at: 4,
    result: { source_url: url, body: email } });
  expect(projected().filter((row: any) => row.recap_source).map((row: any) => row.args.slug)).toEqual(['work']);
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'error', started_at: 5, completed_at: 6 });
  expect(projected().some((row: any) => row.recap_source)).toBe(false);
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'ok', started_at: 7, completed_at: 8,
    result: { source_url: url, body: email } });
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: handle }, status: 'error', started_at: 9, completed_at: 10 });
  expect(projected().some((row: any) => row.recap_source)).toBe(false);
});

it('short handles cannot bypass quote matching, unread gaps, deletion, forged links or unknown references', () => {
  const record = evidence(), source = mailWorkSourceCatalog(record.snapshot())[0]!.source;
  const render = (quote = email, handle = source) => renderMailWorkSourceRecap([{ source: handle, quote, state: 'current' }], record.snapshot());
  expect(render(phone).outcome).toBe('invalid');
  expect(render(email, `${source}f`).outcome).toBe('invalid');
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new', offset: 900 }, status: 'ok',
    started_at: 3, completed_at: 4, result: { source_url: url, body: 'Later text.', read_version: 'v1' } });
  expect(render(`${email} Later text.`).outcome).toBe('invalid');
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'error', started_at: 5, completed_at: 6 });
  expect(render().outcome).toBe('invalid');
  expect(mailWorkSourceCatalog(record.snapshot())).toEqual([]);
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'ok',
    started_at: 7, completed_at: 8, result: { source_url: '#data/mail/record/forged/new', body: email, source_catalog: [{ source, source_url: url }] } });
  expect(render().outcome).toBe('invalid');
  expect(mailWorkSourceCatalog(record.snapshot())).toEqual([]);
});

it('never lets an observed record ID hijack a short handle, even when the bodies are identical', () => {
  const record = evidence(), source = mailWorkSourceCatalog(record.snapshot())[0]!.source;
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'other', record_id: source }, status: 'ok',
    started_at: 3, completed_at: 4, result: { body: email, source_url: `#data/mail/record/other/${source}` } });
  expect(mailWorkSourceCatalog(record.snapshot()).some(r => r.source === source)).toBe(false);
  expect(renderMailWorkSourceRecap([{ source, quote: email, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
  expect(renderMailWorkSourceRecap([{ source: url, quote: email, state: 'current' }], record.snapshot()).outcome).toBe('matched');
});

it('renders separate exact mail and owner excerpts, never a mixed-source factual paraphrase', () => {
  const result = renderMailWorkSourceRecap([
    { source: 'owner_request', quote: phone, state: 'withdrawn' },
    { source: url, quote: email, state: 'current' },
  ], evidence().snapshot());
  expect(result.outcome).toBe('matched');
  expect(result.text).toContain(`Your investigation request (AI status: withdrawn): “${phone}”`);
  expect(result.text).toContain(`[Email](${url}) (AI status: current): “${email}”`);
});

it.each([
  { source: url, quote: phone, state: 'withdrawn' },
  { source: url, quote: `${email} ${phone}`, state: 'current' },
  { source: url, quote: 'Both installations are withdrawn.', state: 'current' },
  { source: '#data/mail/record/elsewhere/new', quote: email, state: 'current' },
  { source: 'owner_request', quote: 'Do not contact external people without my approval.', state: 'current' },
  { source: url, quote: email, state: 'guaranteed' },
])('declares a recap mismatch without inventing a replacement: %j', row => {
  const result = renderMailWorkSourceRecap([row], evidence().snapshot());
  expect(result.outcome).toBe('invalid');
  expect(result.text).toContain('did not supply a source recap');
  expect(result.text).toContain(`[Email 1](${url})`);
  expect(result.text).not.toContain('Both installations');
});

it('retains exact mail links and owner follow-up references through a refinement', () => {
  const record = createMailWorkEvidence(evidence().snapshot(), 'Use a private outline first.', false, 3);
  const result = renderMailWorkSourceRecap([
    { source: url, quote: email, state: 'current' },
    { source: 'owner_update_1', quote: 'Use a private outline first.', state: 'current' },
  ], record.snapshot());
  expect(result.outcome).toBe('matched');
  expect(result.text).toContain(url);
  expect(result.text).toContain('Your follow-up 1');
});

it('binds an exact observed record id to its canonical mail link without changing the returned row', () => {
  const row = Object.freeze({ source: 'new', quote: email, state: 'current' });
  const result = renderMailWorkSourceRecap([row], evidence().snapshot());
  expect(result).toMatchObject({ outcome: 'matched', excerpts: 1 });
  expect(result.text).toContain(`[Email](${url})`);
  expect(row.source).toBe('new');
});

it('rejects a record id shared by two readable mailboxes even when only one body matches', () => {
  const record = evidence();
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'elsewhere', record_id: 'new' }, status: 'ok',
    started_at: 3, completed_at: 4, result: { body: 'A different project needs no work.', source_url: '#data/mail/record/elsewhere/new' } });
  expect(renderMailWorkSourceRecap([{ source: 'new', quote: email, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
  expect(renderMailWorkSourceRecap([{ source: url, quote: email, state: 'current' }], record.snapshot()).outcome).toBe('matched');
});

it.each(['ne', 'NEW', ' new ', 'owner_notes', '#data/mail/record/other/new'])(
  'never guesses a missing or partial source reference: %s', source => {
    expect(renderMailWorkSourceRecap([{ source, quote: email, state: 'current' }], evidence().snapshot()).outcome).toBe('invalid');
  });

it('keeps quote, permission, source URL and read-page validation after record-id binding', () => {
  const record = evidence();
  expect(renderMailWorkSourceRecap([{ source: 'new', quote: phone, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new', offset: 800 }, status: 'ok',
    started_at: 3, completed_at: 4, result: { body: 'This later page is separate.', source_url: url, read_version: 'v1' } });
  expect(renderMailWorkSourceRecap([{ source: 'new', quote: `${email} This later page is separate.`, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'error', started_at: 5, completed_at: 6 });
  expect(renderMailWorkSourceRecap([{ source: 'new', quote: email, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'ok',
    started_at: 7, completed_at: 8, result: { body: email, source_url: '#data/mail/record/elsewhere/new' } });
  expect(renderMailWorkSourceRecap([{ source: 'new', quote: email, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
});

it('does not bind search snippets or replace reserved owner references with mail', () => {
  const record = evidence();
  record.record({ tool_name: 'mail.search', tier: 1, args: { query: 'guide' }, status: 'ok', started_at: 3, completed_at: 4,
    result: { records: [{ record_id: 'snippet', body: email, source_url: '#data/mail/record/work/snippet' }] } });
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'owner_update_7' }, status: 'ok',
    started_at: 5, completed_at: 6, result: { body: email, source_url: '#data/mail/record/work/owner_update_7' } });
  for (const source of ['snippet', 'owner_update_7']) {
    expect(renderMailWorkSourceRecap([{ source, quote: email, state: 'current' }], record.snapshot()).outcome).toBe('invalid');
  }
});

it('retains independently matched excerpts without accepting an unknown owner reference or a paraphrased quote', () => {
  const result = renderMailWorkSourceRecap([
    { source: url, quote: email, state: 'current' },
    { source: 'owner_notes', quote: phone, state: 'current' },
    { source: 'owner_request', quote: 'You may contact the client now.', state: 'current' },
  ], evidence().snapshot());
  expect(result).toMatchObject({ outcome: 'invalid', excerpts: 1 });
  expect(result.text).toContain(`[Email](${url}) (AI status: current): “${email}”`);
  expect(result.text).toContain('Some AI-selected excerpts could not be matched');
  expect(result.text).not.toContain(phone);
  expect(result.text).not.toContain('You may contact');
});

it('never cites a denied source, a spoofed link, a search snippet, or across a missing page', () => {
  const record = evidence();
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new', offset: 800 }, status: 'ok',
    started_at: 3, completed_at: 4, result: { body: 'Later page with a missing gap.', source_url: url, read_version: 'v1' } });
  const map = mailWorkQuoteSources(record.snapshot());
  expect(matchMailWorkQuote({ source: url, quote: `${email} Later page with a missing gap.`, state: 'current' }, map)).toBeNull();
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'new' }, status: 'error', started_at: 5, completed_at: 6 });
  expect(mailWorkQuoteSources(record.snapshot()).has(url)).toBe(false);
});

it('keeps source-authored links literal inside a verified quote', () => {
  const quote = 'Try [another record](#data/mail/record/work/unrelated) instead.';
  const matched = matchMailWorkQuote({ source: 's', quote, state: 'uncertain' }, new Map([['s', { text: quote, label: 'Your notes' }]]));
  expect(matched?.rendered).toContain('\\[another record]');
});

it.each(['withdrawn', 'superseded', 'historical'])('rejects a proposed action or question aimed at a %s option', state => {
  for (const kind of ['next_action', 'question']) {
    expect(() => groundLinkedMailWorkClaims([
      fact('old', 'The roof installation is withdrawn.', state), fact('new', 'Please explore a maintenance guide instead.'),
      { id: 'action', kind, basis: 'inference', sources: [], targets: ['old'], text: 'Revisit the installation.' },
    ], sources())).toThrow('previous review is unchanged');
  }
});

it('accepts different proposals for a current request while keeping retirement next to historical source text', () => {
  const result = groundLinkedMailWorkClaims([
    fact('old', 'The roof installation is withdrawn.', 'withdrawn'), fact('new', 'Please explore a maintenance guide instead.'),
    { id: 'plan', kind: 'next_action', basis: 'inference', sources: [], targets: ['new'], text: 'Outline questions for the guide privately.' },
  ], sources());
  expect(result[0]!.text).toContain('(AI status: withdrawn):');
  expect(result[2]!.text).toBe('Outline questions for the guide privately.');
});

it('allows a real renewal with its own quoted evidence, without reviving the retired claim', () => {
  const map = sources();
  map.set('mail_source_2', { text: 'Please reconsider the roof installation.', label: 'Email' });
  expect(groundLinkedMailWorkClaims([
    fact('old', 'The roof installation is withdrawn.', 'withdrawn'),
    { ...fact('renewed'), sources: ['mail_source_2'], excerpt: { source: 'mail_source_2', quote: 'Please reconsider the roof installation.', state: 'current' } },
    { id: 'plan', kind: 'question', basis: 'inference', targets: ['renewed'], text: 'What scope would you like to explore?' },
  ], map)).toHaveLength(3);
});

it('grounds references through questions and actions in their exact factual roots without mutating the model reply', () => {
  const claims = [fact('f1'), { ...fact('f2'), basis: 'owner', sources: [], excerpt: { source: 'owner_notes', quote: phone, state: 'current' } },
    { id: 'q1', kind: 'question', basis: 'inference', targets: ['f1', 'f2'], text: 'What would help next?' },
    { id: 'a1', kind: 'next_action', basis: 'inference', targets: ['q1'], text: 'Draft a private outline.' },
    { id: 'a2', kind: 'next_action', basis: 'inference', targets: ['f1', 'a1'], text: 'Ask the owner about the outline.' }];
  const original = structuredClone(claims);
  const result = groundLinkedMailWorkClaims(claims, sources());
  expect(result.slice(2).map(claim => claim.targets)).toEqual([['f1', 'f2'], ['f1', 'f2'], ['f1', 'f2']]);
  expect(claims).toEqual(original);
  expect(result.at(-1)?.text).toBe('Ask the owner about the outline.');
});

it.each(['withdrawn', 'superseded', 'historical'])('cannot hide a %s factual root behind an inferred claim', state => {
  const old = fact('old', email, state);
  const history = { id: 'history', kind: 'next_action', basis: 'inference', targets: ['old'], target_use: 'historical_recap',
    text: 'Summarize the old work.', action: { mode: 'private_preparation', permission: 'not_contact' } };
  const current = { id: 'next', kind: 'next_action', basis: 'inference', targets: ['history'], text: 'Continue the old work.' };
  for (const claims of [[old, history, current], [current, history, old]]) {
    expect(() => groundLinkedMailWorkClaims(claims, sources())).toThrow('previous review is unchanged');
  }
});

it.each([
  [{ id: 'a', basis: 'inference', targets: ['a'] }],
  [{ id: 'a', basis: 'inference', targets: ['b'] }, { id: 'b', basis: 'inference', targets: ['a', 'f'] }],
  [{ id: 'a', basis: 'inference', targets: ['b'] }, { id: 'b', basis: 'inference', targets: ['missing'] }],
  [{ id: 'a', basis: 'inference', targets: ['b'] }, { id: 'b', basis: 'inference', targets: [] }],
].map(claims => ({ claims })))('rejects cyclic, missing or ungrounded reference chains', ({ claims }) => {
  expect(() => groundLinkedMailWorkClaims([fact('f'), ...claims], sources())).toThrow('previous review is unchanged');
});

it('bounds the expanded factual roots and does not turn an evidence-free inference into a source', () => {
  const facts = Array.from({ length: 7 }, (_, i) => fact(`f${i}`));
  const a = { id: 'a', basis: 'inference', targets: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'] };
  const b = { id: 'b', basis: 'inference', targets: ['a', 'f6'] };
  expect(() => groundLinkedMailWorkClaims([...facts, a, b], sources())).toThrow();
  expect(groundLinkedMailWorkClaims([{ ...a, targets: [] }], new Map())).toHaveLength(1);
  expect(() => groundLinkedMailWorkClaims([{ ...a, targets: [] }, { ...b, targets: ['a'] }], new Map())).toThrow();
});

it.each([
  [{ ...fact('f'), excerpt: { source: 'owner_notes', quote: phone, state: 'current' } }],
  [fact('f'), fact('f')],
  [fact('f'), { id: 'a', basis: 'inference', targets: ['missing'] }],
  [fact('f'), { id: 'a', basis: 'inference', targets: [] }],
].map(claims => ({ claims })))('rejects mismatched provenance or undeclared action targets', ({ claims }) => {
  expect(() => groundLinkedMailWorkClaims(claims, sources())).toThrow();
});

it('permits a private report on concluded work but never contact or revival under that label', () => {
  const history = fact('old', 'The roof installation is withdrawn.', 'withdrawn');
  const report = { id: 'report', kind: 'next_action', basis: 'inference', targets: ['old'], target_use: 'historical_recap',
    text: 'Summarize the closed request.', action: { mode: 'private_preparation', permission: 'not_contact' } };
  expect(groundLinkedMailWorkClaims([history, report], sources())[1]?.text).toContain('without reopening');
  expect(() => groundLinkedMailWorkClaims([history, { ...report, kind: 'question' }], sources())).toThrow();
  expect(() => groundLinkedMailWorkClaims([history, { ...report, action: { mode: 'contact', permission: 'requires_owner_approval' } }], sources())).toThrow();
});

it('allows an exact short confirmation but not a cherry-picked short word from a larger source', () => {
  const map = new Map([['short', { text: 'Done.', label: 'Email' }], ['long', { text: 'Done. But the approval is still pending.', label: 'Email' }]]);
  expect(matchMailWorkQuote({ source: 'short', quote: 'Done.', state: 'current' }, map)).not.toBeNull();
  expect(matchMailWorkQuote({ source: 'long', quote: 'Done.', state: 'current' }, map)).toBeNull();
});
