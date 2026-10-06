import { RpcError } from '@recued/contracts';
import { matchMailWorkQuote, type MailWorkQuoteSource, type MailWorkSourceState } from './mail-work-source-recap.js';

export const MAIL_WORK_SOURCE_ACTION_FORMAT = 'source_actions_v2';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (): never => { throw new RpcError('bad_request',
  'The AI review did not keep source excerpts and current action targets separate. The previous review is unchanged.', 400); };

/** Same-call source contract. Follow declared references to exact factual roots,
 * including references through another question or action. A derived statement
 * is never evidence or permission. Missing/cyclic links and retired roots for
 * current work remain invalid. This validates structure, not entailment or state. */
export const groundLinkedMailWorkClaims = (claims: unknown[], sources: ReadonlyMap<string, MailWorkQuoteSource>): Record<string, unknown>[] => {
  if (claims.length > 24) return invalid();
  const ids = new Set<string>();
  const states = new Map<string, MailWorkSourceState>();
  const result = claims.map((raw: unknown): Record<string, unknown> => {
    if (!object(raw) || typeof raw.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/u.test(raw.id) || ids.has(raw.id)) return invalid();
    ids.add(raw.id);
    if (raw.basis === 'inference') return { ...raw };
    const matched = matchMailWorkQuote(raw.excerpt, sources);
    if (!matched) return invalid();
    const email = matched.source.startsWith('mail_source_');
    if ((email ? raw.basis !== 'email' : raw.basis !== 'owner')
      || !Array.isArray(raw.sources) || JSON.stringify(raw.sources) !== JSON.stringify(email ? [matched.source] : [])
      || raw.kind === 'next_action' || raw.kind === 'question' || raw.kind === 'completion_condition') return invalid();
    states.set(raw.id, matched.state);
    return { ...raw, text: matched.rendered };
  });
  const byId = new Map(result.map(claim => [String(claim.id), claim]));
  const roots = new Map<string, string[]>();
  const resolveTargets = (claim: Record<string, unknown>, visiting: ReadonlySet<string>): string[] => {
    const id = String(claim.id);
    if (visiting.has(id)) return invalid();
    const cached = roots.get(id);
    if (cached) return cached;
    if (!Array.isArray(claim.targets) || claim.targets.length > 6 || (states.size > 0 && !claim.targets.length)) return invalid();
    const next = new Set(visiting); next.add(id);
    const resolved = new Set<string>();
    for (const target of claim.targets) {
      if (typeof target !== 'string') return invalid();
      if (states.has(target)) resolved.add(target);
      else {
        const dependency = byId.get(target);
        if (!dependency || dependency.basis !== 'inference') return invalid();
        for (const root of resolveTargets(dependency, next)) resolved.add(root);
      }
    }
    if (resolved.size > 6 || (claim.targets.length > 0 && resolved.size === 0)) return invalid();
    const ids = [...resolved]; roots.set(id, ids); return ids;
  };
  for (const claim of result) {
    if (claim.basis !== 'inference') continue;
    const historyOnly = claim.target_use === 'historical_recap';
    if (historyOnly && (claim.kind !== 'next_action' || !object(claim.action)
      || claim.action.mode !== 'private_preparation' || claim.action.permission !== 'not_contact')) return invalid();
    if (claim.target_use !== undefined && !['current_work', 'historical_recap'].includes(String(claim.target_use))) return invalid();
    const targets = resolveTargets(claim, new Set());
    if (targets.some(id => !(historyOnly ? states.has(id) : ['current', 'uncertain'].includes(states.get(id) ?? '')))) return invalid();
    claim.targets = targets;
    if (historyOnly && typeof claim.text === 'string') claim.text = `Historical recap only, without reopening the work: ${claim.text}`;
  }
  return result;
};
