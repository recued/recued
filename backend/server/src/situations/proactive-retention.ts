import type Database from 'better-sqlite3';
import type { SituationStore } from '../storage/situation-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createProactiveLearningStore } from '../storage/proactive-learning-store.js';
import { createProactiveTraceStore } from '../storage/proactive-trace-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { intakeOfferSource, intakeReceiptFact } from './asset-intake.js';
import { createClockRetention } from './clock-retention.js';
import { recallOfferYear } from './episode-runtime.js';
import { LEARNING_LOOKBACK_MS, RELATION_LOOKBACK_MS, relationKey, relationOfferKey } from './learning.js';
import type { ScheduledSituations } from './scheduled-situations.js';

const DAY = 86_400_000;
/** How long the situation log, proposal outcomes, overview runs and resolved
 * situations stay once nothing waits on them. The overview's "Resolved" lines
 * read the log, and four weekly overviews fit. */
export const PROACTIVE_LOG_RETENTION_MS = 30 * DAY;
/** How long opt-in measures, episode corrections, dark-run candidates and finished
 * clock cycles count: a year holds one cycle of every annual clock. */
export const PROACTIVE_COUNT_RETENTION_MS = 366 * DAY;

export interface ProactiveRetentionDeps {
  db: Database.Database;
  situations: SituationStore;
  /** Every durable-feed subscriber that still exists. Each one's checkpoint holds the log. */
  subscribers(): readonly string[];
  /** The overview, when the server runs one: its runs, attempts and what it kept per situation. */
  overview?: Pick<ScheduledSituations, 'prune'>;
  /** The commitments and assets a clock cycle belongs to. Without them no cycle goes. */
  work?: Pick<WorkEntityStore, 'readCommitment' | 'readAssetEffective'>;
  /** The mail an intake offer or receipt came from. Without it neither goes. */
  mailFacts?: Pick<MailFactStore, 'getFact' | 'getThing'>;
  isVaultUnlocked(): boolean;
  now?(): number;
}
/** Each store keeps what its readers can still use: the feed what a subscriber
 * has yet to handle, the learner what its lookback reads, and Yours the receipts
 * it shows. */
export const createProactiveRetention = (deps: ProactiveRetentionDeps) => {
  const now = deps.now ?? Date.now;
  const proposals = createProactiveProposalStore(deps.db); const learning = createProactiveLearningStore(deps.db); const traces = createProactiveTraceStore(deps.db);
  const history = createProactiveHistoryStore(deps.db, proposals);
  const clocks = deps.work ? createClockRetention({ db: deps.db, work: deps.work, history, proposals }) : undefined;
  const mail = deps.mailFacts;
  const prune = () => {
    const at = now(); const before = at - PROACTIVE_LOG_RETENTION_MS; const counted = at - PROACTIVE_COUNT_RETENTION_MS;
    // A recall offer is made for one year; a month into the next, nothing can make it again.
    const recallYear = new Date(before).getUTCFullYear();
    return {
      ...deps.situations.prune({ before, subscribers: deps.subscribers() }),
      // After the situations: what the overview kept goes with the situation it was about.
      ...deps.overview?.prune(before),
      ...proposals.prune({ before, ...(deps.situations.readSetting('metrics.opt_in', false) ? { uncounted: {
        after: deps.situations.readSetting('metrics.proposal_cursor', 0), since: deps.situations.readSetting('metrics.enabled_at', 0) } } : {}) }),
      // Mail ids are never reused, so an offer from mail that is gone cannot come back.
      tombstones: proposals.pruneTombstones(key => {
        const source = intakeOfferSource(key); const year = recallOfferYear(key);
        return source !== null ? !!mail && !mail.getThing(source) && !mail.getFact(source) : year !== null && year < recallYear;
      }),
      intake_receipts: mail ? proposals.pruneReceipts(key => {
        const read = intakeReceiptFact(key); return read !== null && mail.getFact(read.fact_id)?.source_hash === read.source_hash;
      }) : 0,
      // A relation question is asked once, and accepting it keeps its proposal.
      ...learning.prune({ signalsBefore: at - LEARNING_LOOKBACK_MS, evidenceBefore: at - RELATION_LOOKBACK_MS,
        settled: (target_class, sphere) => proposals.offered(relationOfferKey(relationKey(target_class, sphere))) }),
      receipts: traces.pruneReceipts(),
      ...deps.situations.pruneMeasures(counted),
      ...history.pruneFeedback(counted),
      ...history.foldDark(counted),
      ...clocks?.prune({ before: counted, lookback: at - LEARNING_LOOKBACK_MS }),
    };
  };
  return { prune, tick: (): void => { if (deps.isVaultUnlocked()) prune(); } };
};
export type ProactiveRetention = ReturnType<typeof createProactiveRetention>;
