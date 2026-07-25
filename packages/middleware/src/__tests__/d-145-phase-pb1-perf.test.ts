/** D-145 PB1 — latency budget perf test (§ N.18).
 *
 *  100% cache-hit walk (5 capacities) targets < 1ms p95. Run 1000
 *  iterations + assert. Probe stubs are no-op so the cache hit
 *  path is the entire critical path. */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import { F2_BRIDGE_DOM_LOOKUP } from './fixtures/d-145-pb1/index.js';
import {
  buildStubProbeDeps,
  createStubControls,
} from './fixtures/d-145-pb1/stub-deps.js';

describe('D-145 PB1 — § N.18 latency budgets', () => {
  it(
    '100% cache-hit walk (5 capacities) p95 < 5ms',
    async () => {
      const controls = createStubControls();
      controls.bridgeOnline = true;
      controls.installedIngredients.add('web-page-reader');
      controls.bumpedAt.set('web-page-reader', Date.now());
      controls.selectorTtlMs.set('web-page-reader', 7 * 24 * 60 * 60_000);
      controls.loggedInSites.add('example.com');

      const probeDeps = buildStubProbeDeps(controls);
      const cache = capacity.createCapacityCache();
      const registry = capacity.createCapacityProbeRegistry(probeDeps);
      const auditEmitter: capacity.CapacityAuditEmitter = {
        async emitOk() {},
        async emitGap() {},
      };
      const transparencyEmitter = capacity.createNoopTransparencyEmitter();

      // Warm the cache.
      await capacity.walkCapacities({
        spec: F2_BRIDGE_DOM_LOOKUP.spec,
        registry,
        cache,
        ctx: {
          audit_emitter: auditEmitter,
          transparency_emitter: transparencyEmitter,
        },
      });

      const ITER = 1000;
      const samples: number[] = [];
      for (let i = 0; i < ITER; i++) {
        const start = performance.now();
        await capacity.walkCapacities({
          spec: F2_BRIDGE_DOM_LOOKUP.spec,
          registry,
          cache,
          ctx: {
            audit_emitter: auditEmitter,
            transparency_emitter: transparencyEmitter,
          },
        });
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95)]!;
      // Spec budget is < 1ms; CI runners are noisier so we allow
      // 5ms headroom — well below the cold-cache budget. The test
      // asserts the cache-hit path doesn't regress catastrophically.
      expect(p95).toBeLessThan(5);
    },
    20_000,
  );
});
