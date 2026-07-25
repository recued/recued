/** D-117 Phase 6 — calendar-capability install-time validator.
 *
 *  Walks a recipe looking for calendar mutation steps (`calendar-create`
 *  / `calendar-update` / `calendar-delete` / `calendar-rsvp`) plus the
 *  `calendar-search` read whose support varies by adapter, and checks
 *  each targeted instance for the required caps. Mirrors
 *  `validate-file-caps.ts` so Kitchen + the install dialog can render
 *  the same "re-auth / pick a different instance" CTAs across both
 *  platforms.
 *
 *  Capability requirements:
 *    calendar-create → caps.create_event === 'yes' on `slug`.
 *    calendar-update → caps.update_event === 'yes' on `slug`.
 *    calendar-delete → caps.delete_event === 'yes' on `slug`.
 *    calendar-rsvp   → caps.rsvp         === 'yes' on `slug`.
 *    calendar-search → caps.search       !== 'none' on `slug`.
 *
 *  Read ingredients (`calendar-list`, `calendar-get`, `calendar-stat`)
 *  ride on the always-true `read: 'yes'` floor — we still surface a
 *  warning when the instance is unknown so the caller knows the recipe
 *  won't fire.
 *
 *  Unknown instances (server offline / not paired) surface as
 *  warnings — the recipe may ship to users whose server has the
 *  named instance.
 */

import type { RecipeDefinition } from '@recued/contracts';

export interface CalendarInstanceCaps {
  slug: string;
  caps: {
    read: 'yes';
    list_calendars: 'yes' | 'no';
    create_event: 'yes' | 'no';
    update_event: 'yes' | 'no';
    delete_event: 'yes' | 'no';
    rsvp: 'yes' | 'no';
    search: 'local' | 'remote' | 'none';
    watch: 'poll' | 'none';
    // `'none'` (D-173 P4.3) — the credential-free local calendar.
    auth: 'none' | 'oauth' | 'basic' | 'app_password';
    recurrence: 'server' | 'client';
  };
  auth_state: 'healthy' | 'expired' | 'unauthorized' | 'degraded';
}

export type CalendarInstanceLookup = () =>
  | Promise<readonly CalendarInstanceCaps[]>
  | readonly CalendarInstanceCaps[];

export type CalendarCapIngredient =
  | 'calendar-create'
  | 'calendar-update'
  | 'calendar-delete'
  | 'calendar-rsvp'
  | 'calendar-search'
  | 'calendar-list'
  | 'calendar-get'
  | 'calendar-stat';

export interface CalendarCapsIssue {
  severity: 'error' | 'warning';
  step_id: string;
  ingredient: CalendarCapIngredient;
  code:
    | 'calendar_instance_unknown'
    | 'calendar_capability_denied'
    | 'calendar_instance_degraded'
    | 'calendar_missing_target';
  instance: string;
  message: string;
}

const CAP_REQUIREMENTS: Partial<
  Record<CalendarCapIngredient, keyof CalendarInstanceCaps['caps']>
> = {
  'calendar-create': 'create_event',
  'calendar-update': 'update_event',
  'calendar-delete': 'delete_event',
  'calendar-rsvp': 'rsvp',
};

const CALENDAR_SLUGS = new Set<CalendarCapIngredient>([
  'calendar-create',
  'calendar-update',
  'calendar-delete',
  'calendar-rsvp',
  'calendar-search',
  'calendar-list',
  'calendar-get',
  'calendar-stat',
]);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const own = (value: Record<string, unknown>, key: string): unknown =>
  hasOwn(value, key) ? value[key] : undefined;

interface Target {
  step_id: string;
  ingredient: CalendarCapIngredient;
  slug: string | null;
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
    if (typeof slug !== 'string') continue;
    if (!CALENDAR_SLUGS.has(slug as CalendarCapIngredient)) continue;
    const stepId = own(s, 'id');
    const input = own(s, 'input');
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      targets.push({
        step_id: typeof stepId === 'string' ? stepId : '',
        ingredient: slug as CalendarCapIngredient,
        slug: null,
      });
      continue;
    }
    const body = input as Record<string, unknown>;
    const target = own(body, 'slug');
    if (typeof target !== 'string' || target.length === 0) {
      targets.push({
        step_id: typeof stepId === 'string' ? stepId : '',
        ingredient: slug as CalendarCapIngredient,
        slug: null,
      });
      continue;
    }
    targets.push({
      step_id: typeof stepId === 'string' ? stepId : '',
      ingredient: slug as CalendarCapIngredient,
      slug: target,
    });
  }
  return targets;
};

const isPlaceholderRef = (value: string): boolean =>
  value.includes('{{') && value.includes('}}');

export const validateCalendarInstanceCaps = async (
  recipe: RecipeDefinition,
  lookup: CalendarInstanceLookup,
): Promise<CalendarCapsIssue[]> => {
  const targets = collectTargets(recipe);
  if (targets.length === 0) return [];

  const resolved = await Promise.resolve(lookup());
  const byName = new Map<string, CalendarInstanceCaps>();
  for (const inst of resolved) byName.set(inst.slug, inst);

  const issues: CalendarCapsIssue[] = [];
  for (const target of targets) {
    if (!target.slug) {
      issues.push({
        severity: 'error',
        step_id: target.step_id,
        ingredient: target.ingredient,
        code: 'calendar_missing_target',
        instance: '',
        message: `${target.ingredient} at step '${target.step_id}' is missing the slug field`,
      });
      continue;
    }
    if (isPlaceholderRef(target.slug)) continue;
    const inst = byName.get(target.slug);
    if (!inst) {
      issues.push({
        severity: 'warning',
        step_id: target.step_id,
        ingredient: target.ingredient,
        code: 'calendar_instance_unknown',
        instance: target.slug,
        message: `Calendar instance '${target.slug}' is not enrolled on this server — step '${target.step_id}' (${target.ingredient}) will fail at runtime unless a compatible instance is enrolled`,
      });
      continue;
    }
    const requirement = CAP_REQUIREMENTS[target.ingredient];
    if (requirement) {
      const value = inst.caps[requirement];
      if (value !== 'yes') {
        issues.push({
          severity: 'error',
          step_id: target.step_id,
          ingredient: target.ingredient,
          code: 'calendar_capability_denied',
          instance: target.slug,
          message: `Calendar instance '${target.slug}' (caps.${requirement}='${value}') cannot satisfy ${target.ingredient} at step '${target.step_id}'`,
        });
        continue;
      }
    }
    if (target.ingredient === 'calendar-search' && inst.caps.search === 'none') {
      issues.push({
        severity: 'error',
        step_id: target.step_id,
        ingredient: target.ingredient,
        code: 'calendar_capability_denied',
        instance: target.slug,
        message: `Calendar instance '${target.slug}' has caps.search='none' — calendar-search at step '${target.step_id}' will reject at runtime`,
      });
      continue;
    }
    if (inst.auth_state !== 'healthy') {
      issues.push({
        severity: 'warning',
        step_id: target.step_id,
        ingredient: target.ingredient,
        code: 'calendar_instance_degraded',
        instance: target.slug,
        message: `Calendar instance '${target.slug}' auth_state='${inst.auth_state}' — re-auth before running step '${target.step_id}'`,
      });
    }
  }
  return issues;
};
