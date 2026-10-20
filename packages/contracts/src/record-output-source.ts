import { CONNECTION_NAME_REGEX } from './platform-record-id.js';

/** Host-derived source of a displayed API record. This is output metadata;
 * recipes and vendor payloads cannot supply it. */
export interface RecordOutputSource {
  kind: 'api';
  platform: string;
  connection_name: string;
  /** Opaque host account revision. Older sources without it remain display-only. */
  connection_revision?: string;
  entity: string;
}

export const isRecordOutputSource = (value: unknown): value is RecordOutputSource => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return source.kind === 'api'
    && typeof source.platform === 'string' && /^[a-z][a-z0-9_-]*$/.test(source.platform)
    && typeof source.entity === 'string' && /^[a-z][a-z0-9_]*$/.test(source.entity)
    && typeof source.connection_name === 'string' && CONNECTION_NAME_REGEX.test(source.connection_name)
    && (source.connection_revision === undefined || typeof source.connection_revision === 'string'
      && /^[a-f0-9]{64}$/.test(source.connection_revision))
    && Object.keys(source).every(key => ['kind', 'platform', 'connection_name', 'connection_revision', 'entity'].includes(key));
};
