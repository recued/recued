/** D-145 PB15 — privacy hard-fail runtime guard.
 *
 *  Per § B.15.9 + § C.3.6. Substrate-side validator that scans every
 *  `ContextItem` in a plan's `included_context` for invariant
 *  violations BEFORE the AI packet is composed. Compile-time guard
 *  (`ContextContentClass × persist_policy` matrix) catches most cases;
 *  the runtime guard is the backstop for parsed-JSON / object-mutation
 *  / peer-MCP-input paths that bypass the type system.
 *
 *  Three closed-list violation kinds (per § B.15.9):
 *
 *    1. `social_content_persist` — `social_raw_body` content_class
 *       with a persist_policy other than `'immediate_use_only'`. The
 *       hardest gate — social DM bodies / private posts must NEVER
 *       reach storage.
 *    2. `mcp_alias_leak` — `contact_alias` content_class entering a
 *       packet whose destination is MCP-bound (`mcp_dispatch: true`
 *       in input). Aliases must be resolved at packet-compose time;
 *       persisting the alias mapping into an MCP-visible packet
 *       leaks peer-graph structure.
 *    3. `standing_instruction_leak` — `standing_instruction` content
 *       reaching the AI packet with `persist_policy: 'persist'`. SI
 *       bodies must always be redacted (only `redacted_payload`
 *       reaches the packet).
 *
 *  A fourth catch-all (`context_leak`) covers unknown / future cases
 *  where the validator catches a content_class with an admissible-set
 *  policy mismatch that the type system should have rejected at
 *  compile time.
 *
 *  Pure function — returns the violation result; caller (orchestration
 *  policy or the engine's pre-AI-packet wiring) decides whether to
 *  halt. The `failure-semantics/index.ts` barrel re-exports the
 *  builder for the matching transparency event.
 *
 *  Spec: § B.15.9 + § C.3.6 + § B.2.3 (content_class × persist_policy
 *  matrix). */

import {
  CONTEXT_CLASS_PERSIST_POLICIES,
  type ContextItem,
  type TransparencyPrivacyViolationClass,
} from '@recued/contracts';

export interface PrivacyGuardInput {
  /** The plan's included_context entries assembled so far. */
  readonly included_context: ReadonlyArray<ContextItem>;
  /** When the destination packet is MCP-bound (peer AI request), the
   *  contact_alias content_class becomes a hard-block. Default
   *  `false` (local AI dispatch). */
  readonly mcp_dispatch?: boolean;
}

export interface PrivacyGuardOk {
  readonly kind: 'ok';
}

export interface PrivacyGuardViolation {
  readonly kind: 'violation';
  readonly violation_class: TransparencyPrivacyViolationClass;
  /** Index of the offending entry in the input array. */
  readonly offending_index: number;
  /** Short audit-clean detail (closed-list discriminator + offending
   *  content_class + persist_policy). Never echoes the entry's
   *  content. */
  readonly detail: string;
}

export type PrivacyGuardResult = PrivacyGuardOk | PrivacyGuardViolation;

const checkSingleItem = (
  item: ContextItem,
  index: number,
  mcp_dispatch: boolean,
): PrivacyGuardViolation | undefined => {
  // 1. social_raw_body MUST be immediate_use_only.
  if (
    item.content_class === 'social_raw_body' &&
    item.persist_policy !== 'immediate_use_only'
  ) {
    return {
      kind: 'violation',
      violation_class: 'social_content_persist',
      offending_index: index,
      detail: `included_context[${index}] content_class='social_raw_body' has persist_policy='${item.persist_policy}' (must be 'immediate_use_only')`,
    };
  }

  // 2. contact_alias MUST NOT enter MCP-bound packets.
  if (item.content_class === 'contact_alias' && mcp_dispatch) {
    return {
      kind: 'violation',
      violation_class: 'mcp_alias_leak',
      offending_index: index,
      detail: `included_context[${index}] content_class='contact_alias' entered MCP-bound packet (alias must resolve at compose time)`,
    };
  }

  // 3. standing_instruction MUST be redacted_only when reaching the
  //    AI packet.
  if (
    item.content_class === 'standing_instruction' &&
    item.persist_policy !== 'redacted_only'
  ) {
    return {
      kind: 'violation',
      violation_class: 'standing_instruction_leak',
      offending_index: index,
      detail: `included_context[${index}] content_class='standing_instruction' has persist_policy='${item.persist_policy}' (must be 'redacted_only')`,
    };
  }

  // 4. Catch-all: any class × policy combination outside the closed
  //    admissible-set matrix. This is the runtime backstop for the
  //    compile-time `CONTEXT_CLASS_PERSIST_POLICIES` validator (§ B.2.3).
  //
  //    Codex P1 fold (2026-05-10): off-list content_class (parsed-JSON
  //    or `as unknown as` mutation paths) must hard-fail HERE because
  //    this function is the pre-AI-packet privacy backstop. Without
  //    the unknown-class check, an unrecognized class slips past the
  //    guard and the plan validator only catches it later at
  //    persistence time — AFTER the AI packet was composed and
  //    potentially dispatched.
  const allowed = CONTEXT_CLASS_PERSIST_POLICIES[item.content_class];
  if (allowed === undefined) {
    return {
      kind: 'violation',
      violation_class: 'context_leak',
      offending_index: index,
      detail: `included_context[${index}] content_class='${String(item.content_class)}' is not in CONTEXT_CONTENT_CLASSES (off-list — runtime backstop tripped)`,
    };
  }
  if (!allowed.includes(item.persist_policy)) {
    return {
      kind: 'violation',
      violation_class: 'context_leak',
      offending_index: index,
      detail: `included_context[${index}] content_class='${item.content_class}' has persist_policy='${item.persist_policy}' (allowed: ${allowed.join(', ')})`,
    };
  }

  return undefined;
};

/** Run the privacy guard. Returns the FIRST violation found (callers
 *  typically halt on the first; the runtime backstop is not exhaustive
 *  reporting). For exhaustive validation use the contracts-side
 *  `validateRecuedPlan` which collects every issue. */
export const checkPrivacyContext = (input: PrivacyGuardInput): PrivacyGuardResult => {
  const mcp_dispatch = input.mcp_dispatch === true;
  for (let i = 0; i < input.included_context.length; i++) {
    const violation = checkSingleItem(input.included_context[i]!, i, mcp_dispatch);
    if (violation !== undefined) return violation;
  }
  return { kind: 'ok' };
};
