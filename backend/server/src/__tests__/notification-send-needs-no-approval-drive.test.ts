/** A recipe notifying the owner does NOT ask the owner for permission first.
 *
 *  Owner, 2026-08-20: *"otherwise owner will be getting: 1) recipeA wants you
 *  send you a notification, allow? 2) recipeA notify you xxx — that's two
 *  notifications in total."* Exactly right, and it is why
 *  `core.notification.send` is now `read` and is not in
 *  `OUTBOUND_SEND_INGREDIENT_SLUGS` (reasoning + the delegated-door consequence
 *  live on the registry entry and in
 *  `packages/contracts/src/__tests__/d-177-notification-send-is-not-a-send.test.ts`).
 *
 *  This file is the END-TO-END half: a real recipe, the real preflight gate,
 *  real kernel manifests and a real notification block, on the channels that
 *  actually fire. It counts BOTH the deliveries and the asks, because "no
 *  approval was raised" and "nothing ran at all" are the same shape on a result
 *  object — and because the whole complaint was about the COUNT.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Checkpoint, Commit, ExecutionSource, RecipeDefinition,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createCommitStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type NotificationSettings,
  type PendingAsk,
} from '@recued/notification';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

const cron: ExecutionSource = {
  channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'nightly-digest',
} as ExecutionSource;
const autoRun: ExecutionSource = {
  channel: 'reactive', actor: 'system', event_kind: 'auto_run_tick', source_recipe: 'nightly-digest',
} as ExecutionSource;
const ownerDirect: ExecutionSource = {
  channel: 'user', actor: 'user_self', user_id: 'local', client_token_id: 'tok',
} as ExecutionSource;

const oneStepRecipe = (
  recipe_id: string,
  step: Record<string, unknown>,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'Notification-approval drive fixture.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [step],
  output: { sidebar: [] },
}) as unknown as RecipeDefinition;

const notifyStep = {
  id: 'notify',
  op: 'core.notification.send',
  args: { title: 'Nightly digest', text: '3 things happened' },
};
/** The CONTROL's step — a still-`write`, still-gated internal write. */
const writeStep = {
  id: 'notify',
  op: 'core.storage.shared.write',
  args: { key: 'notification_drive.control', value: { at: 'tick' } },
};

const checkpointStore = (): CheckpointStore => {
  const written = new Map<string, Checkpoint>();
  return {
    write: vi.fn(async (c: Checkpoint) => { written.set(c.checkpoint_id, c); }),
    get: vi.fn(async (id: string) => written.get(id) ?? null),
    delete: vi.fn(async (id: string) => { written.delete(id); }),
    listByRun: vi.fn(async (r: string) => [...written.values()].filter((c) => c.run_id === r)),
    list: vi.fn(async () => [...written.values()]),
    size: vi.fn(async () => written.size),
  } as unknown as CheckpointStore;
};

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

/** Fire one recipe and report every surface the owner would meet. */
const fire = async (recipe: RecipeDefinition, source: ExecutionSource, trigger: string) => {
  const delivered: string[] = [];
  const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
  const block = createNotificationBlock({
    askStore,
    channels: [createUiChannel({ busSink: () => undefined })],
    settingsStore: createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    ),
  });
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const deps = {
    recipeStore,
    executorConfig: {
      manifests: createManifestRegistry(),
      kernelDispatchers: {
        // Records instead of delivering — the stub is the CHANNEL FAN-OUT, never
        // the gate. Ceiling, preflight gate, ask raise and audit all run for real.
        notificationSend: async (i: { text: string }) => {
          delivered.push(i.text);
          return { delivered_to: ['in_app' as const], failed: [] };
        },
        write: async (i: { key: string }) => ({ key: i.key, revision: 1 }),
      },
    },
    baseVault: {},
    instanceId: 'notification-drive',
    auditLog: createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    ) as AuditLogStore,
    checkpointStore: checkpointStore(),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    preflightNotifier: block,
  } as unknown as ExecuteHandlerDeps;

  const result = await handleExecute(deps, {
    recipe_id: recipe.recipe_id,
    trigger_source: trigger,
    execution_source: source,
  } as never);

  return {
    held: (result as { awaiting_approval?: unknown }).awaiting_approval !== undefined,
    asks: (await askStore.listByStatus('open')).length,
    delivered,
    errors: (result.errors ?? []).map((e) => (e as { code?: string }).code),
  };
};

describe('a notification to the owner needs no approval from the owner', () => {
  it.each([
    ['cron', cron, 'schedule'],
    ['auto_run', autoRun, 'auto_run'],
    ['owner-direct', ownerDirect, 'manual'],
  ] as const)('%s — ONE notification total, zero asks', async (name, source, trigger) => {
    const { held, asks, delivered, errors } = await fire(
      oneStepRecipe(`notify-${name.replace(/[^a-z]/g, '')}`, notifyStep),
      source,
      trigger,
    );

    expect(held, name).toBe(false);
    expect(errors, name).toEqual([]);
    // ⛔ THE ASSERTION THE COMPLAINT WAS ABOUT. Before this ruling the owner got
    // an approval ask AND the notification; now the ask count is zero and the
    // delivery count is one — one interruption, carrying the actual content.
    expect(asks, `${name}: no approval ask may be raised`).toBe(0);
    expect(delivered, name).toEqual(['3 things happened']);
  });

  it('⚠ CONTROL — the same harness DOES still hold a gated write on cron', async () => {
    // Without this, "zero asks" is unfalsifiable: a harness that never gates
    // anything reports zero asks for every input, and the test above would pass
    // just as happily against a broken gate. `core.storage.shared.write` is
    // still `write` and still not an outbound send, so on the LOW `read`
    // ceiling a cron fire must hold — proving the gate is live in this harness
    // and that the notification result above is a decision, not an absence.
    const { held, asks } = await fire(
      oneStepRecipe('control-write-cron', writeStep),
      cron,
      'schedule',
    );

    expect(held, 'the control must hold').toBe(true);
    expect(asks, 'the control must raise exactly one ask').toBe(1);
  });
});
