/**
 * D-315 §6.3 — Backfill: a template's mail that already arrived, read by the
 * same passes as new mail (ruling 13).
 *
 *   - **The owner picks the period**, as far back as mail is still stored.
 *     Stored mail in it is walked across every mailbox; a condition of the
 *     template the stored copy can decide is tested first, and only an email
 *     that may match is read again from its provider (§4.4) and written by the
 *     same writer as new mail — every template and the standards pass, as at
 *     ingest. Oldest first, so a thing's events follow its mail's order.
 *   - **It stores facts and fires nothing** unless the owner ticks "also run
 *     the recipes these facts trigger": then the template's facts that never
 *     started anything do — stored silently before, or new now — and their
 *     events carry `origin: 'backfill'`, so those runs are started with
 *     `trigger_source: 'backfill'`, stamped `run_mode: backfill`. A fact that
 *     already started its recipes never starts them again, and the other
 *     templates' facts stay silent.
 *   - **Only the template's health counts:** the others read these emails when
 *     they arrived.
 *   - **A poorer reading never replaces a better one.** An email its provider
 *     can no longer give whole is read from the stored copy — no HTML, headers
 *     or sender name — only when it has no facts yet; one that already has
 *     facts from the whole email keeps them, and the job counts it.
 *   - Each email is read again even when the writer read it already (ruling
 *     13: a template made or changed reads past mail only here). A fact whose
 *     email and template did not change stays as it was, the AI's answers
 *     included, so a second backfill over the same period costs the fetches
 *     and changes nothing.
 *   - One job at a time: each email read again is a provider call. One that
 *     runs recipes tells each email as it came: an email whose facts wait on
 *     the AI is told when the AI answers, and the job waits for that before
 *     the next email.
 */

import { randomUUID } from 'node:crypto';

import type {
  CollectionRecord,
  MailFactBackfillJob,
  MailFactEmailRef,
  MailFactBackfillRequest,
  MailFactBackfillState,
  MailTemplate,
} from '@recued/contracts';
import { isMailReconciliationId } from '@recued/contracts';

import type { MailCollection } from '../collections/mail/mail-collection.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import { mailFactEmailDate, type MailFactWriter } from './fact-writer.js';
import { contentFingerprint, mailFactEmailAt } from './mail-ingest.js';
import { conditionsMayHold } from './rules-pass.js';
import { readStoredEmail, storedAttachmentsOf, storedCopyEmail, storedLabels, type StoredEmailDeps } from './stored-email.js';

const DAY_MS = 86_400_000;
const PAGE = 500;
/** The moves one email is followed through while it is read: each is another
 *  fetch, and the move ledger never leads back to an id it left. */
const MAX_MOVES = 3;
/** When no mailbox says, a mailbox keeps a year (`DEFAULT_MAIL_RETENTION_DAYS`). */
const DEFAULT_MAX_DAYS = 365;

export interface MailFactBackfillDeps extends StoredEmailDeps {
  readonly store: Pick<MailFactStore, 'getTemplate' | 'factsForEmail' | 'getEmailLedger' | 'factRecordsForEmail' | 'emailsWithTemplateFacts' | 'emailMovedTo'>;
  readonly writer: Pick<MailFactWriter, 'write'>;
  readonly mailboxes: () => readonly MailCollection[];
  readonly retentionDays?: (slug: string) => number | null;
  readonly now: () => number;
  readonly mintId?: () => string;
  /** The job moved; the screens refresh (coalesced by the caller). */
  readonly onProgress?: () => void;
  /** Resolves once the trigger queue has room: a job that runs recipes waits
   *  here before each email, so its events are not refused at the queue's
   *  ceiling while slow runs drain. */
  readonly triggerRoom?: () => Promise<void>;
  /** Resolves once no AI call holding news waits on the email, with the
   *  events its answers told (`MailFactAiRunner.untilSettled`). A job that
   *  runs recipes waits here after each email: an email whose facts wait on
   *  the AI is told when it answers, and the next email must not go first. */
  readonly aiSettled?: (email: MailFactEmailRef) => Promise<number>;
}

export class MailFactBackfillError extends Error {
  constructor(readonly code: 'not_found' | 'conflict' | 'bad_request', message: string) {
    super(message);
  }
}

export interface MailFactBackfill {
  start(request: MailFactBackfillRequest): MailFactBackfillJob;
  state(): MailFactBackfillState;
  cancel(job_id: string): MailFactBackfillJob | null;
  /** Resolves when the running job, if any, has ended. */
  settled(): Promise<void>;
}

type MutableJob = { -readonly [K in keyof MailFactBackfillJob]: MailFactBackfillJob[K] };

const skippedByIngest = (record: CollectionRecord): boolean =>
  record.hot_fields.direction === 'draft' || isMailReconciliationId(record.hot_fields.reconciliation_id);

export const createMailFactBackfill = (deps: MailFactBackfillDeps): MailFactBackfill => {
  let job: MutableJob | null = null;
  let running: Promise<void> | null = null;
  let cancelled = false;
  /** Ends a wait for room in the trigger queue: a stop does not wait for it. */
  let endWait: (() => void) | null = null;

  const snapshot = (value: MutableJob): MailFactBackfillJob => ({ ...value });
  const progress = (): void => {
    try {
      deps.onProgress?.();
    } catch {
      /* the job goes on */
    }
  };

  const maxDays = (): number => {
    const days = deps.mailboxes()
      .map((mailbox) => deps.retentionDays?.(mailbox.slug) ?? null)
      .filter((value): value is number => value !== null && value > 0);
    return days.length > 0 ? Math.max(...days) : DEFAULT_MAX_DAYS;
  };

  /** The stored emails of the period that may meet the template's conditions —
   *  by id and date only: a year of a mailbox's rows, bodies and all, would
   *  otherwise sit in memory for the whole job. */
  const candidates = async (
    template: MailTemplate,
    since: number,
  ): Promise<{ mailbox: MailCollection; record_id: string; received_at: number; at: number; arrival: number }[]> => {
    const conditions = template.entrance.conditions;
    // An email holding the template's facts is read again whatever its
    // conditions say now: narrowed, they may no longer name it, and only a
    // reading takes its facts back.
    const holding = new Set(deps.store.emailsWithTemplateFacts(template.template_id)
      .map((email) => `${email.slug}\u0000${email.record_id}`));
    const bodyless = conditions.filter((condition) => condition.field !== 'body');
    const needsBody = conditions.some((condition) => condition.field === 'body') && !template.html;
    const found: { mailbox: MailCollection; record_id: string; received_at: number; at: number; arrival: number }[] = [];
    for (const mailbox of deps.mailboxes()) {
      // Paged by date and id: many emails can share a date, and a page that
      // ends inside them must neither repeat them nor stop the walk.
      let before: { received_at: number; record_id: string } | undefined;
      for (;;) {
        if (cancelled) return found;
        const page = mailbox.list({
          platform: 'mail',
          slug: mailbox.slug,
          since,
          ...(before !== undefined ? { before } : {}),
          limit: PAGE,
        });
        for (const record of page) {
          if (skippedByIngest(record)) continue;
          const holds = holding.has(`${mailbox.slug}\u0000${record.record_id}`);
          if (!holds && !conditionsMayHold(bodyless, await storedCopyEmail(deps, record, { withBody: false }), template.html)) continue;
          if (!holds && needsBody && !conditionsMayHold(conditions, await storedCopyEmail(deps, record), template.html)) continue;
          const ref = { slug: mailbox.slug, record_id: record.record_id };
          found.push({
            mailbox,
            record_id: record.record_id,
            received_at: record.received_at,
            at: mailFactEmailDate(deps.store, ref, mailFactEmailAt(record.received_at, deps.now())),
            // Never read: read now, after every email that was.
            arrival: deps.store.getEmailLedger(ref)?.arrival ?? Number.MAX_SAFE_INTEGER,
          });
        }
        if (page.length < PAGE) break;
        const last = page[page.length - 1]!;
        before = { received_at: last.received_at, record_id: last.record_id };
      }
    }
    // In the order a thing folds its facts (§5), which its events follow: by
    // the date they are ordered by — a future-dated email read first is dated
    // when it was read, not by what it says — and of one date, in the order
    // the mail was first read.
    return found.sort((a, b) => a.at - b.at || a.arrival - b.arrival || a.received_at - b.received_at || (a.record_id < b.record_id ? -1 : 1));
  };

  /** One email, read where it lives when it is written: `moved` when a move
   *  gave it a new id before it was fetched, while it was, or while it waited
   *  for room — it is read again there, as a backfill begun after the move
   *  would read it. Skipped, it kept what an older template read. */
  const readOne = async (
    current: MutableJob,
    template: MailTemplate,
    mailbox: MailCollection,
    record_id: string,
    first: boolean,
  ): Promise<{ readonly moved: string } | null> => {
    const ref = { slug: mailbox.slug, record_id };
    const movedOn = (): { readonly moved: string } | null => {
      const moved = deps.store.emailMovedTo(ref);
      return moved === null ? null : { moved: moved.record_id };
    };
    const stored = await readStoredEmail(deps, mailbox, record_id);
    if (first) current.read += 1;
    // Stopped while it fetched: no wait below would hear it.
    if (cancelled) return null;
    if (stored === null) return movedOn();
    if (stored.read === 'stored') {
      current.stored_copies += 1;
      if (deps.store.factsForEmail(ref).length > 0) {
        current.kept += 1;
        progress();
        return null;
      }
    }
    if (current.run_recipes && deps.triggerRoom !== undefined) {
      await Promise.race([deps.triggerRoom(), new Promise<void>((resolve) => { endWait = resolve; })]);
      endWait = null;
      if (cancelled) return null;
    }
    // Deleted while it was fetched or waited: its facts went with it, and
    // writing now would bring them back for an email that is gone. Moved, it
    // is read where it is now. Nothing below awaits, so nothing can change it
    // before the write.
    const row = mailbox.get(ref.record_id);
    if (row === null) return movedOn();
    // With the labels it has now, the sender's relationships now and the
    // files stored now — the ones its row holds are the fetched message's,
    // and the contacts' and the files the ones it was read with, unless they
    // changed while it was fetched or waited: the sync read it as it is now,
    // and a template that tests them may no longer meet it. As read before,
    // it would bring back a fact the change took away, and start its recipes.
    const email = {
      ...stored.email,
      labels: storedLabels(row),
      relationships: deps.relationshipsOf?.(stored.email.from_address) ?? [],
      attachments: stored.message === undefined
        ? stored.email.attachments
        : storedAttachmentsOf(stored.message, ref.slug, ref.record_id, deps),
    };
    const result = deps.writer.write({
      ref,
      email,
      email_at: mailFactEmailAt(stored.record.received_at, deps.now()),
      content_fingerprint: contentFingerprint(email, stored.envelope),
      may_trigger: current.run_recipes,
      count_health: true,
      envelope: stored.envelope,
      force: true,
      backfill_template: template.template_id,
      ...(current.run_recipes ? { origin: 'backfill' as const } : {}),
    });
    if (result.skipped === undefined) current.facts += result.facts;
    current.events += result.events;
    progress();
    // Told as it came: facts that wait on the AI are told when it answers,
    // and a later email told first would leave this one nothing to tell —
    // compared with what was heard, its change is behind the later one's.
    if (current.run_recipes && deps.aiSettled !== undefined) {
      const told = await Promise.race([
        deps.aiSettled(ref),
        new Promise<null>((resolve) => { endWait = () => resolve(null); }),
      ]);
      endWait = null;
      if (told !== null && told > 0) {
        current.events += told;
        progress();
      }
    }
    return null;
  };

  const run = async (current: MutableJob, template: MailTemplate): Promise<void> => {
    const since = deps.now() - current.days * DAY_MS;
    const emails = await candidates(template, since);
    current.total = emails.length;
    progress();
    for (const { mailbox, record_id } of emails) {
      if (cancelled) break;
      // A move leads on once each time; the ledger never leads back.
      let at: string | null = record_id;
      for (let moves = 0; at !== null && moves <= MAX_MOVES && !cancelled; moves += 1) {
        at = (await readOne(current, template, mailbox, at, moves === 0))?.moved ?? null;
      }
    }
  };

  return {
    start: (request) => {
      if (running !== null) {
        throw new MailFactBackfillError('conflict', 'A backfill is already reading past mail — wait for it, or stop it first.');
      }
      const template = deps.store.getTemplate(request.template_id);
      if (template === null) throw new MailFactBackfillError('not_found', 'That template no longer exists.');
      if (!template.active) {
        throw new MailFactBackfillError('bad_request', 'Switch the template on first: a backfill reads with the templates that are on.');
      }
      const limit = maxDays();
      if (!Number.isInteger(request.days) || request.days < 1 || request.days > limit) {
        throw new MailFactBackfillError('bad_request', `days must be a whole number from 1 to ${limit}`);
      }
      cancelled = false;
      const current: MutableJob = {
        job_id: deps.mintId?.() ?? `mbf_${randomUUID()}`,
        template_id: template.template_id,
        days: request.days,
        run_recipes: request.run_recipes === true,
        status: 'running',
        total: 0,
        read: 0,
        facts: 0,
        events: 0,
        stored_copies: 0,
        kept: 0,
        started_at: deps.now(),
      };
      job = current;
      running = run(current, template)
        .then(() => {
          current.status = cancelled ? 'cancelled' : 'done';
        }, (error: unknown) => {
          current.status = 'failed';
          current.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          current.finished_at = deps.now();
          running = null;
          progress();
        });
      progress();
      return snapshot(current);
    },

    state: () => ({ job: job === null ? null : snapshot(job), max_days: maxDays() }),

    cancel: (job_id) => {
      if (job === null || job.job_id !== job_id) return null;
      if (job.status === 'running') {
        cancelled = true;
        endWait?.();
      }
      return snapshot(job);
    },

    settled: () => running ?? Promise.resolve(),
  };
};
