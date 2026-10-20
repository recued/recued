import { calendarDayMs } from '@recued/contracts';
import type { RecordsStore } from '../records/store.js';
import { traceId, type ProactiveTrace } from '../storage/proactive-trace-store.js';
import { SituationScanBoundError } from './query.js';

interface PhotoPeople {
  filePath(id: string): string | undefined;
  contact(email: string): string | undefined;
}
const reference = (value: unknown, entity: string): string | undefined => typeof value === 'string'
  ? value.startsWith(`${entity}/`) ? value.slice(entity.length + 1) : value : undefined;

/** Read only metadata already prepared by the installed photo pack. A scan or
 * an AI caption is not a capture date; missing EXIF stays missing. No image
 * bytes, roster names or AI descriptions enter a trace. A face can add only an
 * existing contact id, joined through the exact enrolled file path. */
export const readPhotoTraces = (records: Pick<RecordsStore, 'listNamespaces' | 'ownerSearch'>, now: number, people?: PhotoPeople): ProactiveTrace[] => {
  const result: ProactiveTrace[] = []; let scanned = 0;
  for (const namespace of records.listNamespaces()) {
    if (namespace.state.state !== 'ready' || namespace.owner.publisher !== 'recued-core' || namespace.owner.pack_slug !== 'job-photo-delivery' || !namespace.schema.entities.photo) continue;
    let cursor: string | undefined;
    do {
      const page = records.ownerSearch({ owner: namespace.owner, entity: 'photo', include_orphaned: false, limit: 200, ...(cursor ? { cursor } : {}) });
      scanned += page.records.length; if (scanned > 20000) throw new SituationScanBoundError('Photo history exceeds its metadata scan bound');
      for (const photo of page.records) {
        if (typeof photo.source_record_id !== 'string' || !photo.source_record_id.startsWith('file:') || typeof photo.taken_at !== 'string') continue;
        const date = /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T]|$)/u.exec(photo.taken_at); if (!date) continue;
        const day = calendarDayMs(`${date[1]}-${date[2]}-${date[3]}`); if (day === null || day + 86400000 > now) continue;
        const source = { collection: 'file', id: photo.source_record_id }; const name = typeof photo.filename === 'string' ? photo.filename.slice(0, 200) : 'Photo';
        result.push({ id: traceId(source, 'photo-capture'), title: `Photo: ${name}`, when: { from: day, to: day + 86400000 - 1 },
          people: [], subjects: [], sources: [source], class_id: 'photos', observed_at: day,
          ...(photo.has_location === true && typeof photo.found_location === 'string' && photo.found_location.trim() ? {
            where: { key: `photo-location:${photo.found_location.trim().toLowerCase()}`, name: photo.found_location.trim().slice(0, 500) },
          } : {}) });
      }
      if (page.next_cursor && page.next_cursor === cursor) throw new Error('Photo history cursor did not advance');
      cursor = page.next_cursor;
    } while (cursor);
  }
  if (people && result.length) for (const namespace of records.listNamespaces()) {
    if (namespace.state.state !== 'ready' || namespace.owner.publisher !== 'recued-core' || namespace.owner.pack_slug !== 'photo-attribution'
      || !namespace.schema.entities.face_profile || !namespace.schema.entities.photo || !namespace.schema.entities.attributed_result) continue;
    const read = (entity: string): Record<string, unknown>[] => {
      const rows: Record<string, unknown>[] = []; let cursor: string | undefined;
      do {
        const page = records.ownerSearch({ owner: namespace.owner, entity, include_orphaned: false, limit: 200, ...(cursor ? { cursor } : {}) });
        rows.push(...page.records); scanned += page.records.length;
        if (scanned > 20000) throw new SituationScanBoundError('Photo attribution exceeds its metadata scan bound');
        if (page.next_cursor && cursor === page.next_cursor) throw new Error('Photo attribution cursor did not advance');
        cursor = page.next_cursor;
      } while (cursor);
      return rows;
    };
    const profiles = new Map(read('face_profile').flatMap(row => {
      const id = reference(row.id, 'face_profile'); const contact = row.status === 'active' && typeof row.contact_email === 'string' ? people.contact(row.contact_email) : undefined;
      return id && contact ? [[id, contact] as const] : [];
    }));
    const photos = new Map(read('photo').flatMap(row => {
      const id = reference(row.id, 'photo'); return id && typeof row.source_path === 'string' && !['skipped', 'rejected', 'deleted'].includes(String(row.status))
        ? [[id, row.source_path] as const] : [];
    }));
    const byPath = new Map<string, Set<string>>();
    for (const row of read('attributed_result')) {
      if (['skipped', 'rejected', 'deleted'].includes(String(row.status))) continue;
      const path = photos.get(reference(row.photo_ref, 'photo') ?? ''); const contact = profiles.get(reference(row.profile_ref, 'face_profile') ?? '');
      if (!path || !contact) continue;
      const ids = byPath.get(path) ?? new Set<string>(); ids.add(contact); byPath.set(path, ids);
    }
    for (const trace of result) {
      const path = people.filePath(trace.sources[0]!.id); if (!path) continue;
      trace.people = [...new Set([...trace.people, ...byPath.get(path) ?? []])].sort();
    }
  }
  return [...new Map(result.map(row => [row.id, row])).values()];
};
