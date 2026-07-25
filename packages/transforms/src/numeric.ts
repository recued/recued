import type { TransformFn, MathOp } from './types.js';

export const round: TransformFn = (p) => {
  const n = Number(p.input);
  if (isNaN(n)) return null;
  const precision = Number(p.precision ?? 0);
  const factor = 10 ** precision;
  return Math.round(n * factor) / factor;
};

export const clamp: TransformFn = (p) => {
  const n = Number(p.input);
  if (isNaN(n)) return null;
  return Math.min(Math.max(n, Number(p.min)), Number(p.max));
};

export const to_number: TransformFn = (p) => {
  const n = Number(p.input);
  return isNaN(n) ? null : n;
};

export const math: TransformFn = (p) => {
  // Expression mode: natural math syntax
  if (typeof p.expression === 'string') {
    return evaluateMathExpression(p.expression);
  }

  // Classic mode: left/operator/right
  const op = p.operator as MathOp;
  const left = Number(p.left);

  // Unary operations
  if (op === 'abs') return Math.abs(left);
  if (op === 'ceil') return Math.ceil(left);
  if (op === 'floor') return Math.floor(left);

  // Binary operations
  const right = Number(p.right);
  if (op === 'add') return left + right;
  if (op === 'subtract') return left - right;
  if (op === 'multiply') return left * right;
  if (op === 'divide') return right === 0 ? null : left / right;
  if (op === 'modulo') return right === 0 ? null : left % right;
  return null;
};

/** Evaluate a math expression string with basic arithmetic + functions.
 *  Supports: + - * / % ( ) and functions min, max, abs, ceil, floor, round.
 *  All values must be numeric — references are resolved before this runs.
 *  No eval() — uses a safe recursive descent parser. */
export const evaluateMathExpression = (expr: string): number | null => {
  const tokens = tokenize(expr);
  if (tokens.length === 0) return null;
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  const consume = (): string => tokens[pos++];

  const parseAtom = (): number | null => {
    const tok = peek();
    if (tok === undefined) return null;

    // Parenthesized expression
    if (tok === '(') {
      consume(); // (
      const val = parseAddSub();
      if (peek() === ')') consume(); // )
      return val;
    }

    // Function call: min(...), max(...), abs(...), etc.
    if (/^[a-z]+$/.test(tok) && tokens[pos + 1] === '(') {
      const fn = consume(); // function name
      consume(); // (
      const args: number[] = [];
      while (peek() !== ')' && peek() !== undefined) {
        const v = parseAddSub();
        if (v === null) return null;
        args.push(v);
        if (peek() === ',') consume();
      }
      if (peek() === ')') consume(); // )
      return applyFn(fn, args);
    }

    // Unary minus
    if (tok === '-') {
      consume();
      const val = parseAtom();
      return val === null ? null : -val;
    }

    // Number literal
    const n = Number(consume());
    return isNaN(n) ? null : n;
  };

  const parseMulDiv = (): number | null => {
    let left = parseAtom();
    if (left === null) return null;
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume();
      const right = parseAtom();
      if (right === null) return null;
      if (op === '*') left = left * right;
      else if (op === '/') { if (right === 0) return null; left = left / right; }
      else { if (right === 0) return null; left = left % right; }
    }
    return left;
  };

  const parseAddSub = (): number | null => {
    let left = parseMulDiv();
    if (left === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseMulDiv();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };

  const result = parseAddSub();
  return result === null || !isFinite(result) ? null : result;
};

const tokenize = (expr: string): string[] => {
  const tokens: string[] = [];
  const re = /(\d+\.?\d*|[a-z]+|[+\-*/%(),])/g;
  let m;
  while ((m = re.exec(expr)) !== null) tokens.push(m[1]);
  return tokens;
};

const applyFn = (fn: string, args: number[]): number | null => {
  if (args.length === 0) return null;
  switch (fn) {
    case 'min': return Math.min(...args);
    case 'max': return Math.max(...args);
    case 'abs': return Math.abs(args[0]);
    case 'ceil': return Math.ceil(args[0]);
    case 'floor': return Math.floor(args[0]);
    case 'round': return args.length > 1
      ? Math.round(args[0] * 10 ** args[1]) / 10 ** args[1]
      : Math.round(args[0]);
    default: return null;
  }
};

/** Compute a weighted score from multiple values. */
export const weighted_score: TransformFn = (p) => {
  const scores = p.scores as Array<{ value: unknown; weight: unknown }> | undefined;
  if (!Array.isArray(scores) || scores.length === 0) return null;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const entry of scores) {
    const value = Number(entry.value);
    const weight = Number(entry.weight);
    if (isNaN(value) || isNaN(weight)) continue;
    weightedSum += value * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;
  let result = weightedSum / totalWeight;

  // Optional clamp
  const clampRange = p.clamp as [number, number] | undefined;
  if (Array.isArray(clampRange) && clampRange.length === 2) {
    result = Math.min(Math.max(result, Number(clampRange[0])), Number(clampRange[1]));
  }

  // Optional precision (default: 1 decimal)
  const precision = Number(p.precision ?? 1);
  const factor = 10 ** precision;
  return Math.round(result * factor) / factor;
};
