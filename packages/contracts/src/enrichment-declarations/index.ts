/** D-145 PA9 — index of all 15 D-145 producer declarations.
 *
 *  Validator at registry load (`D145_PRODUCER_DECLARATIONS`) iterates
 *  this map; missing entries hard-fail load with
 *  `enrichment_declaration_incomplete`. Adding a new producer requires
 *  a new file under this directory + a new entry here + a registry
 *  entry in `enrichment-registry.ts` + a benchmark scenario in C.3
 *  + a producer-version hash bump.
 *
 *  Spec: `docs/d-145-spec.md` § A.7.5. */

import type { EnrichmentDeclaration } from '../enrichment-declaration.js';
import { D145_PRODUCER_TOPICS } from '../enrichment-declaration.js';

import { COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION } from './commitment-followthrough-score.js';
import { COMMITMENT_IMBALANCE_DECLARATION } from './commitment-imbalance.js';
import { OUTBOUND_COMMITMENT_OVERDUE_COUNT_DECLARATION } from './outbound-commitment-overdue-count.js';
import { TASK_COMPLETION_VELOCITY_DECLARATION } from './task-completion-velocity.js';
import { TASK_SIGNAL_DENSITY_PER_THREAD_DECLARATION } from './task-signal-density-per-thread.js';
import { PROJECT_STALL_SIGNAL_DECLARATION } from './project-stall-signal.js';
import { PROJECT_VELOCITY_DECLARATION } from './project-velocity.js';
import { NOTE_RELEVANCE_DECAY_DECLARATION } from './note-relevance-decay.js';
import { OPEN_LOOP_PRESSURE_DECLARATION } from './open-loop-pressure.js';
import { COMMITMENT_RELIABILITY_BAND_DECLARATION } from './commitment-reliability-band.js';
import { PREFERRED_CHANNEL_BY_CONTACT_DECLARATION } from './preferred-channel-by-contact.js';
import { PROJECT_NEXT_ACTION_GAP_DECLARATION } from './project-next-action-gap.js';
import { TASK_DUPLICATE_CANDIDATE_DECLARATION } from './task-duplicate-candidate.js';
import { SOURCE_FRESHNESS_DEGRADATION_DECLARATION } from './source-freshness-degradation.js';
import { CONTEXT_PACKET_QUALITY_DECLARATION } from './context-packet-quality.js';

/** Closed map of every D-145 producer's declaration. Adding a new
 *  topic requires widening `D145_PRODUCER_TOPICS` + adding an entry
 *  here. The validator gate at registry load iterates the keys and
 *  throws if any topic in `D145_PRODUCER_TOPICS` is missing. */
export const D145_PRODUCER_DECLARATIONS: Readonly<
  Record<string, EnrichmentDeclaration>
> = {
  // Work-entity producers (8) — § A.7.1
  commitment_followthrough_score: COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION,
  commitment_imbalance: COMMITMENT_IMBALANCE_DECLARATION,
  outbound_commitment_overdue_count: OUTBOUND_COMMITMENT_OVERDUE_COUNT_DECLARATION,
  task_completion_velocity: TASK_COMPLETION_VELOCITY_DECLARATION,
  task_signal_density_per_thread: TASK_SIGNAL_DENSITY_PER_THREAD_DECLARATION,
  project_stall_signal: PROJECT_STALL_SIGNAL_DECLARATION,
  project_velocity: PROJECT_VELOCITY_DECLARATION,
  note_relevance_decay: NOTE_RELEVANCE_DECAY_DECLARATION,
  // Engine + reliability producers (8) — § A.7.2
  open_loop_pressure: OPEN_LOOP_PRESSURE_DECLARATION,
  commitment_reliability_band: COMMITMENT_RELIABILITY_BAND_DECLARATION,
  preferred_channel_by_contact: PREFERRED_CHANNEL_BY_CONTACT_DECLARATION,
  project_next_action_gap: PROJECT_NEXT_ACTION_GAP_DECLARATION,
  task_duplicate_candidate: TASK_DUPLICATE_CANDIDATE_DECLARATION,
  source_freshness_degradation: SOURCE_FRESHNESS_DEGRADATION_DECLARATION,
  context_packet_quality: CONTEXT_PACKET_QUALITY_DECLARATION,
};

export {
  COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION,
  COMMITMENT_IMBALANCE_DECLARATION,
  OUTBOUND_COMMITMENT_OVERDUE_COUNT_DECLARATION,
  TASK_COMPLETION_VELOCITY_DECLARATION,
  TASK_SIGNAL_DENSITY_PER_THREAD_DECLARATION,
  PROJECT_STALL_SIGNAL_DECLARATION,
  PROJECT_VELOCITY_DECLARATION,
  NOTE_RELEVANCE_DECAY_DECLARATION,
  OPEN_LOOP_PRESSURE_DECLARATION,
  COMMITMENT_RELIABILITY_BAND_DECLARATION,
  PREFERRED_CHANNEL_BY_CONTACT_DECLARATION,
  PROJECT_NEXT_ACTION_GAP_DECLARATION,
  TASK_DUPLICATE_CANDIDATE_DECLARATION,
  SOURCE_FRESHNESS_DEGRADATION_DECLARATION,
  CONTEXT_PACKET_QUALITY_DECLARATION,
};

/** Spec § A.7.5 — runs at registry load. Iterates every D-145 topic
 *  + validates its declaration (presence + closed-list discipline +
 *  per-class consistency) AND asserts every D-145 topic has a
 *  declaration entry on `D145_PRODUCER_DECLARATIONS`.
 *
 *  Returns array of issue strings; empty when every producer's
 *  declaration is complete + consistent. Substrate-side caller
 *  (`assertD145ProducerDeclarations`) throws on the first issue with
 *  `enrichment_declaration_incomplete`. */
import { validateEnrichmentDeclaration } from '../enrichment-declaration.js';

export const validateD145ProducerDeclarations = (): string[] => {
  const issues: string[] = [];
  for (const topic of D145_PRODUCER_TOPICS) {
    const decl = D145_PRODUCER_DECLARATIONS[topic];
    if (!decl) {
      issues.push(
        `enrichment_declaration_incomplete: D-145 producer '${topic}' has no declaration in D145_PRODUCER_DECLARATIONS`,
      );
      continue;
    }
    if (decl.topic !== topic) {
      issues.push(
        `enrichment_declaration_incomplete: D-145 producer '${topic}' declaration carries topic '${decl.topic}' (key/topic mismatch)`,
      );
    }
    for (const issue of validateEnrichmentDeclaration(decl)) {
      issues.push(`topic '${topic}': ${issue}`);
    }
  }
  // Detect declarations without a matching `D145_PRODUCER_TOPICS`
  // entry — a registry entry shape mistake (e.g. typo'd topic).
  for (const key of Object.keys(D145_PRODUCER_DECLARATIONS)) {
    if (!(D145_PRODUCER_TOPICS as ReadonlyArray<string>).includes(key)) {
      issues.push(
        `enrichment_declaration_incomplete: D145_PRODUCER_DECLARATIONS has key '${key}' not in D145_PRODUCER_TOPICS`,
      );
    }
  }
  return issues;
};

/** Substrate-side wrapper. Throws on the first issue. Called from
 *  the registry-load validator alongside `assertEnrichmentTrustDefaults`
 *  + `assertEnrichmentLifecycleDefaults` so PA9 declaration mistakes
 *  surface before any cycle runs. */
export const assertD145ProducerDeclarations = (): void => {
  const issues = validateD145ProducerDeclarations();
  if (issues.length > 0) {
    throw new Error(issues[0]!);
  }
};
