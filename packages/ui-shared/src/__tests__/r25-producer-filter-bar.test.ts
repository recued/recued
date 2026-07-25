/** R25 — AI-producer filter bar (search + cost toggle) + one-liner. */

import { describe, it, expect } from 'vitest';
import type { HousekeepingTaskStatus } from '@recued/contracts';
import {
  filterProducers,
  producerOneLiner,
  renderHousekeepingProducerFilterBar,
} from '../server-settings/housekeeping/producer-filter-bar.js';

// `thread_signals` is a real ENRICHMENT_REGISTRY topic; its user_value is
// the "Triage thread importance…" copy. A synthetic topic exercises the
// description fallback.
const REGISTRY_TOPIC = 'thread_signals';
const REGISTRY_USER_VALUE = 'Triage thread importance without re-reading every message.';

const producer = (
  topic: string,
  opts: { tokens?: number; description?: string } = {},
): HousekeepingTaskStatus => ({
  meta: {
    id: `enrichment.${topic}`,
    description: opts.description ?? `${topic} — engineering description`,
    interruptible: true,
    kind: 'enrichment',
  },
  enrichment: {
    token_estimate_per_record: opts.tokens ?? 250,
    source_collection_count: 10,
  },
});

describe('R25 — producerOneLiner', () => {
  it('renders the registry user_value for a known topic', () => {
    expect(producerOneLiner(producer(REGISTRY_TOPIC))).toBe(REGISTRY_USER_VALUE);
  });

  it('falls back to meta.description for an unregistered topic', () => {
    const p = producer('made_up_topic_xyz', { description: 'fallback copy' });
    expect(producerOneLiner(p)).toBe('fallback copy');
  });

  it('resolves the bare topic for a task_id_suffix producer (not the suffixed id)', () => {
    // `enrichment.open_loop_pressure.project` must look up the BARE topic
    // `open_loop_pressure`, not `open_loop_pressure.project` (which is not a
    // registry key and would fall back to the leaky description).
    const suffixed: HousekeepingTaskStatus = {
      meta: {
        id: 'enrichment.open_loop_pressure.project',
        description: 'engineering description that must NOT be shown',
        interruptible: true,
        kind: 'enrichment',
      },
      enrichment: { token_estimate_per_record: 300, source_collection_count: 5 },
    };
    const line = producerOneLiner(suffixed);
    expect(line).toBe('See where attention is needed without scanning every entity manually.');
    expect(line).not.toBe('engineering description that must NOT be shown');
  });
});

describe('R25 — filterProducers', () => {
  const llm = producer('thread_signals', { tokens: 250 });
  const computed = producer('zzz_computed_topic', { tokens: 0, description: 'plain deterministic rollup' });
  const all = [llm, computed];

  it('returns everything for empty search + cost=all', () => {
    expect(filterProducers(all, '', 'all')).toHaveLength(2);
  });

  it('cost=llm keeps only AI-surface producers (token estimate > 0)', () => {
    const out = filterProducers(all, '', 'llm');
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(llm);
  });

  it('cost=computed keeps only deterministic producers (token estimate = 0)', () => {
    const out = filterProducers(all, '', 'computed');
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(computed);
  });

  it('search matches the topic slug case-insensitively', () => {
    expect(filterProducers(all, 'THREAD', 'all')).toEqual([llm]);
  });

  it('search matches the user_value one-liner copy', () => {
    // "Triage" is in thread_signals' user_value, not its topic slug.
    const out = filterProducers(all, 'triage', 'all');
    expect(out).toEqual([llm]);
  });

  it('search matches the description fallback for unregistered topics', () => {
    const p = producer('zzz_custom', { description: 'unique-needle-token' });
    expect(filterProducers([p], 'unique-needle', 'all')).toEqual([p]);
  });

  it('combines search AND cost (intersection)', () => {
    // thread_signals matches "thread" but is LLM; asking for computed drops it.
    expect(filterProducers(all, 'thread', 'computed')).toHaveLength(0);
  });

  it('treats a producer with no enrichment info as deterministic (no crash)', () => {
    const bare: HousekeepingTaskStatus = {
      meta: { id: 'enrichment.bare', description: 'no enrichment field', interruptible: true, kind: 'enrichment' },
    };
    // cost=llm excludes it (isAiSurface false); cost=computed keeps it.
    expect(filterProducers([bare], '', 'llm')).toHaveLength(0);
    expect(filterProducers([bare], '', 'computed')).toHaveLength(1);
  });
});

describe('R25 — renderHousekeepingProducerFilterBar', () => {
  it('renders the search box with the current value + the 3 cost segments', () => {
    const html = renderHousekeepingProducerFilterBar({ search: 'inbox', cost: 'llm' });
    expect(html).toContain('data-action="housekeeping-producer-search"');
    expect(html).toContain('value="inbox"');
    for (const seg of ['all', 'llm', 'computed']) {
      expect(html).toContain(`data-cost="${seg}"`);
    }
    // The active cost segment is aria-pressed=true; exactly one is pressed.
    expect(html).toMatch(/data-cost="llm"[^>]*aria-pressed="true"/);
    expect((html.match(/aria-pressed="true"/g) ?? [])).toHaveLength(1);
  });

  it('escapes the search value (no attribute-breakout)', () => {
    const html = renderHousekeepingProducerFilterBar({ search: '"><x', cost: 'all' });
    expect(html).not.toContain('"><x');
    expect(html).toContain('&quot;&gt;&lt;x');
  });
});
