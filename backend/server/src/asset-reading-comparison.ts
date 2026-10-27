import { assetFactRefKey, assetRuleInput, type AssetFactContext, type AssetFactContextNode, type AssetFieldRef, type AssetReadingComparison, type AssetRule } from '@recued/contracts';

type RuleNode = Extract<AssetFactContextNode, { kind: 'rule' }>;
export type SavedReadingComparison = { input: AssetFieldRef } & AssetReadingComparison;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Exact subtraction of the canonical decimal spellings of two finite saved
 * numbers. No binary subtraction artefacts, rounding or precision inference.
 * IEEE finite inputs bound the work to fewer than 650 decimal digits. */
const decimalDistance = (left: number, right: number): string | undefined => {
  const parts = (n: number) => {
    const [mantissa = '', exponent = '0'] = String(n).toLowerCase().split('e');
    const [whole = '', fraction = ''] = mantissa.replace('-', '').split('.');
    return { units: BigInt(whole + fraction) * (n < 0 ? -1n : 1n), scale: fraction.length - Number(exponent) };
  };
  const a = parts(left), b = parts(right); const scale = Math.max(0, a.scale, b.scale);
  let delta = a.units * 10n ** BigInt(scale - a.scale) - b.units * 10n ** BigInt(scale - b.scale);
  if (delta < 0n) delta = -delta;
  if (delta === 0n) return '0';
  const digits = String(delta); const significant = digits.replace(/0+$/u, '');
  // Do not invent a rounded gap if the exact result is too long to present.
  if (significant.length > 80) return undefined;
  const padded = digits.padStart(scale + 1, '0');
  const plain = scale ? `${padded.slice(0, -scale)}.${padded.slice(-scale)}`.replace(/0+$/u, '').replace(/\.$/u, '') : padded;
  if (plain.length <= 80) return plain;
  const exponent = digits.length - scale - 1;
  return `${significant[0]}${significant.length > 1 ? `.${significant.slice(1)}` : ''}e${exponent >= 0 ? '+' : ''}${exponent}`;
};

/** D-325 — shared by native Chat context and the owner item read. Callers bind
 * the reading to its declared rule; this function never reads or writes data. */
export const compareSavedAssetReading = (value: unknown, when: Extract<AssetRule['when'], { kind: 'objective' }>, readAt: number, future = false): AssetReadingComparison => {
  if (value === null || value === undefined) return { kind: 'unavailable', reason: 'unknown' };
  if (!object(value) || typeof value.value !== 'number' || !Number.isFinite(value.value) || typeof value.unit !== 'string' || !value.unit.trim()
    || typeof value.as_of !== 'number' || !Number.isSafeInteger(value.as_of) || Math.abs(value.as_of) > 8.64e15
    || !Number.isFinite(when.target) || !when.unit.trim() || !Number.isFinite(readAt)) return { kind: 'unavailable', reason: 'invalid_reading' };
  if (value.unit !== when.unit) return { kind: 'unavailable', reason: 'unit_mismatch' };
  if (future || value.as_of > readAt) return { kind: 'unavailable', reason: 'future' };
  return { kind: 'compared', value: value.value, target: when.target, unit: value.unit, observed_at: value.as_of,
    relation: value.value < when.target ? 'below' : value.value > when.target ? 'above' : 'equal', difference: decimalDistance(value.value, when.target) };
};

/** A pure calculation over one returned native view, never a rule-engine
 * verdict or an authority receipt. Its caller must attest the graph and bind
 * the reading and rule input citations before offering the result to Chat. */
export const compareDeclaredAssetTarget = (graph: AssetFactContext, node: RuleNode): SavedReadingComparison | undefined => {
  if (node.rule.when.kind !== 'objective') return undefined;
  const input = assetRuleInput(node.ref.asset_id, node.rule);
  const unavailable = (reason: Extract<SavedReadingComparison, { kind: 'unavailable' }>['reason']): SavedReadingComparison => ({ input, kind: 'unavailable', reason });
  const field = graph.nodes.find(row => row.kind === 'field' && assetFactRefKey(row.ref) === assetFactRefKey(input));
  const joined = graph.edges.some(edge => edge.kind === 'uses' && assetFactRefKey(edge.from) === assetFactRefKey(node.ref)
    && assetFactRefKey(edge.to) === assetFactRefKey(input));
  if (node.ref.asset_id !== graph.asset.id || node.ref.rule_id !== node.rule.id || !joined || !field || field.kind !== 'field') return unavailable('unreturned_input');
  if (field.value_omitted) return unavailable('omitted');
  if (!field.known || field.value === null) return unavailable('unknown');
  return { input, ...compareSavedAssetReading(field.value, node.rule.when, graph.read_at, field.future) };
};
