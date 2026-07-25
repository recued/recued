/** Lever-2 (2026-07-02) — `searchToolCatalog` ranking ratchets.
 *
 * The pure scorer behind the `tools.search` meta-tool: rank a tool catalog
 * by a capability query, return top-K. Scoring is slug +3 / tag +2 /
 * description +1 per query term; sub-2-char terms are dropped.
 */

import { describe, expect, it } from 'vitest';
import type { ToolEntry } from '@recued/contracts';
import { searchToolCatalog } from '../chat-catalog.js';

const entry = (
  name: string,
  description: string,
  topic_tags: ReadonlyArray<string> = [],
): ToolEntry => ({
  name,
  tier: 2,
  description,
  arg_schema: { type: 'object' },
  topic_tags,
  classification: 'unknown',
  concurrency_safe: false,
});

const CATALOG: ReadonlyArray<ToolEntry> = [
  entry('recued-core/draft-followup-email', 'Draft a personalized follow-up email after a meeting', [
    'email',
    'draft',
    'crm',
  ]),
  entry('recued-core/summarize-pdf', 'Summarize a PDF document into key points', [
    'pdf',
    'summary',
    'document',
  ]),
  entry('recued-core/find-overdue-invoices', 'List invoices past their due date', [
    'invoice',
    'finance',
    'overdue',
  ]),
  entry('acme/email-blast', 'Send a bulk marketing email campaign', ['marketing', 'bulk']),
  entry('recued-core/weather-today', 'Current weather for a location', ['weather']),
];

const names = (result: ReadonlyArray<ToolEntry>): string[] => result.map((e) => e.name);

describe('Lever-2 searchToolCatalog', () => {
  it('ranks a slug/tag/description match above a stopword-only match', () => {
    // "draft a follow-up email" — the single-char "a" is dropped, so weather /
    // summarize / invoices (which only contained "a" as a substring) do not
    // leak into the tail. Only the two genuinely email-related tools survive.
    expect(names(searchToolCatalog(CATALOG, 'draft a follow-up email', 5))).toEqual([
      'recued-core/draft-followup-email',
      'acme/email-blast',
    ]);
  });

  it('orders by score (slug hit dominates description hit)', () => {
    // Both match "email"; draft-followup wins on slug + tag + description,
    // email-blast on slug + description.
    expect(names(searchToolCatalog(CATALOG, 'email', 5))).toEqual([
      'recued-core/draft-followup-email',
      'acme/email-blast',
    ]);
  });

  it('narrows to the single matching tool for a specific query', () => {
    expect(names(searchToolCatalog(CATALOG, 'summarize pdf', 5))).toEqual([
      'recued-core/summarize-pdf',
    ]);
    expect(names(searchToolCatalog(CATALOG, 'invoice overdue', 5))).toEqual([
      'recued-core/find-overdue-invoices',
    ]);
  });

  it('returns [] on no match, empty query, or punctuation-only query', () => {
    expect(searchToolCatalog(CATALOG, 'quantum blockchain', 5)).toEqual([]);
    expect(searchToolCatalog(CATALOG, '', 5)).toEqual([]);
    expect(searchToolCatalog(CATALOG, '!!! ...', 5)).toEqual([]);
    // A single-char query drops to zero terms → no match.
    expect(searchToolCatalog(CATALOG, 'a', 5)).toEqual([]);
  });

  it('caps at limit and returns [] for a non-positive limit (0 or negative)', () => {
    expect(names(searchToolCatalog(CATALOG, 'email', 1))).toEqual([
      'recued-core/draft-followup-email',
    ]);
    expect(searchToolCatalog(CATALOG, 'email', 0)).toEqual([]);
    expect(searchToolCatalog(CATALOG, 'email', -1)).toEqual([]);
  });

  it('breaks score ties on name ascending (deterministic)', () => {
    // Two entries with identical single-tag matches → deterministic name order,
    // regardless of input order (input is z-before-a; output must be a-before-z).
    const tied: ReadonlyArray<ToolEntry> = [
      entry('z/second', 'unrelated', ['widget']),
      entry('a/first', 'unrelated', ['widget']),
    ];
    expect(names(searchToolCatalog(tied, 'widget', 5))).toEqual(['a/first', 'z/second']);
  });
});
