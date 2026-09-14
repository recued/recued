/** Browser fixture for server-side filtering and pages. The real Records store
 * and saved-view persistence are covered by the server integration tests. */
import type { RecordsFriendlyRecord, RecordsOwnerSearchRequest, RecordsSearchResult } from '@recued/contracts';

export const recordsBrowseReply = (request: RecordsOwnerSearchRequest): RecordsSearchResult => {
  const key = 'recued-test-records-searches';
  const requests = JSON.parse(sessionStorage.getItem(key) ?? '[]');
  requests.push(request);
  sessionStorage.setItem(key, JSON.stringify(requests));
  const rows: RecordsFriendlyRecord[] = Array.from({ length: 240 }, (_, index) => ({
    id: `${request.entity}-${String(index).padStart(3, '0')}`,
    title: `${index % 2 === 0 ? 'Open' : 'Closed'} ${index}`,
    amount: `${index}.0000`,
    status: index % 2 === 0 ? 'open' : 'closed',
    total: `${index}.0000`,
    parent: null,
    customer: { email: `${request.owner.publisher}@example.test` },
    _record: { entity: request.entity, version: 3, revision: 1, created_at: index, updated_at: index },
  }));
  const get = (row: RecordsFriendlyRecord, key: string): unknown => key.split('.').reduce<unknown>((value, part) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, row);
  let matching = rows.filter(row => Object.entries(request.filters ?? {}).every(([field, raw]) => {
    const { op, value } = raw as { op: string; value: unknown };
    const actual = get(row, field);
    if (op !== 'is_null' && (actual === null || actual === undefined)) return false;
    switch (op) {
      case 'prefix': return String(actual).startsWith(String(value));
      case 'eq': return actual === value;
      case 'ne': return actual !== value;
      case 'gte': return Number(actual) >= Number(value);
      case 'gt': return Number(actual) > Number(value);
      case 'lte': return Number(actual) <= Number(value);
      case 'lt': return Number(actual) < Number(value);
      case 'is_null': return (actual === null || actual === undefined) === value;
      case 'in': return Array.isArray(value) && value.includes(actual);
      default: throw new Error(`Unsupported fixture predicate ${op}`);
    }
  }));
  const sort = request.sort ?? 'id';
  const field = sort.startsWith('-') ? sort.slice(1) : sort;
  matching = matching.sort((left, right) => (sort.startsWith('-') ? -1 : 1) * (field === 'id'
    ? left.id.localeCompare(right.id) : Number(get(left, field)) - Number(get(right, field))));
  const queryKey = JSON.stringify([request.owner, request.entity, request.filters ?? {}, sort]);
  const handles: Record<string, { queryKey: string; offset: number }> = JSON.parse(sessionStorage.getItem('recued-test-records-cursors') ?? '{}');
  const handle = request.cursor ? handles[request.cursor] : undefined;
  if (request.cursor && (!handle || handle.queryKey !== queryKey)) throw new Error('Records cursor belongs to another query');
  const offset = handle?.offset ?? 0;
  const limit = request.limit ?? 50;
  const cursor = (offset: number): string => {
    const id = `page-${crypto.randomUUID()}`;
    handles[id] = { queryKey, offset };
    return id;
  };
  const response = { records: matching.slice(offset, offset + limit),
    ...(offset + limit < matching.length ? { next_cursor: cursor(offset + limit) } : {}),
    ...(offset > 0 ? { prev_cursor: cursor(Math.max(0, offset - limit)) } : {}),
  };
  sessionStorage.setItem('recued-test-records-cursors', JSON.stringify(handles));
  return response;
};
