/** D-139 P1c — HubSpot engagement reconciler registration factory.
 *
 *  Parallel to `buildSalesforceEngagementReconcilers` (P1b) — single
 *  wire-point for `bin.ts` to construct + thread the per-entity
 *  HubSpot engagement reconcilers (email / meeting / note / call /
 *  task) into production. Pre-P1c the engagement reconciler classes
 *  existed but were exercised exclusively by tests (carry-forward 1
 *  from P1a.1.1 + P1a.2 review folds — "P1 #2 production wire-up via
 *  P1c bin.ts").
 *
 *  The factory does NOT construct webhook processors itself — those
 *  are built per-entity via `build<Entity>EngagementWebhookProcessor`
 *  in the existing webhook-processor modules and threaded through
 *  the reconciler deps. P1c's bin.ts wiring is responsible for
 *  composing both halves before passing into this factory.
 *
 *  Spec: D-139 § A.1, § A.6, § P1c. */

import {
  HubSpotEmailEngagementReconciler,
  type HubSpotEmailEngagementReconcilerDeps,
} from './email-engagement-reconciler.js';
import {
  HubSpotMeetingEngagementReconciler,
  type HubSpotMeetingEngagementReconcilerDeps,
} from './meeting-engagement-reconciler.js';
import {
  HubSpotNoteEngagementReconciler,
  type HubSpotNoteEngagementReconcilerDeps,
} from './note-engagement-reconciler.js';
import {
  HubSpotCallEngagementReconciler,
  type HubSpotCallEngagementReconcilerDeps,
} from './call-engagement-reconciler.js';
import {
  HubSpotTaskEngagementReconciler,
  type HubSpotTaskEngagementReconcilerDeps,
} from './task-engagement-reconciler.js';

// ────────────────────────────────────────────────────────────────
// Substrate shape
// ────────────────────────────────────────────────────────────────

export interface BuildHubSpotEngagementReconcilersInput {
  email: HubSpotEmailEngagementReconcilerDeps;
  meeting: HubSpotMeetingEngagementReconcilerDeps;
  note: HubSpotNoteEngagementReconcilerDeps;
  call: HubSpotCallEngagementReconcilerDeps;
  task: HubSpotTaskEngagementReconcilerDeps;
}

export interface HubSpotEngagementSubstrate {
  email: HubSpotEmailEngagementReconciler;
  meeting: HubSpotMeetingEngagementReconciler;
  note: HubSpotNoteEngagementReconciler;
  call: HubSpotCallEngagementReconciler;
  task: HubSpotTaskEngagementReconciler;
}

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/** D-139 P1c — construct the HubSpot engagement substrate (per-entity
 *  reconcilers). Mirrors `buildSalesforceEngagementReconcilers` —
 *  single wire-point through boot; D-184 folds the returned reconcilers
 *  into the shared reconciler array so they ride the housekeeping
 *  reconciliation cycle (the runonce stopgap is retired). */
export const buildHubSpotEngagementReconcilers = (
  input: BuildHubSpotEngagementReconcilersInput,
): HubSpotEngagementSubstrate => ({
  email: new HubSpotEmailEngagementReconciler(input.email),
  meeting: new HubSpotMeetingEngagementReconciler(input.meeting),
  note: new HubSpotNoteEngagementReconciler(input.note),
  call: new HubSpotCallEngagementReconciler(input.call),
  task: new HubSpotTaskEngagementReconciler(input.task),
});
