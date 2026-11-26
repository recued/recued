import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  REFUND_CREDIT_LIMIT, REFUND_STATEMENT_KIND, REFUND_STATEMENT_OWNER, RpcError,
  formatRefundCents, refundCents, refundWatchOrder,
  type Commitment, type RecordsFriendlyRecord, type RefundCreditCaseRef, type RefundCreditLineRef,
  type RefundCreditsChange, type RefundCreditsRead, type RefundCreditsView, type RefundStatementCredit,
} from '@recued/contracts';
import type { RecordsStore } from './records/store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';

interface CreditMatchRow {
  sequence: number;
  commitment_id: string;
  commitment_created_at: number;
  line_id: string;
  line_stamp: string;
  confirmed_at: number;
}

const text = (value: unknown, max = 2048): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const bad = (message: string): never => { throw new RpcError('bad_request', message, 400); };
const stale = (message: string): never => { throw new RpcError('refund_credits_changed', message, 409); };

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isStamp = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const savedRef = (row: CreditMatchRow): RefundCreditLineRef => ({ id: row.line_id, stamp: row.line_stamp });
const sameLine = (a: RefundCreditLineRef, b: RefundCreditLineRef) => a.id === b.id && a.stamp === b.stamp;
const validLine = (line: unknown): line is RefundCreditLineRef => {
  if (!line || typeof line !== 'object') return false;
  const ref = line as RefundCreditLineRef;
  return text(ref.id) && isStamp(ref.stamp);
};

const amountOf = (value: unknown): bigint | null =>
  typeof value === 'number' && Number.isFinite(value) ? refundCents(String(value)) : null;

/** Imports preserve either one signed column or separate credit/debit columns.
 * Require one unambiguous incoming amount at the commitment's precision. */
const creditFields = (record: RecordsFriendlyRecord, currency: string): Omit<RefundStatementCredit, 'line'> | null => {
  const { account_label, posted_on, description } = record;
  if (!text(account_label) || typeof posted_on !== 'string' || !posted_on.trim()
    || record.currency !== currency) return null;
  const signed = record.amount != null;
  const separate = record.money_in != null || record.money_out != null;
  if (signed && separate || separate && record.money_out != null && record.money_out !== 0) return null;
  const cents = amountOf(signed ? record.amount : record.money_in);
  if (cents === null || cents <= 0n) return null;
  return {
    account_label, posted_on, description: typeof description === 'string' ? description : '', amount: formatRefundCents(cents),
  };
};

const expectedAmount = (commitment: Commitment) => {
  const value = commitment.monetary_value;
  const cents = value ? refundCents(value.amount) : null;
  return value && /^[A-Z]{3}$/u.test(value.currency) && cents !== null && cents > 0n
    ? { amount: formatRefundCents(cents), currency: value.currency } : null;
};

export const createRefundCreditsService = (deps: {
  db: Database.Database;
  work: Pick<WorkEntityStore, 'readCommitment'>;
  records: Pick<RecordsStore, 'getNamespaceState' | 'ownerSearch' | 'reviewSnapshot'>;
  now?: () => number;
}) => {
  const { db, work, records } = deps;
  const now = deps.now ?? Date.now;
  // Bank amounts and descriptions remain in the statement store. Retain
  // exact source versions only, and count a link while its proof holds.
  db.exec(
    'CREATE TABLE IF NOT EXISTS refund_credit_matches (' +
    ' sequence INTEGER PRIMARY KEY AUTOINCREMENT, commitment_id TEXT NOT NULL, commitment_created_at INTEGER NOT NULL,' +
    ' line_id TEXT NOT NULL UNIQUE, line_stamp TEXT NOT NULL, confirmed_at INTEGER NOT NULL' +
    ');' +
    'CREATE INDEX IF NOT EXISTS refund_credit_matches_commitment ON refund_credit_matches(commitment_id,commitment_created_at);',
  );
  const list = db.prepare('SELECT * FROM refund_credit_matches WHERE commitment_id=? AND commitment_created_at=? ORDER BY sequence');
  const claimByLine = db.prepare('SELECT * FROM refund_credit_matches WHERE line_id=?');
  const insert = db.prepare('INSERT INTO refund_credit_matches (commitment_id,commitment_created_at,line_id,line_stamp,confirmed_at) VALUES (?,?,?,?,?)');
  const remove = db.prepare('DELETE FROM refund_credit_matches WHERE sequence=?');

  const existingCommitment = (claim: CreditMatchRow) => {
    const commitment = work.readCommitment(claim.commitment_id);
    return commitment?.created_at === claim.commitment_created_at && commitment.deleted_at == null;
  };
  const readCredit = (id: string, currency: string): RefundStatementCredit | null => {
    const source = records.reviewSnapshot(REFUND_STATEMENT_OWNER, REFUND_STATEMENT_KIND, id);
    if (!source) return null;
    const fields = creditFields(source.record, currency);
    const { version, revision, created_at } = source.record._record;
    return fields && { ...fields, line: { id, stamp: digest([source.incarnation, version, revision, created_at]) } };
  };
  const checkCommitment = (ref: RefundCreditCaseRef) => {
    if (!ref || !text(ref.commitment_id) || !timestamp(ref.created_at)) return bad('Choose the refund commitment.');
    const commitment = work.readCommitment(ref.commitment_id);
    if (!commitment || commitment.created_at !== ref.created_at || commitment.deleted_at != null
      || commitment.sync_state !== 'live' || commitment.pending_write || commitment.source_id !== 'recued.commitment'
      || !refundWatchOrder(commitment)) throw new RpcError('not_found', 'This refund commitment is no longer available.', 404);
    return commitment;
  };
  const viewFor = (ref: RefundCreditCaseRef) => {
    const commitment = checkCommitment(ref);
    const expected = expectedAmount(commitment);
    const statement_available = records.getNamespaceState(REFUND_STATEMENT_OWNER)?.state === 'ready';
    const rows = list.all(commitment.id, commitment.created_at) as CreditMatchRow[];
    let confirmed = 0n;
    let account: string | undefined;
    const matches = rows.map(row => {
      const line = savedRef(row);
      const observed = statement_available && expected ? readCredit(line.id, expected.currency) : null;
      let credit: RefundStatementCredit | null = null;
      if (observed && sameLine(observed.line, line) && (account === undefined || observed.account_label === account)) {
        credit = observed;
        confirmed += refundCents(credit.amount)!;
        account = credit.account_label;
      }
      return { line, confirmed_at: row.confirmed_at, credit };
    });
    const target = expected ? refundCents(expected.amount)! : null;
    const review_token = digest([
      commitment.id, commitment.created_at, commitment.updated_at, refundWatchOrder(commitment), expected, statement_available,
      rows.map((row, i) => [row.sequence, matches[i]!.credit !== null]),
    ]);
    const view: RefundCreditsView = {
      review_token, expected, statement_available,
      credited: formatRefundCents(confirmed),
      outstanding: target === null ? null : formatRefundCents(target > confirmed ? target - confirmed : 0n),
      exceeds_expected: target !== null && confirmed > target,
      ...(account !== undefined ? { account_label: account } : {}),
      matches, candidates: [],
    };
    return { view, rows };
  };

  const read = db.transaction((request: RefundCreditsRead): RefundCreditsView => {
    const { view } = viewFor(request);
    const account = request.account_label;
    if (account === undefined) {
      if (request.cursor !== undefined) return bad('Choose the account before loading more credits.');
      return view;
    }
    if (!text(account) || request.cursor !== undefined && !text(request.cursor, 8192)) return bad('Enter the account label from the import.');
    if (view.account_label !== undefined && account !== view.account_label) return bad('Choose the account already linked to this refund.');
    if (!view.statement_available || !view.expected) return view;
    const { currency } = view.expected;
    const page = records.ownerSearch({
      owner: REFUND_STATEMENT_OWNER, entity: REFUND_STATEMENT_KIND,
      filters: { account_label: account, currency },
      sort: '-_record.created_at', limit: 50, include_orphaned: false,
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
    });
    return {
      ...view,
      account_label: account,
      candidates: page.records.flatMap(record => {
        if (!creditFields(record, currency)) return [];
        const claim = claimByLine.get(record.id) as CreditMatchRow | undefined;
        if (claim && existingCommitment(claim)) return [];
        const credit = readCredit(record.id, currency);
        return credit ? [credit] : [];
      }),
      ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
    };
  });

  const change = db.transaction((request: RefundCreditsChange): RefundCreditsView => {
    const { view, rows } = viewFor(request);
    if (!isStamp(request.review_token)) return bad('Review the statement credits first.');
    if (request.action === 'remove') {
      if (!text(request.line_id)) return bad('Choose the credit to remove.');
      const row = rows.find(item => item.line_id === request.line_id);
      if (!row) return view;
      if (request.review_token !== view.review_token) return stale('Refund credits changed. Refresh and review the current links.');
      remove.run(row.sequence);
      return viewFor(request).view;
    }
    if (request.action !== 'confirm' || !text(request.account_label) || !Array.isArray(request.lines)
      || !request.lines.length || request.lines.length > REFUND_CREDIT_LIMIT || !request.lines.every(validLine)
      || new Set(request.lines.map(line => line.id)).size !== request.lines.length) return bad('Choose distinct credits from one account.');
    const added = request.lines.filter(line => !rows.some(row => sameLine(line, savedRef(row))));
    // A repeat after a lost response returns the confirmed links and writes nothing.
    if (added.length === 0 && request.lines.every(line => view.matches.some(match => match.credit && sameLine(match.line, line)))) {
      return view;
    }
    if (request.review_token !== view.review_token) return stale('Refund credits changed. Refresh and review the current links.');
    if (!view.expected || !view.statement_available) return bad('The expected amount and imported statement are required.');
    if (view.matches.some(match => match.credit === null)) return stale('Remove changed or unavailable credit links before confirming more.');
    if (view.account_label !== undefined && request.account_label !== view.account_label) return bad('Choose credits from the account already linked to this refund.');
    if (rows.length + added.length > REFUND_CREDIT_LIMIT) return bad('This refund has too many credit links to review.');

    const at = now(), target = refundCents(view.expected.amount)!;
    let total = refundCents(view.credited)!;
    for (const line of added) {
      const claim = claimByLine.get(line.id) as CreditMatchRow | undefined;
      if (claim && existingCommitment(claim)) return stale('One of the selected credits is already linked. Refresh and choose another.');
      const credit = readCredit(line.id, view.expected.currency);
      if (!credit || !sameLine(credit.line, line) || credit.account_label !== request.account_label) {
        return stale('A selected statement credit changed. Refresh and review it again.');
      }
      total += refundCents(credit.amount)!;
      if (total > target) return bad('Selected credits exceed the expected refund. Review which credits belong to this order.');
      if (claim) remove.run(claim.sequence);
      insert.run(request.commitment_id, request.created_at, line.id, line.stamp, at);
    }
    return viewFor(request).view;
  });
  return { read: (request: RefundCreditsRead) => read(request), change: (request: RefundCreditsChange) => change.immediate(request) };
};

export type RefundCreditsService = ReturnType<typeof createRefundCreditsService>;
