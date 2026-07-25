/** D-164 P4f — `templates/` public surface.
 *
 *  Aggregates the body-render substrate (`./render-body.ts`) and the
 *  unified library (`./library.ts`) + adapts them to the gate's three
 *  injection contracts:
 *    - `TemplateMatcher` ← `TemplateLibrary.match`
 *    - `TemplateRenderer` ← `renderRenderTemplate` with a `kind` guard
 *      + a throw-to-pass-through adapter (gate's `empty-render` reason
 *      drives the safe fallback per design § 3 Invariant 7).
 *
 *  Bundle (`./bundle/*`) + audit-grown (`./audit-grow/*`) pools both
 *  ship with persistence + adapter substrate. Production boot wires
 *  the bundle pool via `loadBundlePool` + `createFileBundleStore`
 *  (P4g-2/3) and the audit-grown pool via `createFileAuditGrowStore`
 *  + `createStoreBackedAuditGrowFactory` (P4h-4b/5; per-pair FS
 *  persistence + live rebuild on promotion). The library doesn't
 *  care which pool a template came from — `createTemplateLibrary({pools:
 *  [bundlePool, auditPool]})` iterates them in order, first-match
 *  wins (bundle-first / audit-grown-second is the production order).
 *
 *  Production wiring (lands with the boot path at P5/P6):
 *    ```ts
 *    const library = createTemplateLibrary({ pools: [bundlePool, auditPool] });
 *    const deps: GateDeps = {
 *      matchTemplate: (q) => library.match(q),
 *      probeData: realDataPresenceProbe,
 *      renderTemplate: createTemplateRenderer(),
 *    };
 *    registerPromptCacheMiddleware(registry, deps);
 *    ```
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates. */

import type { DataSnapshot } from '../gate/data-presence.js';
import type { TemplateRenderer } from '../gate/index.js';
import { isRenderTemplate, type Template } from '../types.js';

import { renderRenderTemplate, TemplateRenderError } from './render-body.js';

export {
  TemplateRenderError,
  extractPlaceholderPaths,
  renderRenderTemplate,
} from './render-body.js';

export {
  CONTACT_ATTRIBUTE_TEMPLATES,
  matchContactAttributeTemplate,
  type ContactAttribute,
} from './contact-attribute.js';

export {
  CALENDAR_NEXT_MEETING_TEMPLATE,
  matchCalendarNextMeetingTemplate,
} from './calendar-next-meeting.js';

export {
  MAIL_FROM_COUNT_TEMPLATE,
  matchMailFromCountTemplate,
} from './mail-from-count.js';

export {
  CONTACT_HAS_EMAIL_TEMPLATE,
  CONTACT_HAS_NO_EMAIL_TEMPLATE,
  matchContactHasEmailTemplate,
} from './contact-has-email.js';

export {
  createTemplateLibrary,
  type CreateTemplateLibraryOptions,
  type RegisteredTemplate,
  type TemplateLibrary,
  type TemplateMatchQuery,
  type TemplatePool,
} from './library.js';

export {
  AUDIT_GROW_POOL_NAME,
  AuditGrowPoolError,
  AuditGrowStoreError,
  classifyReplayability,
  classifyReplayDiff,
  composePromotionKey,
  createAuditGrowPool,
  createFileAuditGrowStore,
  createPromotionTracker,
  createStoreBackedAuditGrowFactory,
  DEFAULT_NOVEL_TOKEN_MIN_LENGTH,
  DEFAULT_PROMOTION_THRESHOLD,
  DETERMINISTIC_STEP_KINDS,
  isDeterministicStepKind,
  parseAuditGrowSnapshot,
  validateAuditGrowEntry,
  type AuditGrowEntryAccepted,
  type AuditGrowEntryInput,
  type AuditGrowInvalidReason,
  type AuditGrowPoolEntryFailure,
  type AuditGrowPoolFailureReason,
  type AuditGrowRebuildErrorListener,
  type AuditGrowSnapshot,
  type AuditGrowStore,
  type AuditGrowStoreErrorReason,
  type AuditGrowStoreListener,
  type AuditGrowValidation,
  type ClassifyDiffInput,
  type ClassifyReplayabilityInput,
  type CreateAuditGrowPoolOptions,
  type CreateFileAuditGrowStoreOptions,
  type CreatePromotionTrackerOptions,
  type CreateStoreBackedAuditGrowFactoryOptions,
  type DeterministicStepKind,
  type DiffClassification,
  type DiffKind,
  type PromotionKeyInput,
  type PromotionTracker,
  type ReplayabilityClassification,
  type StoreBackedAuditGrowFactory,
} from './audit-grow/index.js';

export {
  BUNDLE_POOL_NAME,
  BundleFetchError,
  BundlePoolError,
  computeBundleEntryHash,
  createBundlePool,
  createFileBundleStore,
  createHttpBundleFetcher,
  createStoreBackedFetcher,
  defaultScheduler,
  loadBundlePool,
  parseBundleManifest,
  startBundlePoller,
  validateBundleEntry,
  type BundleEntryInput,
  type BundleFetcher,
  type BundleFetchErrorReason,
  type BundleHashInput,
  type BundleInvalidReason,
  type BundleManifest,
  type BundlePollerHandle,
  type BundlePoolEntryFailure,
  type BundlePoolFailureReason,
  type BundleStore,
  type BundleValidation,
  type CreateBundlePoolOptions,
  type CreateFileBundleStoreOptions,
  type CreateHttpBundleFetcherOptions,
  type CreateStoreBackedFetcherOptions,
  type HttpClient,
  type LoadBundlePoolOptions,
  type PollerScheduler,
  type StartBundlePollerOptions,
} from './bundle/index.js';

/** Build the gate's `TemplateRenderer` adapter. The adapter:
 *    - Returns `''` for any non-`render_template` (defense in depth —
 *      the gate's short-circuit-eligibility filter normally rejects
 *      these before render, but a misbehaving custom matcher could
 *      still hand a structural plan through; the adapter degrades to
 *      pass-through rather than crashing).
 *    - Catches `TemplateRenderError` thrown by `renderRenderTemplate`
 *      and returns `''` so the gate's `empty-render` pass-through path
 *      fires. The error is surfaced through the optional `onRenderError`
 *      hook for logging / cache eviction; the hook is wrapped in its
 *      own try/catch so a buggy logger can't crash the middleware
 *      pipeline.
 *    - Re-throws any non-`TemplateRenderError` (programming bugs in the
 *      template substrate or below); the gate / framework decides how
 *      to surface those.
 *
 *  Why catch-and-return-empty: the gate's `empty-render` pass-through
 *  is the safety net for any render path that can't produce clean text
 *  (malformed placeholder, missing snapshot data, non-string value).
 *  A throw out of the adapter would crash the middleware pipeline;
 *  empty-string keeps the framework on the safe LLM path for one more
 *  turn while logs surface the underlying template bug. */
export const createTemplateRenderer = (
  opts?: { readonly onRenderError?: (error: TemplateRenderError) => void },
): TemplateRenderer => {
  const onError = opts?.onRenderError;
  return (template: Template, snapshot: DataSnapshot): string => {
    if (!isRenderTemplate(template)) return '';
    try {
      return renderRenderTemplate(template, snapshot);
    } catch (err) {
      if (err instanceof TemplateRenderError) {
        if (onError !== undefined) {
          try {
            onError(err);
          } catch {
            // Hook failure must not escape the adapter — the gate's
            // pass-through is the safety net, but only fires when this
            // function returns a value. Swallowing keeps the pipeline
            // alive at the cost of the hook's diagnostic emission.
          }
        }
        return '';
      }
      throw err;
    }
  };
};
