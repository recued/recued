/** D-116 Phase 6 — validator for the `probe?` field on an ingredient
 *  manifest. Pure function; runs at publish time + can be re-run
 *  client-side for instant author feedback in Kitchen.
 *
 *  Rules:
 *    - Input must only reference `{{vault.<key>}}` paths. No config,
 *      context, step, or meta refs — probes run with vault values
 *      alone so they can't accidentally leak recipe-resolved data
 *      through a "Test credential" click.
 *    - `expected_field` must be declared in `manifest.output`. If the
 *      field doesn't exist on the wire, no response will ever pass.
 */

import type { IngredientManifest } from '@recued/contracts';

export interface ProbeIssue {
  code:
    | 'probe_input_invalid_ref'
    | 'probe_expected_field_undeclared'
    | 'probe_expected_field_required'
    | 'probe_input_required';
  field?: string;
  message: string;
}

const REF_RE = /\{\{([^}]+)\}\}/g;

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

const own = (obj: Record<string, unknown>, key: string): unknown =>
  hasOwn(obj, key) ? obj[key] : undefined;

const walkRefs = (v: unknown, onRef: (ref: string) => void): void => {
  if (typeof v === 'string') {
    let m: RegExpExecArray | null;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(v)) !== null) onRef(m[1].trim());
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) walkRefs(item, onRef);
    return;
  }
  if (v && typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) walkRefs(val, onRef);
  }
};

const isVaultRef = (ref: string): boolean => {
  const head = ref.split(':')[0].trim(); // strip format hints
  return head.startsWith('vault.');
};

export const validateProbeManifest = (manifest: IngredientManifest): ProbeIssue[] => {
  const manifestRecord = manifest as unknown as Record<string, unknown>;
  const probe = own(manifestRecord, 'probe');
  if (!probe) return [];
  const probeRecord = probe && typeof probe === 'object' && !Array.isArray(probe)
    ? probe as Record<string, unknown>
    : {};

  const issues: ProbeIssue[] = [];

  const input = own(probeRecord, 'input');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    issues.push({
      code: 'probe_input_required',
      field: 'probe.input',
      message: 'probe.input must be an object',
    });
  } else {
    walkRefs(input, (ref) => {
      if (!isVaultRef(ref)) {
        issues.push({
          code: 'probe_input_invalid_ref',
          field: 'probe.input',
          message: `probe.input may only reference {{vault.*}} paths — got "${ref}"`,
        });
      }
    });
  }

  const expectedField = own(probeRecord, 'expected_field');
  if (typeof expectedField !== 'string' || !expectedField) {
    issues.push({
      code: 'probe_expected_field_required',
      field: 'probe.expected_field',
      message: 'probe.expected_field is required and must be a non-empty string',
    });
  } else {
    const output = own(manifestRecord, 'output');
    const declaresExpectedField = output &&
      typeof output === 'object' &&
      !Array.isArray(output) &&
      hasOwn(output as Record<string, unknown>, expectedField);
    if (!declaresExpectedField) {
      issues.push({
        code: 'probe_expected_field_undeclared',
        field: 'probe.expected_field',
        message: `probe.expected_field "${expectedField}" is not declared in manifest.output`,
      });
    }
  }

  return issues;
};
