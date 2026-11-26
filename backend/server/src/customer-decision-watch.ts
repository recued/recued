import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  CUSTOMER_ACCOUNT_SCOPES, DECISION_WATCH_ENTITY, DECISION_WATCH_OWNER, DAY_MS, RpcError,
  deserializeEnrichmentMeta, parsePlatformRecordTargetId,
  type CustomerAccountChoice, type CustomerAccountRef, type CustomerDecisionRef,
  type CustomerDecisionReview, type CustomerDecisionWatchChange, type CustomerDecisionWatchView,
} from '@recued/contracts';
import {
  ACCOUNT_DORMANCY_DAYS, ACCOUNT_DORMANCY_MS, ACCOUNT_REENTRY_LOOKBACK_MS, ACCOUNT_REENTRY_RECENT_MS,
} from './housekeeping/engagement-aggregates/account-reentry-signal.js';
import { enrichmentProducerAuthoredBy } from './housekeeping/enrichment-producer.js';
import type { RecordsStore } from './records/store.js';
import { CRM_RECORD_MIRROR_TABLE, type CrmRecordMirrorStore } from './storage/crm-record-mirror-store.js';
import { ENGAGEMENT_EDGES_TABLE, ENGAGEMENTS_TABLE } from './storage/engagement-store.js';
import type { EnrichmentStore } from './storage/enrichment-store.js';

const TOPIC = 'account_reentry_signal';
const AUTHOR = enrichmentProducerAuthoredBy(TOPIC);
const TASK_INTERVAL_MS = 60_000;

interface WatchRow {
  id: string;
  decision_id: string;
  incarnation: string;
  title: string;
  rationale: string;
  account_json: string;
  account_created_at: number;
  connection_revision: string;
  started_at: number;
  checked_at: number | null;
  observation: string | null;
  reentry_at: number | null;
  review_json: string | null;
  reviewed_at: number | null;
}

interface ActivityRow {
  id: string;
  kind: string;
  at: number;
  meta: string;
}

const safeText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0 && value < 8.64e15;
const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const metaLabel = (meta: Record<string, unknown>, fallback: string) =>
  [meta.subject, meta.name, meta.title, meta.summary].find(safeText) ?? fallback;
const evidence = (row: ActivityRow) => ({
  id: row.id, kind: row.kind, at: row.at, label: metaLabel(asObject(JSON.parse(row.meta)), row.kind.replaceAll('_', ' ')),
});

export const createCustomerDecisionWatch = (deps: {
  db: Database.Database;
  records: Pick<RecordsStore, 'getNamespaceState' | 'reviewSnapshot'>;
  mirror: Pick<CrmRecordMirrorStore, 'list'>;
  enrichment: Pick<EnrichmentStore, 'getByRecord'>;
  accountRevision: (connection: string, vendor: string) => string | undefined;
  paused?: () => boolean;
  now?: () => number;
}) => {
  const { db, records, mirror, enrichment } = deps;
  const now = deps.now ?? Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_decision_watches (
      id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, incarnation TEXT NOT NULL,
      title TEXT NOT NULL, rationale TEXT NOT NULL, account_json TEXT NOT NULL,
      account_created_at INTEGER NOT NULL, connection_revision TEXT NOT NULL,
      started_at INTEGER NOT NULL, checked_at INTEGER, observation TEXT, reentry_at INTEGER,
      review_json TEXT, reviewed_at INTEGER,
      UNIQUE(decision_id, incarnation)
    );
    CREATE INDEX IF NOT EXISTS customer_decision_watch_checks ON customer_decision_watches(checked_at, id);
    CREATE INDEX IF NOT EXISTS customer_decision_watch_pending ON customer_decision_watches(reentry_at, id)
      WHERE review_json IS NOT NULL AND reviewed_at IS NULL;
  `);
  const byDecision = db.prepare('SELECT * FROM customer_decision_watches WHERE decision_id=? AND incarnation=?');
  const byId = db.prepare('SELECT * FROM customer_decision_watches WHERE id=?');
  const remove = db.prepare('DELETE FROM customer_decision_watches WHERE id=?');
  const checked = db.prepare('UPDATE customer_decision_watches SET checked_at=? WHERE id=?');
  const observed = db.prepare('UPDATE customer_decision_watches SET observation=? WHERE id=?');
  const saveReview = db.prepare(`
    UPDATE customer_decision_watches SET review_json=?, reentry_at=?, reviewed_at=NULL WHERE id=?
  `);
  const pending = db.prepare(`
    SELECT * FROM customer_decision_watches WHERE review_json IS NOT NULL AND reviewed_at IS NULL
    ORDER BY reentry_at ASC, id ASC
  `);
  const due = db.prepare(`
    SELECT * FROM customer_decision_watches WHERE checked_at IS NULL OR checked_at <= ?
    ORDER BY checked_at ASC, id ASC LIMIT 32
  `);
  const getMirror = db.prepare(`SELECT created_at, meta FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope=? AND target_id=?`);
  // Drive from the selected account's indexed edges. Each activity read is
  // by its composite key, even when the warehouse has many unrelated events.
  const activityOnAccount = `
    SELECT activity.target_id AS id, activity.entity AS kind, activity.event_at AS at, activity.meta
    FROM ${ENGAGEMENT_EDGES_TABLE} AS edge INDEXED BY idx_engagement_edges_by_target
    CROSS JOIN ${ENGAGEMENTS_TABLE} AS activity
    WHERE edge.target_kind='connection.api' AND edge.target_id=? AND edge.edge_type='account'
      AND edge.deleted_at IS NULL AND activity.connection_id=edge.connection_id
      AND activity.target_id=edge.engagement_target_id AND activity.vendor=?
      AND activity.deleted_at IS NULL AND activity.lifecycle_state IN ('completed','point_in_time')
      AND activity.direction<>'internal' AND activity.authorship NOT IN ('crm_automation','system_process')
      AND activity.entity IN ('email','email_message','meeting','event','call','voice_call','call_history')
  `;
  const incomingAt = db.prepare(`${activityOnAccount}
    AND activity.event_at=? AND activity.direction='inbound' AND activity.entity=?
    ORDER BY activity.target_id LIMIT 2`);
  const previousAt = db.prepare(`${activityOnAccount}
    AND activity.event_at>=? AND activity.event_at<? ORDER BY activity.event_at DESC, activity.target_id LIMIT 1`);

  const accountOf = (ref: CustomerAccountRef) => {
    if (!ref || !CUSTOMER_ACCOUNT_SCOPES.includes(ref.scope) || !safeText(ref.target_id)) return null;
    const source = parsePlatformRecordTargetId(ref.target_id);
    if (!source || `connection.api.${source.vendor}.${source.entity}` !== ref.scope) return null;
    const revision = deps.accountRevision(source.connection_name, source.vendor);
    const row = getMirror.get(ref.scope, ref.target_id) as { created_at: number; meta: string } | undefined;
    const meta = deserializeEnrichmentMeta(row?.meta ?? null);
    if (!revision || !row || !meta || !safeText(meta.name)) return null;
    const account: CustomerAccountChoice = {
      scope: ref.scope, target_id: ref.target_id, label: meta.name, connection: source.connection_name,
      ...(safeText(meta.domain) ? { domain: meta.domain } : {}),
    };
    return { account, revision, started: row.created_at, vendor: source.vendor };
  };

  const currentAccount = (row: WatchRow) => {
    const result = accountOf(JSON.parse(row.account_json) as CustomerAccountChoice);
    return result?.revision === row.connection_revision && result.started === row.account_created_at ? result : null;
  };
  const decisionOf = (id: string) => records.getNamespaceState(DECISION_WATCH_OWNER)?.state === 'ready'
    ? records.reviewSnapshot(DECISION_WATCH_OWNER, DECISION_WATCH_ENTITY, id) : null;
  const signalFor = (ref: CustomerAccountRef) => {
    const signal = enrichment.getByRecord(TOPIC, ref.scope, ref.target_id, AUTHOR);
    return signal?.staleness_class === 'fresh' && signal.tombstoned_at === null ? signal : null;
  };
  const reviewOf = (row: WatchRow): CustomerDecisionReview | undefined => row.review_json
    ? { ...JSON.parse(row.review_json) as CustomerDecisionReview,
        ...(row.reviewed_at === null ? {} : { reviewed_at: row.reviewed_at }) }
    : undefined;

  const proofPair = (account: NonNullable<ReturnType<typeof currentAccount>>, at: number) => {
    const target = account.account.target_id;
    const incoming = incomingAt.all(target, account.vendor, at, account.vendor === 'hubspot' ? 'email' : 'email_message') as ActivityRow[];
    if (incoming.length !== 1) return null;
    const previous = previousAt.get(target, account.vendor, at - ACCOUNT_REENTRY_LOOKBACK_MS, at) as ActivityRow | undefined;
    if (!previous || at - previous.at < ACCOUNT_DORMANCY_MS) return null;
    return { previous, incoming: incoming[0]! };
  };
  const currentReview = (row: WatchRow, account: NonNullable<ReturnType<typeof currentAccount>>) => {
    const review = reviewOf(row);
    if (!review || review.reviewed_at !== undefined) return review;
    const pair = proofPair(account, review.incoming.at);
    return pair && pair.incoming.id === review.incoming.id && pair.previous.id === review.previous.id
      && pair.previous.at === review.previous.at ? review : undefined;
  };
  const viewFor = (row?: WatchRow): CustomerDecisionWatchView => {
    if (!row) return { quiet_days: ACCOUNT_DORMANCY_DAYS, watch: null };
    const account = currentAccount(row);
    const review = account ? currentReview(row, account) : undefined;
    return { quiet_days: ACCOUNT_DORMANCY_DAYS, watch: {
      id: row.id, account: account?.account ?? JSON.parse(row.account_json) as CustomerAccountChoice,
      state: !account ? 'account_unavailable' : signalFor(account.account) ? 'watching' : 'waiting_for_signal',
      ...(row.checked_at === null ? {} : { checked_at: row.checked_at }),
      ...(review ? { review } : {}),
    } };
  };

  const read = db.transaction((ref: CustomerDecisionRef): CustomerDecisionWatchView => {
    if (!ref || !safeText(ref.decision_id) || !epoch(ref.created_at) || !epoch(ref.revision)) {
      throw new RpcError('bad_request', 'Choose a saved Decision Log record.', 400);
    }
    const decision = decisionOf(ref.decision_id);
    if (!decision || decision.record._record.created_at !== ref.created_at) {
      throw new RpcError('not_found', 'This decision is unavailable. Reopen it to check its watch.', 404);
    }
    return viewFor(byDecision.get(ref.decision_id, decision.incarnation) as WatchRow | undefined);
  });

  const change = db.transaction((request: CustomerDecisionWatchChange): CustomerDecisionWatchView => {
    if (request?.action === 'start') {
      const current = read(request.decision);
      const account = accountOf(request.account);
      if (!account) throw new RpcError('not_found', 'Choose an available synced CRM account.', 404);
      if (current.watch) {
        if (current.watch.account.scope === account.account.scope && current.watch.account.target_id === account.account.target_id
          && current.watch.state !== 'account_unavailable') return current;
        throw new RpcError('conflict', 'Stop the current watch before linking another account.', 409);
      }
      const decision = decisionOf(request.decision.decision_id);
      if (!decision || decision.record._record.revision !== request.decision.revision) {
        throw new RpcError('conflict', 'The decision changed. Reopen it before starting the watch.', 409);
      }
      const id = randomUUID();
      db.prepare(`INSERT INTO customer_decision_watches
        (id, decision_id, incarnation, title, rationale, account_json, account_created_at, connection_revision, started_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        id, decision.record.id, decision.incarnation,
        typeof decision.record.title === 'string' ? decision.record.title : decision.record.id,
        typeof decision.record.rationale === 'string' ? decision.record.rationale : '',
        JSON.stringify(account.account), account.started, account.revision, now(),
      );
      return viewFor(byId.get(id) as WatchRow);
    }
    if (!request || !safeText(request.watch_id)) throw new RpcError('bad_request', 'Choose a customer watch.', 400);
    const row = byId.get(request.watch_id) as WatchRow | undefined;
    if (request.action === 'stop') {
      remove.run(request.watch_id);
      return viewFor();
    }
    if (request.action !== 'reviewed' || !safeText(request.review_id)) {
      throw new RpcError('bad_request', 'Choose a customer review.', 400);
    }
    const review = row && reviewOf(row);
    if (!row || !review || review.id !== request.review_id) {
      throw new RpcError('conflict', 'This review has changed. Refresh and open the current review.', 409);
    }
    if (row.reviewed_at === null) {
      const account = currentAccount(row);
      const decision = decisionOf(row.decision_id);
      if (!account || decision?.incarnation !== row.incarnation || !currentReview(row, account)) {
        throw new RpcError('conflict', 'The recorded evidence changed. Refresh to check the current review.', 409);
      }
      db.prepare('UPDATE customer_decision_watches SET reviewed_at=? WHERE id=?').run(now(), row.id);
    }
    return viewFor(byId.get(row.id) as WatchRow);
  });

  const check = db.transaction((id: string, at: number) => {
    const row = byId.get(id) as WatchRow | undefined;
    if (!row || (row.checked_at !== null && row.checked_at > at - TASK_INTERVAL_MS)) return;
    checked.run(at, row.id);
    const signal = signalFor(JSON.parse(row.account_json) as CustomerAccountChoice);
    if (!signal) return;
    const data = asObject(signal.value);
    const candidate = data.last_reentry_at;
    if (data.reentered !== true || !epoch(candidate) || candidate <= (row.reentry_at ?? row.started_at)
      || candidate > at || candidate < at - ACCOUNT_REENTRY_RECENT_MS) return;
    const observation = JSON.stringify([signal._id, signal.ingested_at, signal.last_evaluated_at, candidate]);
    if (row.observation === observation) return;
    const decision = decisionOf(row.decision_id);
    if (!decision || decision.incarnation !== row.incarnation) return;
    const account = currentAccount(row);
    if (!account) return;
    observed.run(observation, row.id);
    const pair = proofPair(account, candidate);
    if (!pair) return;
    const review: CustomerDecisionReview = {
      id: randomUUID(), watch_id: row.id, decision_id: row.decision_id, title: row.title, rationale: row.rationale,
      account: account.account, previous: evidence(pair.previous), incoming: evidence(pair.incoming),
      gap_days: Math.floor((candidate - pair.previous.at) / DAY_MS),
    };
    saveReview.run(JSON.stringify(review), candidate, row.id);
  });
  const tick = () => {
    if (deps.paused?.()) return;
    const at = now();
    for (const row of due.all(at - TASK_INTERVAL_MS) as WatchRow[]) {
      try { check.immediate(row.id, at); }
      catch (error) {
        checked.run(at, row.id);
        console.warn('[customer-decision-watch] Could not check a linked decision.', error);
      }
    }
  };
  const readReviews = db.transaction(() => {
    const reviews: CustomerDecisionReview[] = [];
    for (const row of pending.all() as WatchRow[]) {
      const decision = decisionOf(row.decision_id);
      if (decision?.incarnation !== row.incarnation) continue;
      const account = currentAccount(row);
      const review = account ? currentReview(row, account) : undefined;
      if (review) reviews.push(review);
      if (reviews.length === 100) break;
    }
    return { reviews };
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    read: (ref: CustomerDecisionRef) => read(ref),
    change: (request: CustomerDecisionWatchChange) => change.immediate(request),
    accounts(query: unknown): { accounts: CustomerAccountChoice[] } {
      if (!safeText(query) || query.trim().length < 2) throw new RpcError('bad_request', 'Enter at least two characters of the account name.', 400);
      return { accounts: CUSTOMER_ACCOUNT_SCOPES.flatMap(scope => mirror.list(scope, { name_contains: query.trim(), limit: 12 })
        .flatMap(row => {
          const match = accountOf({ scope, target_id: row.target_id });
          return match ? [match.account] : [];
        })) };
    },
    reviews: () => readReviews(),
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, TASK_INTERVAL_MS);
      timer.unref();
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};

export type CustomerDecisionWatchService = ReturnType<typeof createCustomerDecisionWatch>;
