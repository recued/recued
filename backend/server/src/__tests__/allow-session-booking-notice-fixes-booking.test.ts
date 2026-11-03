/** D-336 (spec §43) — "Allow this session" on a notice to a booking's visitor fixes the booking.
 *
 *  `notify-booking-visitor` emails the visitor behind ONE booking, looked up from `booking_id`.
 *  Its declared authority (`authority_args`, what an open grant pins) still named
 *  `event_source_id`, the input it took before 2026-07-19 (`814ee3c60`, "the calendar leaves the
 *  booking path"), so the grant pinned the mailbox alone: after "Allow this session" on booking
 *  A's notice, a notice to booking B's visitor went without asking.
 *
 *  Scaffolding from `allow-session-send-fixes-recipient.test.ts`: the real gate, the real
 *  notification block and answer path, and the real session-grant store. Only the notice is
 *  recorded instead of sent.
 *
 *  Below, that file's own header: */
/** What "Allow this session" lets a chat send do afterwards, and what the
 *  approval says it lets it do.
 *
 *  The owner, reading the approval of an email chat send (2026-10-19): "the
 *  pinned entries: attachments, bcc, cc, references are all empty = [], does
 *  that mean from/to is never in the picture, any empty: [attachments, bcc, cc,
 *  references] will be allowed if choose 'allow this session'?" The grant fixed
 *  the sender and `to` all along; the approval's list was cut before it reached
 *  them, and said nothing of the cut.
 *
 *  Driven, not read: the shipped send-composed-mail recipe, the bundled
 *  mail-send manifest (its `authority_args` decide what the grant fixes), the
 *  real gate, the real notification block and answer path, and the real
 *  session-grant store. Only the delivery is recorded instead of sent. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  D165_CONTRACT_SCHEMA, type Checkpoint, type Commit, type ExecutionSource, type OpenProjection, type RecipeDefinition,
} from '@recued/contracts';
import { registerPreflightHandler } from '@recued/gateway';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection,
  type ActivityEntry, type AuditEntry, type AuditLogStore, type CheckpointStore,
} from '@recued/storage';
import {
  createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type NotificationSettings, type PendingAsk,
} from '@recued/notification';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createContractDefinitionStore, type ContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';

/** A notice to the visitor behind a booking, as `reschedule-booking`'s `notify` step sends it. */
const RECIPE = {
  recipe_id: 'tell-visitor', version: 1, ttl: 60,
  metadata: { name: 'Tell the visitor', description: 'One notice.', author: 'test', supported_platforms: ['test'] },
  variables: {
    booking_id: { type: 'string', label: 'Booking', default: '' },
    sender_mail_instance: { type: 'string', label: 'Send from', default: '' },
  },
  prefetch_steps: [],
  steps: [{
    id: 'notify', ingredient: 'notify-booking-visitor',
    input: { booking_id: '{{config.booking_id}}', sender_mail_instance: '{{config.sender_mail_instance}}', subject: 'Your booking moved', body: 'See you then.' },
  }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** The owner's first notice, for booking A, sent from their Gmail. */
const FIRST = { booking_id: 'booking-a', sender_mail_instance: 'recueddev' };

const NOW = 1_700_000_000_000;
let db: Database.Database;
let definitionStore: ContractDefinitionStore;
let nowMs: number;

beforeEach(() => {
  db = new Database(':memory:');
  nowMs = NOW;
  let seq = 0;
  const contractStore = createContractStore(db, { now: () => nowMs });
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  definitionStore = createContractDefinitionStore(contractStore, { now: () => nowMs, newId: () => `ct_${++seq}` });
});
afterEach(() => { db.close(); });

const inMemoryCheckpointStore = (): CheckpointStore => {
  const rows = new Map<string, Checkpoint>();
  return {
    write: vi.fn(async (c: Checkpoint) => { rows.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    delete: vi.fn(async (id: string) => { rows.delete(id); }),
    listByRun: vi.fn(async (r: string) => [...rows.values()].filter((c) => c.run_id === r)),
    list: vi.fn(async () => [...rows.values()]),
    size: vi.fn(async () => rows.size),
  } as unknown as CheckpointStore;
};

/** One chat session on the owner's server, with "Allow this session" pressed
 *  on its first send. */
const session = async (extra: Partial<ExecuteHandlerDeps> = {}) => {
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore,
    channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>()),
  });
  const checkpoints = inMemoryCheckpointStore();
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>(),
  ) as AuditLogStore;
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  const sent: Array<{ booking_id: string; subject: string }> = [];
  const deps = {
    recipeStore,
    executorConfig: {
      // No community dir: the registry seeds the bundled kernel manifests,
      // mail-send's `authority_args` among them.
      manifests: createManifestRegistry(),
      kernelDispatchers: {
        notifyBookingVisitor: async (input: { booking_id: string; subject: string }) => {
          sent.push({ booking_id: input.booking_id, subject: input.subject });
          return { notified: true };
        },
      },
    },
    baseVault: {},
    instanceId: 'allow-session-send',
    auditLog,
    checkpointStore: checkpoints,
    preflightNotifier: block,
    // The mint happens at the commit Gateway, which runs only with a commit store.
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    sessionGrantResolver: createSessionGrantResolver({ definitionStore, now: () => nowMs }),
    listSendCapableMailboxes: () => [
      { name: 'recueddev', address: 'recued.dev@gmail.com', provider: 'Gmail' },
      { name: 'outlook', address: 'recued.dev@outlook.com', provider: 'Outlook' },
    ],
    ...extra,
  } as unknown as ExecuteHandlerDeps;
  registerPreflightHandler(block, {
    checkpointStore: checkpoints,
    resumer: createPreflightResumer({ getExecuteDeps: () => deps, auditLog }),
  });

  let turn = 0;
  const send = async (config: Record<string, unknown>) => {
    turn += 1;
    const source = {
      channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner-1', turn_id: `turn-${turn}`,
    } as ExecutionSource;
    const before = (await askStore.listByStatus('open')).length;
    const result = await handleExecute(deps, {
      recipe_id: RECIPE.recipe_id, trigger_source: 'chat', execution_source: source, config,
    } as never);
    const open = await askStore.listByStatus('open');
    return {
      held: (result as { awaiting_approval?: unknown }).awaiting_approval !== undefined,
      asked: open.length > before,
      ask: open.at(-1),
    };
  };

  // The first send holds and offers "Allow this session"; the owner presses it.
  const first = await send(FIRST);
  expect(first.held).toBe(true);
  expect(first.ask!.options.map((o) => o.id)).toContain('allow_session');
  await block.submitAnswer({ ask_id: first.ask!.ask_id, option: 'allow_session', via: 'ui' });
  const grants = definitionStore.listSessionGrants('chat:chat-1');
  expect(grants, 'pressing it mints one grant').toHaveLength(1);
  expect(sent, 'the approved send went out').toHaveLength(1);
  return { send, sent, grants, firstAsk: first.ask! };
};

describe('D-336 (spec §43) — "Allow this session" on a notice to a booking\'s visitor', () => {
  it('fixes the booking: a notice to another booking\'s visitor asks again, and nothing is sent', async () => {
    const { send, sent } = await session();
    const other = await send({ ...FIRST, booking_id: 'booking-b' });
    expect(other.held, 'a notice to booking B is held').toBe(true);
    expect(other.asked).toBe(true);
    expect(sent.map((notice) => notice.booking_id)).toEqual(['booking-a']);
  });

  it('a second notice to the same booking\'s visitor goes without asking', async () => {
    const { send, sent } = await session();
    const again = await send(FIRST);
    expect(again.held).toBe(false);
    expect(sent.map((notice) => notice.booking_id)).toEqual(['booking-a', 'booking-a']);
  });

  it('the grant pins the booking, and the approval says it stays as it is', async () => {
    const { grants, firstAsk } = await session();
    const projection = grants[0]!.open_projection as OpenProjection | undefined;
    const fixed = Object.fromEntries((projection?.args ?? []).map((a) => [a.path, a.derived_pinned]));
    expect(fixed).toMatchObject({ booking_id: 'booking-a', sender_mail_instance: 'recueddev' });
    expect(Object.keys(fixed)).not.toContain('event_source_id');
    expect(firstAsk.message.text).toMatch(/\n- Booking[^\n]*: booking-a\n/);
  });
});
