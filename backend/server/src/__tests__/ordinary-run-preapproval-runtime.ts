/** D-201 Slice 10AZ (10AW finding 1) — the pre-approval runtime as the production
 *  server wires it (`composePreapproval`), for a run with no pre-approval: the
 *  answers the real runtime gives, pinned against it in `d-261-service.test.ts`.
 *
 *  ⛔ Without a runtime, `executeDeps.preapprovalRuntime?.resume(checkpoint)` is
 *  `undefined`; the production runtime answers `null`. The restart keeps tested
 *  `=== undefined`, so every test of them passed with no runtime wired while none
 *  of them ever ran on a production server. A harness that drives `resumeRun`
 *  wires this, so it reads what production reads.
 *
 *  Any other call belongs to a reviewed run, which an ordinary run never makes:
 *  it throws, so a harness that reaches one fails rather than reading a guess. */
import type { ExecuteHandlerDeps } from '../execute-handler.js';

type Runtime = NonNullable<ExecuteHandlerDeps['preapprovalRuntime']>;

/** What the real runtime answers an ordinary run, method by method. */
export const ORDINARY_RUN_PREAPPROVAL_ANSWERS = {
  resume: async () => null,
  assertEntry: async () => undefined,
  recordDispatchUse: () => false,
  canPublishCheckpoint: () => false,
  cancelCheckpoint: () => undefined,
} as const;

export const ordinaryRunPreapprovalRuntime = (): Runtime =>
  new Proxy(ORDINARY_RUN_PREAPPROVAL_ANSWERS, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (Object.hasOwn(target, key)) return target[key as keyof typeof target];
      // Not a thenable: awaiting the runtime itself reads it as a value.
      if (key === 'then') return undefined;
      throw new Error(`ordinary-run pre-approval runtime: '${key}' belongs to a reviewed run`);
    },
  }) as unknown as Runtime;
