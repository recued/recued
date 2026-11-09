export interface SchemaCheckChannel {
  min_supported?: string | null;
  compared: readonly { label: string; breaking: number }[];
}

export declare const SCHEMA_CHECK_FILE: 'recued-schema-check.json';
export declare const SCHEMA_CHECK_SCHEMA_VERSION: 1;
export declare const removeSchemaCheck: (options: { stagingDir: string }) => void;
export declare const writeSchemaCheck: (options: {
  stagingDir: string;
  triple: string;
  version: string;
  channels: Record<string, SchemaCheckChannel>;
}) => Record<string, unknown>;
export declare const assertMigrationFlagsChecked: (options: {
  stagingDir: string;
  version: string;
  channels: Record<string, { migration?: unknown; min_supported?: unknown }> | undefined;
}) => string[];
