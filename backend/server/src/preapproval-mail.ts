/** Mail and its required reads participate in the common invocation graph. */
import type Database from 'better-sqlite3';
import { MAIL_SEND_ATTACHMENT_MAX_BYTES, RpcError, normalizeMailSend, parsePreapprovalJson, preapprovalChildPath,
  type IngredientManifest, isTempFileRef} from '@recued/contracts';
import { describePreapprovalInvocation, type PreapprovalCall, type PreapprovalNormalAdmission,
  type PreapprovalRuntimeIdentity } from './preapproval-dispatch-description.js';
import type { PreparedFutureExecution, PreapprovalActivationRecord, PreapprovalDependency, PreapprovalValidationStage } from './preapproval-model.js';
import { preapprovalHash, preapprovalPathKey } from './preapproval-invocations.js';
import { synchronizePreapprovalIdentity, initializePreapprovalLifecycle } from './storage/preapproval-lifecycle.js';
import { collectionInstancePreapprovalMaterial, type CollectionInstanceStore } from './collections/instance-store.js';
import { describeFileContent, filePreapprovalMaterial, type FileContentSnapshot } from './collections/file/file-snapshot.js';
import type { CollectionRegistry } from './collections/registry.js';
import type { MailCollection } from './collections/mail/mail-collection.js';
import type { BlobStore } from './storage/blob-store.js';
import { mergeManifestStepInput, mergeManifestStepOutput } from '@recued/ingredients';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from './gated-action-store.js';

export interface PreapprovalDomainContext {
  stage: PreapprovalValidationStage;
  plan?: PreparedFutureExecution;
  admit(call: PreapprovalCall): PreapprovalNormalAdmission;
}
export interface ReviewedFileSnapshot {
  kind: 'file_snapshot'; version: 1; file: FileContentSnapshot; source: PreapprovalDependency;
}
export const readReviewedFileSnapshot = (value: unknown): ReviewedFileSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<ReviewedFileSnapshot>; const file = row.file; const source = row.source;
  if (row.kind !== 'file_snapshot' || row.version !== 1 || !file || !source || source.kind !== 'file_source'
    || typeof file.record_id !== 'string' || typeof file.filename !== 'string' || typeof file.mime_type !== 'string'
    || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || !/^[a-f0-9]{64}$/.test(file.blob_hash)) return null;
  return row as ReviewedFileSnapshot;
};
const fail = (message: string): never => { throw new RpcError('preapproval_unresolved', message, 409); };

export const createPreapprovalMail = (deps: {
  db: Database.Database; registry: CollectionRegistry; instances: CollectionInstanceStore; blobs: BlobStore;
  manifest(slug: string): IngredientManifest | null;
}) => {
  const { db } = deps;
  initializePreapprovalLifecycle(db);
  // Both archive export and orphan GC use collection-blob-refs.ts. Keeping
  // ownership here makes the accepted copy independent of its original row.
  db.exec(`CREATE TABLE IF NOT EXISTS collection_preapproval_blobs (
    future_ref TEXT NOT NULL, plan_hash TEXT NOT NULL, member_id TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL, blob_hash TEXT NOT NULL, accepted_at INTEGER NOT NULL,
    PRIMARY KEY(future_ref, member_id));
    CREATE INDEX IF NOT EXISTS preapproval_blob_plan ON collection_preapproval_blobs(plan_hash, member_id, snapshot_hash)`);
  const fileIdentity = (call: PreapprovalCall, context: PreapprovalDomainContext): PreapprovalRuntimeIdentity => {
    const recordId = call.input.record_id;
    if (typeof recordId !== 'string' || !recordId) return fail('An attachment must name a saved file.');
    let snapshot: ReviewedFileSnapshot | null = null;
    if (context.plan && context.stage !== 'prepare' && context.stage !== 'decide') {
      const member = context.plan.members.find(row => preapprovalPathKey(row.invocation_path) === preapprovalPathKey(call.path));
      const expected = readReviewedFileSnapshot(member?.dispatch_snapshot);
      if (expected && db.prepare(`SELECT 1 FROM collection_preapproval_blobs WHERE plan_hash=? AND member_id=? AND snapshot_hash=?`)
        .get(preapprovalHash(context.plan), member!.member_id, preapprovalHash(expected))) snapshot = expected;
    }
    if (!snapshot) {
      const record = deps.registry.get('file', 'received')?.get(recordId);
      const file = record ? describeFileContent(record) : null;
      if (!record || !file) return fail('Save or version this file before requesting review; its bytes have no immutable content pin.');
      const identity = synchronizePreapprovalIdentity(db, 'file_source', `received:${recordId}`, filePreapprovalMaterial(record))!;
      snapshot = { kind: 'file_snapshot', version: 1, file,
        source: { kind: 'file_source', key: identity.key, incarnation: identity.incarnation, revision: identity.revision,
          content_hash: identity.content_hash, until_phase: 'decision' } };
    }
    if (snapshot.file.record_id !== recordId) return fail('The file read does not match the reviewed attachment.');
    const frozen = parsePreapprovalJson(snapshot);
    const resource = { kind: 'file_snapshot', key: preapprovalHash(frozen), incarnation: snapshot.source.incarnation,
      revision: 1, content_hash: `sha256:${snapshot.file.blob_hash}` };
    return { family: 'kernel', binding: frozen, dispatch_snapshot: frozen, connection_id: null, account_id: null,
      resources: [resource], dependencies: [snapshot.source], children: [], child_inventory: { complete: true }, nested_recipe: null,
      label: snapshot.file.filename, detail: `${snapshot.file.mime_type} · ${snapshot.file.size_bytes} bytes · SHA-256 ${snapshot.file.blob_hash}. Approval keeps an independent copy for this execution.` };
  };
  return {
    fileChild(call: PreapprovalCall, context: PreapprovalDomainContext, slot: string, index: number, recordId: string) {
      const manifest = deps.manifest('data-file-read');
      if (!manifest) return fail('The required file-read operation is unavailable.');
      const childCall: PreapprovalCall = { ...call, slug: 'data-file-read', manifest, catalog: false,
        input: parsePreapprovalJson(mergeManifestStepInput(manifest.input, { record_id: recordId }, { trustedSurfaceDispatch: false })) as PreapprovalCall['input'],
        output: mergeManifestStepOutput(manifest.output, {}), connection_name: '', path: preapprovalChildPath(call.path, slot, index) };
      const runtime = fileIdentity(childCall, context);
      const description = describePreapprovalInvocation(childCall, runtime, context.admit(childCall));
      if (description.kind !== 'resolved') return fail(description.reason);
      return { child: { slot, index, call: description.call }, snapshot: readReviewedFileSnapshot(runtime.dispatch_snapshot)! };
    },
    describe(call: PreapprovalCall, admission: PreapprovalNormalAdmission, context: PreapprovalDomainContext): PreapprovalRuntimeIdentity | null {
      if (call.catalog) return null;
      if (call.slug === 'data-file-read') return fileIdentity(call, context);
      if (call.slug !== 'mail-send') return null;
      const payload = normalizeMailSend(call.input);
      const row = deps.instances.get('mail', payload.instance);
      const mail = deps.registry.get('mail', payload.instance) as MailCollection | undefined;
      if (!row || !mail?.sendCapable || !mail.accountEmail || row.auth_state !== 'healthy') return fail('The reviewed sender is not available for sending.');
      if (payload.to.some(to => to.trim().toLowerCase().replace(/^.*<([^>]+)>$/, '$1') === mail.accountEmail.trim().toLowerCase())) {
        return fail('Choose a recipient other than the sender account.');
      }
      if (payload.reconciliation_id && payload.to.length + (payload.cc?.length ?? 0) + (payload.bcc?.length ?? 0) !== 1) {
        return fail('A mail reconciliation ID requires exactly one recipient.');
      }
      const identity = synchronizePreapprovalIdentity(db, 'collection_instance', `mail:${payload.instance}`, collectionInstancePreapprovalMaterial(row))!;
      const pin: PreapprovalDependency = { kind: identity.kind, key: identity.key, incarnation: identity.incarnation,
        revision: identity.revision, content_hash: identity.content_hash, until_phase: 'terminal' };
      const children: PreapprovalRuntimeIdentity['children'] = [];
      for (const [index, ref] of (payload.attachments ?? []).entries()) {
        // ⛔ A RUN-SCOPED TEMP REF CANNOT BE SNAPSHOTTED FOR LATER REVIEW. The
        // child is a durable record of what the reviewer approved, and the
        // reviewer may answer long after the producing run's scratch is gone —
        // so there would be nothing to send when they say yes. Refuse at the
        // boundary rather than snapshot a reference that will dangle.
        if (isTempFileRef(ref)) {
          return fail('A run-scoped attachment cannot be sent through deferred review. '
            + 'Keep the file first if the send must be reviewed out of band.');
        }
        const { child, snapshot } = this.fileChild(call, context, 'attachments', index, ref);
        if (snapshot.file.size_bytes > MAIL_SEND_ATTACHMENT_MAX_BYTES) return fail(`Attachment ${snapshot.file.filename} exceeds the mail attachment limit.`);
        children.push(child);
      }
      return { family: 'kernel', binding: parsePreapprovalJson({ version: 1, sender: mail.accountEmail, instance: pin, payload }),
        connection_id: identity.incarnation, account_id: mail.accountEmail, resources: [pin], dependencies: [pin],
        children, child_inventory: { complete: true }, nested_recipe: null,
        label: `Send: ${payload.subject}`, detail: `From ${mail.accountEmail} · To ${payload.to.join(', ')}` };
    },
    /** D-264 — refuse to SCHEDULE a send from a mailbox that cannot send.
     *
     *  Reachable since D-264: compose now opens for a draft-only mailbox, so a
     *  draft can exist against an instance with no outbound path. The dialog
     *  disables Schedule for such a sender, but the dialog is display — this
     *  rpc is the enforcement point, and a caller reaching `preapproval.prepare`
     *  directly would otherwise get a reviewed execution that cannot run.
     *
     *  ⛔ Reads `collection.sendCapable` — the SAME field `MailCollection.send`
     *  gates on at dispatch, not a second opinion about it. Two capability
     *  predicates over one fact is how a bind-time refusal and a runtime gate
     *  come to disagree; there is one fact here and both ends read it.
     *
     *  ⚠ This is a PREPARE-time check and cannot be the only one. A grant can
     *  be revoked between approval and `run_at`, which is why the dispatch-time
     *  gate in `MailCollection.send` stays load-bearing rather than being
     *  treated as already satisfied by this. */
    assertCanSend(slug: string): void {
      const collection = deps.registry.get('mail', slug) as MailCollection | undefined;
      if (!collection) {
        fail(`This draft is saved in mail instance '${slug}', which is no longer connected.`);
      }
      if (!collection!.sendCapable) {
        fail('This mailbox can save drafts but cannot send. '
          + 'Connect outbound sending for it in Settings → Connections, then schedule again.');
      }
    },
    async checkReady(plan: PreparedFutureExecution): Promise<void> {
      for (const member of plan.members) {
        const snapshot = readReviewedFileSnapshot(member.dispatch_snapshot);
        if (!snapshot) continue;
        const { file } = snapshot;
        if (!await deps.blobs.has(file.blob_hash)) return fail(`The saved bytes for ${file.filename} are unavailable.`);
        const size = await deps.blobs.plaintextSizeOf?.(file.blob_hash);
        if (size !== undefined && size !== file.size_bytes) return fail(`The saved length for ${file.filename} changed.`);
      }
    },
    accept(plan: PreparedFutureExecution, activation: PreapprovalActivationRecord): void {
      if (!db.inTransaction) throw new Error('Snapshot ownership requires the decision transaction.');
      const selected = new Set((db.prepare('SELECT member_id FROM preapproval_members WHERE grant_id=?').all(activation.grant_id) as Array<{ member_id: string }>).map(row => row.member_id));
      for (const member of plan.members) {
        const snapshot = readReviewedFileSnapshot(member.dispatch_snapshot);
        if (!snapshot || !selected.has(member.member_id)) continue;
        db.prepare('INSERT INTO collection_preapproval_blobs VALUES(?,?,?,?,?,?)')
          .run(activation.future_execution_ref, preapprovalHash(plan), member.member_id, preapprovalHash(snapshot), snapshot.file.blob_hash, activation.accepted_at);
      }
    },
    releaseExpired(now: number): void {
      db.prepare(`DELETE FROM collection_preapproval_blobs WHERE future_ref IN (
        SELECT e.future_ref FROM preapproval_executions e
        WHERE e.state IN ('succeeded','partial','failed','cancelled','expired','invalidated')
          AND e.updated_at <= ?
          AND EXISTS (SELECT 1 FROM collection_preapproval_blobs b WHERE b.future_ref=e.future_ref)
          AND NOT EXISTS (SELECT 1 FROM preapproval_members m WHERE m.future_ref=e.future_ref AND m.state IN ('dispatching','in_doubt'))
        ORDER BY e.updated_at LIMIT 100)`)
        .run(now - GATED_ACTION_TERMINAL_RETENTION_MS);
    },
  };
};
