/** D-192 F1 — fail-closed shape validation for the manifest's
 *  `commitment_evidence` declarations (spec § Commitment evidence (F1)
 *  § Declaration shape).
 *
 *  Section validator folded into `validateIngredient` — same `add`
 *  reporter contract as `validateWorkEntitySources`. Everything here
 *  is manifest-internal (registry lookups only, no document, no IO),
 *  so it runs identically at local install and marketplace publish.
 *
 *  The gates (the P1 idiom, all fail-closed):
 *   - pack-DECLARABLE `kind` (v1: `crm_field` only). `mail` and `message`
 *     are live evidence ENTRY kinds but NOT pack-declarable — their
 *     producers are the kernel (the email-flagship extraction engine; the
 *     messenger tag/mention/content matcher), so a manifest that declares
 *     either is rejected with a kernel-only pointer. The RESERVED lane is
 *     empty in v1 (`file` is a SOURCE entity, not evidence — §3b); any
 *     other `kind` (incl. `file`) is rejected as invalid;
 *   - the `(crm_alias, field)` pair must exist in the D-190 canonical
 *     vocabulary for at least one vendor (`canonicalCrmFieldSet`);
 *   - `direction` ∈ the D-145 enum;
 *   - `counterparty.resolve` ∈ the closed resolver list;
 *   - `statement.template` non-empty, bounded, and referencing ONLY
 *     the single `{{field_value}}` placeholder (templates are a
 *     convention, not an expression language);
 *   - `capture_on` a non-empty subset of the closed event list;
 *   - `approval` must be the LITERAL `'required'` (invariant 3 pinned
 *     structurally — the validator rejects anything else in v1).
 *
 *  v1 runtime consumes the KERNEL declaration only — a pack-declared
 *  entry that passes here stays INERT until the decomposer
 *  pass-through lands (deliberate: validate early so authored packs
 *  are forward-compatible, never half-run). */

import {
  COMMITMENT_DIRECTION_SET,
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_SET,
  COMMITMENT_EVIDENCE_COUNTERPARTY_RESOLVERS,
  COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVERS,
  COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVER_SET,
  COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET,
  COMMITMENT_EVIDENCE_KIND_SET,
  COMMITMENT_EVIDENCE_RESERVED_KINDS,
  COMMITMENT_EVIDENCE_STATEMENT_TEMPLATE_MAX_CHARS,
  COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER,
  CRM_ALIAS_VALUES,
  canonicalCrmFieldSet,
  type CommitmentDirection,
  type CommitmentEvidenceKind,
  type CrmAlias,
} from '@recued/contracts';
import type { ValidationSeverity } from './validate.js';

type AddFn = (severity: ValidationSeverity, code: string, path: string, message: string) => void;

const isObjectRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const RESERVED_KIND_SET: ReadonlySet<string> = new Set(COMMITMENT_EVIDENCE_RESERVED_KINDS);
const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);

/** Validate `m.commitment_evidence` when present. No-op when the field
 *  is absent — the contract is opt-in per catalog. */
export const validateCommitmentEvidence = (m: Record<string, unknown>, add: AddFn): void => {
  const raw = m.commitment_evidence;
  if (raw === undefined) return;

  if (!Array.isArray(raw)) {
    add('error', 'COMMITMENT_EVIDENCE_INVALID', 'commitment_evidence',
      'commitment_evidence must be an array of capture declarations');
    return;
  }
  if (raw.length === 0) {
    add('error', 'COMMITMENT_EVIDENCE_INVALID', 'commitment_evidence',
      'commitment_evidence must not be empty — declare a capture or omit the field');
    return;
  }

  for (let i = 0; i < raw.length; i++) {
    const p = `commitment_evidence[${i}]`;
    const d = raw[i];
    if (!isObjectRecord(d)) {
      add('error', 'COMMITMENT_EVIDENCE_INVALID', p, 'declaration must be an object');
      continue;
    }

    // ── kind — a pack-DECLARABLE family. Three rejection lanes:
    //    RESERVED (empty in v1 — a squat guard for a future reserved
    //    family); a valid ENTRY kind that is NOT pack-declarable (`mail` /
    //    `message` — produced by the kernel, never a manifest field diff) →
    //    kernel-only pointer; anything else (incl. `file`, a SOURCE entity)
    //    → invalid. Only `crm_field` passes at v1. ──
    if (isNonEmptyString(d.kind) && RESERVED_KIND_SET.has(d.kind)) {
      add('error', 'COMMITMENT_EVIDENCE_KIND_RESERVED', `${p}.kind`,
        `'${d.kind}' is a reserved evidence family name — it ships with a `
        + 'later flagship, and a pack cannot squat it before then');
      continue;
    }
    if (
      isNonEmptyString(d.kind)
      && COMMITMENT_EVIDENCE_KIND_SET.has(d.kind as CommitmentEvidenceKind)
      && !COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET.has(d.kind)
    ) {
      add('error', 'COMMITMENT_EVIDENCE_KIND_NOT_DECLARABLE', `${p}.kind`,
        `'${d.kind}' evidence is produced by the kernel extraction engine, not a `
        + 'pack declaration — it cannot be declared in a manifest at v1');
      continue;
    }
    if (!isNonEmptyString(d.kind) || !COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET.has(d.kind)) {
      add('error', 'COMMITMENT_EVIDENCE_KIND_INVALID', `${p}.kind`,
        'kind must be crm_field (v1)');
      continue;
    }

    // ── source — a (crm_alias, field) pair in the D-190 canonical
    //    vocabulary for at least one vendor ──
    const source = isObjectRecord(d.source) ? d.source : undefined;
    if (source === undefined) {
      add('error', 'COMMITMENT_EVIDENCE_SOURCE_INVALID', `${p}.source`,
        'source must be an object ({ crm_alias, field })');
    } else {
      const alias = source.crm_alias;
      if (!isNonEmptyString(alias) || !CRM_ALIAS_SET.has(alias)) {
        add('error', 'COMMITMENT_EVIDENCE_SOURCE_INVALID', `${p}.source.crm_alias`,
          `source.crm_alias must be one of ${CRM_ALIAS_VALUES.join('|')}`);
      } else if (!isNonEmptyString(source.field)) {
        add('error', 'COMMITMENT_EVIDENCE_SOURCE_INVALID', `${p}.source.field`,
          'source.field is required (a canonical CRM field key)');
      } else if (!canonicalCrmFieldSet(alias as CrmAlias).has(source.field)) {
        add('error', 'COMMITMENT_EVIDENCE_SOURCE_FIELD_UNKNOWN', `${p}.source.field`,
          `'${source.field}' is not a canonical '${alias}' field on any registered vendor — `
          + 'capture reads the canonical vocabulary, never raw vendor properties');
      }
    }

    // ── direction (the D-145 enum; the declaration's DEFAULT, owner-
    //    editable at approval) ──
    if (!isNonEmptyString(d.direction) || !COMMITMENT_DIRECTION_SET.has(d.direction as CommitmentDirection)) {
      add('error', 'COMMITMENT_EVIDENCE_DIRECTION_INVALID', `${p}.direction`,
        'direction must be one of outbound|inbound|internal');
    }

    // ── counterparty resolver — the pack-DECLARABLE subset (v1:
    //    `record_contact_edges`). `mail_thread_contact` is a live
    //    resolved strategy but KERNEL-only (the email-flagship extraction
    //    funnel applies it internally, never a manifest field diff) — a
    //    manifest that names it is rejected with a kernel-only pointer,
    //    mirroring the `mail` kind's KIND_NOT_DECLARABLE lane. ──
    const counterparty = isObjectRecord(d.counterparty) ? d.counterparty : undefined;
    const resolve = counterparty !== undefined && isNonEmptyString(counterparty.resolve)
      ? counterparty.resolve
      : undefined;
    if (
      resolve !== undefined
      && (COMMITMENT_EVIDENCE_COUNTERPARTY_RESOLVERS as readonly string[]).includes(resolve)
      && !COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVER_SET.has(resolve)
    ) {
      add('error', 'COMMITMENT_EVIDENCE_COUNTERPARTY_NOT_DECLARABLE', `${p}.counterparty`,
        `counterparty.resolve '${resolve}' is a kernel-only strategy (the email-flagship `
        + 'extraction funnel applies it internally) — a pack cannot declare it at v1');
    } else if (
      resolve === undefined
      || !COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVER_SET.has(resolve)
    ) {
      add('error', 'COMMITMENT_EVIDENCE_COUNTERPARTY_INVALID', `${p}.counterparty`,
        `counterparty.resolve must be one of ${COMMITMENT_EVIDENCE_DECLARABLE_COUNTERPARTY_RESOLVERS.join('|')}`);
    }

    // ── statement template (bounded single-placeholder convention) ──
    const statement = isObjectRecord(d.statement) ? d.statement : undefined;
    if (statement === undefined || !isNonEmptyString(statement.template)) {
      add('error', 'COMMITMENT_EVIDENCE_STATEMENT_INVALID', `${p}.statement`,
        'statement.template is required (non-empty string)');
    } else {
      if (statement.template.length > COMMITMENT_EVIDENCE_STATEMENT_TEMPLATE_MAX_CHARS) {
        add('error', 'COMMITMENT_EVIDENCE_STATEMENT_INVALID', `${p}.statement.template`,
          `statement.template must be ≤ ${COMMITMENT_EVIDENCE_STATEMENT_TEMPLATE_MAX_CHARS} chars`);
      }
      // Templates reference ONLY the single {{field_value}} placeholder —
      // any other {{…}} is an expression-language smuggle attempt.
      // [\s\S] (not `.`) so a NEWLINE inside the braces can't evade the
      // match (codex LOW — the dotall gap).
      const foreignRefs = statement.template
        .replaceAll(COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER, '')
        .match(/\{\{[\s\S]*?\}\}/);
      if (foreignRefs !== null) {
        add('error', 'COMMITMENT_EVIDENCE_STATEMENT_INVALID', `${p}.statement.template`,
          `statement.template may reference only ${COMMITMENT_EVIDENCE_TEMPLATE_PLACEHOLDER} — `
          + `found '${foreignRefs[0]}'`);
      }
    }

    // ── capture_on (non-empty subset of the closed event list) ──
    if (!Array.isArray(d.capture_on) || d.capture_on.length === 0) {
      add('error', 'COMMITMENT_EVIDENCE_CAPTURE_ON_INVALID', `${p}.capture_on`,
        'capture_on must be a non-empty array of value_set|value_changed');
    } else {
      for (let j = 0; j < d.capture_on.length; j++) {
        const ev = d.capture_on[j];
        if (!isNonEmptyString(ev) || !COMMITMENT_EVIDENCE_CAPTURE_EVENT_SET.has(ev)) {
          add('error', 'COMMITMENT_EVIDENCE_CAPTURE_ON_INVALID', `${p}.capture_on[${j}]`,
            'capture_on entries must be value_set|value_changed');
        }
      }
    }

    // ── approval (LITERAL 'required' — invariant 3, structurally) ──
    if (d.approval !== 'required') {
      add('error', 'COMMITMENT_EVIDENCE_APPROVAL_INVALID', `${p}.approval`,
        "approval must be the literal 'required' — a capture is a proposal until "
        + 'the owner confirms, never auto-from-AI (v1 rejects anything else)');
    }
  }
};
