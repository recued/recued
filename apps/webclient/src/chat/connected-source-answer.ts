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
                'Your changed follow-up is done. Chat does not '
                + 'keep a note of whether it searched this particular file source.',
              pendingText: 'Doing what you changed it to…',
              tone: 'neutral',
              searchTool,
            }
          : {
              state: 'continuing',
              badge: 'You changed this',
              detail:
                'Chat is doing what you changed it to. It keeps no note of '
                + 'what it searched for this file connection.',
              pendingText: 'Doing what you changed it to…',
              tone: 'neutral',
              searchTool,
            };
      }
      return options.complete
        ? {
            state: 'context_only',
            badge: 'Nothing new was searched',
            detail:
              'This follow-up carries on from the last answer. '
              + 'Chat keeps no note of what it searched for '
              + 'this file connection.',
            pendingText: 'Carrying on from the last answer…',
            tone: 'neutral',
            searchTool,
          }
        : {
            state: 'continuing',
            badge: 'Carrying on from before',
            detail:
              'This follow-up carries on from the last answer. '
              + 'Nothing new was searched.',
            pendingText: 'Carrying on from the last answer…',
            tone: 'neutral',
            searchTool,
          };
    }
    return options.complete
      ? {
          state: 'answer_ready',
          badge: 'Answer ready',
          detail:
            'The answer is done. Chat keeps no note of whether '
            + 'it searched this particular file source.',
          pendingText: 'Preparing your answer…',
          tone: 'neutral',
          searchTool,
        }
      : {
          state: 'preparing',
          badge: 'Preparing',
          detail:
            `This question started from your connected ${kind}. `
            + 'Chat is working on the answer.',
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
        badge: 'The search did not finish',
        detail: used
          ? `At least one ${searchLabel} search finished, but another did not. `
            + 'Treat this answer as unfinished. Try again, or check the connection.'
          : `The recorded ${searchLabel} search did not finish. `
            + 'Treat this answer as unfinished. Try again, or check the connection.',
        pendingText: 'Finishing with what Recued already has…',
        tone: 'warning',
        searchTool,
      };
    }
    if (used) {
      return {
        state: 'search_complete',
        badge: `${searchLabel[0]!.toUpperCase()}${searchLabel.slice(1)} search finished`,
        detail:
          `Recued noted a finished ${searchLabel} search. `
          + 'It does not say which records, if any, went into the answer.',
        pendingText: `Reviewing the ${searchLabel} search…`,
        tone: 'positive',
        searchTool,
      };
    }
    if (context === 'context') {
      if (edited) {
        return {
          state: 'context_only',
          badge: 'Nothing new was searched',
          detail:
            `Your changed follow-up finished, with no noted ${searchLabel} search. `
            + 'What Chat read followed your change.',
          pendingText: 'Doing what you changed it to…',
          tone: 'neutral',
          searchTool,
        };
      }
      return {
        state: 'context_only',
        badge: 'Nothing new was searched',
        detail:
          `This follow-up carries on from the last answer. `
          + `No new ${searchLabel} search was noted.`,
        pendingText: 'Carrying on from the last answer…',
        tone: 'neutral',
        searchTool,
      };
    }
    if (context === 'refresh') {
      return {
        state: 'unverified',
        badge: 'Recued could not check the search',
        detail: edited
          ? `Your changed follow-up came from a suggestion that asked for `
            + `a new ${searchLabel} search, but none was noted. `
            + `Read your changes and the answer before you trust ${kind}-specific claims.`
          : `This follow-up asked for a new ${searchLabel} search, `
            + 'but none was noted. '
            + `Read it before you trust ${kind}-specific claims.`,
        pendingText: 'Preparing your answer…',
        tone: 'warning',
        searchTool,
      };
    }
    return {
      state: 'unverified',
      badge: 'Recued could not check the search',
      detail:
        `This answer finished with no noted ${searchLabel} search. `
        + `Read it before you trust ${kind}-specific claims.`,
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
      badge: 'The search did not finish',
      detail: used
        ? `One ${searchLabel} search finished, but another did not. `
          + 'Chat is finishing with what Recued already has.'
        : `The ${searchLabel} search did not finish. `
          + 'Chat is finishing with what Recued already has.',
      pendingText: 'Finishing with what Recued already has…',
      tone: 'warning',
      searchTool,
    };
  }
  if (used) {
    return {
      state: 'reviewing',
      badge: 'Search finished',
      detail: `The ${searchLabel} search finished. Chat is working on the answer.`,
      pendingText: `Reviewing the ${searchLabel} search…`,
      tone: 'positive',
      searchTool,
    };
  }
  if (context === 'context') {
    if (edited) {
      return {
        state: 'continuing',
        badge: 'You changed this',
        detail:
          'Chat is doing what you changed it to. '
          + `Any new ${searchLabel} search shows up here.`,
        pendingText: 'Doing what you changed it to…',
        tone: 'neutral',
        searchTool,
      };
    }
    return {
      state: 'continuing',
      badge: 'Carrying on from before',
      detail:
        `This follow-up carries on from the last answer. `
        + `No new ${searchLabel} search was asked for.`,
      pendingText: 'Carrying on from the last answer…',
      tone: 'neutral',
      searchTool,
    };
  }
  if (context === 'refresh') {
    if (edited) {
      return {
        state: 'preparing',
        badge: 'You changed this',
        detail:
          'Chat is doing what you changed it to. '
          + `The next step you picked asked for a new ${searchLabel} search; `
          + 'whatever it does shows up here.',
        pendingText: 'Doing what you changed it to…',
        tone: 'neutral',
        searchTool,
      };
    }
    return {
      state: 'preparing',
      badge: 'A search was asked for',
      detail:
        `This follow-up asked for a new ${searchLabel} search. `
        + 'Whatever Chat does shows up here.',
      pendingText: `Getting ready to search your connected ${searchLabel}…`,
      tone: 'neutral',
      searchTool,
    };
  }
  return {
    state: 'preparing',
    badge: 'Checking what it did',
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
        label: 'Write the replies',
        prompt:
          'Search my connected mail again for the messages that need my response, '
          + 'then draft concise replies. '
          + 'Do not send anything.',
        mode: 'refresh',
        outcome: 'Reply drafts',
        boundary:
          'Chat shows the drafts here first. '
          + 'If you ask it to send email, you will say yes '
          + 'separately.',
      },
      {
        label: 'Make a to-do list',
        prompt:
          'Using the previous mailbox summary, turn the action items into '
          + 'a prioritized task list.',
        mode: 'context',
        outcome: 'To-do list, most important first',
        boundary:
          'Chat shows the list here first. '
          + 'If you ask it to make tasks, you will say yes '
          + 'separately.',
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
          'Chat shows the notes here first. '
          + 'If you ask it to change your calendar, you will say yes '
          + 'separately.',
      },
      {
        label: 'Check for conflicts',
        prompt:
          'Search my connected calendar again for conflicts this week and '
          + 'suggest how to resolve them.',
        mode: 'refresh',
        outcome: 'Clashes',
        boundary:
          'Chat suggests options here first. '
          + 'If you ask it to change your calendar, you will say yes '
          + 'separately.',
      },
    ];
  }
  return [
    {
      label: 'Make a plan',
      prompt:
        'Using the previous answer, turn the most important information '
        + 'into a short action plan.',
      mode: 'context',
      outcome: 'The plan',
      boundary:
        'Chat shows the plan here first. '
        + 'If you ask it to make tasks, you will say yes '
        + 'separately.',
    },
    {
      label: 'Show me why',
      prompt:
        'Using the previous answer, show the supporting details behind '
        + 'its most important point.',
      mode: 'context',
      outcome: 'Why',
      boundary:
        'Chat shows the reasons here. '
        + 'If you ask it to change files, you will say yes '
        + 'separately.',
    },
  ];
};

export const connectedSourceFollowupContextDetail = (
  source: ChatConnectedSource,
  mode: ConnectedSourceFollowupMode,
): string => {
  if (mode === 'context') {
    return 'Carries on from the last answer · nothing new searched';
  }
  const searchLabel = connectedSourceSearchLabel(source);
  return `Asks for a new ${searchLabel} search`;
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
  if (sourceId.length === 0) return 'Recued did not note where this came from';
  if (sourceId === 'local') return 'Local data';
  if (sourceId === 'hubspot') return 'HubSpot';
  if (sourceId === 'salesforce') return 'Salesforce';
  return sourceId;
};
