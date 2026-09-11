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
  const principal = (origin: PreapprovalOrigin, method: MailDraftMethod): MailDraftPrincipal => {
    const op = `core.mail.draft.${method === 'get' || method === 'list' ? 'read' : method}`;
    return { owner_id: deps.origin.ownerId, contract_id: origin.mode === 'contract' ? origin.contract_id : null,
      validate() {
        deps.authority.resolve(origin, op);
        if (!deps.gate.isOpGranted(origin.source, op)) throw new RpcError('op_not_granted', 'This caller cannot access saved drafts with that operation.', 403);
      } };
  };
  return {
    principal,
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
