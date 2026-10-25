/** D-329 §3.4 — the owner's rpc over the write rules an AI's approvals teach: list the open
 *  suggestions, accept one (mint its rule, within the ceilings), dismiss one for good, list
 *  the live rules, revoke one. Registered in the `collection.contract.` slice, which MCP
 *  never reaches: an AI never sees, accepts or dismisses its own suggestion.
 *
 *  Every decision is audited reserve-class (`write_rule_minted` / `_dismissed` /
 *  `_revoked`), best-effort: the decision is the store's, the audit row its record. */

import { RpcError, type WriteRuleRow, type WriteRuleSuggestionRow } from '@recued/contracts';
import type { ActivityAction, AuditLogStore } from '@recued/storage';

import { WriteRuleError, type WriteRuleStore } from './storage/write-rule-store.js';

export interface WriteRuleRpcDeps {
  readonly store?: WriteRuleStore;
  readonly auditLog?: AuditLogStore;
  readonly now?: () => number;
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

export const createWriteRuleRpcHandlers = (deps: WriteRuleRpcDeps) => {
  const now = deps.now ?? Date.now;
  const store = (method: string): WriteRuleStore => {
    if (deps.store === undefined) throw new RpcError('not_configured', `${method}: write rules are not wired`, 501);
    return deps.store;
  };
  const decided = (method: string, run: () => unknown) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof WriteRuleError) {
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

  return {
    'collection.contract.listWriteRuleSuggestions': async (): Promise<{ suggestions: WriteRuleSuggestionRow[] }> =>
      ({ suggestions: store('collection.contract.listWriteRuleSuggestions').listSuggestions(now()) }),

    'collection.contract.acceptWriteRuleSuggestion': async (
      args: unknown,
    ): Promise<{ rule: WriteRuleRow; suggestion: WriteRuleSuggestionRow }> => {
      const method = 'collection.contract.acceptWriteRuleSuggestion';
      const a = record(method, args);
      const key_hash = text(method, 'key_hash', a.key_hash);
      const ttl_ms = optionalNumber(method, 'ttl_ms', a.ttl_ms);
      const max_uses = optionalNumber(method, 'max_uses', a.max_uses);
      const at = now();
      const result = decided(method, () => store(method).accept(key_hash, {
        ...(ttl_ms !== undefined ? { ttl_ms } : {}),
        ...(max_uses !== undefined ? { max_uses } : {}),
      }, at)) as { rule: WriteRuleRow; suggestion: WriteRuleSuggestionRow };
      audit('write_rule_minted', result.rule.rule_id, {
        key_hash, tool: result.rule.key.tool, scope: result.rule.key.scope, principal: result.rule.key.principal.kind,
        expires_at: result.rule.expires_at, max_uses: result.rule.max_uses,
      }, at);
      return result;
    },

    'collection.contract.dismissWriteRuleSuggestion': async (args: unknown): Promise<{ key_hash: string }> => {
      const method = 'collection.contract.dismissWriteRuleSuggestion';
      const key_hash = text(method, 'key_hash', record(method, args).key_hash);
      const at = now();
      decided(method, () => store(method).dismiss(key_hash, at));
      audit('write_rule_dismissed', key_hash, {}, at);
      return { key_hash };
    },

    'collection.contract.listWriteRules': async (): Promise<{ rules: WriteRuleRow[] }> =>
      ({ rules: store('collection.contract.listWriteRules').listRules(now()) }),

    'collection.contract.revokeWriteRule': async (args: unknown): Promise<{ rule: WriteRuleRow }> => {
      const method = 'collection.contract.revokeWriteRule';
      const rule_id = text(method, 'rule_id', record(method, args).rule_id);
      const at = now();
      const rule = decided(method, () => store(method).revoke(rule_id, at)) as WriteRuleRow;
      audit('write_rule_revoked', rule_id, { key_hash: rule.key_hash, uses_remaining: rule.uses_remaining }, at);
      return { rule };
    },
  };
};
