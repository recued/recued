import { describe, it, expect } from 'vitest';
import { TRANSFORMS, getTransform } from '../index.js';

describe('TRANSFORMS registry', () => {
  // 90 as of `enrich_by` (the relational join the recipe language lacked — see
  // its header in `collection.ts`). The count is a deliberate ratchet: an
  // addition must be a decision, not a drift, and this is where it gets noticed.
  it('has 91 transforms', () => expect(TRANSFORMS.size).toBe(91));

  it('all values are functions', () => {
    for (const [name, fn] of TRANSFORMS) {
      expect(typeof fn, `${name} should be a function`).toBe('function');
    }
  });

  const expected = [
    // Tier 1
    'filter', 'sort', 'map', 'project', 'reduce', 'unique', 'flatten', 'slice', 'group_by', 'to_list', 'partition',
    'merge', 'prefix_keys', 'pick', 'omit', 'rename', 'set', 'json_byte_length',
    'json_stringify', 'json_parse', 'utf8_byte_length', 'sha256',
    'lowercase', 'uppercase', 'trim', 'string_length', 'split', 'contains_any', 'concat', 'replace', 'template', 'truncate', 'strip_html',
    'round', 'clamp', 'to_number', 'math',
    'date_diff', 'date_format', 'date_add', 'date_parse', 'is_past', 'is_future', 'date_period',
    'compare', 'coalesce', 'switch', 'all', 'any', 'count', 'default', 'not', 'ternary', 'pluralize',
    'hash_replace', 'hash_restore', 'redact',
    // D-167 P4 — reversible PII alias comfort layer
    'pii-protect', 'pii-restore',
    'to_checklist', 'to_table', 'to_summary', 'to_csv', 'to_slack_blocks',
    'starts_with', 'ends_with',
    // Tier 2
    'find', 'pluck', 'sum', 'min_by', 'max_by', 'percent', 'join',
    // D-115 reactive (Tier 2 — starter set)
    'mail_received', 'file_changed', 'calendar_starting_soon', 'recipe_succeeded_since',
    'time_within_window', 'time_elapsed_since', 'http_changed',
    // D-117 calendar reactive helpers
    'calendar_changed_since', 'calendar_new_since', 'attendee_diff',
    // D-116 timing
    'wait',
    // D-125 P6.2 enrichment-first convention
    'enrichment-or-fetch',
  ];

  it.each(expected)('has "%s"', (name) => {
    expect(TRANSFORMS.has(name), `missing: ${name}`).toBe(true);
  });
});

describe('getTransform', () => {
  it('returns function for known name', () => expect(typeof getTransform('filter')).toBe('function'));
  it('returns undefined for unknown', () => expect(getTransform('nonexistent')).toBeUndefined());
});
