import { describe, expect, it } from 'vitest';

import {
  connectedSourceConnectionHref,
  connectedSourceProviderLabel,
  connectedSourceStarterPrompt,
  parseConnectedSourceChatSetup,
  parseChatConnectedSource,
  projectChatConnectedSourceStatus,
  serializeChatConnectedSource,
  serializeConnectedSourceChatSetup,
  type ChatConnectedSource,
} from '../chat/connected-source-handoff.js';
import { parseShellRoute } from '../shell/route.js';

const source: ChatConnectedSource = {
  lane: 'mail',
  providerId: 'gmail',
  slug: 'work_primary',
};

describe('connected-source Chat handoff', () => {
  it('round-trips an encoded source without treating readiness as route truth', () => {
    const hash = serializeChatConnectedSource(source);
    expect(hash).toBe('#chat/source/mail/gmail/work_primary');
    expect(parseChatConnectedSource(parseShellRoute(hash))).toEqual(source);
    expect(connectedSourceConnectionHref(source)).toBe(
      '#connections/mail/work_primary',
    );
    const setupHash = serializeConnectedSourceChatSetup(source);
    expect(setupHash).toBe(
      '#settings/ai-models/setup/source/mail/gmail/work_primary',
    );
    expect(parseConnectedSourceChatSetup(parseShellRoute(setupHash))).toEqual(source);
  });

  it('rejects incomplete, unknown, and invalid source routes', () => {
    expect(parseChatConnectedSource(parseShellRoute('#chat/source/mail/gmail'))).toBeNull();
    expect(parseChatConnectedSource(parseShellRoute('#chat/source/crm/hubspot/work'))).toBeNull();
    expect(parseChatConnectedSource(parseShellRoute('#chat/source/mail/gcal/work'))).toBeNull();
    expect(parseChatConnectedSource(parseShellRoute('#chat/source/mail/gmail/Work'))).toBeNull();
    expect(parseChatConnectedSource(parseShellRoute('#chat/source/mail/gmail/work/extra'))).toBeNull();
  });

  it('projects missing, pending, ready, and attention from the live row', () => {
    expect(projectChatConnectedSourceStatus(source, [])).toEqual({
      state: 'missing',
      identity: source.slug,
    });
    expect(projectChatConnectedSourceStatus(source, [{
      slug: source.slug,
      adapter_type: 'gmail',
      auth_state: 'healthy',
      last_synced_at: null,
      account_email: 'person@example.com',
    }])).toMatchObject({ state: 'pending', identity: 'person@example.com' });
    expect(projectChatConnectedSourceStatus(source, [{
      slug: source.slug,
      adapter_type: 'gmail',
      auth_state: 'healthy',
      last_synced_at: 1_700_000_000_000,
    }])).toMatchObject({ state: 'ready', lastSyncedAt: 1_700_000_000_000 });
    expect(projectChatConnectedSourceStatus(source, [{
      slug: source.slug,
      adapter_type: 'gmail',
      auth_state: 'unauthorized',
      last_synced_at: null,
    }])).toMatchObject({ state: 'attention', authState: 'unauthorized' });
    expect(projectChatConnectedSourceStatus(source, [{
      slug: source.slug,
      adapter_type: 'graph',
      auth_state: 'healthy',
      last_synced_at: 1_700_000_000_000,
    }])).toMatchObject({ state: 'missing' });
  });

  it('uses friendly provider labels and lane-specific prompts', () => {
    expect(connectedSourceProviderLabel(source)).toBe('Gmail');
    expect(connectedSourceStarterPrompt(source)).toBe(
      'Using my work_primary mailbox, summarize what needs my attention and suggest the next three actions.',
    );
    expect(connectedSourceStarterPrompt({
      lane: 'calendar',
      providerId: 'graph',
      slug: 'office',
    })).toContain('office calendar');
  });
});
