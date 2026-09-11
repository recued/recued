/** Durable event identity is allocated before the coalescing queue. Exact
 * source-envelope replays retain their sequence across a process restart;
 * source timestamps contribute to identity, never to acceptance ordering. */
import type Database from 'better-sqlite3';
import type { WarehouseEvent } from '@recued/warehouse-events';
import { PREAPPROVAL_LIMITS, RpcError, parsePreapprovalJson } from '@recued/contracts';
import { preapprovalHash } from '../preapproval-invocations.js';
import { initializePreapprovalLifecycle } from './preapproval-lifecycle.js';
import type { PreapprovalCodec } from './preapproval-codec.js';

export interface PreapprovalTriggerEvent {
  event_key: string; ingress_sequence: number; payload_hash: string;
}
export interface PreapprovalTriggerCandidate extends PreapprovalTriggerEvent {
  future_ref: string; trigger_id: string; event_ciphertext: string;
}
export const createPreapprovalTriggerIngress = (db: Database.Database, codec: PreapprovalCodec, now = Date.now,
  onOverflow?: (futureRef: string) => void) => {
  initializePreapprovalLifecycle(db);
  const get = (futureRef: string) => db.prepare('SELECT * FROM preapproval_trigger_candidates WHERE future_ref=?')
    .get(futureRef) as PreapprovalTriggerCandidate | undefined;
  return {
    observe(event: WarehouseEvent): { identity: PreapprovalTriggerEvent; event: WarehouseEvent } {
      if (!db.inTransaction) throw new Error('Trigger ingress must precede queueing in a transaction.');
      const plain = parsePreapprovalJson(event);
      const hash = preapprovalHash(plain);
      const eventKey = `event:${hash}`;
      db.prepare('INSERT OR IGNORE INTO preapproval_trigger_ingress(event_key,payload_hash,received_at) VALUES(?,?,?)')
        .run(eventKey, hash, now());
      const identity = db.prepare('SELECT event_key,ingress_sequence,payload_hash FROM preapproval_trigger_ingress WHERE event_key=?')
        .get(eventKey) as PreapprovalTriggerEvent;
      return { identity, event: plain as unknown as WarehouseEvent };
    },
    offer(futureRef: string, triggerId: string, input: { identity: PreapprovalTriggerEvent; event: WarehouseEvent }): PreapprovalTriggerCandidate | null {
      if (!db.inTransaction) throw new Error('The first trigger candidate requires an ingress transaction.');
      const prior = get(futureRef);
      if (prior) return prior;
      if (Buffer.byteLength(JSON.stringify(input.event), 'utf8') > PREAPPROVAL_LIMITS.plan_bytes) {
        if (!onOverflow) throw new RpcError('preapproval_limit_exceeded', 'The trigger event exceeds the snapshot limit.', 409);
        onOverflow(futureRef); return null;
      }
      const encrypted = codec.sealSync(input.event);
      db.prepare(`INSERT INTO preapproval_trigger_candidates
        (future_ref,trigger_id,event_key,ingress_sequence,payload_hash,event_ciphertext) VALUES(?,?,?,?,?,?)`)
        .run(futureRef, triggerId, input.identity.event_key, input.identity.ingress_sequence, input.identity.payload_hash, encrypted);
      return get(futureRef)!;
    },
    get,
    async read(futureRef: string): Promise<{ candidate: PreapprovalTriggerCandidate; event: WarehouseEvent }> {
      const row = get(futureRef);
      if (!row) throw new RpcError('preapproval_stale', 'The selected trigger event is missing.', 409);
      const event = parsePreapprovalJson(await codec.open(row.event_ciphertext));
      if (preapprovalHash(event) !== row.payload_hash || get(futureRef)?.event_ciphertext !== row.event_ciphertext) {
        throw new RpcError('preapproval_stale', 'The selected trigger event changed.', 409);
      }
      return { candidate: row, event: event as unknown as WarehouseEvent };
    },
    pending(): string[] {
      return (db.prepare(`SELECT c.future_ref FROM preapproval_trigger_candidates c
        JOIN preapproval_executions e ON e.future_ref=c.future_ref
        WHERE e.state='active' AND e.stop_requested=0 ORDER BY c.ingress_sequence LIMIT 100`).all() as Array<{ future_ref: string }>)
        .map(row => row.future_ref);
    },
  };
};
export type PreapprovalTriggerIngress = ReturnType<typeof createPreapprovalTriggerIngress>;
