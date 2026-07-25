/** D-138 Phase 3 — A.10 upstream-re-merge cycle observer.
 *
 *  Watches platform-link changes ON the contact graph during a
 *  housekeeping cycle window. At cycle close, plausibility check
 *  walks the buffered events: when a `(canonical_email, vendor)`
 *  link was REMOVED and a `(rejected_partner_email, vendor)` link
 *  was ADDED inside the same cycle, the substrate fires a re-merge
 *  prompt. The prompt is durable until the user resolves it via
 *  `contact.merge.resolve_remerge_prompt`.
 *
 *  Cycle-window semantics intentional: a webhook delete that lands
 *  between cycles is NOT eligible for the prompt (per spec § A.10
 *  Reviewer #11 fix — between-cycle deletes are best-effort, the
 *  user fallback is the Rejected pairs UI).
 *
 *  This observer is a pure server-internal coordinator — no
 *  cross-cloud sync (D-097 / D-168), never reaches recipes, never
 *  crosses the MCP boundary. The single producer is the contact-store's
 *  `onPlatformLinkChanged` callback; the single consumer is the
 *  scheduler boundary (`beginCycle()` / `closeCycle()`).
 *
 *  Spec: D-138 § A.10. */

import { randomUUID } from 'node:crypto';

import type {
  PlatformLinkChange,
  ContactStore,
} from './storage/contact-store.js';
import type { ServerRemergePromptStore } from './contact-merge-prompt-store.js';
import type { EventBus } from './events/bus.js';

export interface CycleObserverDeps {
  store: ContactStore;
  promptStore: ServerRemergePromptStore;
  /** Optional bus emit for `kind: 'remerge_prompt'` notifications.
   *  Best-effort; missing bus → prompts persist to disk but no
   *  realtime fan-out. The Settings UI re-fetches via the pending
   *  list on open. */
  eventBus?: EventBus;
  /** Optional id factory — defaults to `randomUUID`. Tests pin this
   *  for deterministic prompt rows. */
  idFactory?: () => string;
  /** Optional clock — defaults to `Date.now`. */
  now?: () => number;
}

/** Public surface — the scheduler invokes `beginCycle` once at
 *  cycle start, `closeCycle` once at cycle end, and the contact-
 *  store's `onPlatformLinkChanged` hook calls `recordChange` between
 *  the two. Tests drive the same lifecycle directly. */
export interface ContactMergeCycleObserver {
  /** Reset the buffered change set. Called by the housekeeping
   *  scheduler at cycle start. Reentrant — re-entering before close
   *  drops any not-yet-flushed buffer. */
  beginCycle(): void;
  /** Buffer a platform-link change event. Called by the contact-
   *  store's `onPlatformLinkChanged` hook on every `linkPlatformId`
   *  / `unlinkPlatformId` transition. Outside an active cycle the
   *  call is a no-op (plausibility doesn't fire on between-cycle
   *  webhook deletes per spec § A.10 Reviewer #11). */
  recordChange(change: PlatformLinkChange): void;
  /** Run the plausibility check + emit prompts for any qualifying
   *  pair. Returns the count of prompts emitted (zero is the steady
   *  state — most cycles have no rejected-partner re-link in the
   *  same window). Called by the housekeeping scheduler at cycle
   *  end. Idempotent: re-calling without a `beginCycle` returns 0
   *  (buffer is empty). */
  closeCycle(): number;
  /** Test-only — snapshot the buffered changes. Not exposed via the
   *  scheduler boundary. */
  pendingChangesSnapshot(): ReadonlyArray<PlatformLinkChange>;
}

interface BufferedChange extends PlatformLinkChange {
  recorded_at: number;
}

export const createContactMergeCycleObserver = (
  deps: CycleObserverDeps,
): ContactMergeCycleObserver => {
  const idFactory = deps.idFactory ?? randomUUID;
  const now = deps.now ?? ((): number => Date.now());

  let active = false;
  const buffer: BufferedChange[] = [];

  return {
    beginCycle(): void {
      buffer.length = 0;
      active = true;
    },
    recordChange(change: PlatformLinkChange): void {
      if (!active) return;
      buffer.push({
        kind: change.kind,
        canonical_email: change.canonical_email,
        vendor: change.vendor,
        platform_id: change.platform_id,
        recorded_at: now(),
      });
    },
    closeCycle(): number {
      if (!active) return 0;
      active = false;
      if (buffer.length === 0) return 0;

      // Index events by vendor for the partner-side lookup. We only
      // care about the (vendor, canonical_email, kind) tuple — the
      // platform_id itself isn't load-bearing for plausibility (the
      // partner row gaining ANY same-vendor link is the signal).
      const removedByVendor = new Map<string, Set<string>>();
      const addedByVendor = new Map<string, Set<string>>();
      for (const ev of buffer) {
        const map = ev.kind === 'removed' ? removedByVendor : addedByVendor;
        let set = map.get(ev.vendor);
        if (!set) {
          set = new Set<string>();
          map.set(ev.vendor, set);
        }
        set.add(ev.canonical_email);
      }

      let firedCount = 0;
      for (const [vendor, removedEmails] of removedByVendor.entries()) {
        const addedEmails = addedByVendor.get(vendor);
        if (!addedEmails || addedEmails.size === 0) continue;
        for (const removedEmail of removedEmails) {
          // The row that lost the platform_id may itself have been
          // tombstoned (merged into the partner via a Recued-side
          // merge). Skip — the redirect chain handles that path.
          const affected = deps.store.get(removedEmail);
          if (!affected) continue;
          if (affected.merged_into) continue;

          const rejectedPartners = affected.rejected_pairs ?? [];
          if (rejectedPartners.length === 0) continue;

          for (const partnerEmail of rejectedPartners) {
            if (!addedEmails.has(partnerEmail)) continue;
            // Same-vendor link arrived on the rejected partner inside
            // this cycle. Plausibility holds — fire a prompt.
            const partner = deps.store.get(partnerEmail);
            if (!partner) continue;
            if (partner.merged_into) continue;

            const promptId = idFactory();
            try {
              const row = deps.promptStore.record({
                id: promptId,
                affected_email: removedEmail,
                partner_email: partnerEmail,
                vendor,
                fired_at: now(),
              });
              try {
                deps.eventBus?.emit({
                  kind: 'remerge_prompt',
                  prompt_id: row.id,
                  affected_email: row.affected_email,
                  partner_email: row.partner_email,
                  vendor: row.vendor,
                });
              } catch { /* best-effort */ }
              firedCount += 1;
            } catch { /* duplicate / store error: skip */ }
          }
        }
      }

      buffer.length = 0;
      return firedCount;
    },
    pendingChangesSnapshot(): ReadonlyArray<PlatformLinkChange> {
      return buffer.map((ev) => ({
        kind: ev.kind,
        canonical_email: ev.canonical_email,
        vendor: ev.vendor,
        platform_id: ev.platform_id,
      }));
    },
  };
};
