import type { Asset, SituationSnapshot } from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';
import type { ReadGrantChecker } from '../read-grant-checker.js';
import type { SituationReadContext } from './query.js';
import { scopeWorkFields } from './read-scope.js';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const changedAssetFields = (after: Asset, before?: Asset): string[] => {
  const changed: string[] = [];
  for (const key of ['name', 'class_id', 'status', 'holder_contact', 'belongs_to', 'audience', 'sphere', 'sphere_override',
    'document_number', 'serial_number', 'exact_address', 'retirement', 'values', 'anchors'] as const) {
    if (!before || !same(after[key], before[key])) changed.push(key);
  }
  for (const key of ['dates', 'readings', 'observations', 'attributes', 'settings'] as const) {
    for (const field of new Set([...Object.keys(after[key]), ...Object.keys(before?.[key] ?? {})])) {
      if (!before || !same(after[key][field], before[key][field])) changed.push(`${key}.${field}`);
    }
  }
  const priorRules = new Map(before?.rules.map(rule => [rule.id, rule]));
  const nextRules = new Map(after.rules.map(rule => [rule.id, rule]));
  for (const id of new Set([...priorRules.keys(), ...nextRules.keys()])) if (!same(priorRules.get(id), nextRules.get(id))) changed.push(`rules.${id}`);
  return changed.sort();
};
const workCollections = new Set(['asset', 'task', 'note', 'commitment', 'project', 'booking']);
export const situationSourceReadOp = (collection: string): string | undefined => workCollections.has(collection)
  ? 'core.work-entity.read'
  : ({ calendar: 'core.data.calendar.list', reminder: 'core.reminder.list', contact: 'core.contact.resolve',
    mail: 'core.mail.get', mail_fact: 'core.mail.fact.list', file: 'core.storage.file.get',
    memory: 'core.memory.read', history_trace: 'core.situation.read',
    episode: 'core.situation.read', occasion: 'core.situation.read' } as Record<string, string>)[collection];
const allowed = (grants: ReadGrantChecker, collection: string): boolean => {
  const verb = situationSourceReadOp(collection);
  return verb !== undefined && grants.isVerbOpGranted(verb) && grants.isCollectionReadGranted(collection === 'mail_fact' ? 'mail' : collection === 'history_trace' ? 'episode' : collection);
};
export const wholeSituationSnapshotAllowed = (snapshot: SituationSnapshot, grants: ReadGrantChecker, context?: SituationReadContext): boolean => {
  try { return Boolean(snapshot?.cluster && Array.isArray(snapshot.cluster.items) && Array.isArray(snapshot.cluster.subjects))
    && (context?.memoryAllowed?.(snapshot.cluster) ?? true)
    && snapshot.cluster.items.every(item => allowed(grants, item.ref.collection)
      && (!context || context.owner || context.all_spheres || (item.sphere && context.spheres?.includes(item.sphere)))
      && (item.who.value ?? []).every(id => allowed(grants, 'contact') && (!context || context.owner || context.all_spheres
        || (context.referenceSphere?.({ collection: 'contact', id }) !== undefined
          && context.spheres?.includes(context.referenceSphere({ collection: 'contact', id })!))))
      && [...item.evidence, ...item.what.evidence, ...item.when.evidence, ...item.where.evidence, ...item.who.evidence]
        .every(ref => allowed(grants, ref.collection) && (!context || context.owner || context.all_spheres
          || (context.referenceSphere?.(ref) !== undefined && context.spheres?.includes(context.referenceSphere(ref)!)))))
    && snapshot.cluster.subjects.every(ref => allowed(grants, ref.collection) && (!context || context.owner || context.all_spheres
      || (context.referenceSphere?.(ref) !== undefined && context.spheres?.includes(context.referenceSphere(ref)!))));
  } catch { return false; }
};

/** Applied per subscriber BEFORE trigger conditions or preapproval capture.
 * An absent read context carries only ids and changed field names. */
export const projectProactiveEvent = (event: WarehouseEvent, grants?: ReadGrantChecker, context?: SituationReadContext): WarehouseEvent => {
  const limited = context && !context.owner && !context.all_spheres;
  const otherScopedData = limited && (event.platform === 'work' || ['contact', 'calendar', 'mail', 'mail_fact'].includes(event.platform));
  if (!(event.platform === 'work' && event.slug === 'asset') && event.platform !== 'situation' && !otherScopedData) return event;
  if (grants) {
    const assetSphereAllowed = (record: Record<string, unknown> | undefined): boolean => !context || context.owner || context.all_spheres === true
      || Boolean(record && context.spheres?.includes((record.sphere_override ?? record.sphere) as never));
    // §4.5 — a scoped subscriber's work records lose what a scoped read strips.
    const allows = (ref: { collection: string; id: string }): boolean => {
      const sphere = context?.referenceSphere?.(ref); return sphere !== undefined && context?.spheres?.includes(sphere) === true;
    };
    const scoped = <T>(value: T): T => value && typeof value === 'object' ? scopeWorkFields(value as Record<string, unknown>, allows) as T : value;
    const scopedWork = (value: WarehouseEvent): WarehouseEvent => !limited || value.platform !== 'work' ? value : {
      ...value, ...(value.record ? { record: scoped(value.record) } : {}),
      ...(value.prev ? { prev: { ...value.prev, ...(value.prev.record ? { record: scoped(value.prev.record) } : {}),
        ...(value.prev.prior ? { prior: scoped(value.prev.prior) } : {}) } } : {}),
    };
    // §4.11 — the current asset is judged by its resolved placement, as a read is, so a
    // pin or a source placement counts; an older snapshot keeps the placement it carried.
    const currentAssetAllowed = (): boolean => {
      if (!context || context.owner || context.all_spheres === true) return true;
      const resolved = event.slug === 'asset' ? context.referenceSphere?.({ collection: 'asset', id: event.record_id }) : undefined;
      return resolved === undefined ? assetSphereAllowed(event.record) : context.spheres?.includes(resolved) === true;
    };
    if (event.platform === 'work' && allowed(grants, 'asset') && currentAssetAllowed()
      && (!event.prev?.record || assetSphereAllowed(event.prev.record as Record<string, unknown>))
      && (!event.prev?.prior || assetSphereAllowed(event.prev.prior as Record<string, unknown>))) return scopedWork(event);
    if (event.platform === 'situation' && grants.isVerbOpGranted('core.situation.read')
      && event.record && wholeSituationSnapshotAllowed(event.record as unknown as SituationSnapshot, grants, context)
      && (!event.prev?.record || wholeSituationSnapshotAllowed(event.prev.record as SituationSnapshot, grants, context))
      && (!event.prev?.prior || wholeSituationSnapshotAllowed(event.prev.prior as SituationSnapshot, grants, context))) return event;
    if (otherScopedData) {
      const collection = event.platform === 'work' ? event.slug : event.platform;
      // Old snapshots without a verifiable placement stay as a doorbell. The
      // subscriber can re-read the current record through its scoped reader.
      if (allowed(grants, collection) && currentAssetAllowed()
        && (!event.prev?.record || assetSphereAllowed(event.prev.record as Record<string, unknown>))
        && (!event.prev?.prior || assetSphereAllowed(event.prev.prior as Record<string, unknown>))) return scopedWork(event);
    }
  }
  const changed_fields = event.changed_fields ?? [];
  const snapshot = { id: event.record_id, changed_fields };
  return {
    platform: event.platform, slug: event.slug, entity_type: event.entity_type,
    event_kind: event.event_kind, record_id: event.record_id, at: event.at, changed_fields,
    ...(event.origin ? { origin: event.origin } : {}), ...(event.in_drain ? { in_drain: true } : {}),
    record: snapshot,
    prev: { record: snapshot, ...(event.prev?.prior ? { prior: snapshot } : {}), changed_fields,
      ...(event.platform === 'situation' ? { revision: event.prev?.revision, cause: event.prev?.cause } : {}) },
  };
};
