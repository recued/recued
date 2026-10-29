const fail = (message: string): never => { throw new Error(`CSV Toolkit: ${message}`); };
export interface Decimal { n: bigint; scale: number }
export const decimal = (value: string, label: string): Decimal => {
  const s = value.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(s)) return fail(`${label} must be a plain decimal number; blanks, currency symbols, separators and exponents are not inferred`);
  const scale = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
  if (scale > 18 || s.replace(/[^0-9]/gu, '').length > 38) return fail(`${label} exceeds 38 digits or 18 decimal places`);
  return { n: BigInt(s.replace('.', '')), scale };
};
const scaled = (d: Decimal, scale: number): bigint => d.n * 10n ** BigInt(scale - d.scale);
export const compare = (a: Decimal, b: Decimal): number => {
  const scale = Math.max(a.scale, b.scale), x = scaled(a, scale), y = scaled(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
};
export const plus = (a: Decimal, b: Decimal): Decimal => {
  const scale = Math.max(a.scale, b.scale); return { n: scaled(a, scale) + scaled(b, scale), scale };
};
export const format = ({ n, scale }: Decimal): string => {
  const sign = n < 0n ? '-' : '', digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  if (!scale) return sign + digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return sign + digits.slice(0, -scale) + (fraction ? '.' + fraction : '');
};
export const average = (sum: Decimal, count: number, scale: number): string => {
  const numerator = sum.n * 10n ** BigInt(scale), divisor = BigInt(count) * 10n ** BigInt(sum.scale);
  let quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= divisor) quotient += numerator < 0n ? -1n : 1n;
  return format({ n: quotient, scale });
};
