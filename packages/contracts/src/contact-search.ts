import type { ContactRecord, ContactSource } from './contact.js';
import type { TimelineRollup } from './mcp.js';

/** Paired-owner search of the saved contact graph. Never polls providers. */
export interface ContactSearchLocalRequest {
  query: string;
  source?: ContactSource;
  since?: number;
  phone_exact?: string;
  limit?: number;
  offset?: number;
  with_rollups?: boolean;
}
export interface ContactSearchLocalResponse {
  contacts: ContactRecord[];
  total: number;
  rollups?: Record<string, TimelineRollup[]>;
}
