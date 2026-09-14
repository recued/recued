/** Saved draft access uses the calling principal's ordinary operation grants.
 * A draft method never requests or decides a future approval. */
import { RpcError, type StepMeta } from '@recued/contracts';
import type { MailDraftPrincipal, MailDraftStore } from './storage/mail-drafts.js';
import type { PreapprovalOrigin } from './preapproval-model.js';
import type { createPreapprovalOriginAuthority } from './preapproval-origin-authority.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import { createPreapprovalRequestOrigin } from './preapproval-request-origin.js';

export type MailDraftMethod = 'create' | 'get' | 'list' | 'update' | 'delete';
export const createMailDraftService = (deps: {
  store: MailDraftStore; authority: ReturnType<typeof createPreapprovalOriginAuthority>;
  gate: OpAdmissionGate; origin: Parameters<typeof createPreapprovalRequestOrigin>[0];
}) => {
  /** D-264 — `op` is derivable from the method for the CRUD five, and an
   *  explicit override for `export`, which reads a draft under its own
   *  authority rather than under `core.mail.draft.read`.
   *
   *  ⚠ One grant, not two. Exporting necessarily reads the named draft, so
   *  demanding `read` as well would be the same permission asked twice —
   *  and would make `export` alone unusable, which is the narrower grant a
   *  careful owner would want to give. */
  const principalFor = (origin: PreapprovalOrigin, op: string): MailDraftPrincipal =>
    ({ owner_id: deps.origin.ownerId, contract_id: origin.mode === 'contract' ? origin.contract_id : null,
      validate() {
        deps.authority.resolve(origin, op);
        if (!deps.gate.isOpGranted(origin.source, op)) throw new RpcError('op_not_granted', 'This caller cannot access saved drafts with that operation.', 403);
      } });
  const principal = (origin: PreapprovalOrigin, method: MailDraftMethod): MailDraftPrincipal =>
    principalFor(origin, `core.mail.draft.${method === 'get' || method === 'list' ? 'read' : method}`);
  return {
    principal,
    /** D-264 — the principal a `core.mail.draft.save-to-mailbox` runs under. */
    saveToMailboxPrincipal: (origin: PreapprovalOrigin): MailDraftPrincipal =>
      principalFor(origin, 'core.mail.draft.save-to-mailbox'),
    owner<M extends MailDraftMethod>(method: M, raw: unknown, origin: PreapprovalOrigin) {
      return deps.store[method](raw, principal(origin, method)) as ReturnType<MailDraftStore[M]>;
    },
    kernel(method: Exclude<MailDraftMethod, 'list'>, raw: unknown, meta: StepMeta | undefined) {
      const op = `core.mail.draft.${method === 'get' ? 'read' : method}`;
      const origin = createPreapprovalRequestOrigin(deps.origin, meta, op);
      return deps.store[method](raw, principal(origin, method));
    },
  };
};
export type MailDraftService = ReturnType<typeof createMailDraftService>;
