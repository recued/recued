import type { Condition, ConditionOp, NamespaceStores } from '@recued/contracts';
import { parseCondition, isRef, resolveValue } from '@recued/contracts';
import { evaluateOp } from '@recued/transforms';

/** Evaluate a condition (string or object form) against namespace stores. */
export const evaluateCondition = (cond: string | Condition, stores: NamespaceStores): boolean => {
  if (typeof cond === 'object') return evaluateObjectCondition(cond, stores);
  return evaluateStringCondition(cond, stores);
};

const coerceLiteral = (v: string | undefined): unknown => {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v !== undefined && v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
};

const evaluateStringCondition = (cond: string, stores: NamespaceStores): boolean => {
  const { field, operator, value } = parseCondition(cond);
  const resolvedField = isRef(field) ? resolveValue(field, stores) : field;
  const resolvedValue = value && isRef(value) ? resolveValue(value, stores) : coerceLiteral(value);
  return evaluateOp(resolvedField, operator as ConditionOp, resolvedValue);
};

const evaluateObjectCondition = (cond: Condition, stores: NamespaceStores): boolean => {
  const resolvedField = isRef(cond.field) ? resolveValue(cond.field, stores) : cond.field;
  return evaluateOp(resolvedField, cond.operator, cond.value);
};
