/** The boot re-derives of 2026-10-10 are REACHABLE from production composition.
 *
 *  `rederiveWebhookDoorsAtBoot` and `rederiveReceptionDoorsAtBoot` are driven over real
 *  stores in `webhook-door-boot-rederive.test.ts` / `reception-door-boot-rederive.test.ts`,
 *  and neither file can see whether the server ever CALLS them: the composition roots
 *  run them inside conditional blocks no type checks. Disabling either call, or the
 *  manage door's re-derive, left every behavioural suite green (mutation-checked). So,
 *  as `d-240-slice3b-lookup-door-bind` does for its runner, the wiring is asserted at
 *  the source — the call, its argument, and (for the webhook) that it runs before the
 *  outbox claims a delivery. ⚠ A source ratchet proves the call is there and is not
 *  switched off; it cannot prove the deps it passes are right. Those are the deps every
 *  other door path in the same file already reads. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the door boot re-derives are wired into production composition', () => {
  it('compose-listeners re-derives every webhook door before the outbox starts', () => {
    const src = read('../serve/compose-listeners.ts');
    const call = src.search(
      /if \(webhookDoorDeps && app\.webhookConsumerStoreRef\) \{\s*const changes = rederiveWebhookDoorsAtBoot\(\{\s*\.\.\.webhookDoorDeps,/,
    );
    const start = src.indexOf('webhookOutboxRuntime?.start();');
    expect(call, 'the boot re-derive is not called under the door deps').toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(call, 'it must run before the outbox claims a delivery').toBeLessThan(start);
  });

  it('wire-reception-substrate re-derives every bound form and lookup door', () => {
    const src = read('../composition/bin/wire-reception-substrate.ts');
    expect(src).toMatch(/for \(const endpoint of registryStore\.list\(\)\) \{/);
    expect(src).toMatch(/bootDoors\.push\(\{ endpointId: endpoint\.endpoint_id, recipeId: intake\.binding\.recipe_id, link: pairStore \}\)/);
    expect(src).toMatch(/bootDoors\.push\(\{ endpointId: endpoint\.endpoint_id, recipeId: lookup\.recipe_id, link: lookupRecipePairStore \}\)/);
    expect(src).toMatch(/\brederiveReceptionDoorsAtBoot\(bootDoors, \{\s*\.\.\.bootBindDeps,/);
  });

  it('wire-reception-substrate re-mints the manage door when its derivation moved', () => {
    const src = read('../composition/bin/wire-reception-substrate.ts');
    expect(src).toMatch(/deriveRecipeCapability\(manageRecipe, \{[\s\S]{0,80}?kernelStepOps: true,\s*\}\)/);
    expect(src).toMatch(
      /if \(existing !== undefined && !doorCapabilityChanged\(existing, derived\.capability\)\.changed\) \{\s*manageContractId = existing\.contract_id;/,
    );
  });
});
