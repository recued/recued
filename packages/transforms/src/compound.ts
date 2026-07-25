import type { ConditionOp } from '@recued/contracts';
import type { TransformFn } from './types.js';
import { getField, evaluateOp } from './evaluate.js';

export const find: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return null;
  const field = p.field as string;
  const op = p.operator as ConditionOp;
  return arr.find(item => evaluateOp(getField(item, field), op, p.value)) ?? null;
};

export const pluck: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return [];
  return arr.map(item => getField(item, p.field as string));
};

export const sum: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return 0;
  return arr.reduce<number>((acc, item) => acc + Number(getField(item, p.field as string) ?? 0), 0);
};

export const min_by: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.reduce((best, item) =>
    Number(getField(item, p.field as string)) < Number(getField(best, p.field as string)) ? item : best,
  );
};

export const max_by: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.reduce((best, item) =>
    Number(getField(item, p.field as string)) > Number(getField(best, p.field as string)) ? item : best,
  );
};

export const percent: TransformFn = (p) => {
  const total = Number(p.total);
  if (total === 0) return 0;
  const value = Number(p.value) / total;
  const precision = Number(p.precision ?? 2);
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

export const join: TransformFn = (p) => {
  const arr = p.array as unknown[];
  if (!Array.isArray(arr)) return '';
  return arr.join(String(p.separator ?? ', '));
};
