/** D-114 — Unified dispatch envelope contract invariants.
 *
 *  Locks the additions made by D-114: five new `WorkerDispatchKind`
 *  variants, the `encrypted_payload` field on the envelope base,
 *  the plaintext shapes each encrypted blob decrypts to, and the
 *  new constants governing the staged-deprecation window + chat-
 *  relay buffer retention.
 *
 *  Tests are split between constant values (runtime) and
 *  type-shape assertions (compile-time; we cast to `unknown` then
 *  to the target type to keep the test pure — the compiler
 *  enforces the shape, not a runtime check).
 */

import { describe, expect, it } from 'vitest';
import {
  DISPATCH_EXPIRY_MS,
  DISPATCH_RESULT_TTL_SEC,
  DISPATCH_PENDING_TTL_SEC,
  DISPATCH_TELEGRAM_TTL_SEC,
  CHAT_MESSAGE_RELAY_TTL_MS,
} from '../index.js';
import type {
  WorkerDispatch, WorkerDispatchKind,
  EncryptedBlob,
  RunRecipePlaintext, CronRecipePlaintext, RecipeBackfillPlaintext,
  ReactiveRecipePlaintext, ChatMessageRelayPlaintext,
  EncryptedDispatchPlaintext,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

describe('D-114 constants', () => {
  it('matches the spec values', () => {
    expect(DISPATCH_RESULT_TTL_SEC).toBe(300);
    expect(DISPATCH_PENDING_TTL_SEC).toBe(300);
    expect(DISPATCH_TELEGRAM_TTL_SEC).toBe(1_800);
    expect(CHAT_MESSAGE_RELAY_TTL_MS).toBe(300_000);
  });

  it('DISPATCH_RESULT_TTL and DISPATCH_PENDING_TTL are equal', () => {
    // The caller metadata cmd:{id} and result:{id} entries share the
    // same 5-min window — neither outlives the other.
    expect(DISPATCH_RESULT_TTL_SEC).toBe(DISPATCH_PENDING_TTL_SEC);
  });

  it('DISPATCH_TELEGRAM_TTL > DISPATCH_PENDING_TTL — telegram reply window outlives dispatch', () => {
    // Telegram replies can land well after the dispatch TTL expires
    // (e.g. the user responded 20 min after a slow recipe finished).
    // The reply-target metadata must survive the pending-entry drop.
    expect(DISPATCH_TELEGRAM_TTL_SEC).toBeGreaterThan(DISPATCH_PENDING_TTL_SEC);
  });

  it('CHAT_MESSAGE_RELAY_TTL > DISPATCH_EXPIRY — relay buffer outlives envelope', () => {
    // The envelope TTLs at 60s; the per-instance buffer must retain
    // decoded messages long enough for the slack-watcher /
    // telegram-watcher ingredient to pick them up during its
    // trigger_steps tick. 5 min default gives a multi-tick window.
    expect(CHAT_MESSAGE_RELAY_TTL_MS).toBeGreaterThan(DISPATCH_EXPIRY_MS);
  });
});

// ────────────────────────────────────────────────────────────────
// Kind union — completeness
// ────────────────────────────────────────────────────────────────

describe('WorkerDispatchKind — D-114 extension', () => {
  it('contains every approval kind from D-113', () => {
    const approvalKinds: WorkerDispatchKind[] = [
      'approval_list', 'approval_status',
      'approval_action', 'approval_channel_verify',
    ];
    for (const k of approvalKinds) {
      // Compile-time assignability — round-trip through the union.
      const narrow: WorkerDispatchKind = k;
      expect(narrow).toBe(k);
    }
  });

  it('contains every D-114 encrypted-payload kind', () => {
    const d114Kinds: WorkerDispatchKind[] = [
      'run_recipe', 'cron_recipe', 'recipe_backfill',
      'reactive_recipe', 'chat_message_relay',
    ];
    for (const k of d114Kinds) {
      const narrow: WorkerDispatchKind = k;
      expect(narrow).toBe(k);
    }
  });

  it('exhaustive switch over WorkerDispatchKind compiles', () => {
    // If a new kind lands without a case here, the `never` assertion
    // fires at compile time. Runtime behaviour is a sanity no-op.
    const k: WorkerDispatchKind = 'approval_list';
    const handle = (kind: WorkerDispatchKind): string => {
      switch (kind) {
        case 'approval_list':
        case 'approval_status':
        case 'approval_action':
        case 'approval_channel_verify':
          return 'approval';
        case 'run_recipe':
        case 'cron_recipe':
        case 'recipe_backfill':
        case 'reactive_recipe':
          return 'recipe';
        case 'chat_message_relay':
          return 'relay';
        case 'admin_command':
          return 'admin';
        default: {
          const _never: never = kind;
          return _never;
        }
      }
    };
    expect(handle(k)).toBe('approval');
  });
});

// ────────────────────────────────────────────────────────────────
// Envelope — encrypted_payload carrier
// ────────────────────────────────────────────────────────────────

describe('WorkerDispatch envelope — encrypted_payload', () => {
  const mkEnvelope = <K extends WorkerDispatchKind>(kind: K) => ({
    kind,
    request_id: 'req-1',
    target_instance_id: 'iid-1',
    created_at: Date.now(),
    expires_at: Date.now() + DISPATCH_EXPIRY_MS,
  });

  const encrypted: EncryptedBlob = {
    ciphertext: 'Y2lwaGVy',
    iv: 'bm9uY2U=',
    from: 'worker',
  };

  it('approval_action narrows to cleartext payload (no encrypted_payload)', () => {
    const d: WorkerDispatch = {
      ...mkEnvelope('approval_action'),
      payload: {
        approval_id: 'ap-1',
        decision: 'approve',
        actor_channel: 'slack-slash',
        nonce: 'nonce-1',
      },
    };
    if (d.kind === 'approval_action') {
      expect(d.payload.decision).toBe('approve');
      // encrypted_payload is optional + absent on approval kinds
      expect(d.encrypted_payload).toBeUndefined();
    } else {
      throw new Error('narrowing broken');
    }
  });

  it('run_recipe narrows to encrypted_payload (required field on variant)', () => {
    const d: WorkerDispatch = {
      ...mkEnvelope('run_recipe'),
      encrypted_payload: encrypted,
    };
    if (d.kind === 'run_recipe') {
      expect(d.encrypted_payload).toBe(encrypted);
      expect(d.encrypted_payload.ciphertext).toBe('Y2lwaGVy');
    } else {
      throw new Error('narrowing broken');
    }
  });

  it('cron_recipe / recipe_backfill / reactive_recipe / chat_message_relay each narrow to encrypted_payload', () => {
    const kinds = ['cron_recipe', 'recipe_backfill', 'reactive_recipe', 'chat_message_relay'] as const;
    for (const kind of kinds) {
      const d: WorkerDispatch = {
        ...mkEnvelope(kind),
        encrypted_payload: encrypted,
      };
      expect(d.kind).toBe(kind);
      // Narrow via kind check — each variant has encrypted_payload.
      if (d.kind === 'run_recipe'
        || d.kind === 'cron_recipe'
        || d.kind === 'recipe_backfill'
        || d.kind === 'reactive_recipe'
        || d.kind === 'chat_message_relay') {
        expect(d.encrypted_payload).toBe(encrypted);
      }
    }
  });

  it('expires_at follows the DISPATCH_EXPIRY_MS convention', () => {
    const now = 1_700_000_000_000;
    const d: WorkerDispatch = {
      kind: 'run_recipe',
      request_id: 'req-1',
      target_instance_id: 'iid-1',
      created_at: now,
      expires_at: now + DISPATCH_EXPIRY_MS,
      encrypted_payload: encrypted,
    };
    expect(d.expires_at - d.created_at).toBe(DISPATCH_EXPIRY_MS);
  });
});

// ────────────────────────────────────────────────────────────────
// Plaintext shapes — discriminated on `type`
// ────────────────────────────────────────────────────────────────

describe('EncryptedDispatchPlaintext shapes', () => {
  it('RunRecipePlaintext carries trigger_source + optional backfill metadata', () => {
    const p: RunRecipePlaintext = {
      type: 'run_recipe',
      command_id: 'c1',
      issued_at: Date.now(),
      recipe_id: 'recipe-a',
      trigger_source: 'manual',
    };
    expect(p.type).toBe('run_recipe');
    expect(p.trigger_source).toBe('manual');
  });

  it('CronRecipePlaintext narrows trigger_source to schedule | backfill only', () => {
    const p: CronRecipePlaintext = {
      type: 'cron_recipe',
      command_id: 'c2',
      issued_at: Date.now(),
      recipe_id: 'recipe-a',
      schedule_id: 'sched-1',
      trigger_source: 'schedule',
    };
    expect(p.schedule_id).toBe('sched-1');
    // trigger_source is schedule | backfill — 'manual' wouldn't compile.
    expect(['schedule', 'backfill']).toContain(p.trigger_source);
  });

  it('RecipeBackfillPlaintext requires backfill metadata', () => {
    const p: RecipeBackfillPlaintext = {
      type: 'recipe_backfill',
      command_id: 'c3',
      issued_at: Date.now(),
      recipe_id: 'recipe-a',
      schedule_id: 'sched-1',
      trigger_source: 'backfill',
      backfill: { missed_cycles: 3, last_run_at_before: Date.now() - 300_000 },
    };
    expect(p.backfill.missed_cycles).toBe(3);
    expect(p.trigger_source).toBe('backfill');
  });

  it('ReactiveRecipePlaintext carries process_id continuity', () => {
    const p: ReactiveRecipePlaintext = {
      type: 'reactive_recipe',
      command_id: 'c4',
      issued_at: Date.now(),
      recipe_id: 'reactive-a',
      publisher_id: 'recued-core',
      process_id: 'proc-42',
      trigger_source: 'reactive-remote',
    };
    expect(p.process_id).toBe('proc-42');
    expect(p.trigger_source).toBe('reactive-remote');
  });

  it('ChatMessageRelayPlaintext carries source + channel + message ids', () => {
    const p: ChatMessageRelayPlaintext = {
      type: 'chat_message_relay',
      source: 'slack',
      channel_id: 'C12345',
      message_id: '1700000000.000100',
      team_id: 'T99999',
      sender: { id: 'U1', name: 'Alice' },
      text: 'urgent: prod is down',
      posted_at: 1_700_000_000_000,
    };
    expect(p.source).toBe('slack');
    expect(p.text).toContain('urgent');
  });

  it('EncryptedDispatchPlaintext discriminates on type', () => {
    const plaintexts: EncryptedDispatchPlaintext[] = [
      { type: 'run_recipe', command_id: 'x', issued_at: 0 },
      { type: 'cron_recipe', command_id: 'x', issued_at: 0, recipe_id: 'r', schedule_id: 's', trigger_source: 'schedule' },
      { type: 'recipe_backfill', command_id: 'x', issued_at: 0, recipe_id: 'r', schedule_id: 's', trigger_source: 'backfill', backfill: { missed_cycles: 1, last_run_at_before: 0 } },
      { type: 'reactive_recipe', command_id: 'x', issued_at: 0, recipe_id: 'r', publisher_id: 'p', process_id: 'pid', trigger_source: 'reactive-remote' },
      { type: 'chat_message_relay', source: 'telegram', channel_id: '123', message_id: '456', sender: { id: 'u' }, text: 'hi', posted_at: 0 },
      // Note: admin_command's type field is a free string (slack
      // action values), so the switch's type-narrowing falls through
      // to the default branch when the value isn't one of the
      // recipe/relay literals. Asserted via the cast below.
    ];
    for (const p of plaintexts) {
      switch (p.type) {
        case 'run_recipe': expect(p.command_id).toBe('x'); break;
        case 'cron_recipe': expect((p as { schedule_id: string }).schedule_id).toBe('s'); break;
        case 'recipe_backfill': expect((p as { backfill: { missed_cycles: number } }).backfill.missed_cycles).toBe(1); break;
        case 'reactive_recipe': expect((p as { process_id: string }).process_id).toBe('pid'); break;
        case 'chat_message_relay': expect((p as { text: string }).text).toBe('hi'); break;
      }
    }
  });

  it('AdminCommandPlaintext rides EncryptedDispatchPlaintext', () => {
    const p: EncryptedDispatchPlaintext = {
      type: 'list_recipes',
      command_id: 'x', issued_at: 0,
      requested_by_slack_user: 'U123',
    };
    expect(p.command_id).toBe('x');
    if ('requested_by_slack_user' in p) {
      expect(p.requested_by_slack_user).toBe('U123');
    }
  });
});
