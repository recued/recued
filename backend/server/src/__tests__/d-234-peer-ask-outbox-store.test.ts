import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createPeerAnswerStore } from '../storage/peer-answer-store.js';
import {
  createPeerAskOutboxStore,
  type PeerAskOutboxStageRow,
} from '../storage/peer-ask-outbox-store.js';

const staged = (over: Partial<PeerAskOutboxStageRow> = {}): PeerAskOutboxStageRow => ({
  exchange_ref: 'exchange-1',
  run_id: 'run-1',
  gated_step_id: 'ask-peer',
  checkpoint_id: 'checkpoint-peer-1',
  action_ref: 'action-1',
  connection: 'peer-bob',
  label: 'review',
  offered: ['yes', 'no'],
  deadline_at: 10_000,
  created_at: 100,
  delivery: {
    recipient_fingerprint: 'recipient-fingerprint-1',
    carrier: {
      slug: 'peer-exchange-out',
      operation_key: 'ask',
      binding_fingerprint: 'binding-fingerprint-1',
    },
    spec: {
      connection: 'peer-bob',
      label: 'review',
      question: 'Ship it?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
      deadline_at: 10_000,
      on_timeout: 'stop',
      note_prompt: 'optional',
      body: 'The exact review document.',
      via: 'recipe',
      deliver_to: 'recued_peerAsk',
    },
  },
  ...over,
});

describe('PeerAskOutboxStore delivery journal', () => {
  it('keeps a pre-anchor plan staged and unanswerable until activation', () => {
    const store = createPeerAskOutboxStore(new Database(':memory:'));

    expect(store.stage(staged())).toBe(true);
    expect(store.get('exchange-1')).toBeNull();
    expect(store.list()).toEqual([]);
    expect(store.getDelivery('exchange-1')).toMatchObject({
      action_ref: 'action-1',
      delivery_state: 'staged',
      delivery: {
        spec: {
          question: 'Ship it?',
          body: 'The exact review document.',
          via: 'recipe',
        },
      },
    });

    expect(store.activate('exchange-1')).toBe(true);
    expect(store.get('exchange-1')).toMatchObject({ delivery_state: 'pending' });
    expect(store.list()).toHaveLength(1);
  });

  it('retains accepted and refused transitions for crash repair', () => {
    const accepted = createPeerAskOutboxStore(new Database(':memory:'));
    accepted.stage(staged());
    accepted.activate('exchange-1');
    expect(accepted.markDelivered('exchange-1')).toBe(true);
    expect(accepted.get('exchange-1')).toMatchObject({ delivery_state: 'delivered' });

    const refused = createPeerAskOutboxStore(new Database(':memory:'));
    refused.stage(staged());
    refused.activate('exchange-1');
    expect(refused.markRefused('exchange-1', {
      refusal: 'label_not_exposed',
      reason: 'Review is not exposed to this peer.',
    })).toBe('refused');
    expect(refused.get('exchange-1')).toBeNull();
    expect(refused.list()).toEqual([]);
    expect(refused.getDelivery('exchange-1')).toMatchObject({
      delivery_state: 'refused',
      refusal: { refusal: 'label_not_exposed' },
    });
    expect(refused.listDeliveries()).toHaveLength(1);
  });

  it('arbitrates refusal against an answer committed on another SQLite connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-peer-refusal-'));
    const path = join(dir, 'realm.db');
    const outboxDb = new Database(path);
    const answerDb = new Database(path);
    try {
      const outbox = createPeerAskOutboxStore(outboxDb);
      const answers = createPeerAnswerStore(answerDb);
      outbox.stage(staged());
      outbox.activate('exchange-1');
      expect(answers.record({
        exchange_ref: 'exchange-1',
        peer_contract_id: 'peer-contract-1',
        answered: true,
        option: 'yes',
        at: 1,
      })).toBe(true);

      expect(outbox.markRefused('exchange-1', {
        refusal: 'label_not_exposed',
        reason: 'late transport refusal',
      })).toBe('answered');
      expect(outbox.getDelivery('exchange-1')).toMatchObject({
        delivery_state: 'pending',
      });
    } finally {
      answerDb.close();
      outboxDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prevents a cross-process answer from claiming after refusal won', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-peer-refusal-'));
    const path = join(dir, 'realm.db');
    const outboxDb = new Database(path);
    const answerDb = new Database(path);
    try {
      const outbox = createPeerAskOutboxStore(outboxDb);
      const answers = createPeerAnswerStore(answerDb);
      outbox.stage(staged());
      outbox.activate('exchange-1');
      expect(outbox.markRefused('exchange-1', {
        refusal: 'label_not_exposed',
        reason: 'receiver refused',
      })).toBe('refused');

      expect(answers.record({
        exchange_ref: 'exchange-1',
        peer_contract_id: 'peer-contract-1',
        answered: true,
        option: 'yes',
        at: 1,
      })).toBe(false);
      expect(answers.get('exchange-1')).toBeNull();
    } finally {
      answerDb.close();
      outboxDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('joins refusal arbitration when the answer store was composed before the outbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-peer-refusal-order-'));
    const path = join(dir, 'realm.db');
    const answerDb = new Database(path);
    const outboxDb = new Database(path);
    try {
      const answers = createPeerAnswerStore(answerDb);
      const outbox = createPeerAskOutboxStore(outboxDb);
      outbox.stage(staged());
      outbox.activate('exchange-1');
      expect(outbox.markRefused('exchange-1', {
        refusal: 'label_not_exposed',
        reason: 'receiver refused',
      })).toBe('refused');

      expect(answers.record({
        exchange_ref: 'exchange-1',
        peer_contract_id: 'peer-contract-1',
        answered: true,
        option: 'yes',
        at: 1,
      })).toBe(false);
      expect(answers.get('exchange-1')).toBeNull();
    } finally {
      outboxDb.close();
      answerDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is first-write-wins for one exchange plan', () => {
    const store = createPeerAskOutboxStore(new Database(':memory:'));
    expect(store.stage(staged())).toBe(true);
    expect(store.stage(staged({
      delivery: {
        ...staged().delivery,
        spec: { ...staged().delivery.spec, question: 'A different question?' },
      },
    }))).toBe(false);
    expect(store.getDelivery('exchange-1')?.delivery?.spec.question).toBe('Ship it?');
  });

  it('migrates pre-journal rows as delivered without making them resendable', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE peer_ask_outbox (
        exchange_ref TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        gated_step_id TEXT NOT NULL,
        connection TEXT NOT NULL,
        label TEXT NOT NULL,
        offered_json TEXT NOT NULL,
        deadline_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO peer_ask_outbox VALUES
        ('old-exchange', 'old-run', 'old-step', 'peer-old', 'old-label', '["ok"]', NULL, 1);
    `);

    const store = createPeerAskOutboxStore(db);
    expect(store.get('old-exchange')).toMatchObject({
      delivery_state: 'delivered',
      offered: ['ok'],
    });
    expect(store.listDeliveries()).toEqual([]);
  });
});
