/** D-335 slice AT (2026-11-07) — a tab showing a PDF, read in the round that reached it. The owner: "go
 *  ahead with #1, then #2". Task K's runs clicked a PDF's link, the answer carrying the kept PDF (slice
 *  AS), and then spent a round writing `document.read` before answering. The turn now makes that read
 *  itself, in the click's round, as a call of its own.
 *
 *  Through the REAL orchestrator and chat store, as the held-call wait is tested
 *  (`d-337-owner-chat-held-wait.test.ts`); the registry is a stub answering by tool, and the model's
 *  packets are read as they were sent. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AIOutput, ChatDispatchResult, InternalToolRegistry, RecuedServerSignature, ToolEntry } from '@recued/contracts';

import { pdfKeptNote, pdfReadForYouNote } from '../bridges/pdf-tab-notes.js';
import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { sourceCitation } from '../chat-source-citations.js';
import { keptTabPdfs, withTabPdfReadNote } from '../chat-tab-pdf-read.js';
import { createHeldRunWaiters, settledHeldCallResult } from '../held-run-waiters.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const SIGNATURE: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'tab-pdf-read' };
const ACT = 'kitchen/act-on-web-page';
const READ = 'document.read';
const FILE_REF = 'file:0123456789abcdef0123456789abcdef';
const PDF_TEXT = 'The following image shows a happy looking dog lying in some grass:';
const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const READ_VERSION = 'a'.repeat(64);

const entry = (name: string, tier: 1 | 2, classification: ToolEntry['classification']): ToolEntry => ({
  name, tier, description: name, arg_schema: { type: 'object', properties: {}, additionalProperties: true },
  topic_tags: [], classification, concurrency_safe: false,
});

/** What Act on web pages answers when its click ends on a tab showing a PDF, as slice AS writes it. */
const clicked = (): ChatDispatchResult => ({ ok: true, result: { recipe_id: 'act-on-web-page', success: true, output: {
  render: [{ type: 'json', data: { done: 1, of: 1, steps: ['1. clicked e14'], page: '7:PDFDOC',
    url: 'https://example.test/example.pdf', title: '', pdf: { file_ref: FILE_REF, filename: 'example.pdf',
      mime_type: 'application/pdf', size_bytes: 82_487, note: pdfKeptNote('example.pdf', FILE_REF) } } }],
} } });

/** What `document.read` answers for that PDF. */
const read = (): ChatDispatchResult => ({
  ok: true,
  source_citations: [sourceCitation({ kind: 'file', file_ref: FILE_REF, collection_slug: 'received', content_hash: 'b'.repeat(64) },
    'example.pdf', READ_VERSION, NOW)],
  result: { status: 'read', file_ref: FILE_REF, read_version: READ_VERSION, filename: 'example.pdf', converter: 'pdftotext',
    body: PDF_TEXT, offset: 0, next_offset: null },
});
const held = (run_id: string): ChatDispatchResult => ({ ok: true, run_held: { kind: 'approval' }, run_id,
  result: { status: 'awaiting_approval', awaiting_approval: true, message: 'Held for the owner.' } });

/** One turn of the owner's app chat: the model's rounds as given, the registry answering by tool. */
const turn = async (options: {
  rounds: AIOutput[];
  readAnswer?: () => ChatDispatchResult | Promise<ChatDispatchResult>;
  documentReadNative?: boolean;
  settleHeld?: 'answered' | 'not_answered';
}) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 's1', now: NOW - 10_000 });
  const packets: string[] = [];
  const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
    packets.push(String(aiInput['llm.prompt']));
    return { body: options.rounds[Math.min(packets.length, options.rounds.length) - 1]! };
  });
  const entries = [entry(ACT, 2, 'unknown'), entry(READ, options.documentReadNative === false ? 2 : 1, 'read')];
  const waiters = createHeldRunWaiters({ now: () => NOW });
  const dispatch = vi.fn<InternalToolRegistry['dispatch']>(async (name) => {
    if (name === ACT) return clicked();
    if (name === READ) {
      if (options.settleHeld === 'answered') {
        setTimeout(() => waiters.settled({ execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's1',
          user_id: 'local' }, run_id: 'run-9', tool_name: READ, result: read(), ts: NOW + 2_000 } as PreflightRunSettled), 10);
      }
      return options.readAnswer !== undefined ? options.readAnswer() : read();
    }
    return { ok: false, reason: 'unknown_tool', detail: name };
  });
  const registry: InternalToolRegistry = {
    list: () => entries, listByTier: (tier) => entries.filter((e) => e.tier === tier),
    getByName: (name) => entries.find((e) => e.name === name) ?? null, dispatch, subscribeRefresh: () => () => undefined,
  };
  const settleHeldCall = vi.fn(async (call: { run_id: string; held: ChatDispatchResult; until: number; signal?: AbortSignal }) => {
    if (options.settleHeld !== 'answered') return undefined;
    const settled = await waiters.wait(call.run_id, call.until, call.signal);
    return settled === undefined ? undefined : settledHeldCallResult(settled, call.held);
  });
  const orchestrator = createChatOrchestrator({ chatStore: store, registry, selfSignature: SIGNATURE, executeAiCall,
    now: () => NOW, settleHeldCall } as never);
  await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' },
    message: 'Find the example PDF on that page and tell me the sentence above its image.' } as never);
  const messages = await store.listMessages('s1');
  db.close();
  return { packets, dispatch, messages };
};

const clickRound: AIOutput = { response: '', events: [], tool_calls: [{ tool: ACT, args: { page: '7:PDFDOC',
  steps: [{ do: 'click', ref: 'e14' }] } }] };
const answerRound: AIOutput = { response: `It reads: "${PDF_TEXT}"`, events: [], tool_calls: [] };
const readsOf = (dispatch: ReturnType<typeof vi.fn<InternalToolRegistry['dispatch']>>) =>
  dispatch.mock.calls.filter(([name]) => name === READ).map(([, args]) => args);

describe('D-335 slice AT — the PDF a tab showed, read in the round that reached it', () => {
  // The packets after the second are the turn's own (its closing brief, the chat's title), not rounds.
  it('the click\'s round carries the PDF\'s text into the model\'s next packet', async () => {
    const { packets, dispatch } = await turn({ rounds: [clickRound, answerRound] });
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual([ACT, READ]);
    expect(readsOf(dispatch)).toEqual([{ file_ref: FILE_REF }]);
    expect(packets[1]).toContain(PDF_TEXT);
    expect(packets[1]).toContain(pdfReadForYouNote('example.pdf', FILE_REF));
    expect(packets[1]).not.toContain(pdfKeptNote('example.pdf', FILE_REF));
  });

  it('the read is the turn\'s own call: its row is kept, and the PDF is among the answer\'s sources', async () => {
    const { messages } = await turn({ rounds: [clickRound, answerRound] });
    const answer = messages.filter((m) => m.role === 'assistant').at(-1);
    expect(answer?.source_citations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file', file_ref: FILE_REF })]));
    expect(messages.some((m) => m.role === 'tool' && String(m.content).startsWith(`${READ}(`))).toBe(true);
  });

  // Live, task K: the click's answer, its note swapped, was kept a second time as a call and result of
  // its own, since the turn knows a saved row by its result object, and the swap made a new one.
  it('the click\'s answer is kept once, as the dispatch saved it', async () => {
    const { messages } = await turn({ rounds: [clickRound, answerRound] });
    const actRows = messages.filter((m) => m.role === 'tool' && String(m.content).startsWith(ACT)).map((m) => String(m.content));
    expect(actRows.filter((row) => row.startsWith(`${ACT}: `))).toHaveLength(1);
    expect(actRows.filter((row) => row.startsWith(`${ACT}(`) && row.includes('): '))).toEqual([]);
  });

  it('once a PDF a turn: a second answer keeping the same PDF reads nothing more', async () => {
    const { dispatch } = await turn({ rounds: [clickRound, clickRound, answerRound] });
    expect(readsOf(dispatch)).toHaveLength(1);
  });

  it('only where the model could read it itself: with no native document.read, nothing is read', async () => {
    const { packets, dispatch } = await turn({ rounds: [clickRound, answerRound], documentReadNative: false });
    expect(readsOf(dispatch)).toEqual([]);
    expect(packets[1]).toContain(pdfKeptNote('example.pdf', FILE_REF));
  });

  it('a read held for the owner\'s approval waits as a held call does: answered, its text comes in the round', async () => {
    const { packets } = await turn({ rounds: [clickRound, answerRound], readAnswer: () => held('run-9'), settleHeld: 'answered' });
    expect(packets[1]).toContain(PDF_TEXT);
  });

  it('not answered in time, the read stays held and the model is told so', async () => {
    const { packets } = await turn({ rounds: [clickRound, answerRound], readAnswer: () => held('run-9'), settleHeld: 'not_answered' });
    expect(packets[1]).toContain('awaiting_approval');
    expect(packets[1]).not.toContain(PDF_TEXT);
  });

  it('a read that fails is the read\'s failure, never the click\'s', async () => {
    const { packets } = await turn({ rounds: [clickRound, answerRound],
      readAnswer: () => { throw new Error('the reader went away'); } });
    expect(packets[1]).toContain('1. clicked e14');
    expect(packets[1]).toContain(pdfReadForYouNote('example.pdf', FILE_REF));
    expect(packets[1]).toContain('execution_error');
  });
});

describe('D-335 slice AT — finding the PDFs an answer kept', () => {
  it('a sequence\'s tabs, each PDF once; a pdf AS did not write is left alone', () => {
    const answer: ChatDispatchResult = { ok: true, result: { output: { render: [{ type: 'json', data: {
      pdf: { file_ref: FILE_REF, filename: 'example.pdf', mime_type: 'application/pdf', note: pdfKeptNote('example.pdf', FILE_REF) },
      tabs: [
        { pdf: { file_ref: FILE_REF, filename: 'example.pdf', mime_type: 'application/pdf', note: pdfKeptNote('example.pdf', FILE_REF) } },
        { pdf: { file_ref: 'file:ffffffffffffffffffffffffffffffff', filename: 'b.pdf', mime_type: 'application/pdf', note: 'other' } },
      ],
    } }] } } };
    expect(keptTabPdfs(answer)).toEqual([{ file_ref: FILE_REF, filename: 'example.pdf' }]);
    expect(keptTabPdfs({ ok: false, reason: 'execution_error' })).toEqual([]);
  });

  it('the note swapped wherever the answer carries it, the rest as it was', () => {
    const note = pdfKeptNote('example.pdf', FILE_REF);
    const answer: ChatDispatchResult = { ok: true, result: { output: { render: [{ type: 'json', data: {
      text: `${note}\n`, pdf: { file_ref: FILE_REF, filename: 'example.pdf', mime_type: 'application/pdf', note }, title: 'Example' } }] } } };
    const swapped = JSON.stringify(withTabPdfReadNote(answer, { file_ref: FILE_REF, filename: 'example.pdf' }));
    expect(swapped).not.toContain(note);
    expect(swapped.split(pdfReadForYouNote('example.pdf', FILE_REF).replace(/"/g, '\\"')).length - 1).toBe(2);
    expect(swapped).toContain('"title":"Example"');
  });
});
