/** D-182 slice 3a — kernel op registry.
 *
 *  Pins the per-op enumeration of the Tier-K closed-kind kernel ops: every
 *  `core.<domain>.<op>` is well-formed (the load-bearing SLUG_RE legality
 *  check) and lands in a registered closed-kind domain; the ai dedup rule; the
 *  per-domain coverage + counts; the load-time
 *  integrity assertion (positive + each negative branch). The risk-vs-backing-manifest
 *  drift guard now lives in backend/server (the manifests are inlined there). */

import { describe, expect, it } from 'vitest';
import {
  KERNEL_OP_REGISTRY,
  type KernelOpEntry,
  getKernelOp,
  isNativeKernelOp,
  isRegisteredKernelOp,
  kernelOpsInDomain,
  kernelOpBackingSlug,
  kernelOpForBackingSlug,
  assertKernelOpRegistry,
} from '../kernel-op-registry.js';
import { parseOpId } from '../op-model.js';
import { KERNEL_DOMAINS, getKernelDomain } from '../kernel-ops.js';
import { CORE_CAPABILITY_SLUGS, stripCorePrefix } from '../core-pack.js';

/** The expected per-domain op counts — a snapshot so an accidental add/drop is
 *  caught (the test asserts their sum equals the live registry length). NATIVE
 *  (backing-slug-less) verb-ops: `data` +3
 *  (`core.data.enrichment.{read,vector-search,describe}`, slice 3), `contact` +1
 *  (`core.contact.engagements.read`, slice 3b), `audit` +1
 *  (`core.audit.read`, slice 3b — renamed from `core.memory.audit.read`), and
 *  `customer` +1 (`core.customer.status`, D-196 S2b). */
const EXPECTED_DOMAIN_COUNTS: Record<string, number> = {
  ai: 11,
  mail: 9, // D-210 §7 — + core.mail.notify-booking-visitor
  contact: 3,
  customer: 1,
  notification: 1,
  // D-192 F1 added core.work-entity.commitment.propose (the review-then-
  // approve proposal surface). 2026-07-16 added the NATIVE `core.work-entity.read`
  // verb-op (15 writes → +1 read): the domain's READ half had no grant handle at
  // all, so `work.search` / `work.read` were default-ON for every door.
  // D-210 added the 3 `core.work-entity.booking.*` CRUD ops (16 → 19).
  'work-entity': 19,
  // D-198 follow-on — `core.memory.audit.read` moved OUT of `memory` (13→12)
  // into its own `audit` domain: run history is not the knowledge pool.
  memory: 12,
  audit: 1,
  data: 17,
  webhook: 1,
  storage: 18,
  schedule: 1,
  // D-207 §4.5 — 14 offer/order + the 4 D-196 `customer-access` ops merged in
  // from their retired top-level domain (`core.seller.customer-access.*`), + the
  // `order.link-customer` edge that binds a paid order to the customer it issued,
  // + the D-196 ingress `tier.get`/`tier.list` vendor-neutral reads, + the D-196
  // renewal `order.confirm-renewal-payment` (the second specialized `paid`
  // writer — an invoice-keyed renewal order cannot satisfy the session-shaped
  // confirm's correlation honestly).
  seller: 22,
  watch: 8,
  dom: 2,
};

describe('D-182 slice 3a — kernel op registry', () => {
  it('every op is a well-formed closed-kind kernel op whose domain matches', () => {
    for (const e of KERNEL_OP_REGISTRY) {
      const parsed = parseOpId(e.op);
      expect(parsed, e.op).not.toBeNull();
      expect(parsed?.tier, e.op).toBe('kernel');
      if (parsed?.tier === 'kernel') {
        expect(parsed.domain, e.op).toBe(e.domain);
      }
      const dom = getKernelDomain(e.domain);
      expect(dom, e.op).toBeDefined();
      expect(dom?.class, e.op).toBe('closed_kind');
      // D-187 slice 3 — an ORDINARY op carries a non-empty backing slug; a NATIVE
      // verb-op carries none (no backing ingredient) but still lives in a closed-kind
      // domain (assertion item 2 above still holds for it).
      if (e.native === true) {
        expect(e.backing_slug, e.op).toBeUndefined();
      } else {
        expect((e.backing_slug ?? '').length, e.op).toBeGreaterThan(0);
      }
    }
  });

  it('op ids are unique', () => {
    const ids = KERNEL_OP_REGISTRY.map((e) => e.op);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the registered op id uses the hyphenated verb segment; the underscore form parses but is not registered', () => {
    // the multi-word verb survives as a hyphenated segment …
    expect(parseOpId('core.work-entity.task.mark-done')?.tier).toBe('kernel');
    expect(isRegisteredKernelOp('core.work-entity.task.mark-done')).toBe(true);
    // … the underscore form PARSES post-`17f3e9c0` (the OPERATION-remainder
    // segment admits `_` — the `ledger_account` gap fix, `OP_SEGMENT_RE`) but
    // is NOT in the registry, which keys the canonical hyphenated `mark-done`.
    expect(parseOpId('core.work-entity.task.mark_done')?.tier).toBe('kernel');
    expect(isRegisteredKernelOp('core.work-entity.task.mark_done')).toBe(false);
  });

  it('lookup helpers resolve / reject as expected', () => {
    expect(getKernelOp('core.mail.get')?.backing_slug).toBe('mail-get');
    expect(kernelOpBackingSlug('core.notification.send')).toBe('core-notification-send');
    // a canonical-convention op is NOT in this registry (slice 2 handles it)
    expect(isRegisteredKernelOp('core.crm.deal.search')).toBe(false);
    expect(getKernelOp('core.crm.deal.search')).toBeUndefined();
    // malformed / unknown
    expect(getKernelOp('garbage')).toBeUndefined();
    expect(kernelOpBackingSlug('core.mail.nope')).toBeUndefined();
  });

  it('kernelOpForBackingSlug inverts kernelOpBackingSlug (slice 2b reverse map)', () => {
    // known backing slugs → their core.* op id (the value a simple-form kernel
    // dispatch recovers at the gateway, having no surface op key)
    expect(kernelOpForBackingSlug('mail-send')).toBe('core.mail.send');
    expect(kernelOpForBackingSlug('data-file-read')).toBe('core.storage.data-file-read');
    expect(kernelOpForBackingSlug('core-ai-classify')).toBe('core.ai.classify');
    // a non-kernel / unknown slug → undefined (stays op-unprovable → fail-closed)
    expect(kernelOpForBackingSlug('not-a-kernel-slug')).toBeUndefined();
    expect(kernelOpForBackingSlug('')).toBeUndefined();
    // exact inverse of kernelOpBackingSlug for every ORDINARY (ingredient-backed) op
    // (round-trip). NATIVE verb-ops carry no slug → excluded from the reverse map.
    for (const e of KERNEL_OP_REGISTRY) {
      if (e.native === true) {
        // a native op resolves to NO backing slug, and nothing reverse-maps to it
        expect(kernelOpBackingSlug(e.op), e.op).toBeUndefined();
        continue;
      }
      expect(kernelOpForBackingSlug(e.backing_slug!), e.op).toBe(e.op);
      expect(kernelOpBackingSlug(e.op), e.op).toBe(e.backing_slug);
    }
  });

  it('per-domain counts match the snapshot; convention/unknown domains are empty', () => {
    for (const [domain, count] of Object.entries(EXPECTED_DOMAIN_COUNTS)) {
      expect(kernelOpsInDomain(domain).length, domain).toBe(count);
    }
    expect(KERNEL_OP_REGISTRY.length).toBe(
      Object.values(EXPECTED_DOMAIN_COUNTS).reduce((a, b) => a + b, 0),
    );
    expect(kernelOpsInDomain('crm')).toEqual([]); // canonical convention — slice 2
    expect(kernelOpsInDomain('acct')).toEqual([]);
    expect(kernelOpsInDomain('nope')).toEqual([]);
  });

  it('registry identity is frozen (catches an in-domain swap / rename / backing-slug change)', () => {
    // `<op>|<domain>|<backing_slug>|<risk>`, sorted. The per-domain counts above
    // catch an add/drop; this pins identity so a same-count substitution (a
    // rename, a backing-slug swap, a risk change) can't slip through silently.
    // approval is not a field — it derives at the enforcement point (see the
    // retirement pin below).
    // Regenerate deliberately when the kernel op surface intentionally changes.
    const FROZEN = [
      'core.ai.classify|ai|core-ai-classify|read',
      'core.ai.compare|ai|core-ai-compare|read',
      'core.ai.embed|ai|core-ai-embed|read',
      'core.ai.extract|ai|core-ai-extract|read',
      'core.ai.generate|ai|core-ai-generate|read',
      'core.ai.prompt|ai|core-ai-prompt|read',
      'core.ai.rewrite|ai|core-ai-rewrite|read',
      'core.ai.score|ai|core-ai-score|read',
      'core.ai.sentiment|ai|core-ai-sentiment|read',
      'core.ai.summarize|ai|core-ai-summarize|read',
      'core.ai.translate|ai|core-ai-translate|read',
      // D-187 slice 3b — NATIVE verb-op for `recued_getAudit`. D-198 follow-on
      // moved it OUT of the `memory` domain (it was `core.memory.audit.read`):
      // run history is its own kernel surface, not the knowledge pool.
      'core.audit.read|audit|(native)|read',
      // D-187 slice 3b — NATIVE verb-op for `recued_contactEngagementsList`.
      'core.contact.engagements.read|contact|(native)|read',
      'core.contact.resolve|contact|contact-resolve|read',
      'core.contact.upsert|contact|contact-upsert|write',
      'core.customer.status|customer|(native)|read',
      'core.data.calendar.create|data|calendar-create|write',
      'core.data.calendar.delete|data|calendar-delete|destructive',
      'core.data.calendar.get|data|calendar-get|read',
      'core.data.calendar.list|data|calendar-list|read',
      'core.data.calendar.rsvp|data|calendar-rsvp|write',
      'core.data.calendar.search|data|calendar-search|read',
      'core.data.calendar.stat|data|calendar-stat|read',
      'core.data.calendar.update|data|calendar-update|write',
      // D-187 slice 3 — NATIVE verb-ops: no backing ingredient (rendered `(native)`).
      'core.data.enrichment.describe|data|(native)|read',
      'core.data.enrichment.list|data|enrichment-list|read',
      'core.data.enrichment.read|data|(native)|read',
      'core.data.enrichment.upsert|data|enrichment-upsert|write',
      'core.data.enrichment.vector-search|data|(native)|read',
      'core.data.form-response.get|data|form-response-get|read',
      // D-210 A.8 slice 2 — the lifecycle write. `write`, not `read`: it moves
      // a visitor's state and must sit behind the same approval a write gets.
      'core.data.form-response.set-state|data|form-response-set-state|write',
      'core.data.webhook.get|data|webhook-get|read',
      'core.data.webhook.list|data|webhook-list|read',
      'core.dom.read|dom|dom-read|read',
      'core.dom.write|dom|dom-write|write',
      'core.mail.body-read|mail|mail-body-read|read',
      'core.mail.email.get|mail|email-get|read',
      'core.mail.email.list|mail|email-list|read',
      'core.mail.email.search|mail|email-search|read',
      'core.mail.get|mail|mail-get|read',
      'core.mail.notify-booking-visitor|mail|notify-booking-visitor|write',
      'core.mail.send|mail|mail-send|write',
      'core.mail.sent.reconcile|mail|mail-sent-reconcile|write',
      'core.mail.thread-read|mail|mail-thread-reader|read',
      'core.memory.annotate|memory|data-annotate|write',
      'core.memory.annotation.create|memory|annotation-create|write',
      'core.memory.annotation.delete|memory|annotation-delete|write',
      'core.memory.annotation.list|memory|annotation-list|read',
      'core.memory.annotation.search|memory|annotation-search|read',
      'core.memory.link.create|memory|link-create|write',
      'core.memory.link.delete|memory|link-delete|write',
      'core.memory.link.list|memory|link-list|read',
      'core.memory.link|memory|data-link|write',
      // D-198 Slice 4 — NATIVE collective-memory write/read verb-ops.
      'core.memory.read|memory|(native)|read',
      'core.memory.timeline.read|memory|timeline-read|read',
      'core.memory.write|memory|(native)|write',
      'core.notification.send|notification|core-notification-send|write',
      'core.schedule.recipe|schedule|schedule-recipe|write',
      // D-207 §4.5 — the op path moved under `seller`; the backing capability
      // slug (`customer-access-*`) is deliberately unchanged.
      'core.seller.customer-access.close|seller|customer-access-close|write',
      'core.seller.customer-access.extend|seller|customer-access-extend|write',
      'core.seller.customer-access.issue|seller|customer-access-issue|write',
      'core.seller.customer-access.swap-tier|seller|customer-access-swap-tier|write',
      'core.seller.offer.attach-fulfillment|seller|seller-offer-attach-fulfillment|write',
      'core.seller.offer.ensure|seller|seller-offer-ensure|write',
      'core.seller.offer.get|seller|seller-offer-get|read',
      'core.seller.offer.list|seller|seller-offer-list|read',
      'core.seller.order.attach-artifact|seller|seller-order-attach-artifact|write',
      'core.seller.order.attach-payment|seller|seller-order-attach-payment|write',
      'core.seller.order.confirm-payment|seller|seller-order-confirm-payment|write',
      'core.seller.order.confirm-refund|seller|seller-order-confirm-refund|write',
      'core.seller.order.confirm-renewal-payment|seller|seller-order-confirm-renewal-payment|write',
      'core.seller.order.get|seller|seller-order-get|read',
      'core.seller.order.link-customer|seller|seller-order-link-customer|write',
      'core.seller.order.link-work-entity|seller|seller-order-link-work-entity|write',
      'core.seller.order.list|seller|seller-order-list|read',
      'core.seller.order.open|seller|seller-order-open|write',
      'core.seller.order.quote|seller|seller-order-quote|write',
      'core.seller.order.transition|seller|seller-order-transition|write',
      'core.seller.tier.get|seller|seller-tier-get|read',
      'core.seller.tier.list|seller|seller-tier-list|read',
      'core.storage.data-file-read|storage|data-file-read|read',
      'core.storage.file.delete|storage|file-delete|destructive',
      'core.storage.file.get|storage|file-get|read',
      'core.storage.file.list|storage|file-list|read',
      'core.storage.file.move|storage|file-move|destructive',
      'core.storage.file.persist|storage|file-persist|write',
      'core.storage.file.read|storage|file-read|read',
      'core.storage.file.render-markdown-template|storage|file-render-markdown-template|write',
      'core.storage.file.set-scan-status|storage|file-set-scan-status|write',
      'core.storage.file.stat|storage|file-stat|read',
      'core.storage.file.write|storage|file-write|write',
      'core.storage.shared.compare-and-set|storage|shared-compare-and-set|write',
      'core.storage.shared.delete-prefix|storage|shared-delete-prefix|destructive',
      'core.storage.shared.delete|storage|shared-delete|write',
      'core.storage.shared.list|storage|shared-list|read',
      'core.storage.shared.read|storage|shared-read|read',
      'core.storage.shared.search|storage|shared-search|read',
      'core.storage.shared.write|storage|shared-write|write',
      'core.watch.calendar|watch|calendar-watcher|read',
      'core.watch.file|watch|file-watcher|read',
      'core.watch.http|watch|http-watcher|read',
      'core.watch.mail|watch|mail-watcher|read',
      'core.watch.recipe|watch|recipe-watcher|read',
      'core.watch.time-relative|watch|time-relative-watcher|read',
      'core.watch.time|watch|time-watcher|read',
      'core.watch.webhook|watch|webhook-watcher|read',
      'core.webhook.event.get|webhook|webhook-event-get|read',
      'core.work-entity.booking.create|work-entity|booking-create|write',
      'core.work-entity.booking.delete|work-entity|booking-delete|destructive',
      'core.work-entity.booking.update|work-entity|booking-update|write',
      'core.work-entity.commitment.cancel|work-entity|commitment-cancel|write',
      'core.work-entity.commitment.create|work-entity|commitment-create|write',
      'core.work-entity.commitment.fulfill|work-entity|commitment-fulfill|write',
      // D-192 F1 — the always-held proposal surface (all-actor approval lift).
      'core.work-entity.commitment.propose|work-entity|commitment-propose|write',
      'core.work-entity.commitment.update|work-entity|commitment-update|write',
      'core.work-entity.note.create|work-entity|note-create|write',
      'core.work-entity.note.delete|work-entity|note-delete|destructive',
      'core.work-entity.note.update|work-entity|note-update|write',
      'core.work-entity.project.archive|work-entity|project-archive|write',
      'core.work-entity.project.create|work-entity|project-create|write',
      'core.work-entity.project.update|work-entity|project-update|write',
      // 2026-07-16 — NATIVE verb-op for the Tier-1 `work.search` / `work.read`
      // tools. The domain's 15 writes each had a grant handle; its READS had
      // none, so they were default-ON for every door.
      'core.work-entity.read|work-entity|(native)|read',
      'core.work-entity.task.create|work-entity|task-create|write',
      'core.work-entity.task.delete|work-entity|task-delete|destructive',
      'core.work-entity.task.mark-done|work-entity|task-mark-done|write',
      'core.work-entity.task.update|work-entity|task-update|write',
    ];
    const actual = KERNEL_OP_REGISTRY.map(
      (e) => `${e.op}|${e.domain}|${e.backing_slug ?? '(native)'}|${e.risk}`,
    ).sort();
    expect(actual).toEqual(FROZEN);
  });

  it('every closed-kind kernel domain has at least one op (no orphan domain)', () => {
    for (const d of KERNEL_DOMAINS) {
      if (d.class !== 'closed_kind') continue;
      expect(kernelOpsInDomain(d.domain).length, d.domain).toBeGreaterThan(0);
    }
  });

  it('ai dedup rule: core.ai.* backs core-ai-* (a CORE_CAPABILITY_SLUGS member); embed included (D-174 R28)', () => {
    const aiOps = kernelOpsInDomain('ai');
    expect(aiOps.length).toBe(11);
    for (const e of aiOps) {
      // ai ops are all ordinary (ingredient-backed) — never native.
      expect(e.native ?? false, e.op).toBe(false);
      expect(e.backing_slug, e.op).toBeDefined();
      expect(e.backing_slug!.startsWith('core-ai-'), e.op).toBe(true);
      expect(CORE_CAPABILITY_SLUGS.has(stripCorePrefix(e.backing_slug!)), e.op).toBe(true);
      expect(e.risk).toBe('read');
    }
    // D-174 R28 — ai-embed IS now a kernel op (Slice C built the embeddings slot;
    // `core.ai.embed` routes to the embeddings executor).
    expect(isRegisteredKernelOp('core.ai.embed')).toBe(true);
  });

  it('the shipped registry uses only read/write/destructive risk (no admin)', () => {
    for (const e of KERNEL_OP_REGISTRY) {
      expect(['read', 'write', 'destructive'], e.op).toContain(e.risk);
    }
  });

  // D-209 §5b follow-on — the retirement's regression pin. `KernelOpEntry.approval`
  // + `kernelApprovalForRisk` were a SECOND approval derivation, parked beside the
  // registry it described and DISAGREEING with the enforced `RISK_APPROVAL_FLOOR`
  // on admin + destructive. Nothing read the field, so the divergence was dormant —
  // the hazard was a correct-looking `if (op.approval)` plumb, which would have made
  // a destructive kernel op admit SILENTLY under an `admin` ceiling. Approval now
  // derives at the enforcement point only.
  // ⚠ `toMatchObject` / `objectContaining` CANNOT prove a key is absent — `hasOwn` can.
  it('no entry carries an approval field (the retired second derivation)', () => {
    for (const e of KERNEL_OP_REGISTRY) {
      expect(Object.hasOwn(e, 'approval'), e.op).toBe(false);
    }
  });

  // Risk-vs-backing-manifest drift guard moved to
  // backend/server/src/__tests__/kernel-manifests.test.ts — the backing manifests are now inlined
  // in KERNEL_MANIFESTS (outside the contracts boundary; community/ no longer holds them).

  describe('D-187 slice 3 — native verb-ops', () => {
    const NATIVE_OPS = [
      'core.data.enrichment.read',
      'core.data.enrichment.vector-search',
      'core.data.enrichment.describe',
    ] as const;
    // timeline reuses the EXISTING ordinary op (not a new native id).
    const TIMELINE_VERB_OP = 'core.memory.timeline.read';

    it('registers the 3 new native verb-ops as native, with no backing slug', () => {
      for (const op of NATIVE_OPS) {
        expect(isRegisteredKernelOp(op), op).toBe(true);
        expect(isNativeKernelOp(op), op).toBe(true);
        expect(getKernelOp(op)?.native, op).toBe(true);
        expect(getKernelOp(op)?.backing_slug, op).toBeUndefined();
        // a native op has no backing slug → never recovered via the reverse map,
        // and resolves to no slug via the forward getter.
        expect(kernelOpBackingSlug(op), op).toBeUndefined();
        // read risk, like the other enrichment reads — which the enforced floor
        // maps to `never`. The tier IS the claim; nothing stores the approval.
        expect(getKernelOp(op)?.risk, op).toBe('read');
      }
    });

    it('timeline reuses the existing ordinary op (NOT a native op)', () => {
      expect(isRegisteredKernelOp(TIMELINE_VERB_OP)).toBe(true);
      expect(isNativeKernelOp(TIMELINE_VERB_OP)).toBe(false);
      expect(kernelOpBackingSlug(TIMELINE_VERB_OP)).toBe('timeline-read');
    });

    it('every ordinary (ingredient-backed) op is NOT native', () => {
      for (const e of KERNEL_OP_REGISTRY) {
        if (e.native === true) continue;
        expect(isNativeKernelOp(e.op), e.op).toBe(false);
      }
    });

    it('isNativeKernelOp is false for an unregistered / convention op', () => {
      expect(isNativeKernelOp('core.crm.deal.search')).toBe(false);
      expect(isNativeKernelOp('garbage')).toBe(false);
    });
  });

  describe('assertKernelOpRegistry', () => {
    const ok: KernelOpEntry = {
      op: 'core.mail.get',
      domain: 'mail',
      backing_slug: 'mail-get',
      risk: 'read',
    };
    const okNative: KernelOpEntry = {
      op: 'core.data.enrichment.read',
      domain: 'data',
      risk: 'read',
      native: true,
    };

    it('passes for the shipped registry', () => {
      expect(() => assertKernelOpRegistry()).not.toThrow();
    });

    it('rejects a malformed op id', () => {
      expect(() => assertKernelOpRegistry([{ ...ok, op: 'core.mail' }])).toThrow(/malformed/);
    });

    it('rejects a domain-segment / declared-domain mismatch', () => {
      expect(() => assertKernelOpRegistry([{ ...ok, domain: 'storage' }])).toThrow(/!= declared/);
    });

    it('rejects a non-closed-kind (canonical-convention) domain', () => {
      expect(() =>
        assertKernelOpRegistry([
          { op: 'core.crm.deal.search', domain: 'crm', backing_slug: 'x', risk: 'read' },
        ]),
      ).toThrow(/closed-kind/);
    });

    it('rejects an empty backing_slug (ordinary op)', () => {
      expect(() => assertKernelOpRegistry([{ ...ok, backing_slug: '' }])).toThrow(/backing_slug/);
    });

    it('accepts a native op with no backing_slug', () => {
      expect(() => assertKernelOpRegistry([okNative])).not.toThrow();
    });

    it('rejects a native op that declares a backing_slug', () => {
      // a native op must NOT carry a slug (it has no backing ingredient + must stay
      // out of the reverse map).
      expect(() =>
        assertKernelOpRegistry([{ ...okNative, backing_slug: 'enrichment-list' }]),
      ).toThrow(/native op .* must not declare a backing_slug/);
    });

    it('accepts MULTIPLE native ops (slug-uniqueness exempt — they share the absent slug)', () => {
      const a: KernelOpEntry = { ...okNative, op: 'core.data.enrichment.read' };
      const b: KernelOpEntry = { ...okNative, op: 'core.data.enrichment.describe' };
      expect(() => assertKernelOpRegistry([a, b])).not.toThrow();
    });

    it('still rejects a native op in a NON-closed-kind domain (item 2 holds for native)', () => {
      expect(() =>
        assertKernelOpRegistry([
          { op: 'core.crm.deal.search', domain: 'crm', risk: 'read', native: true },
        ]),
      ).toThrow(/closed-kind/);
    });

    it('rejects a duplicate op id', () => {
      expect(() => assertKernelOpRegistry([ok, ok])).toThrow(/duplicate/);
    });

    it('rejects distinct ops sharing one backing_slug (slice 2b reverse-map collision guard)', () => {
      // two DIFFERENT ops with the SAME backing slug — the slice-2b reverse map
      // (backing_slug → op) would silently drop one. Distinct op ids so the
      // duplicate-op-id check passes first (the slug guard is ordered AFTER it).
      const a: KernelOpEntry = { ...ok, op: 'core.mail.get', backing_slug: 'shared-slug' };
      const b: KernelOpEntry = { ...ok, op: 'core.mail.body-read', backing_slug: 'shared-slug' };
      expect(() => assertKernelOpRegistry([a, b])).toThrow(/backing_slug/);
      expect(() => assertKernelOpRegistry([a, b])).toThrow(/unique/);
    });

    it('a fully-duplicate entry reports as a duplicate op id, not a slug collision (guard ordering)', () => {
      // [ok, ok] shares BOTH op id and backing slug; the op-id check must win so
      // the existing /duplicate op id/ contract holds (the slug guard runs after).
      expect(() => assertKernelOpRegistry([ok, ok])).toThrow(/duplicate op id/);
    });
  });
});
