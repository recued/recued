/** D-200 — project Data's collection-qualified file entity ids into the
 * durable record refs recipe operations consume.
 *
 * `data.mirror.search(kind:'files')` returns `file:<record_id>` so Data can
 * address the Files collection uniformly. The record id is already the
 * operation-facing file_ref (commonly `file:<cas-id>`), hence a CAS hit looks
 * like `file:file:<cas-id>` on the entity wire. Strip exactly one collection
 * prefix; never hand the doubled entity id to a recipe variable.
 */

export interface FileRefPickerOption {
  id: string;
  label: string;
  sublabel?: string;
}

export const mirrorFileEntityIdToFileRef = (entityId: unknown): string | null => {
  // The outer `file:` is the collection qualifier; the inner `file:` is part
  // of every durable local/remote data.file record id.
  if (typeof entityId !== 'string' || !entityId.startsWith('file:file:')) return null;
  const ref = entityId.slice('file:'.length);
  return ref.length > 'file:'.length ? ref : null;
};

export const fileRefOptionsFromMirrorResults = (
  results: ReadonlyArray<unknown>,
): FileRefPickerOption[] => {
  const options: FileRefPickerOption[] = [];
  for (const result of results) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) continue;
    const row = result as Record<string, unknown>;
    const id = mirrorFileEntityIdToFileRef(row.entity_id);
    if (id === null || typeof row.label !== 'string' || row.label.length === 0) continue;
    options.push(typeof row.sublabel === 'string'
      ? { id, label: row.label, sublabel: row.sublabel }
      : { id, label: row.label });
  }
  return options;
};
