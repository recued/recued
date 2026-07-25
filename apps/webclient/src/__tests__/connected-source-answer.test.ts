import { describe, expect, it } from 'vitest';

import {
  connectedSourceAnswerFollowups,
  connectedSourceAnswerTitle,
  connectedSourceFollowupContextDetail,
  connectedSourceRecordReferences,
  connectedSourceSearchRetryPrompt,
  connectedSourceSearchTool,
  projectConnectedSourceAnswer,
} from '../chat/connected-source-answer.js';
import type { ChatConnectedSource } from '../chat/connected-source-handoff.js';

const mail: ChatConnectedSource = {
  lane: 'mail',
  providerId: 'gmail',
  slug: 'work',
};

describe('connected-source first answer projection', () => {
  it('separates source context from a recorded search receipt', () => {
    expect(connectedSourceAnswerTitle(mail, 'person@example.com')).toBe(
      'Gmail · person@example.com',
    );
    expect(connectedSourceSearchTool(mail)).toBe('mail.search');
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: false,
      failed: false,
    })).toMatchObject({
      state: 'preparing',
      badge: 'Checking activity',
      tone: 'neutral',
    });
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: true,
      failed: false,
    })).toMatchObject({
      state: 'unverified',
      badge: 'Search not verified',
      tone: 'warning',
    });
  });

  it('progresses from a running search through a completed search receipt', () => {
    expect(projectConnectedSourceAnswer(mail, [{
      tool_name: 'mail.search',
      status: 'started',
    }], {
      complete: false,
      failed: false,
    })).toMatchObject({
      state: 'searching',
      pendingText: 'Searching connected mail…',
    });
    expect(projectConnectedSourceAnswer(mail, [{
      tool_name: 'mail.search',
      status: 'ok',
    }], {
      complete: false,
      failed: false,
    })).toMatchObject({
      state: 'reviewing',
      badge: 'Search complete',
    });
    expect(projectConnectedSourceAnswer(mail, [{
      tool_name: 'mail.search',
      status: 'ok',
    }], {
      complete: true,
      failed: false,
    })).toMatchObject({
      state: 'search_complete',
      badge: 'Mail search completed',
      tone: 'positive',
    });
    expect(projectConnectedSourceAnswer(mail, [{
      tool_name: 'mail.search',
      status: 'ok',
    }], {
      complete: true,
      failed: false,
    }).detail).toContain(
      'does not show which records, if any, informed the answer',
    );
  });

  it('keeps tool errors and failed turns explicit', () => {
    expect(projectConnectedSourceAnswer(mail, [{
      tool_name: 'mail.search',
      status: 'error',
    }], {
      complete: true,
      failed: false,
    })).toMatchObject({
      state: 'search_failed',
      badge: 'Search incomplete',
      tone: 'warning',
    });
    expect(projectConnectedSourceAnswer(mail, [
      { tool_name: 'mail.search', status: 'ok' },
      { tool_name: 'mail.search', status: 'error' },
    ], {
      complete: true,
      failed: false,
    })).toMatchObject({
      state: 'search_failed',
      detail: expect.stringContaining('another did not'),
      tone: 'warning',
    });
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: false,
      failed: true,
    })).toMatchObject({
      state: 'failed',
      badge: 'Needs retry',
      tone: 'danger',
    });
  });

  it('distinguishes continuing from a prior answer from requesting a refresh', () => {
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: false,
      failed: false,
      context: 'context',
    })).toMatchObject({
      state: 'continuing',
      badge: 'Conversation context',
      pendingText: 'Continuing from the previous answer…',
      tone: 'neutral',
    });
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: true,
      failed: false,
      context: 'context',
    })).toMatchObject({
      state: 'context_only',
      badge: 'No new search',
      detail: expect.stringContaining('No new mail search was recorded'),
      tone: 'neutral',
    });
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: false,
      failed: false,
      context: 'refresh',
    })).toMatchObject({
      state: 'preparing',
      badge: 'Search requested',
      pendingText: 'Preparing to search connected mail…',
    });
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: true,
      failed: false,
      context: 'refresh',
    })).toMatchObject({
      state: 'unverified',
      detail: expect.stringContaining(
        'requested a new mail search, but none was recorded',
      ),
      tone: 'warning',
    });
  });

  it('keeps edited follow-up receipts honest about source use', () => {
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: false,
      failed: false,
      context: 'context',
      edited: true,
    })).toMatchObject({
      state: 'continuing',
      badge: 'Edited request',
      detail: expect.stringContaining(
        'Any new mail search will appear here',
      ),
      pendingText: 'Following your edited request…',
      tone: 'neutral',
    });
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: true,
      failed: false,
      context: 'context',
      edited: true,
    })).toMatchObject({
      state: 'context_only',
      badge: 'No new search',
      detail: expect.stringContaining(
        'Source use followed your edited request',
      ),
      tone: 'neutral',
    });
    expect(projectConnectedSourceAnswer(mail, [], {
      complete: true,
      failed: false,
      context: 'refresh',
      edited: true,
    })).toMatchObject({
      state: 'unverified',
      badge: 'Search not verified',
      detail: expect.stringContaining(
        'started from a suggestion that requested a new mail search',
      ),
      tone: 'warning',
    });
    expect(projectConnectedSourceAnswer(mail, [{
      tool_name: 'mail.search',
      status: 'ok',
    }], {
      complete: true,
      failed: false,
      context: 'context',
      edited: true,
    })).toMatchObject({
      state: 'search_complete',
      badge: 'Mail search completed',
      tone: 'positive',
    });
  });

  it('does not pretend a foundational file connection has a search receipt', () => {
    const file: ChatConnectedSource = {
      lane: 'file',
      providerId: 's3',
      slug: 'archive',
    };
    expect(connectedSourceSearchTool(file)).toBeNull();
    expect(projectConnectedSourceAnswer(file, [{
      tool_name: 'work.search',
      status: 'ok',
    }], {
      complete: true,
      failed: false,
    })).toMatchObject({
      state: 'answer_ready',
      badge: 'Answer ready',
    });
    expect(projectConnectedSourceAnswer(file, [], {
      complete: true,
      failed: false,
      context: 'context',
    })).toMatchObject({
      state: 'context_only',
      badge: 'No new source check',
      detail: expect.stringContaining(
        'does not currently record a source-specific search',
      ),
    });
    expect(connectedSourceAnswerFollowups(file).every(
      (followup) => followup.mode === 'context',
    )).toBe(true);
    expect(projectConnectedSourceAnswer(file, [], {
      complete: false,
      failed: false,
      context: 'context',
      edited: true,
    })).toMatchObject({
      state: 'continuing',
      badge: 'Edited request',
      pendingText: 'Following your edited request…',
    });
  });

  it('offers unsent source-aware follow-ups', () => {
    expect(connectedSourceAnswerFollowups(mail).map(
      ({ label, mode, outcome }) => ({ label, mode, outcome }),
    )).toEqual([
      {
        label: 'Draft the replies',
        mode: 'refresh',
        outcome: 'Reply drafts',
      },
      {
        label: 'Make an action list',
        mode: 'context',
        outcome: 'Prioritized action list',
      },
    ]);
    expect(connectedSourceAnswerFollowups(mail)[0]!.prompt).toContain(
      'Search my connected mail again',
    );
    expect(connectedSourceAnswerFollowups(mail)[0]!.boundary).toBe(
      'Chat will show drafts here first. '
      + 'If you ask it to send email, you’ll review and approve '
      + 'that separately.',
    );
    expect(connectedSourceAnswerFollowups(mail)[1]!.boundary).toContain(
      'If you ask it to create tasks, you’ll review and approve '
      + 'that separately.',
    );
    const calendar: ChatConnectedSource = {
      lane: 'calendar',
      providerId: 'graph',
      slug: 'office',
    };
    expect(connectedSourceAnswerFollowups(calendar).map(
      ({ outcome }) => outcome,
    )).toEqual(['Meeting prep', 'Conflict review']);
    expect(connectedSourceAnswerFollowups(calendar).every(
      ({ boundary }) => boundary.includes('change your calendar'),
    )).toBe(true);
    const file: ChatConnectedSource = {
      lane: 'file',
      providerId: 's3',
      slug: 'archive',
    };
    expect(connectedSourceAnswerFollowups(file).map(
      ({ outcome }) => outcome,
    )).toEqual(['Action plan', 'Supporting details']);
    expect(connectedSourceAnswerFollowups(file).every(
      ({ boundary }) => boundary.includes('review and approve'),
    )).toBe(true);
    expect(connectedSourceFollowupContextDetail(mail, 'refresh')).toBe(
      'Requests a new mail search',
    );
    expect(connectedSourceFollowupContextDetail(mail, 'context')).toBe(
      'Continues from the previous answer · no new search requested',
    );
    expect(connectedSourceSearchRetryPrompt(mail, 'What needs me?')).toBe(
      'Search my connected mail before answering this question: What needs me?',
    );
  });

  it('keeps same-title records distinct while removing exact duplicate references', () => {
    expect(connectedSourceRecordReferences({
      provenance: [
        {
          source: 'local',
          collection_platform: 'mail',
          collection_slug: 'work',
          record_id: 'mail-1',
        },
        {
          source: 'local',
          collection_platform: 'mail',
          collection_slug: 'work',
          record_id: 'mail-1',
          label: 'Quarterly planning',
        },
        {
          source: 'local',
          collection_platform: 'mail',
          collection_slug: 'work',
          record_id: 'mail-1',
          label: 'Renamed duplicate',
        },
        {
          source: 'local',
          collection_platform: 'mail',
          collection_slug: 'personal',
          record_id: 'mail-1',
          label: 'Personal copy',
        },
        {
          source: 'local',
          collection_platform: 'mail',
          collection_slug: 'work',
          record_id: 'mail-2',
          label: 'Quarterly planning',
        },
        { source: 'salesforce' },
        { source: '' },
        { source: '', record_id: 'orphan-1' },
      ],
    })).toEqual([
      {
        label: 'Quarterly planning',
        sourceId: 'local',
        sourceLabel: 'Mail · work',
        collectionSlug: 'work',
        dataTab: 'mail',
        recordId: 'mail-1',
      },
      {
        label: 'Personal copy',
        sourceId: 'local',
        sourceLabel: 'Mail · personal',
        collectionSlug: 'personal',
        dataTab: 'mail',
        recordId: 'mail-1',
      },
      {
        label: 'Quarterly planning',
        sourceId: 'local',
        sourceLabel: 'Mail · work',
        collectionSlug: 'work',
        dataTab: 'mail',
        recordId: 'mail-2',
      },
      {
        label: 'Salesforce',
        sourceId: 'salesforce',
        sourceLabel: 'Salesforce',
        collectionSlug: null,
        dataTab: null,
        recordId: null,
      },
      {
        label: 'orphan-1',
        sourceId: '',
        sourceLabel: 'Source not recorded',
        collectionSlug: null,
        dataTab: null,
        recordId: 'orphan-1',
      },
    ]);
  });

  it('preserves opaque record ids exactly for collection.get deep links', () => {
    expect(connectedSourceRecordReferences({
      provenance: [{
        source: 'local',
        collection_platform: 'mail',
        collection_slug: 'work',
        record_id: ' provider id with spaces ',
      }],
    })[0]).toMatchObject({
      collectionSlug: 'work',
      dataTab: 'mail',
      recordId: ' provider id with spaces ',
    });
  });
});
