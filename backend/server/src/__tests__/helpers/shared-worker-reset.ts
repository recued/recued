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
 *  one learned about an endpoint they share.
 *
 *  ⚠ 2026-10-10 — and the chat's per-session rolling brief and unfolded user
 *  statements (`chat-rolling-brief.ts`, module-level maps keyed by session id).
 *  A chat test that ended a session with a statement still unfolded left it for
 *  the next file using that session id: `d-164-phase-6-3-chat-orchestrator-ratchet`
 *  then found `pending_user_statements` in a packet it pins key by key, red in the
 *  sweep of `ec63b6afb` and green alone. Which files share a worker shifts as
 *  files are added, so the leak shows only on some commits.
 *
 *  ⚠ 2026-10-19 — and the folders' shared watch process
 *  (`collections/file/watch-host.ts`). Its closes run one at a time in that
 *  process, seconds each under load, so a file's closes would hold up the next
 *  file's watches. Letting it go is a few milliseconds. */
import { afterAll } from 'vitest';
import { setVendorAliasRegistryResolver } from '@recued/contracts';
import { onEndpointCapabilityLearned, resetEndpointCapabilities } from '@recued/llm';
import { __clearSessionBriefs, __clearUnfoldedUserMessages } from '../../chat-rolling-brief.js';
import { __stopSharedWatchHost } from '../../collections/file/watch-host.js';

afterAll(() => {
  setVendorAliasRegistryResolver(null);
  resetEndpointCapabilities();
  onEndpointCapabilityLearned(undefined);
  __clearSessionBriefs();
  __clearUnfoldedUserMessages();
  __stopSharedWatchHost();
});
