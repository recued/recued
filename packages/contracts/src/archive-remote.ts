/** Owner-only remote archive delivery. Credentials and recovery words never
 * enter these views or the durable delivery ledger. Verification means that
 * the retrieved ciphertext matched the exported bytes, not a restored DB. */
export interface ArchiveRemoteTarget {
  operation_id: string;
  connection_name: string;
  destination_id: string;
  keep_last: number;
}

export interface ArchiveRemoteDestination {
  connection_name: string;
  /** Binds the displayed bucket/endpoint/scope, without credential material. */
  destination_id: string;
  bucket: string;
  region: string;
  endpoint: string;
  /** App-owned objects stay inside the connection's selected resource scope. */
  prefix: string;
}

export type ArchiveRemoteState = 'preparing' | 'uploading' | 'verifying'
  | 'verified' | 'unconfirmed' | 'pruning' | 'pruned';
export type ArchiveRemoteIssue = 'interrupted' | 'export_failed' | 'destination_unavailable'
  | 'transfer_unconfirmed' | 'verification_failed';

export interface ArchiveRemoteBackup {
  operation_id: string;
  job_id: string;
  destination: ArchiveRemoteDestination;
  object_key: string;
  created_at: number;
  state: ArchiveRemoteState;
  keep_last: number;
  bytes?: number;
  sha256?: string;
  verified_at?: number;
  issue?: ArchiveRemoteIssue;
  retention_pending?: boolean;
}
