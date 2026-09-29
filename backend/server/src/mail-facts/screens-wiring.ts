/**
 * D-315 §6 — the Mail facts screens' wiring, in the one place both the server
 * composition (`serve/compose-listeners.ts`) and the live proof
 * (`d-315-mail-facts-live.test.ts`) build it from, so the proof runs the
 * wiring the server runs:
 *
 *   - the stored mail the screens read: a fact's email for its row, its body
 *     for the security-notice check, its mailbox's retention for when the fact
 *     goes with it (§5.3);
 *   - the template editor's reads: an email read again as the ingest read it,
 *     and a preview over the mailboxes (§6.1, §6.2);
 *   - a run's status from the run log, and a recipe's name;
 *   - the `mail_fact` broadcast when a template or a standards switch changes;
 *   - the dispatcher observer that links a run to the email that caused it.
 */

import type { MailFactEmailRef } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { CollectionInstanceStore } from '../collections/instance-store.js';
import { buildMailCollectionConfig } from '../collections/mail/compose.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { EventBus } from '../events/bus.js';
import { materializeMailBody } from '../mail-body-read-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import type { TriggerFire } from '../triggers/dispatcher.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { mailFactAiCallThrough } from './ai-pass.js';
import { createMailFactAnnouncer } from './announcer.js';
import { createMailFactBackfill } from './backfill.js';
import type { MailFactWriter } from './fact-writer.js';
import type { MailFactMailAccess, MailFactRpcDeps } from './mail-fact-rpc-handler.js';
import { mailFactRunLinkOf } from './run-link.js';
import { MAIL_TEMPLATE_DRAFT_MANIFEST } from './template-draft.js';

export interface MailFactMailAccessDeps {
  readonly registry: CollectionRegistry;
  readonly instances: Pick<CollectionInstanceStore, 'get'>;
  readonly blobs: BlobStore;
  /** The sender's relationships from the contact graph (`family`, `work`, …). */
  readonly relationshipsOf?: (address: string) => readonly string[];
}

/** Whether the ingest stored an attachment's file (`data.file`, received). */
const fileStoredIn = (registry: CollectionRegistry) => (file_id: string): boolean => {
  const files = registry.get('file', 'received');
  return files !== undefined && files.get(file_id) !== null;
};

/** The type the ingest stored an attachment's file with, read from its bytes. */
const storedFileTypeIn = (registry: CollectionRegistry) => (file_id: string): string | undefined => {
  const type = registry.get('file', 'received')?.get(file_id)?.hot_fields.mime_type;
  return typeof type === 'string' ? type : undefined;
};

const retentionDaysOf = (instances: Pick<CollectionInstanceStore, 'get'>) => (slug: string): number | null => {
  const row = instances.get('mail', slug);
  return row === null ? null : buildMailCollectionConfig(row).retention_days;
};

export const createMailFactMailAccess = (deps: MailFactMailAccessDeps): MailFactMailAccess => ({
  get: (slug, record_id) => deps.registry.get('mail', slug)?.get(record_id) ?? null,
  body: (record) => materializeMailBody(record, deps.blobs),
  retentionDays: retentionDaysOf(deps.instances),
});

export interface MailFactScreensDeps {
  readonly store: MailFactStore;
  /** Absent on a server with no mail stack or no blob store. */
  readonly mail?: MailFactMailAccessDeps;
  readonly auditLog?: Pick<AuditLogStore, 'get'>;
  readonly recipeStore: Pick<RecipeStore, 'get'>;
  readonly eventBus?: Pick<EventBus, 'emit'>;
  /** The composition's one fact writer, for a backfill (§6.3). */
  readonly writer?: MailFactWriter;
  /** One model call through the chat's privacy layer, for Draft with AI (§6.1). */
  readonly privateAiCall?: ExecuteChatAiCall;
  /** Switch off rows made on this server (the triggers rpc's own update). */
  readonly switchOffTriggers?: MailFactRpcDeps['switchOffTriggers'];
  /** The trigger queue has room: a backfill that runs recipes waits for it. */
  readonly triggerRoom?: () => Promise<void>;
  /** No AI call holding news waits on an email: a backfill that runs recipes
   *  waits for it after each email, so each is told as it came. */
  readonly aiSettled?: (email: MailFactEmailRef) => Promise<number>;
  readonly now?: () => number;
}

export const mailFactScreensRpcDeps = (deps: MailFactScreensDeps): MailFactRpcDeps => {
  const { auditLog, eventBus } = deps;
  const now = deps.now ?? Date.now;
  const mailboxes = (): MailCollection[] =>
    deps.mail === undefined
      ? []
      : deps.mail.registry.list().filter((collection): collection is MailCollection => collection.platform === 'mail');
  const progress = eventBus
    ? createMailFactAnnouncer((subkind) => { eventBus.emit({ kind: 'mail_fact', subkind }); }).announce
    : undefined;
  // An email read again, as the ingest read it — its attachments by the files
  // it stored, under the id the email had then (§6.3) — for the editor and a
  // backfill alike.
  const storedEmailOf = (mail: MailFactMailAccessDeps) => ({
    blobs: mail.blobs,
    fileStored: fileStoredIn(mail.registry),
    storedFileType: storedFileTypeIn(mail.registry),
    formerRecordIds: (slug: string, record_id: string) => deps.store.formerEmailIds(slug, record_id),
    ...(mail.relationshipsOf ? { relationshipsOf: mail.relationshipsOf } : {}),
  });
  return {
    store: deps.store,
    ...(deps.switchOffTriggers !== undefined ? { switchOffTriggers: deps.switchOffTriggers } : {}),
    ...(deps.mail ? { mail: createMailFactMailAccess(deps.mail) } : {}),
    ...(deps.mail
      ? {
          editor: {
            mailboxes,
            ...storedEmailOf(deps.mail),
            retentionDays: retentionDaysOf(deps.mail.instances),
            standardsOff: () => deps.store.standardsOff(),
          },
        }
      : {}),
    ...(auditLog
      ? { runStatusOf: async (run_id: string) => (await auditLog.get(run_id))?.commit_status ?? null }
      : {}),
    recipeNameOf: (recipe_id) => deps.recipeStore.get(recipe_id)?.metadata.name ?? null,
    ...(eventBus
      ? {
          onTemplatesChanged: () => { eventBus.emit({ kind: 'mail_fact', subkind: 'templates' }); },
          onFactsChanged: () => { eventBus.emit({ kind: 'mail_fact', subkind: 'facts' }); },
        }
      : {}),
    ...(deps.privateAiCall !== undefined
      ? { draftCall: mailFactAiCallThrough(deps.privateAiCall, MAIL_TEMPLATE_DRAFT_MANIFEST) }
      : {}),
    ...(deps.mail !== undefined && deps.writer !== undefined
      ? {
          backfill: createMailFactBackfill({
            store: deps.store,
            writer: deps.writer,
            mailboxes,
            ...storedEmailOf(deps.mail),
            retentionDays: retentionDaysOf(deps.mail.instances),
            now,
            ...(progress ? { onProgress: () => progress('backfill') } : {}),
            ...(deps.triggerRoom !== undefined ? { triggerRoom: deps.triggerRoom } : {}),
            ...(deps.aiSettled !== undefined ? { aiSettled: deps.aiSettled } : {}),
          }),
        }
      : {}),
    now,
  };
};

/** The dispatcher's `onFired`: record a fact's run against its email (§6.4). */
export const linkMailFactRuns = (
  store: Pick<MailFactStore, 'recordRun' | 'getFact' | 'emailMovedTo' | 'getEmailLedger' | 'factsForEmail' | 'getThing'>,
  /** A run was linked: the Facts view shows it now, not at some later refresh. */
  onLinked?: () => void,
) => (fire: TriggerFire): void => {
  const link = mailFactRunLinkOf(fire);
  if (link === null) return;
  // The run can end after its email moved to a new id, or its thing joined
  // another: the link goes to the fact as it is now, found by its id.
  const factId = (fire.event.record as { fact?: { fact_id?: unknown } } | undefined)?.fact?.fact_id;
  const fact = typeof factId === 'string' ? store.getFact(factId) : null;
  if (fact !== null) {
    store.recordRun({ ...link, email: { slug: fact.email.slug, record_id: fact.email.record_id }, ...(fact.thing_id !== null ? { thing_id: fact.thing_id } : {}) });
  } else {
    // One no longer stored: its email as it is now, where a move took it —
    // while that email and the thing are still here. A deleted email took
    // its runs with it, as a deleted kind took its things'; a link made
    // after would name what is gone.
    const email = store.emailMovedTo(link.email) ?? link.email;
    const known = store.getEmailLedger(email) !== null || store.factsForEmail(email).length > 0;
    if (!known || store.getThing(link.thing_id) === null) return;
    store.recordRun({ ...link, email });
  }
  try {
    onLinked?.();
  } catch {
    /* the link is stored; a view refreshes on its next change */
  }
};
