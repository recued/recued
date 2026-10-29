import { CSV_TOOLKIT_LIMITS, type CsvExpression } from '@recued/contracts';
import { decimal, plus, format, type Decimal } from './csv-decimal.js';

type Evaluate = (row: string[]) => string;
const fail = (message: string): never => { throw new Error(`CSV Toolkit: ${message}`); };
const bounded = (value: string): string => value.length <= CSV_TOOLKIT_LIMITS.cell_chars
  ? value : fail('mapped cell exceeds the character limit');
const divide = (a: Decimal, b: Decimal, scale: number): string => {
  if (b.n === 0n) return fail('division by zero');
  const numerator = a.n * 10n ** BigInt(b.scale + scale), divisor = b.n * 10n ** BigInt(a.scale);
  let quotient = numerator / divisor;
  const remainder = numerator % divisor, abs = (n: bigint) => n < 0n ? -n : n;
  if (abs(remainder) * 2n >= abs(divisor)) quotient += (numerator < 0n) !== (divisor < 0n) ? -1n : 1n;
  return format({ n: quotient, scale });
};

/** Compile once against the original schema. Expressions cannot execute code,
 * mutate a row, or refer to another mapping's partially written result. */
export const compileCsvExpression = (expression: CsvExpression, columns: string[], empty: 'error' | 'blank'): Evaluate => {
  const compile = (e: CsvExpression): Evaluate => {
    if ('column' in e) {
      const index = columns.indexOf(e.column);
      if (index < 0) return fail(`column ${JSON.stringify(e.column)} does not exist`);
      return row => row[index]!;
    }
    if ('value' in e) return () => e.value;
    switch (e.op) {
      case 'trim': case 'lower': case 'upper': case 'replace': {
        const input = compile(e.input);
        return row => {
          const value = input(row);
          return bounded(e.op === 'trim' ? value.trim() : e.op === 'lower' ? value.toLowerCase()
            : e.op === 'upper' ? value.toUpperCase() : e.op === 'replace' && value === e.from ? e.to : value);
        };
      }
      case 'concat': {
        const values = e.values.map(compile);
        return row => {
          let result = '';
          for (let i = 0; i < values.length; i++) result = bounded(result + (i ? e.separator : '') + values[i]!(row));
          return result;
        };
      }
      case 'add': case 'subtract': case 'multiply': case 'divide': {
        const left = compile(e.left), right = compile(e.right);
        const number = (value: string) => empty === 'blank' && !value.trim() ? null : decimal(value, 'mapped operand');
        return row => {
          // Evaluate both sides even when one is blank, so invalid values cannot hide.
          const a = number(left(row)), b = number(right(row));
          if (!a || !b) return '';
          const result = e.op === 'divide' ? divide(a, b, e.scale)
            : format(e.op === 'multiply' ? { n: a.n * b.n, scale: a.scale + b.scale }
              : plus(a, e.op === 'subtract' ? { n: -b.n, scale: b.scale } : b));
          // Keep arithmetic outputs valid as inputs to every numeric CSV operation.
          decimal(result, 'mapped result');
          return result;
        };
      }
    }
  };
  return compile(expression);
};
