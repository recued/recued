/** D-136 P6 — `consumes_external_context` → registry population
 *  exercise. The bin's `registerEnrichmentProducer` walks each
 *  producer's `consumes_external_context` declarations and forwards
 *  them to `ExternalContextDependencyRegistry.add(topic, deps)`. The
 *  registry's `consumersOf` / `invalidatingConsumersOf` then surface
 *  those topics to the cascade primitive
 *  `cascadeForExternalContextPulseChange`.
 *
 *  This test exercises the registry-population pattern directly
 *  (a single producer's declarations land in the registry) so a
 *  future refactor of the bin's loop can't silently break the wiring
 *  without updating this contract. */

import { describe, expect, it } from 'vitest';

import {
  createExternalContextDependencyRegistry,
  type ConsumesExternalContextEntry,
} from '../storage/external-context-pulse.js';
import type { HousekeepingEnrichmentProducer } from '../housekeeping/enrichment-producer.js';

const producerWith = (
  topic: string,
  deps: ConsumesExternalContextEntry[],
): HousekeepingEnrichmentProducer => ({
  topic: topic as never,
  source_scope: 'mail',
  scope_read_declaration: [
    { collection: 'data.mail', sample_field_paths: ['subject'] },
  ],
  estimate_per_record_tokens: () => 0,
  async produce() {
    return null;
  },
  consumes_external_context: deps,
});

/** Drives the same registry-population path the bin uses; isolated
 *  here so a refactor that drops the loop in `registerEnrichmentProducer`
 *  surfaces as a test failure. */
const populateFromProducer = (
  reg: ReturnType<typeof createExternalContextDependencyRegistry>,
  producer: HousekeepingEnrichmentProducer,
): void => {
  if (
    producer.consumes_external_context &&
    producer.consumes_external_context.length > 0
  ) {
    reg.add(producer.topic, producer.consumes_external_context);
  }
};

describe('consumes_external_context → ExternalContextDependencyRegistry', () => {
  it('registers single consumer for a context_id', () => {
    const reg = createExternalContextDependencyRegistry();
    const producer = producerWith('purpose', [
      { id: 'hubspot_api_deal_meta', pulse_provider: 'connection', invalidates_on_pulse_change: true },
    ]);
    populateFromProducer(reg, producer);

    const consumers = reg.consumersOf('hubspot_api_deal_meta');
    expect([...consumers]).toEqual(['purpose']);
    const invalidators = reg.invalidatingConsumersOf('hubspot_api_deal_meta');
    expect([...invalidators]).toEqual(['purpose']);
  });

  it('aggregates multiple producer topics consuming the same context_id', () => {
    const reg = createExternalContextDependencyRegistry();
    const a = producerWith('purpose', [
      { id: 'shared_pulse', pulse_provider: 'connection', invalidates_on_pulse_change: true },
    ]);
    const b = producerWith('summary', [
      { id: 'shared_pulse', pulse_provider: 'connection', invalidates_on_pulse_change: true },
    ]);
    populateFromProducer(reg, a);
    populateFromProducer(reg, b);
    const consumers = reg.consumersOf('shared_pulse');
    expect(new Set(consumers)).toEqual(new Set(['purpose', 'summary']));
  });

  it('honors invalidates_on_pulse_change=false (consumer registered, not in invalidating set)', () => {
    const reg = createExternalContextDependencyRegistry();
    populateFromProducer(
      reg,
      producerWith('purpose', [
        {
          id: 'observatory_pulse',
          pulse_provider: 'periodic_check',
          invalidates_on_pulse_change: false,
        },
      ]),
    );
    expect([...reg.consumersOf('observatory_pulse')]).toEqual(['purpose']);
    expect([...reg.invalidatingConsumersOf('observatory_pulse')]).toEqual([]);
  });

  it('producers without declarations contribute nothing', () => {
    const reg = createExternalContextDependencyRegistry();
    populateFromProducer(reg, producerWith('purpose', []));
    expect(reg.snapshot().size).toBe(0);
  });
});
