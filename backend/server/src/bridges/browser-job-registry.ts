/** D-402 slice A2 — the job an AI app started, so the calls it makes can be gathered into one plan.
 *
 *  An MCP call carries no job or session id: its source is the app's agent id, a tool-call id made
 *  fresh for each dispatch, its token and its contract, and each call is a run of its own. So "the
 *  plan an AI app ran" (D-402 §3.2) needs the app to say when a job starts: `recued_startJob`. Until
 *  it ends the job, asks for its draft, or an hour passes, the execute handler binds the app's runs
 *  to the job, and the recorder (`browser-flow-record.ts`) keeps their calls under the job's own
 *  session, `job:<id>`.
 *
 *  The owner of a job is the app: its token and its agent id. Local clients share one token, and
 *  are told apart by their agent ids. An app has one job at a time: starting another ends the first.
 *  In memory only, as the plan is. */

import { randomUUID } from 'node:crypto';

import type { BrowserJobLabels } from './browser-job-labels.js';

/** Who a job belongs to: the app's token and the agent id its calls carry. */
export interface BrowserJobOwner {
  readonly mcp_token_id: string;
  readonly agent_id: string;
}

export interface BrowserJobRegistry {
  /** Start a job for this app, ending the one it had going. */
  start(owner: BrowserJobOwner): { job_id: string; started_at: number; expires_at: number; ended_job_id?: string };
  /** End this app's job, if it has one going. */
  end(owner: BrowserJobOwner): { job_id: string } | undefined;
  /** The job this app has going, if any and not yet an hour old. */
  activeFor(owner: BrowserJobOwner): string | undefined;
  /** D-402 slice A5 — end this app's job and keep it for a draft, with the app's labels (checked by
   *  the caller), for a day: the owner answers the draft request when they can. Its calls stop
   *  being gathered. An app keeps one job for a draft: keeping another lets the earlier one go
   *  (`released_job_id`, whose record the caller forgets). */
  keepForDraft(owner: BrowserJobOwner, labels: BrowserJobLabels):
    { job_id: string; expires_at: number; released_job_id?: string } | undefined;
  /** The job kept for a draft, when it is this app's and not yet a day old. */
  keptFor(job_id: string, owner: BrowserJobOwner): { labels: BrowserJobLabels; kept_at: number } | undefined;
  /** A draft was made of it. */
  release(job_id: string): void;
}

/** How long a job binds an app's calls. The plan it gathers is held for an hour too. */
export const BROWSER_JOB_HOLD_MS = 60 * 60_000;
/** D-402 slice A5 — how long a job kept for its draft waits for the owner to answer the request. */
export const BROWSER_JOB_DRAFT_HOLD_MS = 24 * 60 * 60_000;

/** The recorder's session for a job: each job is a session of its own, whose one turn is the job. */
export const browserJobSession = (job_id: string): string => `job:${job_id}`;

const keyOf = (owner: BrowserJobOwner): string => `${owner.mcp_token_id}\u0000${owner.agent_id}`;

export const createBrowserJobRegistry = (options: {
  now?: () => number; holdMs?: number; draftHoldMs?: number; newId?: () => string;
} = {}): BrowserJobRegistry => {
  const now = options.now ?? Date.now;
  const holdMs = options.holdMs ?? BROWSER_JOB_HOLD_MS;
  const draftHoldMs = options.draftHoldMs ?? BROWSER_JOB_DRAFT_HOLD_MS;
  const newId = options.newId ?? randomUUID;
  const jobs = new Map<string, { job_id: string; started_at: number }>();
  /** Jobs kept for a draft, by job id: one per app. */
  const kept = new Map<string, { key: string; labels: BrowserJobLabels; kept_at: number }>();
  const keptLive = (job_id: string) => {
    const job = kept.get(job_id);
    if (job === undefined) return undefined;
    if (now() - job.kept_at >= draftHoldMs) { kept.delete(job_id); return undefined; }
    return job;
  };
  const live = (key: string): { job_id: string; started_at: number } | undefined => {
    const job = jobs.get(key);
    if (job === undefined) return undefined;
    if (now() - job.started_at >= holdMs) { jobs.delete(key); return undefined; }
    return job;
  };
  return {
    start(owner) {
      const key = keyOf(owner);
      const previous = live(key);
      const started_at = now();
      const job_id = newId();
      jobs.set(key, { job_id, started_at });
      return { job_id, started_at, expires_at: started_at + holdMs,
        ...(previous !== undefined ? { ended_job_id: previous.job_id } : {}) };
    },
    end(owner) {
      const key = keyOf(owner);
      const job = live(key);
      jobs.delete(key);
      return job === undefined ? undefined : { job_id: job.job_id };
    },
    activeFor(owner) {
      return live(keyOf(owner))?.job_id;
    },
    keepForDraft(owner, labels) {
      const key = keyOf(owner);
      const job = live(key);
      if (job === undefined) return undefined;
      jobs.delete(key);
      let released_job_id: string | undefined;
      for (const [id, other] of kept) if (other.key === key) { kept.delete(id); released_job_id = id; }
      const kept_at = now();
      kept.set(job.job_id, { key, labels, kept_at });
      return { job_id: job.job_id, expires_at: kept_at + draftHoldMs,
        ...(released_job_id !== undefined ? { released_job_id } : {}) };
    },
    keptFor(job_id, owner) {
      const job = keptLive(job_id);
      return job === undefined || job.key !== keyOf(owner) ? undefined : { labels: job.labels, kept_at: job.kept_at };
    },
    release(job_id) {
      kept.delete(job_id);
    },
  };
};

/** The process's registry, as the recorder is the process's: one server, one owner. */
export const browserJobs: BrowserJobRegistry = createBrowserJobRegistry();
