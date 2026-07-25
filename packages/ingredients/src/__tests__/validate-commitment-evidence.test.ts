import { describe, expect, it } from 'vitest';

import type { IngredientManifest } from '@recued/contracts';
import { validateIngredient } from '@recued/ingredients';

type Issue = ReturnType<typeof validateIngredient>['issues'][number];
type MutableManifest =
  Omit<IngredientManifest, 'commitment_evidence' | 'operations' | 'operation_groups'> & {
  operations: Record<string, Record<string, unknown>>;
  operation_groups: Record<string, Record<string, unknown>>;
  commitment_evidence?: unknown;
};
type CommitmentEvidenceDeclarationLiteral = {
  kind: unknown;
  source: { crm_alias?: unknown; field?: unknown };
  direction: unknown;
  counterparty: { resolve?: unknown };
  statement: { template?: unknown };
  capture_on: unknown;
  approval: unknown;
};

const READ_OP = 'deal.read';
const READ_GROUP = 'recued-core/hubspot.deals.read';

const KERNEL_COMMITMENT_EVIDENCE_DECLARATION: CommitmentEvidenceDeclarationLiteral = {
  kind: 'crm_field',
  source: { crm_alias: 'deal', field: 'next_step' },
  direction: 'outbound',
  counterparty: { resolve: 'record_contact_edges' },
  statement: { template: '{{field_value}}' },
  capture_on: ['value_set', 'value_changed'],
  approval: 'required',
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const baseManifest = (): MutableManifest => ({
  slug: 'hubspot-commitment-evidence-test',
  name: 'HubSpot Commitment Evidence Test',
  description: 'D-192 F1 commitment_evidence validation fixture.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['hubspot', 'crm', 'catalog'],
  input: {
    operation: null,
    args: null,
  },
  output: {
    result: 'result',
  },
  operations: {
    [READ_OP]: {
      operation_id: 'recued-core/hubspot.deal.read',
      risk_tier: 'read',
      groups: [READ_GROUP],
    },
  },
  operation_groups: {
    [READ_GROUP]: {
      group_id: READ_GROUP,
      display_name: 'Deals read',
      description: 'Read HubSpot deals.',
      operations: [READ_OP],
      risk_floor: 'read',
      grant_default: 'on_after_connect',
      upgrade_behavior: 'new_operations_off',
    },
  },
});

const manifestWithDeclaration = (
  mutate?: (declaration: CommitmentEvidenceDeclarationLiteral, manifest: MutableManifest) => void,
): MutableManifest => {
  const manifest = baseManifest();
  const declaration = clone(KERNEL_COMMITMENT_EVIDENCE_DECLARATION);
  mutate?.(declaration, manifest);
  manifest.commitment_evidence = [declaration];
  return manifest;
};

const commitmentEvidenceIssues = (manifest: unknown): Issue[] =>
  validateIngredient(manifest).issues.filter((issue) =>
    issue.code.startsWith('COMMITMENT_EVIDENCE_'));

const expectCommitmentEvidenceCodes = (manifest: unknown, codes: readonly string[]): void => {
  expect(commitmentEvidenceIssues(manifest).map((issue) => issue.code)).toEqual(codes);
};

describe('validateIngredient commitment_evidence declarations', () => {
  it('accepts the kernel CRM next_step commitment_evidence declaration literal', () => {
    const manifest = manifestWithDeclaration();
    const result = validateIngredient(manifest);

    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expectCommitmentEvidenceCodes(manifest, []);
  });

  it.each([
    {
      // `mail` is a live evidence ENTRY kind (the email flagship) but is
      // produced by the kernel extraction engine, never pack-declared —
      // a manifest declaring it is rejected as non-declarable, NOT
      // reserved.
      name: 'non-declarable mail kind',
      code: 'COMMITMENT_EVIDENCE_KIND_NOT_DECLARABLE',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.kind = 'mail'; },
    },
    {
      // `message` graduated with the messenger flagship — a live entry
      // kind produced by the kernel tag/mention/content matcher, so it is
      // non-declarable (like `mail`), no longer reserved.
      name: 'non-declarable message kind',
      code: 'COMMITMENT_EVIDENCE_KIND_NOT_DECLARABLE',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.kind = 'message'; },
    },
    {
      // `file` is a first-class SOURCE entity, NOT an evidence kind
      // (F-1=A superseded, kinds-taxonomy § 3b) — a manifest that declares
      // file-evidence is rejected as invalid, like any unknown kind.
      name: 'file kind is not evidence (SOURCE entity)',
      code: 'COMMITMENT_EVIDENCE_KIND_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.kind = 'file'; },
    },
    {
      name: 'unknown kind',
      code: 'COMMITMENT_EVIDENCE_KIND_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.kind = 'bogus'; },
    },
    {
      name: 'unknown crm_alias',
      code: 'COMMITMENT_EVIDENCE_SOURCE_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.source.crm_alias = 'bogus'; },
    },
    {
      name: 'unknown source field',
      code: 'COMMITMENT_EVIDENCE_SOURCE_FIELD_UNKNOWN',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.source.field = 'not_a_field'; },
    },
    {
      name: 'bad direction',
      code: 'COMMITMENT_EVIDENCE_DIRECTION_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.direction = 'sideways'; },
    },
    {
      name: 'bad counterparty resolver',
      code: 'COMMITMENT_EVIDENCE_COUNTERPARTY_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.counterparty.resolve = 'x'; },
    },
    {
      // `mail_thread_contact` is a valid RESOLVED strategy (the email
      // flagship's E1 seam) but KERNEL-only — a pack cannot declare it,
      // exactly as `mail` is a live entry kind that is not pack-declarable.
      name: 'kernel-only mail_thread_contact resolver',
      code: 'COMMITMENT_EVIDENCE_COUNTERPARTY_NOT_DECLARABLE',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => {
        d.counterparty.resolve = 'mail_thread_contact';
      },
    },
    {
      // `messenger_sender_contact` is a valid RESOLVED strategy (the
      // messenger flagship's M3 seam) but KERNEL-only — a pack cannot
      // declare it, exactly like `mail_thread_contact`.
      name: 'kernel-only messenger_sender_contact resolver',
      code: 'COMMITMENT_EVIDENCE_COUNTERPARTY_NOT_DECLARABLE',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => {
        d.counterparty.resolve = 'messenger_sender_contact';
      },
    },
    {
      name: 'foreign statement placeholder',
      code: 'COMMITMENT_EVIDENCE_STATEMENT_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => {
        d.statement.template = '{{field_value}} {{sneaky}}';
      },
    },
    {
      name: 'foreign statement placeholder with newline',
      code: 'COMMITMENT_EVIDENCE_STATEMENT_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => {
        d.statement.template = '{{field_value}} {{sne\naky}}';
      },
    },
    {
      name: 'overlong statement template',
      code: 'COMMITMENT_EVIDENCE_STATEMENT_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => {
        d.statement.template = `{{field_value}} ${'x'.repeat(201)}`;
      },
    },
    {
      name: 'empty capture_on',
      code: 'COMMITMENT_EVIDENCE_CAPTURE_ON_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.capture_on = []; },
    },
    {
      name: 'unknown capture_on entry',
      code: 'COMMITMENT_EVIDENCE_CAPTURE_ON_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.capture_on = ['bogus']; },
    },
    {
      name: 'bad approval literal',
      code: 'COMMITMENT_EVIDENCE_APPROVAL_INVALID',
      mutate: (d: CommitmentEvidenceDeclarationLiteral): void => { d.approval = 'ask'; },
    },
  ])('rejects $name with $code', ({ code, mutate }) => {
    expectCommitmentEvidenceCodes(manifestWithDeclaration(mutate), [code]);
  });

  it('rejects an empty commitment_evidence array', () => {
    const manifest = baseManifest();
    manifest.commitment_evidence = [];

    expectCommitmentEvidenceCodes(manifest, ['COMMITMENT_EVIDENCE_INVALID']);
  });

  it('omits commitment_evidence cleanly without COMMITMENT_EVIDENCE_* issues', () => {
    expectCommitmentEvidenceCodes(baseManifest(), []);
  });
});
