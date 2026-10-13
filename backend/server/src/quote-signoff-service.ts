/** Core adapter joining the explicitly supported Quote Pipeline and Invoice
 * Book contracts. Packs do not read each other's private Records here.
 * Release rechecks installed schemas and the frozen quote or amendment base
 * inside the same SQLite transaction as its business writes. */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  QUOTE_SIGNOFF_SCOPE_MAX,
  QUOTE_SIGNOFF_CONTEXT_MAX,
  QUOTE_SIGNOFF_STATES,
  QUOTE_SIGNOFF_SEARCH_MAX,
  QUOTE_SIGNOFF_RELEASE_RECIPE,
  RECUED_BUILTIN_SOURCE_ID,
  isRecordsExecutionBinding,
  validateApprovalLinkConfig,
  resolveServerTimeZone,
  type ApprovalLinkConfig,
  type IngredientManifest,
  type QuoteSignoffPrepareInput,
  type QuoteSignoffAdditionPrepareInput,
  type QuoteSignoffAdditionSummary,
  type QuoteSignoffFollowUp,
  type QuoteSignoffListInput,
  type QuoteSignoffListResult,
  type QuoteSignoffReleaseInput,
  type QuoteSignoffReleaseResult,
  type QuoteSignoffState,
  type QuoteSignoffSummary,
  type RecordsExecutionBinding,
  type RecordsFriendlyRecord,
  type Task,
} from '@recued/contracts';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';
import type { RecordsStore } from './records/store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import { createServerTimeZoneStore } from './storage/server-timezone-store.js';

const QUOTES = { publisher: 'recued-core', pack_slug: 'quote-pipeline' };
const INVOICES = { publisher: 'recued-core', pack_slug: 'invoice-book' };
/** The pack versions each adapter is written against, oldest first. ⚠ A release cut
 *  raises a pack's version whenever its content moved, with no change to its Records
 *  schema (`scripts/bump-changed-since-publish.mjs`), so a version is added here once
 *  its schema is checked: invoice-book 5 is 4 with `record-payment` pinned at v6 (the
 *  26.10.12 cut). An owner who has not updated the pack yet keeps working. */
export const QUOTE_SIGNOFF_PACK_VERSIONS: Readonly<Record<string, readonly number[]>> = {
  'quote-pipeline': [2],
  'invoice-book': [4, 5],
};
const TABLE = 'quote_signoffs';
const DAY = 86_400_000;

export class QuoteSignoffError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = 'QuoteSignoffError';
  }
}

interface Plan {
  display_name: string;
  scope: string;
  task_title: string;
  invoice_ref: string;
  issued_on: string;
  due_on: string;
  amount: string;
  net: string;
  vat_amount: string;
  quote_version: number;
  quote_schema_hash: string;
  quote_declaration_hash: string;
  invoice_version: number;
  invoice_schema_hash: string;
  invoice_declaration_hash: string;
  expiry_days: number;
  addition?: QuoteSignoffAdditionSummary & { task: Task; task_revision: number };
}
interface Row {
  signoff_id: string;
  quote_id: string;
  quote_json: string;
  plan_json: string;
  plan_hash: string;
  state: QuoteSignoffState;
  created_at: number;
  expires_at: number;
  endpoint_id: string | null;
  responded_at: number | null;
  released_at: number | null;
  intent_id: string | null;
}

export interface QuoteSignoffServiceDeps {
  db: Database.Database;
  records: RecordsStore;
  manifest: (owner: { publisher: string; pack_slug: string }) => IngredientManifest | null;
  work?: Pick<WorkEntityStore, 'writeTask' | 'readTask'>;
  now: () => number;
  timeZone?: () => string;
}

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new QuoteSignoffError('quote_signoff_invalid', `${field} must contain 1–${max} characters.`, 400);
  }
  return value.trim();
};
const date = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new QuoteSignoffError('quote_signoff_invalid', `${field} must be a calendar date (YYYY-MM-DD).`, 400);
  }
  return value;
};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const searchText = (value: string): string => value.normalize('NFKC').toLowerCase();
const isSignoffId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const pageAnchor = (value: unknown, query: string): { created_at: number; signoff_id: string } => {
  const invalid = () => new QuoteSignoffError('quote_signoff_invalid', 'This request page is invalid. Start from the newest requests.', 400);
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)
    || Buffer.from(value, 'base64url').toString('base64url') !== value) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some(key => !['v', 'created_at', 'signoff_id', 'query'].includes(key))
    || !('v' in parsed) || parsed.v !== 1
    || !('created_at' in parsed) || typeof parsed.created_at !== 'number'
    || !Number.isSafeInteger(parsed.created_at) || parsed.created_at < 0
    || !('signoff_id' in parsed) || !isSignoffId(parsed.signoff_id)
    || !('query' in parsed) || parsed.query !== query) throw invalid();
  return { created_at: parsed.created_at, signoff_id: parsed.signoff_id };
};

/** Compute the canonical internal catalog names before entering any synchronous
 * SQLite transaction; resolve their installed manifests afresh on every use. */
export const quoteSignoffManifestReader = async (get: (slug: string) => IngredientManifest | null)
  : Promise<QuoteSignoffServiceDeps['manifest']> => {
  const names = new Map(await Promise.all([QUOTES, INVOICES].map(async (owner) =>
    [owner.pack_slug, await recordsCatalogSlug(owner)] as const)));
  return (owner) => owner.publisher === 'recued-core' && names.has(owner.pack_slug)
    ? get(names.get(owner.pack_slug)!) : null;
};

/** Quote Pipeline stores a number, Invoice Book exact decimal strings. Reject
 * unrepresentable money rather than round a customer's accepted amount. */
const money = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QuoteSignoffError('quote_signoff_invalid', 'The quote must have a positive finite amount.', 400);
  }
  const spelled = String(value);
  if (!/^\d+(?:\.\d{1,4})?$/.test(spelled)) {
    throw new QuoteSignoffError('quote_signoff_invalid', 'The quote amount must fit four decimal places without rounding.', 400);
  }
  const [whole, fraction = ''] = spelled.split('.');
  const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  if (scaled > 9_223_372_036_854_775_807n) {
    throw new QuoteSignoffError('quote_signoff_invalid', 'The quote amount exceeds Invoice Book’s exact money range.', 400);
  }
  return `${whole}.${fraction.padEnd(4, '0')}`;
};
const units = (value: string): bigint => BigInt(value.replace('.', ''));
const decimal = (value: bigint): string => `${value / 10_000n}.${String(value % 10_000n).padStart(4, '0')}`;
const additionalMoney = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(value) || value.length > 24) {
    throw new QuoteSignoffError('quote_signoff_invalid', 'Added amount must be a positive decimal with up to four places.', 400);
  }
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  if (scaled <= 0n || scaled > 9_223_372_036_854_775_807n) {
    throw new QuoteSignoffError('quote_signoff_invalid', 'Added amount is outside Invoice Book’s positive exact money range.', 400);
  }
  return decimal(scaled);
};
const tax = (value: unknown, total: string): string => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(value) || value.length > 24) {
    throw new QuoteSignoffError('quote_signoff_invalid', 'VAT included in the total must be a non-negative decimal with up to four places.', 400);
  }
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  if (scaled >= units(total)) throw new QuoteSignoffError('quote_signoff_invalid', 'VAT must be less than the quoted total.', 400);
  return decimal(scaled);
};
const recordedMoney = (value: unknown, total: string): string => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(value) || value.length > 24) {
    throw new Error('Invalid recorded invoice balance.');
  }
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  if (scaled > units(total)) throw new Error('Recorded invoice balance exceeds its total.');
  return decimal(scaled);
};

export const createQuoteSignoffService = (deps: QuoteSignoffServiceDeps) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    signoff_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL,
    quote_json TEXT NOT NULL, plan_json TEXT NOT NULL, plan_hash TEXT NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    endpoint_id TEXT UNIQUE, responded_at INTEGER, released_at INTEGER, intent_id TEXT UNIQUE
  ); CREATE INDEX IF NOT EXISTS quote_signoffs_quote ON ${TABLE}(quote_id, created_at);
  CREATE INDEX IF NOT EXISTS quote_signoffs_created ON ${TABLE}(created_at DESC, signoff_id);`);

  deps.db.exec('CREATE INDEX IF NOT EXISTS quote_signoffs_state_created ON quote_signoffs(state, created_at DESC, signoff_id)');
  deps.db.function('quote_signoff_search_text', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? searchText(value) : '');

  // Track only tasks used by this adapter. A content hash / wall-clock cannot
  // detect an edit followed by restoration at the same timestamp. The durable
  // counter also catches delete/recreate through any task writer.
  deps.db.exec(`CREATE TABLE IF NOT EXISTS quote_signoff_task_versions (
    task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL
  );`);
  const ensureTaskVersions = (): void => {
    deps.db.exec(['INSERT', 'UPDATE', 'DELETE'].map((operation) => `
      CREATE TRIGGER IF NOT EXISTS quote_signoff_task_${operation.toLowerCase()}
      AFTER ${operation} ON data_task
      BEGIN UPDATE quote_signoff_task_versions SET revision=revision+1
        WHERE task_id=${operation === 'DELETE' ? 'OLD' : 'NEW'}.id; END;`).join('\n'));
  };
  if (deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='data_task'").get()) ensureTaskVersions();

  const today = (): string => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: deps.timeZone?.() ?? resolveServerTimeZone(createServerTimeZoneStore(deps.db).read(),
        Intl.DateTimeFormat().resolvedOptions().timeZone),
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(deps.now());
    return ['year', 'month', 'day'].map((kind) => parts.find((p) => p.type === kind)!.value).join('-');
  };
  const load = (id: string): Row => {
    const row = deps.db.prepare(`SELECT * FROM ${TABLE} WHERE signoff_id=?`).get(id) as Row | undefined;
    if (!row) throw new QuoteSignoffError('quote_signoff_not_found', 'This customer sign-off no longer exists.', 404);
    return row;
  };
  const quoteOf = (row: Row): RecordsFriendlyRecord => JSON.parse(row.quote_json) as RecordsFriendlyRecord;
  const planOf = (row: Row): Plan => JSON.parse(row.plan_json) as Plan;
  const binding = (owner: typeof QUOTES, action: string, entity: string): RecordsExecutionBinding => {
    const ns = deps.records.getNamespace(owner);
    // These are versioned core adapters, not an untyped join of arbitrary packs.
    const supported = QUOTE_SIGNOFF_PACK_VERSIONS[owner.pack_slug] ?? [];
    const latest = supported[supported.length - 1];
    if (!ns || ns.state.state !== 'ready' || !supported.includes(ns.state.version)) {
      throw new QuoteSignoffError('quote_signoff_pack_unavailable',
        ns?.state.state === 'ready' && latest !== undefined && ns.state.version > latest
          ? `This Recued does not know ${owner.pack_slug} version ${ns.state.version} yet. Update Recued before using customer sign-off.`
          : `Install ${owner.pack_slug} version ${latest} before using customer sign-off.`);
    }
    const installed = ns.state.version;
    const catalog = deps.manifest(owner);
    const found = Object.values(catalog?.surfaces?.records?.executes ?? {})
      .find((b) => b.action === action && b.entity === entity);
    if (!isRecordsExecutionBinding(found) || found.owner.publisher !== owner.publisher
      || found.owner.pack_slug !== owner.pack_slug || found.pack_version !== installed) {
      throw new QuoteSignoffError('quote_signoff_pack_unavailable', `The installed ${owner.pack_slug} action is unavailable.`);
    }
    return found;
  };
  const currentQuote = (id: string): RecordsFriendlyRecord => {
    binding(QUOTES, 'get', 'quote');
    const quote = deps.records.ownerGet(QUOTES, 'quote', id);
    if (!quote) throw new QuoteSignoffError('quote_signoff_quote_missing', 'The quote no longer exists.', 404);
    return quote;
  };
  const taskRevision = (id: string): number => (deps.db.prepare('SELECT revision FROM quote_signoff_task_versions WHERE task_id=?')
    .get(id) as { revision: number } | undefined)?.revision ?? 0;
  const quoteTerms = (quote: RecordsFriendlyRecord): string => hash(Object.fromEntries(Object.keys(quote)
    .filter((key) => !['_record', 'status', 'decided_on'].includes(key)).sort().map((key) => [key, quote[key]])));
  const additionBase = (parentId: string) => {
    const parent = load(parentId); const parentPlan = planOf(parent);
    const root = parentPlan.addition ? load(parentPlan.addition.root_signoff_id) : parent;
    const rootPlan = planOf(root); const acceptedQuote = quoteOf(root);
    if (root.state !== 'released' || parent.state !== 'released' || rootPlan.addition || root.quote_id !== parent.quote_id) {
      throw new QuoteSignoffError('quote_signoff_not_released', 'Choose a released agreement before adding work.');
    }
    const additions = deps.db.prepare(`SELECT * FROM ${TABLE} WHERE state='released'
      AND json_extract(plan_json,'$.addition.root_signoff_id')=?
      ORDER BY json_extract(plan_json,'$.addition.revision')`).all(root.signoff_id) as Row[];
    let tip = root.signoff_id; let amount = units(rootPlan.amount); let scope = rootPlan.scope;
    for (const [index, row] of additions.entries()) {
      const plan = planOf(row); const addition = plan.addition!;
      if (addition.parent_signoff_id !== tip || addition.revision !== index + 1 || row.quote_id !== root.quote_id) {
        throw new QuoteSignoffError('quote_signoff_base_unavailable', 'The accepted amendment history is unavailable.');
      }
      tip = row.signoff_id; amount += units(plan.amount);
      scope += `\n\nAdded work ${addition.revision}:\n${plan.scope}`;
    }
    if (tip !== parentId) throw new QuoteSignoffError('quote_signoff_superseded', 'This agreement has a newer released amendment. Choose that agreement to add work.');
    const quote = currentQuote(root.quote_id);
    if (quote.status !== 'won' || quoteTerms(quote) !== quoteTerms(acceptedQuote)) {
      throw new QuoteSignoffError('quote_signoff_superseded', 'The original accepted quote has changed. Restore its terms before adding work.');
    }
    binding(INVOICES, 'get', 'invoice');
    for (const row of [root, ...additions]) {
      const plan = planOf(row);
      const invoice = deps.records.ownerGet(INVOICES, 'invoice', `quote_signoff_${row.signoff_id}`);
      if (!invoice || invoice.client_name !== acceptedQuote.customer || invoice.currency !== acceptedQuote.currency
        || invoice.ref !== plan.invoice_ref || invoice.total !== plan.amount || invoice.net !== plan.net || invoice.vat_amount !== plan.vat_amount) {
        throw new QuoteSignoffError('quote_signoff_base_unavailable', 'An invoice for the accepted agreement is missing or its terms have changed.');
      }
    }
    const task = deps.work?.readTask(`quote_signoff_${root.signoff_id}`);
    if (!task || task.done || task.deleted_at !== undefined || task.sync_state !== 'live'
      || task.source_id !== RECUED_BUILTIN_SOURCE_ID('task') || task.source_extension_blob?.quote_signoff_id !== root.signoff_id) {
      throw new QuoteSignoffError('quote_signoff_task_unavailable', 'The original task must be present and unfinished before adding work.');
    }
    return { root, quote, task, revision: additions.length + 1, base_scope: scope, base_amount: decimal(amount) };
  };
  const availability = (row: Row): QuoteSignoffSummary['availability'] => {
    if (row.state === 'released' || row.state === 'rejected' || row.state === 'cancelled') return 'current';
    if (row.state === 'superseded') return 'superseded';
    if (deps.now() >= row.expires_at) return 'expired';
    try {
      const quote = currentQuote(row.quote_id);
      const plan = planOf(row);
      if (plan.addition) {
        const base = additionBase(plan.addition.parent_signoff_id);
        if (JSON.stringify(quote) !== row.quote_json || hash(base.task) !== hash(plan.addition.task)
          || taskRevision(base.task.id) !== plan.addition.task_revision) return 'superseded';
      } else {
        if (typeof quote.valid_until !== 'string' || today() > date(quote.valid_until, 'Quote valid-until')) return 'expired';
        if (quote.status !== 'open' || JSON.stringify(quote) !== row.quote_json) return 'superseded';
      }
      const invoice = binding(INVOICES, 'create', 'invoice');
      const update = binding(QUOTES, 'update', 'quote');
      if (update.pack_version !== plan.quote_version || update.storage_schema_hash !== plan.quote_schema_hash
        || update.declaration_hash !== plan.quote_declaration_hash) return 'unavailable';
      if (invoice.pack_version !== plan.invoice_version || invoice.storage_schema_hash !== plan.invoice_schema_hash
        || invoice.declaration_hash !== plan.invoice_declaration_hash) return 'unavailable';
      return 'current';
    } catch (error) { return error instanceof QuoteSignoffError && error.code === 'quote_signoff_superseded' ? 'superseded' : 'unavailable'; }
  };
  const requireCurrent = (row: Row): void => {
    const current = availability(row);
    if (current !== 'current') throw new QuoteSignoffError(`quote_signoff_${current}`,
      current === 'superseded' ? 'The quote or scope has changed. Prepare a new customer sign-off.'
        : current === 'expired' ? 'This quote sign-off has expired. Prepare a new one.'
          : 'A required quote or invoice pack is unavailable. Nothing was released.');
  };
  const summary = (row: Row): QuoteSignoffSummary => {
    const quote = quoteOf(row); const plan = planOf(row);
    return {
      signoff_id: row.signoff_id, quote_id: row.quote_id,
      quote_version: quote._record.version, quote_revision: quote._record.revision,
      quote_label: String(quote.label), customer: String(quote.customer), amount: plan.amount,
      ...(typeof quote.reference === 'string' ? { quote_reference: quote.reference } : {}),
      currency: String(quote.currency), scope: plan.scope, task_title: plan.task_title,
      net: plan.net, vat_amount: plan.vat_amount,
      invoice_ref: plan.invoice_ref, issued_on: plan.issued_on, due_on: plan.due_on,
      state: row.state, availability: availability(row), created_at: row.created_at,
      expires_at: row.expires_at, endpoint_id: row.endpoint_id,
      responded_at: row.responded_at, released_at: row.released_at,
      task_id: row.state === 'released' ? plan.addition?.task.id ?? `quote_signoff_${row.signoff_id}` : null,
      invoice_id: row.state === 'released' ? `quote_signoff_${row.signoff_id}` : null,
      ...(plan.addition ? { addition: { parent_signoff_id: plan.addition.parent_signoff_id,
        root_signoff_id: plan.addition.root_signoff_id, revision: plan.addition.revision,
        base_scope: plan.addition.base_scope, base_amount: plan.addition.base_amount, total_amount: plan.addition.total_amount } } : {}),
    };
  };
  const followUp = (row: Row): QuoteSignoffFollowUp => {
    const plan = planOf(row); const quote = quoteOf(row);
    const result: QuoteSignoffFollowUp = { checked_at: deps.now(),
      task: { availability: 'unavailable' }, invoice: { availability: 'unavailable' } };
    if (deps.work) {
      try {
        const task = deps.work.readTask(plan.addition?.task.id ?? `quote_signoff_${row.signoff_id}`);
        const rootId = plan.addition?.root_signoff_id ?? row.signoff_id;
        result.task = !task || task.deleted_at !== undefined || task.sync_state === 'tombstoned' ? { availability: 'missing' }
          : task.sync_state !== 'live' ? { availability: 'unavailable' }
          : task.source_id !== RECUED_BUILTIN_SOURCE_ID('task')
            || task.source_extension_blob?.quote_signoff_id !== rootId
            || task.source_extension_blob?.quote_id !== row.quote_id ? { availability: 'changed' }
            : { availability: 'current', title: task.title, done: task.done,
              ...(task.state !== undefined ? { state: task.state } : {}),
              ...(task.progress !== undefined ? { progress: task.progress } : {}) };
      } catch { /* A missing store must not look like completed work. */ }
    }
    try {
      binding(INVOICES, 'get', 'invoice');
      const invoice = deps.records.ownerGet(INVOICES, 'invoice', `quote_signoff_${row.signoff_id}`);
      if (!invoice) result.invoice = { availability: 'missing' };
      else {
        result.invoice = { availability: 'changed' };
        if (invoice.client_name === quote.customer && invoice.currency === quote.currency
          && invoice.ref === plan.invoice_ref && invoice.total === plan.amount
          && invoice.net === plan.net && invoice.vat_amount === plan.vat_amount) {
          // Check exact arithmetic and state as well as the commercial terms.
          // A carried balance still needs follow-up even when its task is done.
          const paid = recordedMoney(invoice.amount_paid, plan.amount);
          const outstanding = recordedMoney(invoice.outstanding, plan.amount);
          const due = date(invoice.due_on, 'Invoice due date');
          const status = invoice.status;
          if (units(paid) + units(outstanding) === units(plan.amount)
            && (status === 'carried_forward' || !invoice.carried_to)
            && (status === 'open' && units(outstanding) > 0n
              || status === 'settled' && units(outstanding) === 0n
              || status === 'carried_forward' && units(outstanding) > 0n
                && typeof invoice.carried_to === 'string' && invoice.carried_to.trim())) {
            result.invoice = { availability: 'current', status, amount_paid: paid, outstanding,
              due_on: due, overdue: status === 'open' && due < today(),
              ...(status === 'carried_forward' ? { carried_to: invoice.carried_to as string } : {}) };
          }
        }
      }
    } catch { /* Preserve changed for malformed records; unavailable for read failures. */ }
    return result;
  };
  const customerPreview = (row: Row): string => {
    const quote = quoteOf(row); const plan = planOf(row);
    if (plan.addition) return `Added work ${plan.addition.revision} for quote ${String(quote.reference || quote.label)} — ${String(quote.customer)}\n`
      + `Previously agreed: ${plan.addition.base_amount} ${String(quote.currency)} total\n`
      + `Added amount: ${plan.amount} ${String(quote.currency)} total\n`
      + `Added net: ${plan.net}; VAT included in added amount: ${plan.vat_amount} ${String(quote.currency)}\n`
      + `New agreed total: ${plan.addition.total_amount} ${String(quote.currency)}\n\n`
      + `Previously agreed scope:\n${plan.addition.base_scope}\n\nAdded scope:\n${plan.scope}`;
    return `Quote ${String(quote.reference || quote.label)} — ${String(quote.customer)}\n`
      + `Revision ${quote._record.revision}\n${plan.amount} ${String(quote.currency)} total\n`
      + `Net: ${plan.net}; VAT included: ${plan.vat_amount} ${String(quote.currency)}\n`
      + `Valid through ${String(quote.valid_until)}\n\n${plan.scope}`;
  };
  const approvalConfig = (id: string): ApprovalLinkConfig => {
    const row = load(id); const plan = planOf(row);
    const config: ApprovalLinkConfig = {
      display_name: plan.display_name, action_kind: 'approve_wording',
      prompt: plan.addition ? 'Do you accept the added work and additional charge shown below?' : 'Do you accept this quote and the scope shown below?',
      context_raw: { summary: customerPreview(row) },
      visitor_field_constraints: { name: 'optional', email: 'optional' },
      expiry_days: plan.expiry_days,
      on_action: { target_id: id, on_approve_action: 'quote_signoff' },
      success_message: 'Your response has been recorded. Accepted work will be reviewed by the business before it starts.',
    };
    const failures = validateApprovalLinkConfig(config);
    if (failures.length) throw new QuoteSignoffError('quote_signoff_invalid', failures[0]!.detail, 400);
    return config;
  };
  const releaseInput = (row: Row): QuoteSignoffReleaseInput => {
    const plan = planOf(row);
    return {
      signoff_id: row.signoff_id, expected_plan_hash: row.plan_hash,
      summary: `${customerPreview(row)}\n\n${plan.addition ? `Append the added scope to existing task ${plan.addition.task.id}: ${plan.task_title}` : `Create task: ${plan.task_title}`}\n`
        + `Issue invoice ${plan.invoice_ref}: ${plan.amount} ${String(quoteOf(row).currency)} total; `
        + `dated ${plan.issued_on}, due ${plan.due_on}. No email or payment is sent.`,
    };
  };
  return {
    prepare(input: QuoteSignoffPrepareInput): QuoteSignoffSummary {
      const quoteId = text(input.quote_id, 'Quote', 512);
      const scope = text(input.scope, 'Customer-visible scope', QUOTE_SIGNOFF_SCOPE_MAX);
      const expiry = input.expiry_days ?? 7;
      if (!Number.isSafeInteger(expiry) || expiry < 1 || expiry > 30) {
        throw new QuoteSignoffError('quote_signoff_invalid', 'Link lifetime must be 1–30 days.', 400);
      }
      return deps.db.transaction(() => {
        const quote = currentQuote(quoteId);
        if (quote.status !== 'open') throw new QuoteSignoffError('quote_signoff_quote_closed', 'Only an open quote can be offered for sign-off.');
        if (today() > date(quote.valid_until, 'Quote valid-until')) throw new QuoteSignoffError('quote_signoff_expired', 'The quote has expired. Revise it before requesting sign-off.');
        if (typeof quote.currency !== 'string' || !/^[A-Z]{3}$/.test(quote.currency)) {
          throw new QuoteSignoffError('quote_signoff_invalid', 'The quote must name a three-letter currency.', 400);
        }
        const invoice = binding(INVOICES, 'create', 'invoice');
        const update = binding(QUOTES, 'update', 'quote');
        const amount = money(quote.amount);
        const vat = tax(input.vat_amount ?? '0', amount);
        const issued = date(input.issued_on ?? today(), 'Invoice date');
        const due = date(input.due_on ?? new Date(Date.parse(`${issued}T00:00:00Z`) + 30 * DAY).toISOString().slice(0, 10), 'Invoice due date');
        if (due < issued) throw new QuoteSignoffError('quote_signoff_invalid', 'Invoice due date cannot precede its issue date.', 400);
        const plan: Plan = {
          display_name: text(input.display_name, 'Business name', 100), scope,
          task_title: text(input.task_title, 'Task title', 200), invoice_ref: text(input.invoice_ref, 'Invoice reference', 100),
          issued_on: issued, due_on: due, amount, net: decimal(units(amount) - units(vat)), vat_amount: vat, expiry_days: expiry,
          quote_version: update.pack_version, quote_schema_hash: update.storage_schema_hash,
          quote_declaration_hash: update.declaration_hash,
          invoice_version: invoice.pack_version, invoice_schema_hash: invoice.storage_schema_hash,
          invoice_declaration_hash: invoice.declaration_hash,
        };
        const row: Row = {
          signoff_id: randomUUID(), quote_id: quoteId, quote_json: JSON.stringify(quote),
          plan_json: JSON.stringify(plan), plan_hash: hash({ quote, plan }), state: 'draft',
          created_at: deps.now(), expires_at: deps.now() + expiry * DAY,
          endpoint_id: null, responded_at: null, released_at: null, intent_id: null,
        };
        if (customerPreview(row).length > QUOTE_SIGNOFF_CONTEXT_MAX) throw new QuoteSignoffError('quote_signoff_invalid', 'The customer-visible quote is too long.', 400);
        // A new scope for the same quote supersedes every earlier offer, even
        // when the quote row itself did not change. Old held releases stay closed.
        deps.db.prepare(`UPDATE ${TABLE} SET state='superseded' WHERE quote_id=? AND state IN ('draft','publishing','waiting','accepted')`).run(quoteId);
        deps.db.prepare(`INSERT INTO ${TABLE} (signoff_id,quote_id,quote_json,plan_json,plan_hash,state,created_at,expires_at) VALUES (?,?,?,?,?,'draft',?,?)`)
          .run(row.signoff_id, quoteId, row.quote_json, row.plan_json, row.plan_hash, row.created_at, row.expires_at);
        return summary(row);
      }).immediate();
    },
    prepareAddition(input: QuoteSignoffAdditionPrepareInput): QuoteSignoffSummary {
      const parentId = text(input.parent_signoff_id, 'Released agreement', 36);
      const scope = text(input.scope, 'Added customer-visible scope', QUOTE_SIGNOFF_SCOPE_MAX);
      const amount = additionalMoney(input.amount);
      const expiry = input.expiry_days ?? 7;
      if (!Number.isSafeInteger(expiry) || expiry < 1 || expiry > 30) throw new QuoteSignoffError('quote_signoff_invalid', 'Link lifetime must be 1–30 days.', 400);
      return deps.db.transaction(() => {
        const base = additionBase(parentId);
        const invoice = binding(INVOICES, 'create', 'invoice'); const update = binding(QUOTES, 'update', 'quote');
        const total = units(base.base_amount) + units(amount);
        if (total > 9_223_372_036_854_775_807n) throw new QuoteSignoffError('quote_signoff_invalid', 'The new agreed total exceeds the exact money range.', 400);
        const vat = tax(input.vat_amount ?? '0', amount);
        const issued = date(input.issued_on ?? today(), 'Invoice date');
        const due = date(input.due_on ?? new Date(Date.parse(`${issued}T00:00:00Z`) + 30 * DAY).toISOString().slice(0, 10), 'Invoice due date');
        if (due < issued) throw new QuoteSignoffError('quote_signoff_invalid', 'Invoice due date cannot precede its issue date.', 400);
        ensureTaskVersions();
        deps.db.prepare('INSERT OR IGNORE INTO quote_signoff_task_versions (task_id,revision) VALUES (?,0)').run(base.task.id);
        const plan: Plan = { display_name: text(input.display_name, 'Business name', 100), scope,
          task_title: base.task.title, invoice_ref: text(input.invoice_ref, 'Additional invoice reference', 100),
          issued_on: issued, due_on: due, amount, net: decimal(units(amount) - units(vat)), vat_amount: vat, expiry_days: expiry,
          quote_version: update.pack_version, quote_schema_hash: update.storage_schema_hash, quote_declaration_hash: update.declaration_hash,
          invoice_version: invoice.pack_version, invoice_schema_hash: invoice.storage_schema_hash, invoice_declaration_hash: invoice.declaration_hash,
          addition: { parent_signoff_id: parentId, root_signoff_id: base.root.signoff_id, revision: base.revision,
            base_scope: base.base_scope, base_amount: base.base_amount, total_amount: decimal(total),
            task: base.task, task_revision: taskRevision(base.task.id) } };
        const row: Row = { signoff_id: randomUUID(), quote_id: base.root.quote_id, quote_json: JSON.stringify(base.quote),
          plan_json: JSON.stringify(plan), plan_hash: hash({ quote: base.quote, plan }), state: 'draft',
          created_at: deps.now(), expires_at: deps.now() + expiry * DAY,
          endpoint_id: null, responded_at: null, released_at: null, intent_id: null };
        if (customerPreview(row).length > QUOTE_SIGNOFF_CONTEXT_MAX) throw new QuoteSignoffError('quote_signoff_invalid', 'The customer-visible agreement and added scope are too long.', 400);
        deps.db.prepare(`UPDATE ${TABLE} SET state='superseded' WHERE state IN ('draft','publishing','waiting','accepted')
          AND json_extract(plan_json,'$.addition.root_signoff_id')=?`).run(base.root.signoff_id);
        deps.db.prepare(`INSERT INTO ${TABLE} (signoff_id,quote_id,quote_json,plan_json,plan_hash,state,created_at,expires_at)
          VALUES (?,?,?,?,?,'draft',?,?)`).run(row.signoff_id, row.quote_id, row.quote_json, row.plan_json, row.plan_hash, row.created_at, row.expires_at);
        return summary(row);
      }).immediate();
    },
    get: (id: string): QuoteSignoffSummary => summary(load(id)),
    quotes(limit: number) {
      binding(QUOTES, 'get', 'quote'); binding(INVOICES, 'create', 'invoice');
      const result = deps.records.ownerSearch({ owner: QUOTES, entity: 'quote', filters: { status: 'open' }, limit });
      return { quotes: result.records.filter((q) => typeof q.valid_until === 'string' && q.valid_until >= today())
        .map((q) => ({ id: q.id, label: String(q.label), customer: String(q.customer),
          amount: String(q.amount), currency: String(q.currency), revision: q._record.revision })),
        truncated: result.next_cursor !== undefined };
    },
    list(input: QuoteSignoffListInput | number = {}): QuoteSignoffListResult {
      const options = typeof input === 'number' ? { limit: input } : input;
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['limit', 'search', 'state', 'cursor', 'signoff_id'].includes(key))) {
        throw new QuoteSignoffError('quote_signoff_invalid', 'Invalid customer sign-off search.', 400);
      }
      if (options.limit !== undefined && typeof options.limit !== 'number') {
        throw new QuoteSignoffError('quote_signoff_invalid', 'Limit must be 1–100.', 400);
      }
      const limit = options.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new QuoteSignoffError('quote_signoff_invalid', 'Limit must be 1–100.', 400);
      }
      if (options.search !== undefined && (typeof options.search !== 'string'
        || options.search.length > QUOTE_SIGNOFF_SEARCH_MAX || options.search.includes('\0'))) {
        throw new QuoteSignoffError('quote_signoff_invalid', 'Search must contain at most 200 characters.', 400);
      }
      const search = searchText(options.search?.trim() ?? '');
      if (search.length > QUOTE_SIGNOFF_SEARCH_MAX) {
        throw new QuoteSignoffError('quote_signoff_invalid', 'Search must contain at most 200 characters.', 400);
      }
      const state = options.state;
      if (state !== undefined && !QUOTE_SIGNOFF_STATES.some(candidate => candidate === state)) {
        throw new QuoteSignoffError('quote_signoff_invalid', 'Choose a customer sign-off state.', 400);
      }
      if (options.signoff_id !== undefined && (!isSignoffId(options.signoff_id)
        || options.search !== undefined || state !== undefined || options.cursor !== undefined)) {
        throw new QuoteSignoffError('quote_signoff_invalid', 'An exact request lookup needs only its sign-off reference.', 400);
      }
      const query = hash({ search, state: state ?? null });
      const anchor = options.cursor === undefined ? undefined : pageAnchor(options.cursor, query);
      const where: string[] = [];
      const values: Array<string | number> = [];
      if (options.signoff_id !== undefined) { where.push('signoff_id=?'); values.push(options.signoff_id); }
      if (state !== undefined) { where.push('state=?'); values.push(state); }
      if (search) {
        where.push(`(instr(quote_signoff_search_text(json_extract(quote_json,'$.customer')),?)>0
          OR instr(quote_signoff_search_text(json_extract(quote_json,'$.label')),?)>0
          OR instr(quote_signoff_search_text(json_extract(quote_json,'$.reference')),?)>0
          OR instr(quote_signoff_search_text(json_extract(plan_json,'$.invoice_ref')),?)>0)`);
        values.push(search, search, search, search);
      }
      if (anchor) {
        where.push('(created_at<? OR (created_at=? AND signoff_id>?))');
        values.push(anchor.created_at, anchor.created_at, anchor.signoff_id);
      }
      return deps.db.transaction(() => {
        const rows = deps.db.prepare(`SELECT * FROM ${TABLE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY created_at DESC, signoff_id LIMIT ?`).all(...values, limit + 1) as Row[];
        const truncated = rows.length > limit;
        const last = rows[limit - 1];
        return {
          signoffs: rows.slice(0, limit).map(row => {
            const result = summary(row);
            if (row.state === 'released') {
              result.follow_up = followUp(row);
              result.can_add_work = result.follow_up.task.availability === 'current' && !result.follow_up.task.done
                && !deps.db.prepare(`SELECT 1 FROM ${TABLE} WHERE quote_id=? AND state='released'
                  AND json_extract(plan_json,'$.addition.parent_signoff_id')=? LIMIT 1`).get(row.quote_id, row.signoff_id);
            }
            return result;
          }),
          truncated,
          ...(truncated && last ? { next_cursor: Buffer.from(JSON.stringify({
            v: 1, created_at: last.created_at, signoff_id: last.signoff_id, query,
          })).toString('base64url') } : {}),
        };
      })();
    },
    approvalConfig,
    reservePublish(id: string): void {
      deps.db.transaction(() => {
        const row = load(id); requireCurrent(row);
        if (row.state !== 'draft') throw new QuoteSignoffError('quote_signoff_already_published', 'This request is already published or has been superseded.');
        deps.db.prepare(`UPDATE ${TABLE} SET state='publishing' WHERE signoff_id=?`).run(id);
      }).immediate();
    },
    attachEndpoint(id: string, endpoint: string): void {
      deps.db.transaction(() => {
        const row = load(id); requireCurrent(row);
        if (row.state !== 'publishing') throw new QuoteSignoffError('quote_signoff_superseded', 'The request changed while its link was being created.');
        deps.db.prepare(`UPDATE ${TABLE} SET endpoint_id=?,state='waiting' WHERE signoff_id=?`).run(endpoint, id);
      }).immediate();
    },
    resetPublish(id: string): void {
      deps.db.prepare(`UPDATE ${TABLE} SET state='draft',endpoint_id=NULL WHERE signoff_id=? AND state IN ('publishing','waiting') AND responded_at IS NULL`).run(id);
    },
    cancel(id: string): QuoteSignoffSummary {
      return deps.db.transaction(() => {
        const row = load(id);
        if (row.state === 'released') throw new QuoteSignoffError('quote_signoff_already_released', 'The work and invoice have already been released. Correct those records explicitly.');
        deps.db.prepare(`UPDATE ${TABLE} SET state='cancelled' WHERE signoff_id=?`).run(id);
        return summary(load(id));
      }).immediate();
    },
    checkLink(id: string, endpoint: string, config?: ApprovalLinkConfig): string | null {
      try {
        const row = load(id);
        if (row.endpoint_id !== endpoint || row.state !== 'waiting') return 'This quote sign-off is no longer available. Ask the business for a new link.';
        if (config && JSON.stringify(config) !== JSON.stringify(approvalConfig(id))) return 'This quote sign-off no longer matches the offer. Ask the business for a new link.';
        requireCurrent(row); return null;
      } catch { return 'This quote has changed or expired. Ask the business for a new quote sign-off.'; }
    },
    recordResponse(id: string, endpoint: string, intent: string, affirmative: boolean): QuoteSignoffReleaseInput | null {
      return deps.db.transaction(() => {
        const row = load(id);
        if (row.endpoint_id !== endpoint || intent !== endpoint) throw new QuoteSignoffError('quote_signoff_wrong_link', 'The response belongs to another sign-off.');
        if (row.intent_id !== null) {
          if (row.intent_id !== intent) throw new QuoteSignoffError('quote_signoff_wrong_response', 'The response belongs to another sign-off.');
          return row.state === 'accepted' ? releaseInput(row) : null;
        }
        if (row.state !== 'waiting' || availability(row) !== 'current') {
          if (row.state !== 'cancelled' && row.state !== 'superseded') deps.db.prepare(`UPDATE ${TABLE} SET state='superseded' WHERE signoff_id=?`).run(id);
          return null;
        }
        deps.db.prepare(`UPDATE ${TABLE} SET state=?,responded_at=?,intent_id=? WHERE signoff_id=?`)
          .run(affirmative ? 'accepted' : 'rejected', deps.now(), intent, id);
        return affirmative ? releaseInput(load(id)) : null;
      }).immediate();
    },
    release(input: QuoteSignoffReleaseInput): QuoteSignoffReleaseResult {
      return deps.db.transaction(() => {
        const row = load(input.signoff_id);
        const expected = releaseInput(row);
        if (input.expected_plan_hash !== row.plan_hash || input.summary !== expected.summary) {
          throw new QuoteSignoffError('quote_signoff_plan_changed', 'This approval no longer matches the customer’s accepted quote and release plan.');
        }
        const id = `quote_signoff_${row.signoff_id}`;
        const plan = planOf(row); const taskId = plan.addition?.task.id ?? id;
        if (row.state === 'released') return { signoff_id: row.signoff_id, task_id: taskId, invoice_id: id, already_released: true };
        if (row.state !== 'accepted' || row.intent_id === null) throw new QuoteSignoffError('quote_signoff_not_accepted', 'The customer has not accepted this quote, or the request was cancelled.');
        requireCurrent(row);
        if (!deps.work) throw new QuoteSignoffError('quote_signoff_work_unavailable', 'The local task store is unavailable. Nothing was released.');
        if (!plan.addition && deps.db.prepare('SELECT id FROM data_task WHERE id=?').get(id)) {
          throw new QuoteSignoffError('quote_signoff_target_exists', 'The planned task already exists. Nothing was overwritten.');
        }
        const quote = quoteOf(row);
        const update = binding(QUOTES, 'update', 'quote');
        const create = binding(INVOICES, 'create', 'invoice');
        const lease = deps.records.acquireExecutionLease({
          lease_id: `quote-signoff:${row.signoff_id}`, recipe_id: QUOTE_SIGNOFF_RELEASE_RECIPE,
          caller_pack: 'core.quote-signoff', targets: [...(plan.addition ? [] : [{ binding: update }]), { binding: create }],
        });
        try {
          // Fail on a duplicate invoice reference before creating anything.
          const existing = deps.records.ownerSearch({ owner: INVOICES, entity: 'invoice',
            filters: { ref: plan.invoice_ref }, limit: 1 });
          if (existing.records.length) throw new QuoteSignoffError('quote_signoff_invoice_ref_exists', 'That invoice reference already exists. Nothing was released.');
          if (!plan.addition) deps.records.execute({ binding: update, principal: 'owner-approved:quote-signoff', execution_lease_id: lease.lease_id,
            args: { id: row.quote_id, expected_version: quote._record.version,
              expected_revision: quote._record.revision, set: { status: 'won', decided_on: today() }, unset: [] } });
          deps.records.execute({ binding: create, principal: 'owner-approved:quote-signoff', execution_lease_id: lease.lease_id,
            args: { id, values: { client_name: quote.customer, client_contact: quote.customer_contact ?? '',
              ref: plan.invoice_ref, currency: quote.currency, status: 'open',
              note: `${plan.addition ? `Added work ${plan.addition.revision} for` : 'Accepted'} quote ${String(quote.reference || quote.label)}. ${plan.scope}`,
              lines_json: JSON.stringify([{ item_id: row.quote_id, date: plan.issued_on, description: plan.scope, amount: plan.net }]),
              line_count: 1, total: plan.amount, net: plan.net, vat_amount: plan.vat_amount,
              amount_paid: '0.0000', outstanding: plan.amount, issued_on: plan.issued_on, due_on: plan.due_on } } });
          if (plan.addition) {
            const task = plan.addition.task;
            deps.work.writeTask({ ...task, updated_at: deps.now(),
              body: `${task.body ?? ''}\n\nAdded work ${plan.addition.revision}:\n${plan.scope}`,
              source_extension_blob: { ...task.source_extension_blob,
                quote_signoff_additions: [...(Array.isArray(task.source_extension_blob?.quote_signoff_additions)
                  ? task.source_extension_blob.quote_signoff_additions : []),
                { signoff_id: row.signoff_id, invoice_id: id, parent_signoff_id: plan.addition.parent_signoff_id }] } }, deps.now());
          } else deps.work.writeTask({ id, source_id: RECUED_BUILTIN_SOURCE_ID('task'),
            title: plan.task_title, body: plan.scope, state: 'open', done: false,
            source_extension_blob: { quote_signoff_id: row.signoff_id, quote_id: row.quote_id,
              quote_revision: quote._record.revision, reception_approval_intent_id: row.intent_id,
              invoice_id: id } }, deps.now());
          deps.db.prepare(`UPDATE ${TABLE} SET state='released',released_at=? WHERE signoff_id=?`).run(deps.now(), row.signoff_id);
        } finally { lease.release(); }
        return { signoff_id: row.signoff_id, task_id: taskId, invoice_id: id, already_released: false };
      }).immediate();
    },
  };
};
export type QuoteSignoffService = ReturnType<typeof createQuoteSignoffService>;
