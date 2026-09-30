import { describe, expect, it, vi } from 'vitest';

import { buildUpdatesSurfaceLink, resolvePublicBaseUrl } from '../ask-landing-answer-link.js';
import {
  createUpdateOwnerAlertSink,
  describeUpdateOwnerAlert,
  notifyUpdateOwnerAlert,
  type UpdateOwnerAlert,
} from '../update/owner-alert.js';

const autoRevert: UpdateOwnerAlert = {
  kind: 'auto-revert-starting',
  release_identity: 'stable:26.9.4',
  from_version: '26.9.3',
  to_version: '26.9.4',
  reason: 'boot health failed 3 times',
};

const updateApplied: UpdateOwnerAlert = {
  kind: 'update-applied',
  release_identity: 'stable:26.9.4',
  from_version: '26.9.3',
  to_version: '26.9.4',
  channel: 'stable',
  trigger: 'auto',
};

describe('owner-facing update alert', () => {
  it('describes a committed automatic update with its exact version delta', () => {
    expect(describeUpdateOwnerAlert(
      updateApplied,
      'https://home.example.net/#settings/updates',
    )).toEqual({
      title: 'Server update completed',
      text:
        'Recued updated the server from 26.9.3 to 26.9.4 on the stable channel. '
        + 'It was applied automatically. Review Settings → Updates.',
      link_url: 'https://home.example.net/#settings/updates',
    });
  });

  it('preserves manual trigger provenance in the owner copy', () => {
    expect(describeUpdateOwnerAlert({
      kind: 'update-applied',
      release_identity: 'edge:26.9.4',
      from_version: '26.9.3',
      to_version: '26.9.4',
      channel: 'edge',
      trigger: 'manual',
    }).text).toContain('It was started by an owner.');
  });

  it('describes an automatic rollback prospectively, without claiming it completed', () => {
    const message = describeUpdateOwnerAlert(
      autoRevert,
      'https://home.example.net/#settings/updates',
    );

    expect(message).toEqual({
      title: 'Update failed; rollback starting',
      text:
        'Recued 26.9.4 failed its boot health check (boot health failed 3 times). '
        + 'Recued is beginning a controlled recovery restart and will try to return to 26.9.3. '
        + 'Review Settings → Updates after Recued restarts.',
      link_url: 'https://home.example.net/#settings/updates',
    });
    expect(message.text).not.toMatch(/rolled back|rollback (?:succeeded|completed)/i);
  });

  it('names a retained webclient recovery condition and its retry behavior', () => {
    expect(describeUpdateOwnerAlert({
      kind: 'webclient-recovery-failed',
      release_identity: 'stable:26.9.4',
      reason: 'the prior bundle could not be restored',
    })).toEqual({
      title: 'Update recovery needs attention',
      text:
        'Recued could not restore the previous web app for stable:26.9.4: '
        + 'the prior bundle could not be restored. The update remains in progress '
        + 'so recovery can try again on the next boot. Review Settings → Updates.',
    });
  });

  it('tells the owner an ambiguous manual rollback kept its recovery record', () => {
    expect(describeUpdateOwnerAlert({
      kind: 'manual-rollback-recovery-failed',
      release_identity: 'stable:26.9.4',
      reason: 'the installed generation could not be identified',
    })).toEqual({
      title: 'Rollback recovery needs attention',
      text:
        'Recued could not prove whether the interrupted rollback for stable:26.9.4 finished: '
        + 'the installed generation could not be identified. Its recovery record was kept. '
        + 'Review Settings → Updates before starting another update or rollback.',
    });
  });

  it('claims a supervisor rollback completed only from its terminal record', () => {
    expect(describeUpdateOwnerAlert({
      kind: 'supervisor-revert-complete',
      release_identity: 'stable:26.9.4',
      from_version: '26.9.3',
      to_version: '26.9.4',
      reason: 'boot health failed 3 times (payload exited 126, never started)',
    })).toEqual({
      title: 'Update failed; previous server version restored',
      text:
        'Recued 26.9.4 could not launch: boot health failed 3 times (payload exited 126, never started). '
        + 'The supervisor restored server version 26.9.3. Review Settings → Updates.',
    });
  });

  it('uses notificationBlock.notify and never needs an ask surface', () => {
    const notify = vi.fn(async () => undefined);
    const ask = vi.fn();
    const block = { notify, ask };
    const sink = createUpdateOwnerAlertSink(
      block,
      () => 'https://home.example.net/#settings/updates',
    );

    sink(updateApplied);

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Server update completed',
      link_url: 'https://home.example.net/#settings/updates',
    }));
    expect(ask).not.toHaveBeenCalled();
  });

  it('reads the link when the alert fires, so an address that appears later is used', () => {
    const notify = vi.fn(async (_message: { link_url?: string }) => undefined);
    let link: string | undefined;
    const sink = createUpdateOwnerAlertSink({ notify }, () => link);

    sink(updateApplied);
    link = 'https://alice.recued.net/#settings/updates';
    sink(updateApplied);

    expect(notify.mock.calls.map(([message]) => message.link_url))
      .toEqual([undefined, 'https://alice.recued.net/#settings/updates']);
  });

  it('contains notification failure and reports it without throwing into recovery', async () => {
    await expect(notifyUpdateOwnerAlert(
      autoRevert,
      async () => { throw new Error('all owner channels are unavailable'); },
    )).resolves.toBe(false);
  });
});

describe('the Update Owner Alert deep link', () => {
  it('builds the real Settings -> Updates route as an absolute URL', () => {
    expect(buildUpdatesSurfaceLink(resolvePublicBaseUrl('https://home.example.net/')))
      .toBe('https://home.example.net/#settings/updates');
  });

  it('omits the link when this server has no public base URL', () => {
    expect(buildUpdatesSurfaceLink(resolvePublicBaseUrl('http://localhost:4711'))).toBeNull();
  });
});
