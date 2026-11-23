/** D-348 slice 2 — the owner's rpc over the chains their approvals teach: list the open
 *  suggestions, accept one (mint its rule, within the ceilings; its deletes only when asked, Q7),
 *  dismiss one or only its deletes for good, list the live rules, end one. Registered in the
 *  `collection.contract.` slice, which MCP never reaches: an AI never sees, accepts or dismisses
 *  its own suggestion.
 *
 *  Every decision is audited reserve-class (`chain_rule_minted` / `_dismissed` / `_revoked`),
 *  best-effort: the decision is the store's, the audit row its record. */

import {
  RpcError, type ApprovalValueLabels, type ChainCallSignature, type ChainCallView, type ChainRuleRow,
  type ChainSuggestionRow,
} from '@recued/contracts';
import type { ActivityAction, AuditLogStore } from '@recued/storage';

import { ChainRuleError, type ChainRuleStore } from './storage/chain-rule-store.js';

export interface ChainRuleRpcDeps {
  readonly store?: ChainRuleStore;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
  /** Slice 3 — each call by the name the owner knows it by (`chain-call-name.ts`). Absent ⇒ the
   *  page shows a call by its operation. */
  readonly nameCall?: (signature: ChainCallSignature) => string | undefined;
  /** How the owner knows the values each call names (`chain-call-name.ts` `chainCallPinLabels`).
   *  Absent ⇒ the page shows the values as they are. */
  readonly labelCall?: (signature: ChainCallSignature) => Promise<ApprovalValueLabels | undefined>;
}

const record = (method: string, args: unknown): Record<string, unknown> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError('bad_request', `${method}: args must be an object`);
  }
  return args as Record<string, unknown>;
};

const text = (method: string, field: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: ${field} is required`);
  }
  return value;
};

const optionalNumber = (method: string, field: string, value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError('bad_request', `${method}: ${field} must be a number`);
  }
  return value;
};

/** Counts, never the calls themselves: the audit row records the decision, not whom it reaches. */
const shapeOf = (rule: ChainRuleRow): Record<string, unknown> => ({
  key_hash: rule.key_hash, calls: rule.members.length, deletes: rule.deletes.length,
  expires_at: rule.expires_at, max_uses: rule.max_uses,
});

export const createChainRuleRpcHandlers = (deps: ChainRuleRpcDeps) => {
  const now = deps.now ?? Date.now;
  const store = (method: string): ChainRuleStore => {
    if (deps.store === undefined) throw new RpcError('not_configured', `${method}: chains are not wired`, 501);
    return deps.store;
  };
  const decided = async <T>(method: string, run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ChainRuleError) {
        throw new RpcError(error.code, `${method}: ${error.message}`, error.code === 'not_found' ? 404 : 400, method);
      }
      throw error;
    }
  };
  const audit = (action: ActivityAction, target: string, detail: Record<string, unknown>, at: number): void => {
    if (deps.auditLog === undefined) return;
    void deps.auditLog.logActivity({
      activity_id: '', timestamp: at, action, target, detail: JSON.stringify(detail),
    }).catch(() => undefined);
  };

  /** Each call with its name, and how the owner knows the values it names, when the server has
   *  them. A namer or a lookup that throws names nothing. */
  const named = (views: readonly ChainCallView[]): Promise<ChainCallView[]> => Promise.all(views.map(async (view) => {
    if (view.signature === undefined) return view;
    let title: string | undefined;
    try { title = deps.nameCall?.(view.signature); } catch { title = undefined; }
    let pin_labels: ApprovalValueLabels | undefined;
    try { pin_labels = await deps.labelCall?.(view.signature); } catch { pin_labels = undefined; }
    return {
      ...view,
      ...(title !== undefined && title.trim() !== '' ? { title } : {}),
      ...(pin_labels !== undefined && Object.keys(pin_labels).length > 0 ? { pin_labels } : {}),
    };
  }));
  const namedRow = async <T extends { readonly members: readonly ChainCallView[]; readonly deletes: readonly ChainCallView[] }>(
    row: T,
  ): Promise<T> => ({ ...row, members: await named(row.members), deletes: await named(row.deletes) });

  return {
    'collection.contract.listChainSuggestions': async (): Promise<{ suggestions: ChainSuggestionRow[] }> =>
      ({ suggestions: await Promise.all((await store('collection.contract.listChainSuggestions').listSuggestions(now())).map(namedRow)) }),

    'collection.contract.acceptChainSuggestion': async (
      args: unknown,
    ): Promise<{ rule: ChainRuleRow; suggestion: ChainSuggestionRow }> => {
      const method = 'collection.contract.acceptChainSuggestion';
      const a = record(method, args);
      const key_hash = text(method, 'key_hash', a.key_hash);
      if (a.deletes !== undefined && typeof a.deletes !== 'boolean') {
        throw new RpcError('bad_request', `${method}: deletes must be true or false`);
      }
      const ttl_ms = optionalNumber(method, 'ttl_ms', a.ttl_ms);
      const max_uses = optionalNumber(method, 'max_uses', a.max_uses);
      const at = now();
      const result = await decided(method, () => store(method).accept(key_hash, {
        ...(a.deletes === true ? { deletes: true } : {}),
        ...(ttl_ms !== undefined ? { ttl_ms } : {}),
        ...(max_uses !== undefined ? { max_uses } : {}),
      }, at));
      audit('chain_rule_minted', result.rule.rule_id, shapeOf(result.rule), at);
      return { rule: await namedRow(result.rule), suggestion: await namedRow(result.suggestion) };
    },

    'collection.contract.dismissChainSuggestion': async (
      args: unknown,
    ): Promise<{ key_hash: string; part: 'all' | 'deletes' }> => {
      const method = 'collection.contract.dismissChainSuggestion';
      const a = record(method, args);
      const key_hash = text(method, 'key_hash', a.key_hash);
      if (a.part !== undefined && a.part !== 'all' && a.part !== 'deletes') {
        throw new RpcError('bad_request', `${method}: part must be 'all' or 'deletes'`);
      }
      const part = a.part === 'deletes' ? 'deletes' : 'all';
      const at = now();
      await decided(method, () => store(method).dismiss(key_hash, part, at));
      audit('chain_rule_dismissed', key_hash, { part }, at);
      return { key_hash, part };
    },

    'collection.contract.listChainRules': async (): Promise<{ rules: ChainRuleRow[] }> =>
      ({ rules: await Promise.all((await store('collection.contract.listChainRules').listRules(now())).map(namedRow)) }),

    'collection.contract.revokeChainRule': async (args: unknown): Promise<{ rule: ChainRuleRow }> => {
      const method = 'collection.contract.revokeChainRule';
      const rule_id = text(method, 'rule_id', record(method, args).rule_id);
      const at = now();
      const rule = await decided(method, () => store(method).revoke(rule_id, at));
      audit('chain_rule_revoked', rule_id, { key_hash: rule.key_hash, uses_remaining: rule.uses_remaining }, at);
      return { rule: await namedRow(rule) };
    },
  };
};
