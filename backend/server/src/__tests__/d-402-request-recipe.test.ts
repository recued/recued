/** D-402 slice A4 — "Make a recipe" on a request in the owner's chat: every turn of the request
 *  compiled into a draft kept in Kitchen as Recued's, with its notes (D-402 §3.3). */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRecipe } from '@recued/recipes';
import { createBrowserFlowRecorder } from '../bridges/browser-flow-record.js';
import { createKitchenDraftStore } from '../kitchen-draft-store.js';
import { makeRequestRecipeDraft } from '../request-recipe.js';
import { handleExecutionRequestRecipe, type ChatRpcDeps } from '../chat-handler.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const stand = () => {
  const db = new Database(':memory:'); databases.push(db);
  const kitchen = createKitchenDraftStore(db);
  const flows = createBrowserFlowRecorder({ now: () => 5 });
  // Turns 1 and 2 are one request (2 is the approval's turn); turn 3 is the next request.
  const roots: Record<string, string> = { 't-1': 'req-a', 't-2': 'req-a', 't-3': 'req-b' };
  const make = makeRequestRecipeDraft({ flows, resolveRoot: (_session, turn) => roots[turn], kitchenDrafts: kitchen });
  /** One toolkit call of the request, as the execute handler and the DOM adapter record it. */
  const step = (run: string, turn: string, step: Parameters<typeof flows.record>[1]) => {
    flows.bindRun(run, { session_id: 'chat-1', turn_id: turn });
    flows.startCall(run, { recipe_id: step.do === 'type' ? 'type-into-web-page' : 'click-web-element',
      args: { page: 'bridge:work:7:D1', ref: 'e1', ...(step.do === 'type' ? { value: step.value } : {}) }, browser: true });
    flows.record(run, step, 1);
    flows.finishCall(run, { outcome: 'done', steps: [{ id: 'act', result: { page: 'bridge:work:7:D1', url: step.url } }] });
  };
  return { kitchen, flows, make, step };
};
const page = { url: 'https://github.com/new', title: 'New repository' };

describe('D-402 slice A4 — a request in the chat made into a draft in Kitchen', () => {
  it('compiles every turn of the request, and keeps the draft as Recued\'s with its notes', async () => {
    const t = stand();
    t.step('run-1', 't-1', { do: 'type', ...page, element: { role: 'text box', label: 'Repository name', selector: '#name' },
      value: 'recued-notes' });
    t.step('run-2', 't-2', { do: 'click', ...page, element: { role: 'button', label: 'Create' } });
    t.step('run-3', 't-3', { do: 'click', ...page, element: { role: 'button', label: 'Somewhere else', selector: '#other' } });
    const answer = await t.make({ session_id: 'chat-1', turn_id: 't-2' });
    expect(answer).toMatchObject({ ok: true, kitchen_path: expect.stringContaining('#kitchen/import/') });
    if (!answer.ok) throw new Error('expected a draft');
    const draft = t.kitchen.get(answer.draft_id)!;
    expect(draft).toMatchObject({ made_from: { kind: 'chat_request', session_id: 'chat-1', turn_id: 't-2' },
      validation: { valid: true } });
    expect(draft.notes).toEqual(answer.issues);
    // Slice B1: the button no selector was recorded for is found by what it shows.
    expect(draft.notes!.some((note) => note.includes('found by what it shows, “Create”'))).toBe(true);
    const parsed = parseRecipe(JSON.parse(draft.source));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const text = JSON.stringify(parsed.recipe);
    expect(text).toContain('#name');
    expect(text).toContain('recued-notes');
    expect(text).not.toContain('#other');
    expect(t.kitchen.listAll().find((item) => item.draft_id === answer.draft_id)).toMatchObject({ from: 'your chat' });
  });

  it('gives each draft a recipe of its own, so saving one never replaces another from the same chat', async () => {
    const t = stand();
    t.step('run-1', 't-1', { do: 'click', ...page, element: { role: 'button', label: 'Create', selector: '#create' } });
    t.step('run-3', 't-3', { do: 'click', ...page, element: { role: 'button', label: 'Import', selector: '#import' } });
    const ids = [];
    for (const turn_id of ['t-1', 't-3']) {
      const answer = await t.make({ session_id: 'chat-1', turn_id });
      if (!answer.ok) throw new Error(answer.issues.join(' '));
      ids.push((JSON.parse(t.kitchen.get(answer.draft_id)!.source) as { recipe_id: string }).recipe_id);
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('says so when nothing is held for the request, or nothing in it can be repeated; a request that only read compiles', async () => {
    const t = stand();
    expect(await t.make({ session_id: 'chat-1', turn_id: 't-1' })).toMatchObject({ ok: false, reason: 'nothing_kept' });
    t.flows.bindRun('run-tabs', { session_id: 'chat-1', turn_id: 't-1' });
    t.flows.startCall('run-tabs', { recipe_id: 'list-browser-tabs', args: {}, browser: true });
    t.flows.finishCall('run-tabs', { outcome: 'done', steps: [{ id: 'tabs', result: { tabs: [] } }] });
    expect(await t.make({ session_id: 'chat-1', turn_id: 't-1' })).toMatchObject({ ok: false, reason: 'no_actions' });
    expect(t.kitchen.listAll()).toEqual([]);
    // Slice B: reading is something a recipe repeats.
    t.flows.bindRun('run-read', { session_id: 'chat-1', turn_id: 't-1' });
    t.flows.startCall('run-read', { recipe_id: 'inspect-web-page', args: { page: 'bridge:work:7:D1' }, browser: true });
    t.flows.finishCall('run-read', { outcome: 'done', steps: [{ id: 'read', result: { page: 'bridge:work:7:D1',
      url: 'https://github.com/notifications', html: '<h1>Hi</h1>' } }] });
    const read = await t.make({ session_id: 'chat-1', turn_id: 't-1' });
    if (!read.ok) throw new Error(read.issues.join(' '));
    expect(JSON.parse(t.kitchen.get(read.draft_id)!.source).steps[0].args.steps).toEqual([
      { url: 'https://github.com/notifications', do: 'read' }]);
  });

  it('reads out the values the request\'s reply set apart, from the page that showed them (slice B2b)', async () => {
    const db = new Database(':memory:'); databases.push(db);
    const kitchen = createKitchenDraftStore(db);
    const flows = createBrowserFlowRecorder({ now: () => 5 });
    const replies: Array<{ session: string; turns: string[] }> = [];
    const make = makeRequestRecipeDraft({ flows, resolveRoot: () => 'req-a', kitchenDrafts: kitchen,
      answerOf: async (session, inRequest) => { replies.push({ session, turns: ['t-1', 't-9'].filter(inRequest) });
        return { reply: 'The newest notification is **Build failed on main**.', request: 'What is my newest notification?' }; } });
    flows.bindRun('run-read', { session_id: 'chat-1', turn_id: 't-1' });
    flows.startCall('run-read', { recipe_id: 'inspect-web-page', args: { page: 'bridge:work:7:D1' }, browser: true });
    flows.recordRead('run-read', { page: 'bridge:work:7:D1', url: 'https://github.com/notifications',
      html: '<ul><li class="notification"><a class="title" href="/n/1" ref="e3">Build failed on main</a></li></ul>' });
    flows.finishCall('run-read', { outcome: 'done', steps: [{ id: 'inspect', result: { page: 'bridge:work:7:D1', url: 'https://github.com/notifications' } }] });
    const answer = await make({ session_id: 'chat-1', turn_id: 't-1' });
    if (!answer.ok) throw new Error(answer.issues.join(' '));
    expect(replies).toEqual([{ session: 'chat-1', turns: ['t-1', 't-9'] }]);
    expect(JSON.parse(kitchen.get(answer.draft_id)!.source).steps[0].args.steps).toEqual([
      { url: 'https://github.com/notifications', do: 'read', selector: 'a.title', form: 'text' }]);
  });

  it('a reply the job wrote from what it read is written again at each run, by the owner\'s request (rule 7, task E)', async () => {
    const db = new Database(':memory:'); databases.push(db);
    const kitchen = createKitchenDraftStore(db);
    const flows = createBrowserFlowRecorder({ now: () => 5 });
    const request = 'Read the release notes on that page and sum them up in two sentences.';
    const make = makeRequestRecipeDraft({ flows, resolveRoot: () => 'req-a', kitchenDrafts: kitchen,
      answerOf: async () => ({ request, reply: 'This release makes start-up faster and fixes the crash on large files. '
        + 'It also adds a dark theme that follows the system setting.' }) });
    const notes = 'https://example.com/releases';
    flows.bindRun('run-read', { session_id: 'chat-1', turn_id: 't-1' });
    flows.startCall('run-read', { recipe_id: 'read-web-text', args: { page: notes, find: 'Release notes' }, browser: true });
    flows.recordRead('run-read', { page: 'bridge:work:7:D1', url: notes, html: '<main><h2>Release notes</h2><ul><li>Start-up is twice as '
      + 'quick.</li><li>Opening files over 2 GB no longer crashes.</li><li>Dark theme, set by the system.</li></ul></main>' });
    flows.finishCall('run-read', { outcome: 'done', steps: [{ id: 'read', result: { page: 'bridge:work:7:D1', url: notes } }] });
    const answer = await make({ session_id: 'chat-1', turn_id: 't-1' });
    if (!answer.ok) throw new Error(answer.issues.join(' '));
    const source = JSON.parse(kitchen.get(answer.draft_id)!.source) as { steps: Array<{ id: string; op: string }>; variables: Record<string, unknown> };
    expect(source.steps.map((step) => step.op)).toEqual(['core.dom.act', 'core.ai.prompt']);
    expect(source.variables).toMatchObject({ instruction_answer: { default: request } });
  });

  it('a document read the chat answered from kept text reads with the reader Recued reads that file with (task K, live)', async () => {
    const opsOf = async (documentReader?: (record_id: string) => string | undefined) => {
      const db = new Database(':memory:'); databases.push(db);
      const kitchen = createKitchenDraftStore(db);
      const flows = createBrowserFlowRecorder({ now: () => 5 });
      const make = makeRequestRecipeDraft({ flows, resolveRoot: () => 'req-a', kitchenDrafts: kitchen, ...(documentReader ? { documentReader } : {}) });
      // As `document.read` runs a file whose text a reader had kept: a read of the file's details, to admit it.
      flows.bindRun('run-doc', { session_id: 'chat-1', turn_id: 't-1' });
      flows.startCall('run-doc', { recipe_id: 'read-work-document', args: { source: 'file:doc-1' }, ops: ['core.storage.data-file-read'] });
      flows.finishCall('run-doc', { outcome: 'done', steps: [{ id: 'read', result: { record_id: 'file:doc-1', mime_type: 'application/pdf' } }] });
      const answer = await make({ session_id: 'chat-1', turn_id: 't-1' });
      if (!answer.ok) throw new Error(answer.issues.join(' '));
      return (JSON.parse(kitchen.get(answer.draft_id)!.source) as { steps: Array<{ op?: string; transform?: string }> }).steps.map((step) => step.op ?? step.transform);
    };
    expect(await opsOf((id) => (id === 'file:doc-1' ? 'recued-core.pdftotext.pdf.to_text' : undefined)))
      .toEqual(['recued-core.pdftotext.pdf.to_text', 'core.storage.file.read-temp', 'decode_base64']);
    expect(await opsOf()).toEqual(['core.storage.data-file-read', 'decode_base64']);
  });

  it('the rpc names the request by session and turn, and refuses a call without them', async () => {
    const t = stand();
    t.step('run-1', 't-1', { do: 'click', ...page, element: { role: 'button', label: 'Create', selector: '#create' } });
    const deps = { executionRequestRecipe: t.make } as unknown as ChatRpcDeps;
    expect(await handleExecutionRequestRecipe(deps, { session_id: 'chat-1', turn_id: 't-1' })).toMatchObject({ ok: true });
    await expect(handleExecutionRequestRecipe(deps, { session_id: 'chat-1' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleExecutionRequestRecipe({} as ChatRpcDeps, { session_id: 'chat-1', turn_id: 't-1' }))
      .rejects.toMatchObject({ code: 'not_configured' });
  });
});
