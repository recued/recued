import type {
  ChatMessage,
  ChatProvenanceRef,
  ChatToolCall,
} from '@recued/contracts';

import {
  connectedSourceProviderLabel,
  type ChatConnectedSource,
} from './connected-source-handoff.js';
import type { SourceRecordDataTab } from '../shell/route.js';

type SearchCall = Pick<ChatToolCall, 'tool_name' | 'status'>;

export type ConnectedSourceAnswerState =
  | 'preparing'
  | 'continuing'
  | 'searching'
  | 'reviewing'
  | 'search_complete'
  | 'search_failed'
  | 'context_only'
  | 'unverified'
  | 'answer_ready'
  | 'failed';

export interface ConnectedSourceAnswerProjection {
  readonly state: ConnectedSourceAnswerState;
  readonly badge: string;
  readonly detail: string;
  readonly pendingText: string;
  readonly tone: 'neutral' | 'positive' | 'warning' | 'danger';
  readonly searchTool: string | null;
}

export interface ConnectedSourceFollowup {
  readonly label: string;
  readonly prompt: string;
  readonly mode: ConnectedSourceFollowupMode;
  /** Noun phrase shown in the review-first composer handoff. */
  readonly outcome: string;
  /** Honest boundary between asking Chat and performing a write action. */
  readonly boundary: string;
}

export type ConnectedSourceFollowupMode = 'refresh' | 'context';

export type ConnectedSourceTurnContext =
  | 'initial'
  | ConnectedSourceFollowupMode;

export const connectedSourceSearchTool = (
  source: ChatConnectedSource,
): string | null => {
  if (source.lane === 'mail') return 'mail.search';
  if (source.lane === 'calendar') return 'calendar.search';
  // Foundational file connections do not currently have a source-specific
  // Chat primitive. Do not reinterpret work.search as proof that an arbitrary
  // connected folder or bucket was read.
  return null;
};

const connectedSourceSearchLabel = (
  source: ChatConnectedSource,
): string => source.lane === 'mail' ? 'mail' : 'calendar';

export const connectedSourceKindLabel = (
  source: ChatConnectedSource,
): string => {
  if (source.lane === 'mail') return 'mailbox';
  if (source.lane === 'calendar') return 'calendar';
  return 'file source';
};

export const connectedSourceAnswerTitle = (
  source: ChatConnectedSource,
  identity: string,
): string => {
  const provider = connectedSourceProviderLabel(source);
  const cleanIdentity = identity.trim();
  return cleanIdentity.length > 0 && cleanIdentity !== source.slug
    ? `${provider} · ${cleanIdentity}`
    : `${provider} · ${source.slug}`;
};

export const projectConnectedSourceAnswer = (
  source: ChatConnectedSource,
  calls: ReadonlyArray<SearchCall>,
  options: {
    readonly complete: boolean;
    readonly failed: boolean;
    readonly context?: ConnectedSourceTurnContext;
    readonly edited?: boolean;
  },
): ConnectedSourceAnswerProjection => {
  const searchTool = connectedSourceSearchTool(source);
  const kind = connectedSourceKindLabel(source);
  const context = options.context ?? 'initial';
  const edited = options.edited === true;
  const isFollowup = context !== 'initial';
  if (options.failed) {
    return {
      state: 'failed',
      badge: 'Needs retry',
      detail:
        `Your ${isFollowup ? 'follow-up' : 'question'} was saved, `
        + `but this answer did not finish. `
        + `You can put the same question back in the composer without reconnecting your ${kind}.`,
      pendingText: 'This answer did not finish.',
      tone: 'danger',
      searchTool,
    };
  }

  if (searchTool === null) {
    if (context === 'context') {
      if (edited) {
        return options.complete
          ? {
              state: 'answer_ready',
              badge: 'Answer ready',
              detail:
                'The edited follow-up finished. Chat does not currently '
                + 'record whether this specific file source was searched.',
              pendingText: 'Following your edited request…',
              tone: 'neutral',
              searchTool,
            }
          : {
              state: 'continuing',
              badge: 'Edited request',
              detail:
                'Chat is following your edited request. Source-specific '
                + 'activity is not recorded for this file connection.',
              pendingText: 'Following your edited request…',
              tone: 'neutral',
              searchTool,
            };
      }
      return options.complete
        ? {
            state: 'context_only',
            badge: 'No new source check',
            detail:
              'This follow-up was sent as a continuation of the previous answer. '
              + 'Chat does not currently record a source-specific search for '
              + 'this file connection.',
            pendingText: 'Continuing from the previous answer…',
            tone: 'neutral',
            searchTool,
          }
        : {
            state: 'continuing',
            badge: 'Conversation context',
            detail:
              'This follow-up is continuing from the previous answer. '
              + 'No new source-specific search was requested.',
            pendingText: 'Continuing from the previous answer…',
            tone: 'neutral',
            searchTool,
          };
    }
    return options.complete
      ? {
          state: 'answer_ready',
          badge: 'Answer ready',
          detail:
            'The answer finished. Chat does not currently record whether '
            + 'this specific file source was searched.',
          pendingText: 'Preparing your answer…',
          tone: 'neutral',
          searchTool,
        }
      : {
          state: 'preparing',
          badge: 'Preparing',
          detail:
            `This question started from your connected ${kind}. `
            + 'Chat is preparing the answer.',
          pendingText: 'Preparing your answer…',
          tone: 'neutral',
          searchTool,
        };
  }

  const matching = calls.filter((call) => call.tool_name === searchTool);
  const used = matching.some((call) => call.status === 'ok');
  const running = matching.some((call) => call.status === 'started');
  const errored = matching.some((call) => call.status === 'error');
  const searchLabel = connectedSourceSearchLabel(source);

  if (options.complete) {
    if (errored) {
      return {
        state: 'search_failed',
        badge: 'Search incomplete',
        detail: used
          ? `At least one ${searchLabel} search completed, but another did not. `
            + 'Treat this answer as incomplete and retry or review the connection.'
          : `The recorded ${searchLabel} search did not complete. `
            + 'Treat this answer as incomplete and retry or review the connection.',
        pendingText: 'Finishing with the information still available…',
        tone: 'warning',
        searchTool,
      };
    }
    if (used) {
      return {
        state: 'search_complete',
        badge: `${searchLabel[0]!.toUpperCase()}${searchLabel.slice(1)} search completed`,
        detail:
          `This turn recorded a completed ${searchLabel} search. `
          + 'The receipt does not show which records, if any, informed the answer.',
        pendingText: `Reviewing the ${searchLabel} search…`,
        tone: 'positive',
        searchTool,
      };
    }
    if (context === 'context') {
      if (edited) {
        return {
          state: 'context_only',
          badge: 'No new search',
          detail:
            `The edited follow-up finished without a recorded ${searchLabel} search. `
            + 'Source use followed your edited request.',
          pendingText: 'Following your edited request…',
          tone: 'neutral',
          searchTool,
        };
      }
      return {
        state: 'context_only',
        badge: 'No new search',
        detail:
          `This follow-up was sent as a continuation of the previous answer. `
          + `No new ${searchLabel} search was recorded.`,
        pendingText: 'Continuing from the previous answer…',
        tone: 'neutral',
        searchTool,
      };
    }
    if (context === 'refresh') {
      return {
        state: 'unverified',
        badge: 'Search not verified',
        detail: edited
          ? `This edited follow-up started from a suggestion that requested `
            + `a new ${searchLabel} search, but none was recorded. `
            + `Review your edits and the answer before relying on ${kind}-specific claims.`
          : `This follow-up requested a new ${searchLabel} search, `
            + 'but none was recorded. '
            + `Review it before relying on ${kind}-specific claims.`,
        pendingText: 'Preparing your answer…',
        tone: 'warning',
        searchTool,
      };
    }
    return {
      state: 'unverified',
      badge: 'Search not verified',
      detail:
        `This answer finished without a recorded ${searchLabel} search. `
        + `Review it before relying on ${kind}-specific claims.`,
      pendingText: 'Preparing your answer…',
      tone: 'warning',
      searchTool,
    };
  }

  if (running) {
    return {
      state: 'searching',
      badge: `Searching ${searchLabel}`,
      detail: `Chat is searching your connected ${kind} now.`,
      pendingText: `Searching connected ${searchLabel}…`,
      tone: 'neutral',
      searchTool,
    };
  }
  if (errored) {
    return {
      state: 'search_failed',
      badge: 'Search incomplete',
      detail: used
        ? `One ${searchLabel} search completed, but another did not. `
          + 'Chat is finishing with the information still available.'
        : `The ${searchLabel} search did not complete. `
          + 'Chat is finishing with the information still available.',
      pendingText: 'Finishing with the information still available…',
      tone: 'warning',
      searchTool,
    };
  }
  if (used) {
    return {
      state: 'reviewing',
      badge: 'Search complete',
      detail: `The ${searchLabel} search completed. Chat is preparing the answer.`,
      pendingText: `Reviewing the ${searchLabel} search…`,
      tone: 'positive',
      searchTool,
    };
  }
  if (context === 'context') {
    if (edited) {
      return {
        state: 'continuing',
        badge: 'Edited request',
        detail:
          'Chat is following your edited request. '
          + `Any new ${searchLabel} search will appear here.`,
        pendingText: 'Following your edited request…',
        tone: 'neutral',
        searchTool,
      };
    }
    return {
      state: 'continuing',
      badge: 'Conversation context',
      detail:
        `This follow-up is continuing from the previous answer. `
        + `No new ${searchLabel} search was requested.`,
      pendingText: 'Continuing from the previous answer…',
      tone: 'neutral',
      searchTool,
    };
  }
  if (context === 'refresh') {
    if (edited) {
      return {
        state: 'preparing',
        badge: 'Edited request',
        detail:
          'Chat is following your edited request. '
          + `The selected next step requested a new ${searchLabel} search; `
          + 'recorded activity will appear here.',
        pendingText: 'Following your edited request…',
        tone: 'neutral',
        searchTool,
      };
    }
    return {
      state: 'preparing',
      badge: 'Search requested',
      detail:
        `This follow-up requested a new ${searchLabel} search. `
        + 'Recorded activity will appear here.',
      pendingText: `Preparing to search connected ${searchLabel}…`,
      tone: 'neutral',
      searchTool,
    };
  }
  return {
    state: 'preparing',
    badge: 'Checking activity',
    detail:
      `This question started from your connected ${kind}. `
      + `If Chat searches your ${kind}, that activity will be shown here.`,
    pendingText: 'Preparing your answer…',
    tone: 'neutral',
    searchTool,
  };
};

export const connectedSourceAnswerFollowups = (
  source: ChatConnectedSource,
): ReadonlyArray<ConnectedSourceFollowup> => {
  if (source.lane === 'mail') {
    return [
      {
        label: 'Draft the replies',
        prompt:
          'Search my connected mail again for the messages that need my response, '
          + 'then draft concise replies. '
          + 'Do not send anything.',
        mode: 'refresh',
        outcome: 'Reply drafts',
        boundary:
          'Chat will show drafts here first. '
          + 'If you ask it to send email, you’ll review and approve '
          + 'that separately.',
      },
      {
        label: 'Make an action list',
        prompt:
          'Using the previous mailbox summary, turn the action items into '
          + 'a prioritized task list.',
        mode: 'context',
        outcome: 'Prioritized action list',
        boundary:
          'Chat will show the list here first. '
          + 'If you ask it to create tasks, you’ll review and approve '
          + 'that separately.',
      },
    ];
  }
  if (source.lane === 'calendar') {
    return [
      {
        label: 'Prepare for the next meeting',
        prompt:
          'Search my connected calendar again, then help me prepare for '
          + 'the next meeting that needs my attention.',
        mode: 'refresh',
        outcome: 'Meeting prep',
        boundary:
          'Chat will show prep notes here first. '
          + 'If you ask it to change your calendar, you’ll approve '
          + 'that separately.',
      },
      {
        label: 'Check for conflicts',
        prompt:
          'Search my connected calendar again for conflicts this week and '
          + 'suggest how to resolve them.',
        mode: 'refresh',
        outcome: 'Conflict review',
        boundary:
          'Chat will suggest options here first. '
          + 'If you ask it to change your calendar, you’ll approve '
          + 'that separately.',
      },
    ];
  }
  return [
    {
      label: 'Make an action plan',
      prompt:
        'Using the previous answer, turn the most important information '
        + 'into a short action plan.',
      mode: 'context',
      outcome: 'Action plan',
      boundary:
        'Chat will show the plan here first. '
        + 'If you ask it to create tasks, you’ll review and approve '
        + 'that separately.',
    },
    {
      label: 'Show supporting details',
      prompt:
        'Using the previous answer, show the supporting details behind '
        + 'its most important point.',
      mode: 'context',
      outcome: 'Supporting details',
      boundary:
        'Chat will show supporting details here. '
        + 'If you ask it to change files, you’ll review and approve '
        + 'that separately.',
    },
  ];
};

export const connectedSourceFollowupContextDetail = (
  source: ChatConnectedSource,
  mode: ConnectedSourceFollowupMode,
): string => {
  if (mode === 'context') {
    return 'Continues from the previous answer · no new search requested';
  }
  const searchLabel = connectedSourceSearchLabel(source);
  return `Requests a new ${searchLabel} search`;
};

export const connectedSourceSearchRetryPrompt = (
  source: ChatConnectedSource,
  originalQuestion: string,
): string => {
  const searchLabel =
    source.lane === 'mail'
      ? 'connected mail'
      : source.lane === 'calendar'
        ? 'connected calendar'
        : 'connected file source';
  return `Search my ${searchLabel} before answering this question: ${originalQuestion}`;
};

/** One exact provenance reference recorded on an assistant message.
 *
 * `ChatProvenanceRef` deliberately does not claim sentence-level support.
 * New local-search references carry an account-qualified collection locator;
 * legacy or third-party references remain reviewable without inventing one.
 * This is a record reference, not a fabricated sentence-level citation.
 */
export interface ConnectedSourceRecordReference {
  /** Human-readable record label, falling back to the id/source. */
  readonly label: string;
  /** Exact source id carried on the message. */
  readonly sourceId: string;
  /** Calm display label for the source id. */
  readonly sourceLabel: string;
  /** Exact collection instance when the producer supplied an addressable
   * local warehouse locator. */
  readonly collectionSlug: string | null;
  /** Data tab that owns the collection record. */
  readonly dataTab: SourceRecordDataTab | null;
  /** Exact underlying record id when the producer supplied one. */
  readonly recordId: string | null;
}

/** Preserve record identity while removing exact duplicate references.
 *
 * Labels are intentionally NOT the dedupe key: two messages or events can
 * share a title while remaining distinct evidence records.
 */
export const connectedSourceRecordReferences = (
  message: Pick<ChatMessage, 'provenance'>,
): ConnectedSourceRecordReference[] => {
  const references: ConnectedSourceRecordReference[] = [];
  const referenceIndexes = new Map<string, number>();
  const referencesWithExplicitLabels = new Set<string>();
  for (const rawRef of message.provenance ?? []) {
    if (rawRef === null || typeof rawRef !== 'object') continue;
    const ref = rawRef as Partial<ChatProvenanceRef>;
    const sourceId =
      typeof ref.source === 'string' ? ref.source.trim() : '';
    const recordId =
      typeof ref.record_id === 'string'
      && ref.record_id.trim().length > 0
        ? ref.record_id
        : null;
    const collectionSlug =
      typeof ref.collection_slug === 'string'
      && ref.collection_slug.trim().length > 0
        ? ref.collection_slug
        : null;
    const dataTab: SourceRecordDataTab | null =
      ref.collection_platform === 'mail'
        ? 'mail'
        : ref.collection_platform === 'calendar'
          ? 'calendar'
          : ref.collection_platform === 'file'
            ? 'files'
            : null;
    const sourceLabel = provenanceSourceLabel(
      sourceId,
      dataTab,
      collectionSlug,
    );
    const explicitLabel =
      typeof ref.label === 'string' ? ref.label.trim() : '';
    if (
      sourceId.length === 0
      && recordId === null
      && explicitLabel.length === 0
    ) continue;
    const label = explicitLabel || recordId || sourceLabel;
    const key =
      recordId !== null && dataTab !== null && collectionSlug !== null
        ? `collection:${dataTab}\u0000${collectionSlug}\u0000record:${recordId}`
        : recordId === null
          ? `source:${sourceId}\u0000label:${label}`
          : `source:${sourceId}\u0000record:${recordId}`;
    const existingIndex = referenceIndexes.get(key);
    if (existingIndex !== undefined) {
      // Keep the first explicit producer label stable, but do not let an
      // earlier id-only fallback hide a useful label carried by a duplicate.
      if (
        explicitLabel.length > 0
        && !referencesWithExplicitLabels.has(key)
      ) {
        references[existingIndex] = {
          ...references[existingIndex]!,
          label: explicitLabel,
        };
        referencesWithExplicitLabels.add(key);
      }
      continue;
    }
    referenceIndexes.set(key, references.length);
    if (explicitLabel.length > 0) {
      referencesWithExplicitLabels.add(key);
    }
    references.push({
      label,
      sourceId,
      sourceLabel,
      collectionSlug,
      dataTab,
      recordId,
    });
  }
  return references;
};

const provenanceSourceLabel = (
  sourceId: string,
  dataTab: SourceRecordDataTab | null,
  collectionSlug: string | null,
): string => {
  if (dataTab !== null && collectionSlug !== null) {
    const lane =
      dataTab === 'mail'
        ? 'Mail'
        : dataTab === 'calendar'
          ? 'Calendar'
          : 'Files';
    return `${lane} · ${collectionSlug}`;
  }
  if (sourceId.length === 0) return 'Source not recorded';
  if (sourceId === 'local') return 'Local data';
  if (sourceId === 'hubspot') return 'HubSpot';
  if (sourceId === 'salesforce') return 'Salesforce';
  return sourceId;
};
