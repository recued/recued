/** Runs after every test file in the `backend-shared` vitest project, whose files share
 *  worker processes (`vitest.config.ts`).
 *
 *  ⛔ WHY. A composed server installs process-wide state that nothing removes: the
 *  vendor-alias resolver (`compose-app-context.ts`, into `@recued/contracts`'s
 *  `vendor-alias-registry.ts`) reads the database of the server that installed it. In a
 *  process of its own, no test file ever met another's; sharing one, the next file
 *  validated its recipes through a closed database ("The database connection is not
 *  open") — every one of the 252 tests in 46 files that failed in the 2026-10-09 pilot
 *  without this — and with the database still open it would have resolved against
 *  another test's packs. This puts back what isolation gave for free.
 *
 *  ⚠ A new process-wide setter in server composition needs a line here. The audit
 *  of 2026-10-09 found one that had none: the LLM substrate's learned endpoint
 *  capabilities (`wire-llm-substrate.ts`), which a composed boot hydrates from its
 *  database and which install a listener holding that server's config manager.
 *  A later file in the worker would have budgeted its prompts by what an earlier
 *  one learned about an endpoint they share. */
import { afterAll } from 'vitest';
import { setVendorAliasRegistryResolver } from '@recued/contracts';
import { onEndpointCapabilityLearned, resetEndpointCapabilities } from '@recued/llm';

afterAll(() => {
  setVendorAliasRegistryResolver(null);
  resetEndpointCapabilities();
  onEndpointCapabilityLearned(undefined);
});
