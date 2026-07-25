/** D-130 Phase 2 — Salesforce reconciler registration manifest.
 *
 *  Single source of truth for which Salesforce reconcilers exist + how
 *  the boot wire (`bin.ts`) registers + per-connection task-binds them.
 *
 *  P2 ships one reconciler (`salesforce.opportunity`); P3 stacks
 *  contact, P4 stacks account. D-139 P1b adds the engagement
 *  substrate (task / event / email_message / voice_call OR
 *  call_history + 3 relationship objects); engagement reconcilers
 *  + their webhook processors are exported via
 *  `buildSalesforceEngagementReconcilers`. D-184 folds the engagement
 *  reconcilers into the SAME reconciler array as the CRM trio at boot,
 *  so they ride the standard housekeeping reconciliation cycle (the
 *  `reconciler-runonce` stopgap is retired). The CRM trio
 *  `buildSalesforceReconcilers` still returns only Opportunity /
 *  Contact / Account.
 *
 *  Spec: D-130 § A.5; D-139 § P1b;
 *  D-184. */

import type {
  SalesforceEngagementEntityName,
  SalesforceRelationshipEntityName,
} from '@recued/contracts';
import type { VendorReconciler } from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  SalesforceAccountReconciler,
  type SalesforceAccountReconcilerDeps,
} from './account-reconciler.js';
import {
  SalesforceContactReconciler,
  type SalesforceContactReconcilerDeps,
} from './contact-reconciler.js';
import {
  SalesforceOpportunityReconciler,
  type SalesforceOpportunityReconcilerDeps,
} from './opportunity-reconciler.js';
import {
  buildSalesforceWebhookProcessor,
  createInMemoryReplayIdTracker,
  type SalesforceReplayIdTracker,
} from './webhook-processor.js';
import { buildSalesforceEngagementWebhookProcessor } from './engagement-webhook-processor.js';
import {
  SalesforceTaskEngagementReconciler,
  type SalesforceTaskEngagementReconcilerDeps,
} from './task-engagement-reconciler.js';
import {
  SalesforceEventEngagementReconciler,
  type SalesforceEventEngagementReconcilerDeps,
} from './event-engagement-reconciler.js';
import {
  SalesforceEmailMessageEngagementReconciler,
  type SalesforceEmailMessageEngagementReconcilerDeps,
} from './email-message-engagement-reconciler.js';
import {
  SalesforceCallEngagementReconciler,
  type SalesforceCallEngagementReconcilerDeps,
} from './call-engagement-reconciler.js';
import {
  SalesforceTaskRelationReconciler,
  SalesforceEventRelationReconciler,
  SalesforceEmailMessageRelationReconciler,
  type RelationReconcilerDeps,
} from './relationship-reconcilers.js';
import type { EngagementStore } from '../../storage/engagement-store.js';

/** Construction-time deps shared across every Salesforce reconciler.
 *  P2 shipped `opportunity`; P3 stacked `contact`; P4 closed the Sales
 *  Cloud trio with `account`. Each entry passes the search-helper deps
 *  through plus an optional `now()` override; the boot wire shares the
 *  same `refreshApiConnectionAuth` refresh hook across reconcilers. */
export interface BuildSalesforceReconcilersInput {
  opportunity: SalesforceOpportunityReconcilerDeps;
  contact: SalesforceContactReconcilerDeps;
  account: SalesforceAccountReconcilerDeps;
  /** D-130 P5 — optional replayId tracker for the CometD webhook
   *  processors. The boot wire constructs one in-memory instance
   *  shared across the trio (so reconnect-with-replayId resume
   *  works across the entity set). When omitted, the registration
   *  helper allocates a fresh tracker per call — fine for tests, not
   *  what production wants (each call would reset replay state). */
  replayIdTracker?: SalesforceReplayIdTracker;
}

/** D-130 P5 — construct every Salesforce reconciler the server boots
 *  with, with their CometD webhook processors wired in. Insertion
 *  order is the registration order: `[opportunity, contact, account]`
 *  — closes the Sales Cloud trio. Marketing / Service Cloud entities
 *  are post-launch.
 *
 *  Each reconciler instance carries a `webhookProcessor` reference
 *  pointing at a per-entity `SalesforceWebhookProcessor` sharing one
 *  replayId tracker across the trio. The actual CometD long-poll
 *  client + PushTopic auto-creation lifecycle live in the boot wire
 *  (`bin.ts`) and the dedicated subscriber module (P5.2 follow-up). */
export const buildSalesforceReconcilers = (
  input: BuildSalesforceReconcilersInput,
): ReadonlyArray<VendorReconciler> => {
  const tracker = input.replayIdTracker ?? createInMemoryReplayIdTracker();
  return [
    new SalesforceOpportunityReconciler({
      ...input.opportunity,
      webhookProcessor: buildSalesforceWebhookProcessor({
        entity: 'opportunity',
        replayIdTracker: tracker,
      }),
    }),
    new SalesforceContactReconciler({
      ...input.contact,
      webhookProcessor: buildSalesforceWebhookProcessor({
        entity: 'contact',
        replayIdTracker: tracker,
      }),
    }),
    new SalesforceAccountReconciler({
      ...input.account,
      webhookProcessor: buildSalesforceWebhookProcessor({
        entity: 'account',
        replayIdTracker: tracker,
      }),
    }),
  ];
};

// ────────────────────────────────────────────────────────────────
// D-139 P1b — Engagement reconcilers (production wiring lands at P1c)
// ────────────────────────────────────────────────────────────────

/** D-139 P1b — input shape for the engagement-substrate constructor.
 *  Each entry passes the search-helper deps + EngagementStore +
 *  authorship deps + identity-resolution callbacks through; boot wire
 *  shares one tracker across the engagement webhook-processor set. */
export interface BuildSalesforceEngagementReconcilersInput {
  task: SalesforceTaskEngagementReconcilerDeps;
  event: SalesforceEventEngagementReconcilerDeps;
  email_message: SalesforceEmailMessageEngagementReconcilerDeps;
  /** Caller picks `voice_call` or `call_history` per the dual-schema
   *  probe outcome (Pass-5 R5.11). When neither is queryable on the
   *  org, omit and the substrate falls back to mail/calendar twins
   *  for engagement evidence. */
  call?:
    | { entity: 'voice_call'; deps: SalesforceCallEngagementReconcilerDeps }
    | { entity: 'call_history'; deps: SalesforceCallEngagementReconcilerDeps };
  /** Relationship-reconciler deps — same shape across the trio. P1c
   *  may bind these conditionally per the per-entity probe results. */
  task_relation?: RelationReconcilerDeps;
  event_relation?: RelationReconcilerDeps;
  email_message_relation?: RelationReconcilerDeps;
  /** Shared replayId tracker — same instance the CRM trio uses so the
   *  CometD subscriber can resume cleanly across the full entity set
   *  on reconnect. */
  replayIdTracker?: SalesforceReplayIdTracker;
}

export interface SalesforceEngagementSubstrate {
  task: SalesforceTaskEngagementReconciler;
  event: SalesforceEventEngagementReconciler;
  email_message: SalesforceEmailMessageEngagementReconciler;
  call?: SalesforceCallEngagementReconciler;
  task_relation?: SalesforceTaskRelationReconciler;
  event_relation?: SalesforceEventRelationReconciler;
  email_message_relation?: SalesforceEmailMessageRelationReconciler;
  /** Engagement webhook processors keyed by entity. The CometD funnel
   *  (P1c-driven wiring) dispatches incoming events to the matching
   *  processor by channel discriminator. */
  webhookProcessors: ReadonlyMap<
    SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
    ReturnType<typeof buildSalesforceEngagementWebhookProcessor>
  >;
}

/** D-139 P1b — construct the Salesforce engagement substrate
 *  (reconcilers + webhook processors) per the per-connection
 *  capability set. Returns the substrate by entity name. D-184 wires
 *  the task / event / email_message reconcilers into the shared
 *  reconciler array at boot so they ride the housekeeping cycle; the
 *  dual-schema call entity binds lazily per connection via the
 *  reprobe hook.
 *
 *  This builder is the single wire-point boot uses to thread the
 *  engagement substrate into production. It mirrors the shape of
 *  `buildSalesforceReconcilers` for the CRM trio. */
export const buildSalesforceEngagementReconcilers = (
  input: BuildSalesforceEngagementReconcilersInput,
  engagementStore: EngagementStore,
): SalesforceEngagementSubstrate => {
  void engagementStore; // EngagementStore is threaded through deps; reserved for future cross-reconciler coordination.
  const tracker = input.replayIdTracker ?? createInMemoryReplayIdTracker();
  const wp = (
    entity: SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
  ): ReturnType<typeof buildSalesforceEngagementWebhookProcessor> =>
    buildSalesforceEngagementWebhookProcessor({
      entity,
      replayIdTracker: tracker,
      engagementStore: input.task.engagementStore,
    });

  const webhookProcessors = new Map<
    SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
    ReturnType<typeof buildSalesforceEngagementWebhookProcessor>
  >();
  webhookProcessors.set('task', wp('task'));
  webhookProcessors.set('event', wp('event'));
  webhookProcessors.set('email_message', wp('email_message'));
  if (input.call !== undefined) {
    webhookProcessors.set(input.call.entity, wp(input.call.entity));
  }
  if (input.task_relation !== undefined) {
    webhookProcessors.set('task_relation', wp('task_relation'));
  }
  if (input.event_relation !== undefined) {
    webhookProcessors.set('event_relation', wp('event_relation'));
  }
  if (input.email_message_relation !== undefined) {
    webhookProcessors.set(
      'email_message_relation',
      wp('email_message_relation'),
    );
  }

  const out: SalesforceEngagementSubstrate = {
    task: new SalesforceTaskEngagementReconciler({
      ...input.task,
      webhookProcessor: webhookProcessors.get('task'),
    }),
    event: new SalesforceEventEngagementReconciler({
      ...input.event,
      webhookProcessor: webhookProcessors.get('event'),
    }),
    email_message: new SalesforceEmailMessageEngagementReconciler({
      ...input.email_message,
      webhookProcessor: webhookProcessors.get('email_message'),
    }),
    webhookProcessors,
  };
  if (input.call !== undefined) {
    out.call = new SalesforceCallEngagementReconciler({
      ...input.call.deps,
      callEntity: input.call.entity,
      webhookProcessor: webhookProcessors.get(input.call.entity),
    });
  }
  if (input.task_relation !== undefined) {
    out.task_relation = new SalesforceTaskRelationReconciler(input.task_relation);
  }
  if (input.event_relation !== undefined) {
    out.event_relation = new SalesforceEventRelationReconciler(
      input.event_relation,
    );
  }
  if (input.email_message_relation !== undefined) {
    out.email_message_relation = new SalesforceEmailMessageRelationReconciler(
      input.email_message_relation,
    );
  }
  return out;
};
