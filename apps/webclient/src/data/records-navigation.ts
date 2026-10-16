import type { RecordsPackRef } from '@recued/contracts';
import { serializeShellRoute, type ShellRoute } from '../shell/route.js';
export interface RecordsRecordAddress {
    owner: RecordsPackRef;
    entity: string;
    id: string;
}
export const recordsRecordAddress = ({ owner, entity, id }: RecordsRecordAddress): string => serializeShellRoute('data', 'records', owner.publisher, owner.pack_slug, entity, id);
export const parseRecordsRecordAddress = (route: ShellRoute): RecordsRecordAddress | null => route.surface === 'data' && route.segments[0] === 'records' && route.segments.length === 5 && route.segments.every(s => s.trim().length > 0)
    ? { owner: { publisher: route.segments[1]!, pack_slug: route.segments[2]! }, entity: route.segments[3]!, id: route.segments[4]! } : null;
export const customerInvoiceRecordAddress = (id: string): string => recordsRecordAddress({ owner: { publisher: 'recued-core', pack_slug: 'invoice-book' }, entity: 'invoice', id });
