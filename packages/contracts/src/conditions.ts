/** The 14 condition operators used by skip_when, fail_on, stop_when, guard, and filter. */
export type ConditionOp =
  | 'equal' | 'not_equal'
  | 'greater' | 'greater_or_equal'
  | 'less' | 'less_or_equal'
  | 'is_null' | 'is_not_null'
  | 'is_empty' | 'is_not_empty'
  | 'contains' | 'not_contains'
  | 'in' | 'not_in';

export const OPS = new Set<ConditionOp>([
  'equal', 'not_equal', 'greater', 'greater_or_equal',
  'less', 'less_or_equal', 'is_null', 'is_not_null',
  'is_empty', 'is_not_empty', 'contains', 'not_contains',
  'in', 'not_in',
] as const);

export const UNARY_OPS = new Set<ConditionOp>([
  'is_null', 'is_not_null', 'is_empty', 'is_not_empty',
] as const);

/** Object-form condition. String-form ("{{field}} operator value") is also valid. */
export interface Condition {
  field: string;
  operator: ConditionOp;
  value?: unknown;
}
