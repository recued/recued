/** D-137 W2.3 § A.1.1 + § A.10 — Tier 3 (connection.mcp.*) catalog
 *  substrate. Contracts-layer ratchets:
 *
 *    - Closed-list `TIER3_TOOL_CLASSIFICATIONS` (3 entries; read /
 *      write / unknown) + `isTier3ToolClassification` membership.
 *    - `formatTier3ToolName` formatting + `<connection>.<tool>` shape.
 *    - `buildTier3ToolEntry` projection — surfaces iff enabled &&
 *      classified; passes through `destructive_hint` from descriptor;
 *      per-tool `custom_topic_tags` overrides connection-level
 *      `topic_tags`; classification surfaces verbatim.
 *    - `buildTier3Catalog` — flat-map across annotations + descriptors;
 *      sorted by name asc; empty when no annotations.
 *    - `computeConnectionMcpDisabledTier3Names` — every cached
 *      descriptor that does NOT pass the gates surfaces as a member of
 *      the disabled set; tools that survive the gates are absent.
 *    - `buildDefaultConnectionMcpAnnotation` empty shape.
 *    - `validateConnectionMcpAnnotationInput` exhaustive shape rejection
 *      + canonicalization. */

import { describe, it, expect } from 'vitest';
import {
  TIER3_TOOL_CLASSIFICATIONS,
  TIER3_TOOL_CLASSIFICATION_SET,
  isTier3ToolClassification,
  buildDefaultConnectionMcpAnnotation,
  formatTier3ToolName,
  CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES,
  validateConnectionMcpAnnotationInput,
  type ConnectionMcpAnnotationState,
  type McpToolDescriptor,
} from '../chat.js';

const baseAnnotation = (
  connection_name: string,
  overrides: Partial<ConnectionMcpAnnotationState> = {},
): ConnectionMcpAnnotationState => ({
  connection_name,
  topic_tags: [],
  updated_at: 0,
  ...overrides,
});

describe('D-137 W2.3 — TIER3_TOOL_CLASSIFICATIONS closed list', () => {
  it('lists exactly read / write / unknown in canonical order', () => {
    expect([...TIER3_TOOL_CLASSIFICATIONS]).toEqual([
      'read',
      'write',
      'unknown',
    ]);
    expect(TIER3_TOOL_CLASSIFICATION_SET.size).toBe(3);
  });

  it('isTier3ToolClassification accepts every member + rejects off-list', () => {
    for (const c of TIER3_TOOL_CLASSIFICATIONS) {
      expect(isTier3ToolClassification(c)).toBe(true);
    }
    expect(isTier3ToolClassification('execute')).toBe(false);
    expect(isTier3ToolClassification(null)).toBe(false);
    expect(isTier3ToolClassification(0)).toBe(false);
    expect(isTier3ToolClassification(undefined)).toBe(false);
  });
});

describe('D-137 W2.3 — formatTier3ToolName', () => {
  it('joins connection + tool with a dot', () => {
    expect(formatTier3ToolName('exa', 'search')).toBe('exa.search');
    expect(formatTier3ToolName('github', 'list_issues')).toBe('github.list_issues');
  });
});

describe('D-137 W2.3 — buildDefaultConnectionMcpAnnotation', () => {
  it('returns an empty annotation shape for a fresh connection', () => {
    const def = buildDefaultConnectionMcpAnnotation('exa');
    expect(def.connection_name).toBe('exa');
    expect([...def.topic_tags]).toEqual([]);
    // ⛔ D-228 slice 4 — `tool_overrides` is GONE from the shape. Asserting its
    // absence rather than deleting the line: a default annotation that grew the
    // field back would mean a second classification store had returned.
    // ⛔ D-228 slices 4 + 6 — FOUR fields are GONE from the shape. Asserting
    // their absence rather than deleting the lines: a default annotation that
    // grew one back would mean a second store of the same fact had returned.
    for (const key of ['tool_overrides', 'tools_list_cache', 'recued_signature', 'chat_mode']) {
      expect(key in def).toBe(false);
    }
    expect(def.updated_at).toBe(0);
  });
});

/** ⛔ D-228 slice 4 — THREE SUITES REMOVED HERE, NOT LOST.
 *
 *  `buildTier3ToolEntry`, `buildTier3Catalog` and
 *  `computeConnectionMcpDisabledTier3Names` projected the chat Tier-3 catalog
 *  from `tool_overrides`. That store is deleted (D-225 named it as the standing
 *  defect; an MCP tool now reaches chat once, as a contract-governed pack op),
 *  and with it every gate those ~350 lines exercised: enabled / classification /
 *  custom topic tags / the Tier-1 name-collision refusal.
 *
 *  What the deletion must not lose is the CLAIM that the surface is gone, and
 *  that lives where the surface did: `packages/middleware`'s tier-3 suite now
 *  pins the projection at zero and `getByName` at null. The validator + picker
 *  suites below are the parts of this file whose subject survives. */

/** ⛔⛔ D-228 slice 6 — THE HAND-WRITTEN CLOSED-LIST TWIN IS DELETED, AND ITS
 *  DELETION IS THE POINT.
 *
 *  This suite asserted `.length === 24` and spot-checked members by name. It was
 *  green the entire time 19 of those 24 codes had become unemittable — slices 4
 *  and 6 moved four fields to tolerate-and-ignore, and a tolerated key raises
 *  nothing. A count plus a `toContain` list cannot notice that a code stopped
 *  being produced; it only notices that someone edited the array, which is the
 *  half that was never the risk.
 *
 *  🔑 REPLACED BY A DERIVED RATCHET, in
 *  `backend/server/src/__tests__/d-228-slice-6-annotation-collapse.test.ts`: it
 *  parses the validator's own `code:` emissions out of the source and asserts
 *  set equality in BOTH directions. A second hand-written list is exactly what
 *  drifted here, so the replacement deliberately has no list to maintain. */

describe('D-137 W2.3 — validateConnectionMcpAnnotationInput', () => {
  it('rejects non-object input with input_not_object', () => {
    const r = validateConnectionMcpAnnotationInput(null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]!.code).toBe('input_not_object');
    }
  });

  it('rejects payloads missing connection_name', () => {
    const r = validateConnectionMcpAnnotationInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'connection_name_invalid')).toBe(true);
    }
  });

  it('accepts a minimal connection_name-only payload', () => {
    const r = validateConnectionMcpAnnotationInput({ connection_name: 'exa' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.connection_name).toBe('exa');
      expect([...r.value.topic_tags]).toEqual([]);
      // ⛔ D-228 slice 4 — the validated value no longer CARRIES the field.
      expect('tool_overrides' in r.value).toBe(false);
      expect('tools_list_cache' in r.value).toBe(false);
    }
  });

  it('rejects topic_tags shape errors', () => {
    const r1 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: 'web',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.some((i) => i.code === 'topic_tags_not_array')).toBe(true);
    }
    const r2 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: ['web', 42, ''],
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues.some((i) => i.code === 'topic_tag_member_invalid')).toBe(true);
    }
    const r3 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: ['web', 'web'],
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.issues.some((i) => i.code === 'topic_tag_duplicate')).toBe(true);
    }
  });

  it('⛔⛔ D-228 slice 4 — ACCEPTS AND IGNORES a retired `tool_overrides` key, however malformed', () => {
    // THIS TEST INVERTED, and the inversion is the wire-compatibility claim.
    // It used to assert three REJECTIONS (`tool_overrides_not_object`,
    // `tool_override_enabled_invalid`, `tool_override_classification_invalid`).
    // The field is retired, and a cached older webclient still sends it — so
    // failing its payload would break a client that is otherwise perfectly able
    // to set topic tags. What you ACCEPT is not what you ADVERTISE.
    for (const tool_overrides of [
      [],
      { search: { enabled: 'yes', classification: 'read' } },
      { search: { enabled: true, classification: 'execute' } },
    ]) {
      const r = validateConnectionMcpAnnotationInput({
        connection_name: 'exa',
        tool_overrides,
      });
      expect(r.ok).toBe(true);
      // ⚠ AND IT MUST NOT COME BACK OUT. Accepting the key is compatibility;
      // carrying it forward would be a second classification store returning.
      if (r.ok) expect('tool_overrides' in r.value).toBe(false);
    }
  });

  // ⛔ D-228 slice 6 — the `tools_list_cache` REJECTION tests are deleted with
  // their subject, and INVERTED rather than dropped: the validator now accepts
  // every one of those malformed shapes and ignores them. That claim is pinned
  // in the slice-6 suite ("accepts a MALFORMED legacy key"), because tolerance
  // that still runs the shape check is not tolerance — it would 400 a caller
  // over a field the server no longer stores.

  // ⛔ D-228 slice 4 — the `custom_topic_tags` rejection tests are DELETED with
  // their subject. Those tags lived INSIDE a `tool_overrides` entry (per-tool
  // topic chips overriding the connection-level ones); the whole entry shape is
  // retired, so there is no longer a place for them to be malformed. The
  // CONNECTION-level `topic_tags` validation, which survives, is covered above.

  it('canonicalizes a full valid payload', () => {
    const r = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: ['web', 'research'],
      tool_overrides: {
        search: {
          enabled: true,
          classification: 'read',
          custom_topic_tags: ['search'],
        },
        delete_index: {
          enabled: true,
          classification: 'write',
        },
      },
      tools_list_cache: {
        tools: [
          { name: 'search', description: 'Search the web', destructive_hint: false },
          { name: 'delete_index', destructive_hint: true },
        ],
        cached_at: 1700000000,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.connection_name).toBe('exa');
      expect([...r.value.topic_tags]).toEqual(['web', 'research']);
      // ⛔⛔ ACCEPTED, IGNORED, NOT REJECTED. The input above still SENDS
      // `tool_overrides` — a cached older webclient does — and the validator
      // must not fail its payload over a retired key. It reads past it.
      expect('tool_overrides' in r.value).toBe(false);
      expect('tools_list_cache' in r.value).toBe(false);
    }
  });
});
