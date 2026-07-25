/** D-172 P3 § A.5 / D-173 P5 § A.7 — reception `drop_link` submission processor.
 *
 *  Turns a persisted `reception_drop_blob_metadata` row (a visitor-
 *  uploaded file, bytes already in the warehouse CAS — D-172 A.1
 *  sink-swap) into a first-class `data.file.received` record. This is the
 *  third drain processor (alongside intake_form + approval_link); it
 *  mirrors their STRUCTURE — enumerate every endpoint of the kind (disabled
 *  + revoked included) → `listPendingForEndpoint` → dispatch review →
 *  `markProcessed` → optional seams.
 *
 *  D-173 P5 / D-210 Phase C — REVIEW IS THE ONLY PATH: ingest the file, then
 *  dispatch the compiled `review-then-approve` workflow so a
 *  `drop.materialize` op (a TASK with the file attached via
 *  `data.link role:'attachment'`) is HELD at the D-157 gate → Reception Inbox.
 *  The owner approves (materializing the task + attach) or rejects. The
 *  processor NEVER inline-materializes (no ambient write — I-1).
 *
 *  ⛔ `on_upload.auto_accept` was RETIRED (owner ruling, 2026-07-18) with the
 *  intake + approval_link flags, so inbox model "B" holds without exception.
 *
 *  SCAN GATE (N.2) is ADVISORY (D-173 P5 "A"): a drop ingests as
 *  `scan_status: 'unscanned'` and the inbox surfaces it as an attachment the
 *  admin attaches with an explicit `acknowledge_attachment_risk` (warn-and-confirm,
 *  NOT a hard block). Attaching ≠ executing; the gated `file.read` (D-172 A.8 / F2)
 *  stays the egress boundary. Part "B" landed: a ClamAV / Windows Defender scanner
 *  pack reactively writes `scan_status` to `clean` / `flagged` via
 *  `core.storage.file.set-scan-status`, and the inbox resolver does a LIVE read of
 *  it (`withLiveAttachmentScanStatus`) so the warning clears / sharpens. Absent a
 *  scanner pack, drops stay `unscanned` and the gate stays advisory.
 *
 *  Flow per pending drop blob:
 *    1. Parse the endpoint's `DropLinkConfig` — corrupt/unparseable → mark
 *       the row `failed` (retained for review; never retried forever).
 *    2. Decrypt the sealed visitor PII (email/name/description) for
 *       PROVENANCE ONLY. It NEVER enters the `data.file` record's
 *       queryable fields and is NEVER used to resolve or create a contact
 *       (D-149 N.6 / I-9). A LOCKED vault (the drop-PII getter throws
 *       `not_configured`) leaves the WHOLE tick's remaining rows PENDING
 *       (not `failed`) so a later drain retries after unlock — matching
 *       the intake_form discipline.
 *    3. If `on_upload.create_data_file_entity`: `ingest` the already-stored
 *       CAS blob into `received` via the storage_ref form (the metadata's
 *       `storage_path` is the CAS blob_hash post-A.1; `content_hash` +
 *       `size_bytes` + the server-detected MIME + sanitized filename ride
 *       along). `origin: 'reception_drop'`, `source_id: blob_id`. The
 *       record_id is deterministic from `(origin, source_id)` → a re-drain
 *       upserts the SAME record (crash-idempotent — D-172 I-2).
 *    4. Attach (PROCEEDS — never gated on scan_status):
 *       - `auto_attach_to_contact` + `contact_scoping?.contact_id` → resolve
 *         the PRE-BOUND contact via `getByContactId` (the substrate-stable
 *         id the user bound at link creation — NOT the visitor email),
 *         then `attachFile` to that contact's canonical email (the
 *         `data.contact.<email>` address). When `require_contact_email_match`
 *         is set, the visitor email is decrypted + compared to the bound
 *         contact's known email and the contact-attach is SKIPPED on
 *         mismatch (see § require_contact_email_match below). A new contact
 *         is NEVER resolved from the visitor email.
 *       - `auto_attach_to_project_id` → `attachFile` to that project.
 *    5. `markProcessed({ outcome: 'processed', data_file_entity_id: record_id,
 *       scan_status })`. When `create_data_file_entity` is false → no
 *       ingest / attach, still `markProcessed` (+ notify).
 *    6. Optional seams (mirror intake_form, swallowed on error): `notify`
 *       (after attach) + `runRecipe` (retired with `triggered_recipe_id`, with
 *       blob_id / endpoint_id / record_id / contact_id provenance).
 *
 *  ── `require_contact_email_match` enforcement ──────────────────────
 *  Investigated: the field is validated as a boolean in the config
 *  (`drop-link-config.ts`) but is NOT enforced anywhere at UPLOAD time —
 *  the upload handler (`handlers/drop-link.ts`) only domain-allowlist-
 *  gates the visitor email; it never compares it to the bound contact.
 *  The config comment claims "the engine reactive path uses
 *  `resolveContactIdentity` ... at attach time" — that path is THIS
 *  processor, and it didn't exist until now. So the match is enforced
 *  HERE: when `require_contact_email_match === true` we decrypt the
 *  visitor email, canonicalize both sides, and SKIP the contact-attach on
 *  mismatch (or when the visitor omitted an email). The file is still
 *  ingested + the project-attach (if any) still runs + the row is still
 *  marked processed — only the contact edge is withheld. We never use the
 *  visitor email to find a DIFFERENT contact (D-149 N.6 / I-9).
 *
 *  Spec: D-172 § A.5 / N.3 / I-1 / I-2; D-149
 *  § A.5.4 / N.6 / I-9 / Must Hold I-12. */

import { canonicalizeEmail, type DropLinkConfig } from '@recued/contracts';
import type {
  FireReceptionWorkflow,
  ReceptionDrainResult,
  ReceptionDrainTickInput,
  ReceptionSubmissionProcessor,
} from '../reception-drain.js';
import { openDropBlobPiiField } from '../drop-pii.js';
import { parseDropLinkConfig } from '../transformations/drop-link.js';
import type { ReceptionProjectionInput } from '../projection/reception-projection.js';
import type { DropBlobStore, DropBlobSummary } from '../../../storage/reception-drop-store.js';
import type { PublicEndpointRegistryStore } from '../../../storage/public-endpoint-registry-store.js';
import type {
  AttachFileArgs,
  AttachFileDeps,
  AttachFileResult,
} from '../../../collections/file/attach-file.js';
import type {
  DataFileRecord,
  InboundFileIngestInput,
} from '../../../collections/file/inbound-file-collection.js';

/** Narrow store slices — keep the processor decoupled + unit-fakeable,
 *  matching the intake_form processor's `Pick<...>` discipline. */
export type DropLinkDrainRegistry = Pick<PublicEndpointRegistryStore, 'list'>;
export type DropLinkDrainStore = Pick<
  DropBlobStore,
  'listPendingForEndpoint' | 'markProcessed'
>;

/** The `ingest` slice of the `received` inbound-file collection (D-172
 *  A.2). The drop blob is already in the CAS, so the processor calls the
 *  storage_ref form. */
export interface DropLinkFileIngestor {
  ingest(input: InboundFileIngestInput): Promise<DataFileRecord>;
}

/** Resolve the pre-bound contact's canonical email from the
 *  substrate-stable `contact_id` the endpoint config carries. Returns
 *  `null` when no contact carries the id (the bound contact was deleted /
 *  the id is stale). `data.contact.<email>` is the attach address, so the
 *  processor needs the email, not the id. (Pick over `ContactStore`.) */
export interface DropLinkContactResolver {
  /** `ContactStore.getByContactId` slice. */
  getByContactId(contact_id: string): { email: string } | null;
}

/** Effect seam fired after a drop blob materializes (mirrors the
 *  intake_form `notify` seam). Never throws into the drain (swallowed). */
export interface DropLinkMaterializeNotice {
  readonly endpoint_id: string;
  readonly kind: 'drop_link';
  readonly blob_id: string;
  readonly data_file_id: string | null;
  // D-210 Phase C — `notification_target` retired; the notice names no channel.
  readonly filename: string;
}

export interface DropLinkProcessorDeps {
  readonly registryStore: DropLinkDrainRegistry;
  readonly dropBlobStore: DropLinkDrainStore;
  /** Lazily-resolved drop-PII AEAD key. Throws `not_configured` (503)
   *  when the FileVault is locked — the processor treats that as a
   *  transient "leave pending" signal, NOT row corruption. */
  readonly getDropBlobPiiKey: () => Uint8Array;
  /** The `received` inbound-file collection (`ingest`). */
  readonly fileIngestor: DropLinkFileIngestor;
  /** `attachFile` deps (annotation store + collection registry). The
   *  processor calls the injected `attach` with these. */
  readonly attachDeps: AttachFileDeps;
  /** Injected `attachFile` fn (DI for unit fakes; production passes the
   *  real `attachFile`). */
  readonly attach: (args: AttachFileArgs, deps: AttachFileDeps) => Promise<AttachFileResult>;
  /** Resolve the pre-bound contact_id → canonical email. Optional: when
   *  absent, a `auto_attach_to_contact` config still ingests + project-
   *  attaches but skips the contact edge (the resolver is required to
   *  turn a contact_id into the attach email). */
  readonly contactResolver?: DropLinkContactResolver;
  readonly now: () => number;
  /** Optional — fired after each successful materialization. */
  readonly notify?: (notice: DropLinkMaterializeNotice) => void | Promise<void>;
  // D-210 Phase C — the `runRecipe` seam is GONE: it was auto-accept-only, and
  // that branch is retired. `on_upload.triggered_recipe_id` now has no reader.
  // (`notify` survives — the REVIEW path calls it.)
  /** D-173 P5 § A.7 — the review-then-approve dispatch seam (D-210 Phase C:
   *  the ONLY path). The upload is ingested into
   *  `data.file.received`, then the `drop.materialize` op (a task with the file
   *  attached) is HELD at the D-157 gate → Reception Inbox. Absent (boot phase
   *  before the engine composes, or no reception core-pack installed) ⇒ a
   *  review-mode drop is left `pending` to dispatch once the recipe lands
   *  (NEVER inline-materialized as a fallback — that would bypass review, I-1). */
  readonly fireReceptionWorkflow?: FireReceptionWorkflow;
}

/** The `received` slug the file collection registers under. The ingest
 *  record_id is per-ingest; we attach against the file's bare `'file'`
 *  platform name inside `attachFile`. */
const FILE_RECORD_ORIGIN = 'reception_drop' as const;

export const createDropLinkSubmissionProcessor = (
  deps: DropLinkProcessorDeps,
): ReceptionSubmissionProcessor => ({
  label: 'drop_link',
  drainOnce: async ({ now, limit }: ReceptionDrainTickInput): Promise<ReceptionDrainResult> => {
    let processed = 0;
    let failed = 0;
    let budget = limit;

    // Resolve the drop-PII key lazily + once per tick. A locked /
    // uninitialised FileVault makes the getter throw `not_configured`
    // (503). That MUST NOT be treated as row corruption: marking pending
    // rows `failed` would lose valid uploads on the fire-immediate boot
    // drain (vault not yet unlocked). On key-unavailable the whole tick
    // aborts, leaving rows `pending` to retry after unlock. (We only need
    // the key when `require_contact_email_match` is set, but resolving it
    // once up front keeps the locked-vault posture identical to the
    // sibling processors + is cheap.)
    let keyResolved = false;
    let piiKey: Uint8Array | null = null;
    const resolveKey = (): Uint8Array | null => {
      if (!keyResolved) {
        keyResolved = true;
        try {
          piiKey = deps.getDropBlobPiiKey();
        } catch (e) {
          console.warn(
            '[d-172] drop_link drain: drop-PII key unavailable (vault locked?) — leaving blobs pending',
            e,
          );
          piiKey = null;
        }
      }
      return piiKey;
    };

    // ALL drop_link endpoints — including disabled AND revoked. A blob
    // uploaded while the endpoint was live is valid received data and must
    // still materialize even if the user later disabled or revoked the
    // endpoint: revocation stops FUTURE visitor uploads, it does not
    // retroactively discard already-accepted rows (which would strand them
    // `pending` forever). The config blob is preserved on disabled/revoked
    // rows so materialization still resolves.
    const endpoints = deps.registryStore.list({ kind: 'drop_link', include_revoked: true });

    for (const endpoint of endpoints) {
      if (budget <= 0) break;
      const pending = deps.dropBlobStore.listPendingForEndpoint(endpoint.endpoint_id, budget);
      if (pending.length === 0) continue;
      budget -= pending.length;

      const config = parseDropLinkConfig(endpoint.metadata);

      for (const row of pending) {
        // A corrupt/unparseable config can never materialize — fail the
        // row (retained for review) rather than retry forever.
        if (!config) {
          deps.dropBlobStore.markProcessed({ blob_id: row.blob_id, outcome: 'failed' });
          failed += 1;
          continue;
        }

        try {
          const outcome = await processBlob(deps, endpoint.endpoint_id, config, row, now, resolveKey);
          if (outcome === 'vault_pending') {
            // Vault locked mid-tick — abort the remaining rows; they stay
            // `pending` for the next cycle after unlock.
            return { processed, failed };
          }
          if (outcome === 'dispatch_pending') {
            // Review mode with no dispatch seam (boot phase / no reception
            // core-pack) — leave the row PENDING (valid undispatched review
            // work, not a poison row); it dispatches once the recipe installs.
            // NEVER inline-materialize as a fallback (I-1). Not counted
            // processed.
            continue;
          }
          processed += 1;
        } catch (e) {
          console.warn(
            `[d-172] drop_link blob ${row.blob_id} processing failed`,
            e,
          );
          deps.dropBlobStore.markProcessed({ blob_id: row.blob_id, outcome: 'failed' });
          failed += 1;
        }
      }
    }

    return { processed, failed };
  },
});

/** Outcome of processing one pending drop blob:
 *   - `'processed'`     — dispatched to review.
 *   - `'vault_pending'` — a locked vault blocked a required decrypt; the caller
 *                         ABORTS the tick (all remaining rows stay pending).
 *   - `'dispatch_pending'` — review mode with no dispatch seam / not-yet-
 *                         dispatched; the caller SKIPS the row (leaves it
 *                         pending, continues the tick — never inline-materialize).
 *  A hard failure throws (the caller marks the row `failed`). */
type DropBlobOutcome = 'processed' | 'vault_pending' | 'dispatch_pending';

/** D-173 P5 § A.7 — deterministic task id for a drop blob. The
 *  `reception-materialize` projection upserts on `ON CONFLICT(id)`, so a
 *  re-release lands the SAME task (crash-idempotent — I-4). */
const taskIdForBlob = (blob_id: string): string => `reception_${blob_id}`;

/** Build the review task body from the visitor's free-text (provenance). The
 *  description is what the owner reads; the name is contextual. The visitor
 *  EMAIL is deliberately absent (sealed, D-138). */
const buildDropBody = (visitorName: string, description: string): string => {
  const name = visitorName.trim();
  const desc = description.trim();
  if (desc.length > 0) return name.length > 0 ? `From ${name}: ${desc}` : desc;
  return name.length > 0 ? `Uploaded by ${name}` : '';
};

/** Process one pending drop blob — dispatch it for review (D-210 Phase C
 *  standing-instruction (D3 / A.7). Default (absent / false) = REVIEW. */
const processBlob = async (
  deps: DropLinkProcessorDeps,
  endpoint_id: string,
  config: DropLinkConfig,
  row: DropBlobSummary,
  now: number,
  resolveKey: () => Uint8Array | null,
): Promise<DropBlobOutcome> =>
  // D-210 Phase C — REVIEW IS THE ONLY PATH. `on_upload.auto_accept` was
  // retired (owner ruling, 2026-07-18) with the intake + approval_link flags,
  // so every upload holds at the D-157 gate and is reviewed in the inbox.
  processReviewBlob(deps, endpoint_id, config, row, now, resolveKey);

/** D-173 P5 § A.7 — REVIEW (the default). Ingest the upload into
 *  `data.file.received` (the drop's artifact — review needs the file record to
 *  attach + a future scanner to scan), then dispatch the compiled
 *  `review-then-approve` workflow so a `drop.materialize` op (a task with the
 *  file attached) is HELD at the D-157 gate → inbox. NEVER inline-materializes
 *  (I-1); the task + attach run only on the user's explicit approve. */
const processReviewBlob = async (
  deps: DropLinkProcessorDeps,
  endpoint_id: string,
  config: DropLinkConfig,
  row: DropBlobSummary,
  now: number,
  resolveKey: () => Uint8Array | null,
): Promise<DropBlobOutcome> => {
  const onUpload = config.on_upload;

  // No dispatch seam (boot phase / no reception core-pack) — leave PENDING to
  // dispatch once the recipe installs. Skip the ingest too (idempotent re-drain
  // re-ingests when the seam lands; no point materializing the file early).
  if (!deps.fireReceptionWorkflow) return 'dispatch_pending';

  // Ingest the file — the drop's artifact — BEFORE dispatch (the payload must
  // carry the resulting `file_id`). This is idempotent STAGING, not the
  // reviewable entity: it writes a `data.file.received` record (the bytes are
  // already in the CAS, A.1), but the user-facing TASK is NOT materialized
  // until approve (I-1 holds — the reviewable artifact never lands early). A
  // dispatch that returns `dispatched: false` (no compiled drop recipe yet)
  // leaves the row pending with this staged record; the next drain re-ingests
  // the SAME record (deterministic id, D-172 I-2) and retries the dispatch.
  let record: DataFileRecord | null = null;
  if (onUpload.create_data_file_entity) {
    const mime = row.mime_type_detected || row.mime_type_reported;
    record = await deps.fileIngestor.ingest({
      storage_ref: { kind: 'cas', blob_hash: row.storage_path },
      filename: row.filename_sanitized,
      mime_type: mime,
      content_hash: row.content_hash,
      size_bytes: row.size_bytes,
      origin: FILE_RECORD_ORIGIN,
      source_id: row.blob_id,
      ...(row.scan_status !== null ? { scan_status: row.scan_status } : {}),
      now,
    });
  }

  // Decrypt the visitor's name + description (PROVENANCE + the task body). The
  // EMAIL is never decrypted here / never enters the queryable task (sealed,
  // D-138). A locked vault → leave the tick pending (signal up).
  const key = resolveKey();
  if (!key) return 'vault_pending';
  let visitorName = '';
  let visitorDescription = '';
  try {
    visitorName =
      (await openDropBlobPiiField({
        key,
        endpoint_id,
        blob_id: row.blob_id,
        field: 'visitor_name',
        ciphertext: row.visitor_name_encrypted,
      })) ?? '';
    visitorDescription =
      (await openDropBlobPiiField({
        key,
        endpoint_id,
        blob_id: row.blob_id,
        field: 'visitor_description',
        ciphertext: row.visitor_description_encrypted,
      })) ?? '';
  } catch (e) {
    // Tampered ciphertext on the free-text — provenance only; the file +
    // filename are the artifact, so proceed with empties rather than failing
    // the whole drop (a hard decrypt failure of the BODY is not a poison row).
    console.warn(
      `[d-172] drop_link blob ${row.blob_id}: visitor free-text decrypt failed — dispatching with empty body`,
      e,
    );
  }

  const body = buildDropBody(visitorName, visitorDescription);
  // The projection-shaped review payload — a task carrying the file. `file_id`
  // (when ingested) drives the projection's `data.link role:'attachment'` write
  // on approve. The visitor email is absent (sealed). The compiled recipe
  // forwards this verbatim as `context.event.payload` → the op's `args`.
  const payload: ReceptionProjectionInput = {
    top_tier_kind: 'task',
    id: taskIdForBlob(row.blob_id),
    title: row.filename_sanitized,
    ...(body.length > 0 ? { body } : {}),
    ...(record ? { file_id: record.record_id } : {}),
    metadata: {
      reception_drop_blob_id: row.blob_id,
      reception_endpoint_id: endpoint_id,
      reception_filename: row.filename_sanitized,
      reception_mime_type: row.mime_type_detected || row.mime_type_reported,
      reception_size_bytes: row.size_bytes,
      ...(visitorName.trim().length > 0 ? { reception_visitor_name: visitorName } : {}),
    },
  };

  const fired = await deps.fireReceptionWorkflow({
    kind: 'drop_link',
    // Spread to a plain record — the seam's payload is `Record<string,
    // unknown>`; the closed `ReceptionProjectionInput` has no index signature.
    payload: { ...payload },
    source_ref: row.blob_id,
    endpoint_id,
  });
  if (!fired.dispatched) return 'dispatch_pending';

  // Handed off to review-then-approve — mark processed so the drain never
  // re-dispatches it. `data_file_entity_id` records the ingested file (for
  // re-drain idempotency); the task + attach materialize only on approve.
  deps.dropBlobStore.markProcessed({
    blob_id: row.blob_id,
    outcome: 'processed',
    data_file_entity_id: record?.record_id ?? null,
    scan_status: row.scan_status,
  });

  // Optional notify seam (swallowed on error — never undo the dispatch).
  if (deps.notify) {
    try {
      await deps.notify({
        endpoint_id,
        kind: 'drop_link',
        blob_id: row.blob_id,
        data_file_id: record?.record_id ?? null,
        filename: row.filename_sanitized,
      });
    } catch (e) {
      console.warn('[d-172] drop_link notify seam failed', e);
    }
  }
  // NB: no `runRecipe` — the review-then-approve workflow IS the post-approve
  // effect. D-210 Phase C retired the auto-accept branch that was
  // `triggered_recipe_id`'s only reader, so that config field now has none.
  return 'processed';
};

