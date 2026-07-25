/** Phase 7 (D-110) — file-capability install-time validator.
 *
 *  Walks a recipe looking for file mutation steps
 *  (`file-write` / `file-delete` / `file-move`) and checks each
 *  targeted instance for the required caps. Runs independently of
 *  `validateIngredientRefs` so recipe publishers can surface the
 *  capability-mismatch class of errors separately — Kitchen + the
 *  install dialog render these with a different CTA (re-auth / pick
 *  a different instance vs. install a different ingredient).
 *
 *  Capability requirements:
 *    file-write  → caps.write === 'yes' on `target`.
 *    file-delete → caps.delete === 'yes' on `target`.
 *    file-move   → caps on source ⊇ { delete } AND
 *                  caps on destination ⊇ { write }.
 *
 *  Unknown instances (server offline / not paired) surface as
 *  warnings — the recipe may ship to users whose server has the
 *  named instance. Published recipes therefore don't need the
 *  publisher's own server reachable. */

import type { RecipeDefinition } from '@recued/contracts';

export interface FileInstanceCaps {
  slug: string;
  caps: {
    read: 'yes';
    write: 'yes' | 'no';
    delete: 'yes' | 'no';
    watch: 'realtime' | 'poll' | 'none';
    mirror: 'optional' | 'required' | 'disabled';
    auth: 'none' | 'oauth' | 'keys';
    path_style: 'posix' | 's3-key' | 'uri';
  };
  auth_state: 'healthy' | 'expired' | 'unauthorized' | 'degraded';
}

export type FileInstanceLookup = () =>
  | Promise<readonly FileInstanceCaps[]>
  | readonly FileInstanceCaps[];

export interface FileCapsIssue {
  severity: 'error' | 'warning';
  step_id: string;
  ingredient: 'file-write' | 'file-delete' | 'file-move';
  code:
    | 'file_instance_unknown'
    | 'file_capability_denied'
    | 'file_instance_degraded'
    | 'file_missing_target';
  instance: string;
  message: string;
}

const FILE_SLUGS = new Set([
  'file-write',
  'file-delete',
  'file-move',
]);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const own = (value: Record<string, unknown>, key: string): unknown =>
  hasOwn(value, key) ? value[key] : undefined;

interface Target {
  step_id: string;
  ingredient: FileCapsIssue['ingredient'];
  /** Instance slugs that must be checked — two for `file-move`. */
  targets: { slug: string; requirement: 'write' | 'delete' }[];
}

const collectTargets = (recipe: RecipeDefinition): Target[] => {
  const targets: Target[] = [];
  const steps = [
    ...(recipe.prefetch_steps ?? []),
    ...(recipe.steps ?? []),
  ];

  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
    const s = step as Record<string, unknown>;
    const slug = own(s, 'ingredient');
    if (typeof slug !== 'string' || !FILE_SLUGS.has(slug)) continue;
    const stepId = own(s, 'id');
    const input = own(s, 'input');
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const body = input as Record<string, unknown>;

    if (slug === 'file-write') {
      const t = own(body, 'target') ?? own(body, 'slug');
      if (typeof t !== 'string' || t.length === 0) {
        targets.push({
          step_id: typeof stepId === 'string' ? stepId : '',
          ingredient: 'file-write',
          targets: [],
        });
        continue;
      }
      targets.push({
        step_id: typeof stepId === 'string' ? stepId : '',
        ingredient: 'file-write',
        targets: [{ slug: t, requirement: 'write' }],
      });
    } else if (slug === 'file-delete') {
      const t = own(body, 'target') ?? own(body, 'slug');
      if (typeof t !== 'string' || t.length === 0) {
        targets.push({
          step_id: typeof stepId === 'string' ? stepId : '',
          ingredient: 'file-delete',
          targets: [],
        });
        continue;
      }
      targets.push({
        step_id: typeof stepId === 'string' ? stepId : '',
        ingredient: 'file-delete',
        targets: [{ slug: t, requirement: 'delete' }],
      });
    } else if (slug === 'file-move') {
      const from = own(body, 'from_slug') ?? own(body, 'from');
      const to = own(body, 'to_slug') ?? own(body, 'to');
      if (typeof from !== 'string' || typeof to !== 'string') {
        targets.push({
          step_id: typeof stepId === 'string' ? stepId : '',
          ingredient: 'file-move',
          targets: [],
        });
        continue;
      }
      targets.push({
        step_id: typeof stepId === 'string' ? stepId : '',
        ingredient: 'file-move',
        targets: [
          { slug: from, requirement: 'delete' },
          { slug: to, requirement: 'write' },
        ],
      });
    }
  }
  return targets;
};

const isPlaceholderRef = (value: string): boolean =>
  value.includes('{{') && value.includes('}}');

export const validateFileInstanceCaps = async (
  recipe: RecipeDefinition,
  lookup: FileInstanceLookup,
): Promise<FileCapsIssue[]> => {
  const targets = collectTargets(recipe);
  if (targets.length === 0) return [];

  const resolved = await Promise.resolve(lookup());
  const byName = new Map<string, FileInstanceCaps>();
  for (const inst of resolved) byName.set(inst.slug, inst);

  const issues: FileCapsIssue[] = [];
  for (const target of targets) {
    if (target.targets.length === 0) {
      issues.push({
        severity: 'error',
        step_id: target.step_id,
        ingredient: target.ingredient,
        code: 'file_missing_target',
        instance: '',
        message: `${target.ingredient} at step '${target.step_id}' is missing the target instance field`,
      });
      continue;
    }

    for (const need of target.targets) {
      // Dynamic instances — can't resolve at install time.
      if (isPlaceholderRef(need.slug)) continue;
      const inst = byName.get(need.slug);
      if (!inst) {
        issues.push({
          severity: 'warning',
          step_id: target.step_id,
          ingredient: target.ingredient,
          code: 'file_instance_unknown',
          instance: need.slug,
          message: `File instance '${need.slug}' is not enrolled on this server — step '${target.step_id}' (${target.ingredient}) will fail at runtime unless a compatible instance is enrolled`,
        });
        continue;
      }
      if (inst.caps[need.requirement] !== 'yes') {
        issues.push({
          severity: 'error',
          step_id: target.step_id,
          ingredient: target.ingredient,
          code: 'file_capability_denied',
          instance: need.slug,
          message: `File instance '${need.slug}' (caps.${need.requirement}='${inst.caps[need.requirement]}') cannot satisfy ${target.ingredient} at step '${target.step_id}'`,
        });
        continue;
      }
      if (inst.auth_state !== 'healthy') {
        issues.push({
          severity: 'warning',
          step_id: target.step_id,
          ingredient: target.ingredient,
          code: 'file_instance_degraded',
          instance: need.slug,
          message: `File instance '${need.slug}' auth_state='${inst.auth_state}' — re-auth before running step '${target.step_id}'`,
        });
      }
    }
  }
  return issues;
};
