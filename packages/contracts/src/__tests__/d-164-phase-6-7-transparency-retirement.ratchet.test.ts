/** D-164 P6.7 — transparency-stream Stage 1 / Stage 2 retirement ratchet.
 *
 *  Pins:
 *    - `TRANSPARENCY_EVENT_KINDS` does NOT carry `engine.stage1_classified`,
 *      `engine.context_filtered`, `engine.stage2_composed`, or
 *      `engine.stage1_fallback`.
 *    - `TRANSPARENCY_EVENT_KINDS` DOES carry the two replacement kinds
 *      `engine.gate_short_circuit` + `engine.catalog_assembled`.
 *    - `TRANSPARENCY_EVENT_CLASSES` retires the `'two_stage'` class
 *      (length is now 4); `TRANSPARENCY_AUDIT_SOURCES` mirrors that
 *      shape; `DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes`
 *      drops the matching default entry.
 *    - `engine.budget_exceeded` reclassifies into `'failure'`.
 *    - `validateTransparencyEvent` rejects the four retired kinds as
 *      `unknown_kind` and accepts the two new kinds with proper
 *      per-payload field gates.
 *    - `TRANSPARENCY_TEMPLATES_EN` carries templates for the two new
 *      kinds; defaults to `'hidden'` on both.
 *    - `ContextSelectionTrace` shape carries the catalog-assembly
 *      snapshot fields (`catalog_section_counts`,
 *      `catalog_short_circuited`) and no longer carries `stage1_*` keys.
 *    - `RECUED_PLAN_VALIDATION_ISSUE_KINDS` swaps
 *      `unknown_intent_kind` + `unknown_context_breadth` for the new
 *      `invalid_catalog_section_count`.
 *    - Contracts barrel does NOT re-export
 *      `TRANSPARENCY_STAGE1_FALLBACK_REASONS` or
 *      `TransparencyStage1FallbackReason` (compile-time pin via
 *      `@ts-expect-error`).
 *    - Cross-repo source-grep ratchets pin per-pattern hit counts
 *      against the post-P6.7 tree. Allow-list captures the documented
 *      residue (this ratchet file's own pattern catalog + the
 *      retirement-context comments in adjacent test + barrel files +
 *      the previously-landed `d-164-phase-6-6-contracts-deletion`
 *      ratchet whose comment block calls out P6.7's scope).
 *
 *  Spec: D-164
 *  line 521 (P6.7 row). Prior slice: D-164 P6.6 commit `3cd82925`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import * as ContractsBarrel from '../index.js';
import {
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  RECUED_PLAN_VALIDATION_ISSUE_KINDS,
  TRANSPARENCY_AUDIT_SOURCES,
  TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND,
  TRANSPARENCY_EVENT_CLASS_FOR_KIND,
  TRANSPARENCY_EVENT_CLASSES,
  TRANSPARENCY_EVENT_KIND_SET,
  TRANSPARENCY_TEMPLATES_EN,
  classForTransparencyEventKind,
  renderTransparencyTemplate,
  validateRecuedPlan,
  validateTransparencyEvent,
  type ContextSelectionTrace,
  type RecuedPlan,
  type TransparencyEventKind,
} from '../index.js';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

// `ContractsBarrel` is a runtime namespace import so the barrel-
// retirement ratchets can walk the loaded module object — type-only
// imports would erase to nothing at runtime and silently pass the
// retirement assertions even after a roll-back. The `Object.keys`
// snapshot below pins the runtime surface.

// ── Path resolution ─────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

// ── Retirement-target catalogs ─────────────────────────────────────

const RETIRED_KINDS = [
  'engine.stage1_classified',
  'engine.context_filtered',
  'engine.stage2_composed',
  'engine.stage1_fallback',
] as const;

const NEW_KINDS = [
  'engine.gate_short_circuit',
  'engine.catalog_assembled',
] as const;

// ── Closed-list shape ratchets ─────────────────────────────────────

describe('D-164 P6.7 — TransparencyEventKind closed list retires Stage 1 / Stage 2', () => {
  it.each(RETIRED_KINDS)(
    '%s is absent from TRANSPARENCY_EVENT_KIND_SET',
    (kind) => {
      // mutate: re-add the kind to TRANSPARENCY_EVENT_KINDS → fails.
      expect(TRANSPARENCY_EVENT_KIND_SET.has(kind as TransparencyEventKind)).toBe(
        false,
      );
    },
  );

  it.each(NEW_KINDS)(
    '%s is present in TRANSPARENCY_EVENT_KIND_SET',
    (kind) => {
      // mutate: drop the kind from TRANSPARENCY_EVENT_KINDS → fails.
      expect(TRANSPARENCY_EVENT_KIND_SET.has(kind as TransparencyEventKind)).toBe(
        true,
      );
    },
  );

  it.each(NEW_KINDS)(
    '%s classifies as engine_brokering',
    (kind) => {
      expect(
        TRANSPARENCY_EVENT_CLASS_FOR_KIND[kind as TransparencyEventKind],
      ).toBe('engine_brokering');
      expect(classForTransparencyEventKind(kind as TransparencyEventKind)).toBe(
        'engine_brokering',
      );
    },
  );

  it('engine.budget_exceeded reclassifies into the failure class', () => {
    // mutate: revert to 'two_stage' → fails (the class itself no longer
    // exists in the closed list).
    expect(TRANSPARENCY_EVENT_CLASS_FOR_KIND['engine.budget_exceeded']).toBe(
      'failure',
    );
  });
});

describe('D-164 P6.7 — TRANSPARENCY_EVENT_CLASSES drops two_stage', () => {
  it('has four distinct entries', () => {
    expect(TRANSPARENCY_EVENT_CLASSES).toHaveLength(4);
    expect(new Set(TRANSPARENCY_EVENT_CLASSES).size).toBe(4);
  });

  it('does not contain two_stage', () => {
    expect(TRANSPARENCY_EVENT_CLASSES).not.toContain('two_stage' as never);
  });

  it('TRANSPARENCY_AUDIT_SOURCES mirrors the four-class shape', () => {
    expect(TRANSPARENCY_AUDIT_SOURCES).toHaveLength(4);
    expect(TRANSPARENCY_AUDIT_SOURCES).not.toContain('two_stage' as never);
    expect(new Set(TRANSPARENCY_AUDIT_SOURCES)).toEqual(
      new Set(TRANSPARENCY_EVENT_CLASSES),
    );
  });

  it('default visible_classes carries the four-class shape', () => {
    const keys = Object.keys(
      DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes,
    ).sort();
    expect(keys).toHaveLength(4);
    expect(keys).not.toContain('two_stage');
  });
});

// ── Validator ratchets ──────────────────────────────────────────────

describe('D-164 P6.7 — validateTransparencyEvent rejects retired kinds', () => {
  it.each(RETIRED_KINDS)('%s validates as unknown_kind', (kind) => {
    // mutate: re-add the kind to the union → it ceases to be unknown.
    const issues = validateTransparencyEvent({ kind });
    expect(issues.some((i) => i.kind === 'unknown_kind')).toBe(true);
  });
});

describe('D-164 P6.7 — validator gates for new kinds', () => {
  it('engine.gate_short_circuit accepts a string template_hash', () => {
    expect(
      validateTransparencyEvent({
        kind: 'engine.gate_short_circuit',
        template_hash: 'sha256:deadbeef',
      }),
    ).toEqual([]);
  });

  it('engine.gate_short_circuit flags missing template_hash', () => {
    const issues = validateTransparencyEvent({ kind: 'engine.gate_short_circuit' });
    expect(
      issues.some(
        (i) => i.kind === 'missing_required_string' && i.path === 'template_hash',
      ),
    ).toBe(true);
  });

  it('engine.catalog_assembled accepts an empty section_counts', () => {
    expect(
      validateTransparencyEvent({
        kind: 'engine.catalog_assembled',
        section_counts: {},
      }),
    ).toEqual([]);
  });

  it('engine.catalog_assembled accepts numeric per-section entries', () => {
    expect(
      validateTransparencyEvent({
        kind: 'engine.catalog_assembled',
        section_counts: { 'entity-query': 4, recipes: 7 },
      }),
    ).toEqual([]);
  });

  it('engine.catalog_assembled flags invalid per-section entries', () => {
    const issues = validateTransparencyEvent({
      kind: 'engine.catalog_assembled',
      section_counts: { recipes: 'lots', enrichment: -1 },
    });
    expect(
      issues.some(
        (i) =>
          i.kind === 'missing_required_number' &&
          i.path === 'section_counts.recipes',
      ),
    ).toBe(true);
    expect(
      issues.some(
        (i) =>
          i.kind === 'missing_required_number' &&
          i.path === 'section_counts.enrichment',
      ),
    ).toBe(true);
  });

  it('engine.catalog_assembled flags a missing section_counts object', () => {
    const issues = validateTransparencyEvent({ kind: 'engine.catalog_assembled' });
    expect(
      issues.some(
        (i) =>
          i.kind === 'missing_required_object' && i.path === 'section_counts',
      ),
    ).toBe(true);
  });
});

// ── Template + redaction ratchets ──────────────────────────────────

describe('D-164 P6.7 — new kinds carry templates + hidden defaults', () => {
  it('TRANSPARENCY_TEMPLATES_EN has entries for both new kinds', () => {
    for (const kind of NEW_KINDS) {
      expect(typeof TRANSPARENCY_TEMPLATES_EN[kind as TransparencyEventKind]).toBe(
        'function',
      );
    }
  });

  it('engine.gate_short_circuit template embeds a truncated template_hash', () => {
    const rendered = renderTransparencyTemplate({
      kind: 'engine.gate_short_circuit',
      template_hash: 'sha256:abcdef1234567890',
    });
    expect(rendered).toContain('sha256:a');
    expect(rendered.length).toBeLessThan(80);
  });

  it('engine.catalog_assembled template names every non-empty section', () => {
    const rendered = renderTransparencyTemplate({
      kind: 'engine.catalog_assembled',
      section_counts: { 'entity-query': 2, recipes: 4 },
    });
    expect(rendered).toContain('entity-query:2');
    expect(rendered).toContain('recipes:4');
  });

  it.each(NEW_KINDS)('%s defaults to the hidden redaction tier', (kind) => {
    expect(
      TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND[kind as TransparencyEventKind],
    ).toBe('hidden');
  });
});

// ── ContextSelectionTrace ratchets (Open Q1 (b)) ────────────────────

const baseTrace = (): ContextSelectionTrace => ({
  recipe_candidates_considered: 0,
  recipe_candidates_selected: [],
  recipe_candidates_dropped: [],
  commitment_context_pulled: false,
  commitment_rows_count: 0,
  catalog_section_counts: {},
  catalog_short_circuited: false,
});

const wrapTrace = (trace: ContextSelectionTrace): RecuedPlan => ({
  plan_id: 'plan-d164-p67',
  goal_id: 'plan-d164-p67',
  user_request: 'baseline',
  considered_sources: [],
  capacity_checks: [],
  included_context: [],
  omitted_context: [],
  selection_trace: trace,
  model_tier: 'fast',
  ai_provider: 'anthropic',
  ai_model_id: 'claude-haiku-4-5',
  primitive_calls: [],
  status: 'completed',
  user_visible_internal_steps: [],
  user_response: 'ok',
  user_events: [],
  provenance_links: [],
  audit_policy: {
    retain_for_days: 90,
    high_assurance: false,
    redact_user_request: false,
  },
  started_at: 1_736_000_000_000,
  completed_at: 1_736_000_001_000,
});

describe('D-164 P6.7 — ContextSelectionTrace catalog-assembly snapshot shape', () => {
  it('carries catalog_section_counts + catalog_short_circuited', () => {
    const trace = baseTrace();
    expect(trace.catalog_section_counts).toEqual({});
    expect(trace.catalog_short_circuited).toBe(false);
  });

  it('does not carry any stage1_* fields (compile-time pin)', () => {
    const trace = baseTrace();
    // @ts-expect-error D-164 P6.7 removed `stage1_intents`.
    void trace.stage1_intents;
    // @ts-expect-error D-164 P6.7 removed `stage1_context_breadth`.
    void trace.stage1_context_breadth;
    // @ts-expect-error D-164 P6.7 removed `stage1_topic_tags`.
    void trace.stage1_topic_tags;
    // @ts-expect-error D-164 P6.7 removed `stage1_fallback_used`.
    void trace.stage1_fallback_used;
  });

  it('validateRecuedPlan rejects non-finite section count values', () => {
    const trace = baseTrace();
    (trace as { catalog_section_counts: Record<string, number> }).catalog_section_counts = {
      enrichment: Number.NaN,
    };
    const issues = validateRecuedPlan(wrapTrace(trace));
    expect(
      issues.some(
        (i) =>
          i.kind === 'invalid_catalog_section_count' &&
          i.path === 'selection_trace.catalog_section_counts.enrichment',
      ),
    ).toBe(true);
  });

  it('validateRecuedPlan rejects negative section count values', () => {
    const trace = baseTrace();
    (trace as { catalog_section_counts: Record<string, number> }).catalog_section_counts = {
      'entity-query': -1,
    };
    const issues = validateRecuedPlan(wrapTrace(trace));
    expect(
      issues.some((i) => i.kind === 'invalid_catalog_section_count'),
    ).toBe(true);
  });
});

describe('D-164 P6.7 — RECUED_PLAN_VALIDATION_ISSUE_KINDS swaps Stage 1 issue kinds', () => {
  it('carries invalid_catalog_section_count', () => {
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).toContain(
      'invalid_catalog_section_count',
    );
  });

  it('drops unknown_intent_kind + unknown_context_breadth', () => {
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).not.toContain(
      'unknown_intent_kind' as never,
    );
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS).not.toContain(
      'unknown_context_breadth' as never,
    );
  });
});

// ── Barrel surface ratchets ─────────────────────────────────────────

// `@ts-expect-error` blocks evaporate under `vitest run` (no type-check
// gate runs the tests), so the barrel-retirement ratchets need runtime
// teeth — walk the loaded `* as Contracts` namespace and assert the
// retired runtime constant is absent. (The type-alias retirement is
// covered transitively by the type itself dropping out of the source
// barrel: the cross-repo file walker below asserts the literal
// identifier no longer appears in `packages/contracts/src/index.ts`
// outside the retirement-comment allowance.)
describe('D-164 P6.7 — contracts barrel retires Stage 1 fallback symbols', () => {
  it('does not re-export TRANSPARENCY_STAGE1_FALLBACK_REASONS at runtime', () => {
    // mutate: re-add the `TRANSPARENCY_STAGE1_FALLBACK_REASONS` re-export
    // in the barrel → this assertion fails.
    const barrel = ContractsBarrel as unknown as Record<string, unknown>;
    expect(barrel.TRANSPARENCY_STAGE1_FALLBACK_REASONS).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(
      barrel,
      'TRANSPARENCY_STAGE1_FALLBACK_REASONS',
    )).toBe(false);
  });

  it('does not re-export TransparencyStage1FallbackReason in the source barrel', () => {
    // The type itself has no runtime presence; the cross-repo file
    // walker below pins that the identifier is absent from `index.ts`.
    // This test exists for symmetry + as the explicit retirement record.
    const barrel = ContractsBarrel as unknown as Record<string, unknown>;
    expect(barrel.TransparencyStage1FallbackReason).toBeUndefined();
  });
});

// ── Cross-repo source-grep ratchets ─────────────────────────────────

// Quote-delimited so suffixed identifiers (`engine.stage1_classified_extra`)
// don't slip past as accidental matches. Every legitimate reference to a
// transparency event kind across the repo appears as a string literal —
// either inside the kind closed list, the class registry, the validator
// switch, the templates, the redaction map, or a test fixture — so the
// quote anchor is faithful to how these names actually appear in source.
const STAGE1_CLASSIFIED_RE = /['"`]engine\.stage1_classified['"`]/g;
const CONTEXT_FILTERED_RE = /['"`]engine\.context_filtered['"`]/g;
const STAGE2_COMPOSED_RE = /['"`]engine\.stage2_composed['"`]/g;
const STAGE1_FALLBACK_EVENT_RE = /['"`]engine\.stage1_fallback['"`]/g;
const STAGE1_FALLBACK_REASONS_RE = /\bTRANSPARENCY_STAGE1_FALLBACK_REASONS\b/g;
const STAGE1_FALLBACK_REASON_TYPE_RE = /\bTransparencyStage1FallbackReason\b/g;
const STAGE1_INTENTS_FIELD_RE = /\bstage1_intents\b/g;
const STAGE1_BREADTH_FIELD_RE = /\bstage1_context_breadth\b/g;
const STAGE1_TOPIC_TAGS_FIELD_RE = /\bstage1_topic_tags\b/g;
const STAGE1_FALLBACK_FIELD_RE = /\bstage1_fallback_used\b/g;

interface ExpectedCounts {
  readonly stage1Classified: number;
  readonly contextFiltered: number;
  readonly stage2Composed: number;
  readonly stage1FallbackEvent: number;
  readonly stage1FallbackReasonsConst: number;
  readonly stage1FallbackReasonType: number;
  readonly stage1IntentsField: number;
  readonly stage1BreadthField: number;
  readonly stage1TopicTagsField: number;
  readonly stage1FallbackField: number;
}

const ZERO_COUNTS: ExpectedCounts = {
  stage1Classified: 0,
  contextFiltered: 0,
  stage2Composed: 0,
  stage1FallbackEvent: 0,
  stage1FallbackReasonsConst: 0,
  stage1FallbackReasonType: 0,
  stage1IntentsField: 0,
  stage1BreadthField: 0,
  stage1TopicTagsField: 0,
  stage1FallbackField: 0,
};

// Allow-list captures documented residue against the post-P6.8 tree.
//
// 6 load-bearing entries:
//  - This ratchet file itself (pattern catalog + pin comments + new-kind
//    + retired-kind round-trip tests).
//  - `d-164-phase-6-6-contracts-deletion.ratchet.test.ts` — header doc-
//    comment block calls out P6.7's scope by name.
//  - `packages/contracts/src/index.ts` — main barrel retirement comment.
//  - `packages/contracts/src/__tests__/d-145-phase-pb2-contracts.test.ts`
//    — `appendTransparencyEvent` round-trip test names the retired
//    `engine.stage1_classified` to call out the replacement kind it
//    now emits.
//  - `packages/contracts/src/__tests__/d-145-phase-pb7-transparency-stream.test.ts`
//    — transparency-stream substrate tests carry one explicit retired-
//    kinds-reject block (1 mention of each of the 4 retired event kinds).
//  - `backend/server/src/__tests__/d-164-phase-6-3-chat-orchestrator-ratchet.test.ts`
//    — chat-orchestrator P6.3 ratchet pins that emission of
//    `engine.context_filtered` / `engine.stage1_fallback` never
//    happens. Negative assertions still name the strings.
const ALLOW_LIST_EXPECTED: ReadonlyMap<string, ExpectedCounts> = new Map([
  // This ratchet file's pattern catalog + new-kind + retired-kind
  // tests + comment block. Counts captured against the in-tree text.
  [
    'packages/contracts/src/__tests__/d-164-phase-6-7-transparency-retirement.ratchet.test.ts',
    {
      stage1Classified: 4,
      contextFiltered: 4,
      stage2Composed: 3,
      stage1FallbackEvent: 4,
      stage1FallbackReasonsConst: 7,
      stage1FallbackReasonType: 5,
      stage1IntentsField: 3,
      stage1BreadthField: 3,
      stage1TopicTagsField: 3,
      stage1FallbackField: 3,
    },
  ],
  // The P6.6 ratchet's doc-comment header names the P6.7 follow-on
  // (TRANSPARENCY_STAGE1_FALLBACK_REASONS + TransparencyStage1FallbackReason).
  [
    'packages/contracts/src/__tests__/d-164-phase-6-6-contracts-deletion.ratchet.test.ts',
    {
      ...ZERO_COUNTS,
      stage1FallbackReasonsConst: 1,
      stage1FallbackReasonType: 1,
    },
  ],
  // Main barrel retirement comment.
  [
    'packages/contracts/src/index.ts',
    {
      ...ZERO_COUNTS,
      stage1Classified: 1,
      contextFiltered: 1,
      stage2Composed: 1,
      stage1FallbackEvent: 1,
      stage1FallbackReasonType: 1,
      stage1FallbackReasonsConst: 1,
    },
  ],
  // PB2 contracts test — appendTransparencyEvent's narrative comment.
  [
    'packages/contracts/src/__tests__/d-145-phase-pb2-contracts.test.ts',
    {
      ...ZERO_COUNTS,
      stage1Classified: 1,
    },
  ],
  // PB7 transparency-stream test — retired-kinds rejection block.
  [
    'packages/contracts/src/__tests__/d-145-phase-pb7-transparency-stream.test.ts',
    {
      ...ZERO_COUNTS,
      stage1Classified: 1,
      contextFiltered: 1,
      stage2Composed: 1,
      stage1FallbackEvent: 1,
    },
  ],
  // P6.3 chat-orchestrator ratchet pins negative emissions.
  [
    'backend/server/src/__tests__/d-164-phase-6-3-chat-orchestrator-ratchet.test.ts',
    {
      ...ZERO_COUNTS,
      contextFiltered: 1,
      stage1FallbackEvent: 1,
    },
  ],
]);

const expectedFor = (rel: string): ExpectedCounts =>
  ALLOW_LIST_EXPECTED.get(rel) ?? ZERO_COUNTS;

const REPO_SCAN_ROOTS = ['backend', 'packages', 'apps'] as const;
const REPO_SCAN_SKIP_DIR = new Set([
  'node_modules',
  'dist',
  '.git',
  '.tsbuild',
]);
const REPO_SCAN_SKIP_FILE_SUFFIX = ['.d.ts', '.d.ts.map', '.js.map'];

const isScannableFile = (filePath: string): boolean => {
  if (!isTypeScriptSource(filePath)) {
    return false;
  }
  for (const suffix of REPO_SCAN_SKIP_FILE_SUFFIX) {
    if (filePath.endsWith(suffix)) {
      return false;
    }
  }
  return true;
};

const walk = (dirAbs: string, out: string[]): void => {
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return;
  }
  for (const name of entries) {
    if (REPO_SCAN_SKIP_DIR.has(name)) {
      continue;
    }
    const abs = path.join(dirAbs, name);
    let info;
    try {
      info = statSync(abs);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(abs, out);
    } else if (info.isFile() && isScannableFile(abs)) {
      out.push(abs);
    }
  }
};

const collectRepoSources = (): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const root of REPO_SCAN_ROOTS) {
    walk(path.join(REPO_ROOT, root), out);
  }
  return out;
};

const relFromRepo = (abs: string): string => path.relative(REPO_ROOT, abs);

const countMatches = (src: string, re: RegExp): number => {
  const matches = src.match(re);
  return matches === null ? 0 : matches.length;
};

interface FileScan {
  readonly rel: string;
  readonly counts: ExpectedCounts;
}

let cachedScans: ReadonlyArray<FileScan> | null = null;

const scanAllFiles = (): ReadonlyArray<FileScan> => {
  if (cachedScans !== null) {
    return cachedScans;
  }
  const out: FileScan[] = [];
  for (const abs of collectRepoSources()) {
    const rel = relFromRepo(abs);
    const src = readFileSync(abs, 'utf8');
    out.push({
      rel,
      counts: {
        stage1Classified: countMatches(src, STAGE1_CLASSIFIED_RE),
        contextFiltered: countMatches(src, CONTEXT_FILTERED_RE),
        stage2Composed: countMatches(src, STAGE2_COMPOSED_RE),
        stage1FallbackEvent: countMatches(src, STAGE1_FALLBACK_EVENT_RE),
        stage1FallbackReasonsConst: countMatches(src, STAGE1_FALLBACK_REASONS_RE),
        stage1FallbackReasonType: countMatches(src, STAGE1_FALLBACK_REASON_TYPE_RE),
        stage1IntentsField: countMatches(src, STAGE1_INTENTS_FIELD_RE),
        stage1BreadthField: countMatches(src, STAGE1_BREADTH_FIELD_RE),
        stage1TopicTagsField: countMatches(src, STAGE1_TOPIC_TAGS_FIELD_RE),
        stage1FallbackField: countMatches(src, STAGE1_FALLBACK_FIELD_RE),
      },
    });
  }
  cachedScans = out;
  return out;
};

describe('D-164 P6.7 — cross-repo source grep matches the allow-list exactly', () => {
  let scans: ReadonlyArray<FileScan> = [];

  beforeAll(() => {
    scans = scanAllFiles();
  });

  it('the scan found at least one source file (sanity)', () => {
    expect(scans.length).toBeGreaterThan(100);
  });

  const PATTERN_LABELS: ReadonlyArray<readonly [keyof ExpectedCounts, string]> = [
    ['stage1Classified', '`engine.stage1_classified`'],
    ['contextFiltered', '`engine.context_filtered`'],
    ['stage2Composed', '`engine.stage2_composed`'],
    ['stage1FallbackEvent', '`engine.stage1_fallback`'],
    ['stage1FallbackReasonsConst', '`TRANSPARENCY_STAGE1_FALLBACK_REASONS`'],
    ['stage1FallbackReasonType', '`TransparencyStage1FallbackReason`'],
    ['stage1IntentsField', '`stage1_intents`'],
    ['stage1BreadthField', '`stage1_context_breadth`'],
    ['stage1TopicTagsField', '`stage1_topic_tags`'],
    ['stage1FallbackField', '`stage1_fallback_used`'],
  ];

  for (const [field, label] of PATTERN_LABELS) {
    it(`every file matches its expected ${label} hit-count`, () => {
      const offenders: string[] = [];
      for (const { rel, counts } of scans) {
        const expected = expectedFor(rel)[field];
        const actual = counts[field];
        if (actual !== expected) {
          offenders.push(
            `${rel}: ${field} actual=${actual} expected=${expected}`,
          );
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('every allow-list entry resolves to a file the walker actually visited', () => {
    const scannedRel = new Set(scans.map(({ rel }) => rel));
    const missing: string[] = [];
    for (const rel of ALLOW_LIST_EXPECTED.keys()) {
      if (!scannedRel.has(rel)) {
        missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });
});
