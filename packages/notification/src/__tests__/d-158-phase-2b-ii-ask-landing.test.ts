import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  ASK_LANDING_RESPONSE_HEADERS,
  NOTIFICATION_VERIFICATION_PHRASE_MAX,
  createAskStore,
  createEmailChannel,
  createNotificationBlock,
  createNotificationSettings,
  createNotificationSettingsStore,
  parseAskLandingSubmission,
  renderAskLandingHtml,
  type AskOption,
  type Channel,
  type ChannelName,
  type EmailSender,
  type NotificationMessage,
  type NotificationSettings,
  type NotificationSettingsStore,
  type OutboundEmail,
  type PendingAsk,
} from '@recued/notification';

const defaultSettings: NotificationSettings = {
  ui: true,
  bridge: false,
  slack: { notification: false, approval: false, messenger: false },
  telegram: { notification: false, approval: false, messenger: false },
  whatsapp: { notification: false, approval: false, messenger: false },
  discord: { notification: false, approval: false, messenger: false },
  teams: { notification: false, approval: false, messenger: false },
  email: { notification: false, approval: false, messenger: false },
  // D-169 P1 — `DEFAULT_NOTIFICATION_SETTINGS` gains an always-present
  // (empty) bridges map; the store's read-merge path forces this even
  // on stored rows that pre-date the field.
  bridges: {},
};

const askOptions: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
  { id: 'more-info', label: 'Need more info' },
];

const askMessage: NotificationMessage = {
  title: 'Deploy approval',
  text: 'Approve the production deploy?',
};

const createPendingAsk = (overrides: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: 'ask-landing-1',
  message: askMessage,
  options: askOptions,
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: 'checkpoint-1' },
  fanout_channels: ['email'],
  status: 'open',
  created_at: 1234,
  ...overrides,
});

const renderLanding = (
  ask: PendingAsk,
  overrides: {
    verification_phrase?: string;
    form_nonce?: string;
    action?: string;
  } = {},
): string =>
  renderAskLandingHtml({
    ask,
    verification_phrase: overrides.verification_phrase,
    form_nonce: overrides.form_nonce ?? 'nonce-landing-1',
    action: overrides.action ?? '/notification/ask/ask-landing-1',
  });

const createSettingsStore = (): NotificationSettingsStore =>
  createNotificationSettingsStore(
    createInMemoryCollection<NotificationSettings>(),
  );

const createNoopChannel = (name: ChannelName): Channel => ({
  name,
  capability: name === 'bridge' ? 'notify-only'
    : name === 'email' ? 'landing-page' : 'inline',
  owns_llm_egress: name === 'ui',
  deliverNotify: vi.fn<Channel['deliverNotify']>(async () => {}),
  deliverAsk: vi.fn<Channel['deliverAsk']>(async () => {}),
  closeAsk: vi.fn<Channel['closeAsk']>(async () => {}),
});

const emailSender = (): ReturnType<typeof vi.fn<EmailSender>> =>
  vi.fn<EmailSender>(async () => {});

const sentEmail = (
  sendEmail: ReturnType<typeof vi.fn<EmailSender>>,
): OutboundEmail => {
  const call = sendEmail.mock.calls[0];
  if (call === undefined) {
    throw new Error('missing sendEmail call');
  }
  return call[0];
};

const requireHtmlBody = (email: OutboundEmail): string => {
  if (email.body_html === undefined) {
    throw new Error('expected body_html');
  }
  return email.body_html;
};

describe('D-158 P2b-ii ask landing renderer', () => {
  it('D-158 P2b-ii renders an open PendingAsk as a nonce-protected option form', () => {
    const ask = createPendingAsk();
    const html = renderLanding(ask, {
      form_nonce: 'nonce-open-123',
      action: '/notification/ask/ask-open',
    });

    expect(html).toContain('Approve the production deploy?');
    expect(html.match(/<input type="radio" name="option"/g) ?? []).toHaveLength(
      askOptions.length,
    );
    for (const option of askOptions) {
      expect(html).toContain(`name="option" value="${option.id}"`);
      expect(html).toContain(`<span>${option.label}</span>`);
    }
    expect(html).toContain(
      '<input type="hidden" name="form_nonce" value="nonce-open-123">',
    );
    expect(html).toContain(
      '<input type="hidden" name="ask_id" value="ask-landing-1">',
    );
    expect(html).toContain(
      '<form method="POST" action="/notification/ask/ask-open">',
    );
    expect(html).toContain('<button type="submit">Submit response</button>');
    expect(html).not.toContain('Already answered');
  });

  it('D-158 P2b-ii renders answered and handled asks without an answer form', () => {
    const answered = renderLanding(
      createPendingAsk({
        status: 'answered',
        answer: { option: 'reject', answered_at: 2000 },
        answered_via: 'email',
      }),
    );
    const answeredFallback = renderLanding(
      createPendingAsk({
        status: 'answered',
        answer: { option: 'legacy-choice', answered_at: 2001 },
        answered_via: 'slack',
      }),
    );
    const handled = renderLanding(
      createPendingAsk({
        status: 'handled',
        answer: { option: 'more-info', answered_at: 2002 },
        answered_via: 'ui',
      }),
    );

    for (const html of [answered, answeredFallback, handled]) {
      expect(html).toContain('Already answered');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('type="radio"');
      expect(html).not.toContain('name="option"');
    }
    expect(answered).toContain('Response recorded: Reject');
    expect(answeredFallback).toContain('Response recorded: legacy-choice');
    expect(handled).toContain('Response recorded: Need more info');
  });

  it('D-158 P2b-ii renders the verification phrase only when it is set', () => {
    const phrase = 'pair phrase 4271';
    const open = renderLanding(createPendingAsk(), {
      verification_phrase: phrase,
    });
    const answered = renderLanding(
      createPendingAsk({
        status: 'answered',
        answer: { option: 'approve', answered_at: 3000 },
        answered_via: 'email',
      }),
      { verification_phrase: phrase },
    );
    const absent = renderLanding(createPendingAsk(), {
      verification_phrase: undefined,
    });

    expect(open).toContain('Your verification phrase');
    expect(open).toContain(`<span class="phrase-value">${phrase}</span>`);
    expect(answered).toContain('Your verification phrase');
    expect(answered).toContain(`<span class="phrase-value">${phrase}</span>`);
    expect(absent).not.toContain('class="phrase"');
    expect(absent).not.toMatch(/verification phrase/i);
  });

  it('D-158 P2b-ii renders only safe open-page link_url anchors and never renders links after answering', () => {
    const httpsUrl = 'https://recued.test/runs/1';
    const httpUrl = 'http://recued.test/runs/2';

    for (const link_url of [httpsUrl, httpUrl]) {
      const html = renderLanding(
        createPendingAsk({ message: { ...askMessage, link_url } }),
      );
      expect(html).toContain(
        `<p class="link"><a href="${link_url}">${link_url}</a></p>`,
      );
    }

    for (const link_url of ['javascript:alert(1)', 'data:text/html,x']) {
      const html = renderLanding(
        createPendingAsk({ message: { ...askMessage, link_url } }),
      );
      expect(html).not.toContain('<a href');
      expect(html).not.toContain(link_url);
    }

    const answered = renderLanding(
      createPendingAsk({
        message: { ...askMessage, link_url: httpsUrl },
        status: 'answered',
        answer: { option: 'approve', answered_at: 4000 },
        answered_via: 'email',
      }),
    );
    expect(answered).not.toContain('<a href');
    expect(answered).not.toContain(httpsUrl);
  });

  it('D-158 P2b-ii escapes hostile HTML in text, labels, phrase, nonce, action, and href attributes', () => {
    const attack = `<script>alert("x")</script> "double" 'single' &`;
    const escapedAttack =
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; ' +
      '&quot;double&quot; &#39;single&#39; &amp;';
    const linkUrl =
      'https://recued.test/run?next=<script>&quote="quoted"&ok=1';
    const escapedLinkUrl =
      'https://recued.test/run?next=&lt;script&gt;&amp;quote=' +
      '&quot;quoted&quot;&amp;ok=1';
    const html = renderLanding(
      createPendingAsk({
        message: {
          ...askMessage,
          text: `Message ${attack}`,
          link_url: linkUrl,
        },
        options: [{ id: 'approve', label: `Label ${attack}` }],
      }),
      {
        verification_phrase: `Phrase ${attack}`,
        form_nonce: `nonce ${attack}`,
        action: `/submit/${attack}`,
      },
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain(`Message ${escapedAttack}`);
    expect(html).toContain(`<span>Label ${escapedAttack}</span>`);
    expect(html).toContain(`Phrase ${escapedAttack}`);
    expect(html).toContain(`value="nonce ${escapedAttack}"`);
    expect(html).toContain(`action="/submit/${escapedAttack}"`);
    expect(html).toContain(
      `<a href="${escapedLinkUrl}">${escapedLinkUrl}</a>`,
    );
    expect(html).not.toContain(`href="${linkUrl}"`);
  });

  it('D-158 P2b-ii keeps frame-ancestors out of the meta CSP', () => {
    const html = renderLanding(createPendingAsk());
    const csp = html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
    );

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(csp).not.toBeNull();
    if (csp === null) throw new Error('missing CSP meta tag');
    expect(csp[1]).toContain("default-src 'none'");
    expect(csp[1]).toContain("form-action 'self'");
    expect(csp[1]).not.toContain('frame-ancestors');
  });
});

describe('D-158 P2b-ii ask landing headers and parser', () => {
  it('D-158 P2b-ii exports the frame, referrer, MIME, and cache response headers', () => {
    expect(ASK_LANDING_RESPONSE_HEADERS).toMatchObject({
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
  });

  it('D-158 P2b-ii parses only the closed urlencoded submission shape and trims values', () => {
    expect(
      parseAskLandingSubmission(
        'form_nonce=nonce-1&ask_id=ask-form-1&option=approve',
      ),
    ).toEqual({
      reply: { ask_id: 'ask-form-1', option: 'approve', via: 'email' },
      form_nonce: 'nonce-1',
    });
    expect(
      parseAskLandingSubmission(
        'form_nonce=%20nonce-2%20&ask_id=%20ask-form-2%20&option=%20reject%20',
      ),
    ).toEqual({
      reply: { ask_id: 'ask-form-2', option: 'reject', via: 'email' },
      form_nonce: 'nonce-2',
    });
    expect(
      parseAskLandingSubmission(
        'form_nonce=nonce-1&ask_id=ask-form-1&option=approve&extra=evil',
      ),
    ).toEqual({ error: 'unknown_field' });

    const malformedBodies = [
      'ask_id=ask-form-1&option=approve',
      'form_nonce=nonce-1&option=approve',
      'form_nonce=nonce-1&ask_id=ask-form-1',
      'form_nonce=&ask_id=ask-form-1&option=approve',
      'form_nonce=nonce-1&ask_id=&option=approve',
      'form_nonce=nonce-1&ask_id=ask-form-1&option=',
      'form_nonce=%20%20&ask_id=ask-form-1&option=approve',
      'form_nonce=nonce-1&ask_id=%20%20&option=approve',
      'form_nonce=nonce-1&ask_id=ask-form-1&option=%20%20',
    ];
    for (const body of malformedBodies) {
      expect(parseAskLandingSubmission(body)).toEqual({ error: 'malformed' });
    }
  });
});

describe('D-158 P2b-ii verification phrase settings', () => {
  it('D-158 P2b-ii persists, trims, and clears verification_phrase at the store layer', async () => {
    const store = createSettingsStore();

    await expect(store.setVerificationPhrase('trusted phrase')).resolves.toEqual(
      {
        ...defaultSettings,
        verification_phrase: 'trusted phrase',
      },
    );
    await expect(store.get()).resolves.toEqual({
      ...defaultSettings,
      verification_phrase: 'trusted phrase',
    });

    await expect(store.setVerificationPhrase('  trimmed phrase  ')).resolves.toEqual(
      {
        ...defaultSettings,
        verification_phrase: 'trimmed phrase',
      },
    );

    for (const clearValue of [null, '', '   '] as const) {
      await store.setVerificationPhrase('clear me');
      const cleared = await store.setVerificationPhrase(clearValue);
      expect(cleared).toEqual(defaultSettings);
      expect('verification_phrase' in cleared).toBe(false);
      const afterClear = await store.get();
      expect(afterClear).toEqual(defaultSettings);
      expect('verification_phrase' in afterClear).toBe(false);
    }
  });

  it('D-158 P2b-ii caps verification_phrase at the settings surface and refuses overlong writes', async () => {
    const store = createSettingsStore();
    const setVerificationPhrase = vi.spyOn(store, 'setVerificationPhrase');
    const surface = createNotificationSettings({ store });

    await expect(
      surface.setVerificationPhrase('  surface phrase  '),
    ).resolves.toEqual({
      ok: true,
      settings: {
        ...defaultSettings,
        verification_phrase: 'surface phrase',
      },
    });
    await expect(surface.get()).resolves.toEqual({
      ...defaultSettings,
      verification_phrase: 'surface phrase',
    });

    for (const clearValue of [null, '', '   '] as const) {
      await surface.setVerificationPhrase('surface clear me');
      const cleared = await surface.setVerificationPhrase(clearValue);
      expect(cleared).toEqual({ ok: true, settings: defaultSettings });
      if (!cleared.ok) throw new Error('expected clear to succeed');
      expect('verification_phrase' in cleared.settings).toBe(false);
      const afterClear = await surface.get();
      expect(afterClear).toEqual(defaultSettings);
      expect('verification_phrase' in afterClear).toBe(false);
    }

    await surface.setVerificationPhrase('keep me');
    setVerificationPhrase.mockClear();
    const tooLong = 'x'.repeat(NOTIFICATION_VERIFICATION_PHRASE_MAX + 1);
    await expect(surface.setVerificationPhrase(tooLong)).resolves.toEqual({
      ok: false,
      reason: 'too_long',
      max: NOTIFICATION_VERIFICATION_PHRASE_MAX,
    });
    expect(setVerificationPhrase).not.toHaveBeenCalled();
    await expect(surface.get()).resolves.toEqual({
      ...defaultSettings,
      verification_phrase: 'keep me',
    });

    const exactlyAtCap = 'x'.repeat(NOTIFICATION_VERIFICATION_PHRASE_MAX);
    await expect(surface.setVerificationPhrase(exactlyAtCap)).resolves.toEqual({
      ok: true,
      settings: {
        ...defaultSettings,
        verification_phrase: exactlyAtCap,
      },
    });
  });

  it('D-158 P2b-ii delegates block verification phrase writes through the settings surface', async () => {
    const settingsStore = createSettingsStore();
    const setVerificationPhrase = vi.spyOn(
      settingsStore,
      'setVerificationPhrase',
    );
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createNoopChannel('ui')],
      settingsStore,
    });

    await expect(
      block.setNotificationVerificationPhrase('  block phrase  '),
    ).resolves.toEqual({
      ok: true,
      settings: {
        ...defaultSettings,
        verification_phrase: 'block phrase',
      },
    });
    expect(setVerificationPhrase).toHaveBeenLastCalledWith('  block phrase  ');
    await expect(block.getNotificationSettings()).resolves.toEqual({
      ...defaultSettings,
      verification_phrase: 'block phrase',
    });

    await expect(block.setNotificationVerificationPhrase(null)).resolves.toEqual({
      ok: true,
      settings: defaultSettings,
    });
    expect(setVerificationPhrase).toHaveBeenLastCalledWith(null);
    const cleared = await block.getNotificationSettings();
    expect(cleared).toEqual(defaultSettings);
    expect('verification_phrase' in cleared).toBe(false);

    setVerificationPhrase.mockClear();
    const tooLong = 'z'.repeat(NOTIFICATION_VERIFICATION_PHRASE_MAX + 1);
    await expect(
      block.setNotificationVerificationPhrase(tooLong),
    ).resolves.toEqual({
      ok: false,
      reason: 'too_long',
      max: NOTIFICATION_VERIFICATION_PHRASE_MAX,
    });
    expect(setVerificationPhrase).not.toHaveBeenCalled();
  });
});

describe('D-158 P2b-ii email one-link affordance', () => {
  it('D-158 P2b-ii deliverAsk adds an HTML answer link while preserving reply-by-text', async () => {
    const sendEmail = emailSender();
    const answerLink = vi.fn<(ask_id: string) => string>(
      (ask_id) => `https://recued.test/asks/${ask_id}`,
    );
    const channel = createEmailChannel({ sendEmail, answerLink });

    await channel.deliverAsk('ask-email-link', askMessage, askOptions);

    expect(answerLink).toHaveBeenCalledWith('ask-email-link');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const email = sentEmail(sendEmail);
    const html = requireHtmlBody(email);
    expect(email.subject).toBe('Deploy approval [#ask-email-link]');
    expect(email.body_text).toContain(
      'Or answer in one click: https://recued.test/asks/ask-email-link',
    );
    expect(email.body_text).toContain(
      'To answer, reply to this email with just one of these options:',
    );
    for (const option of askOptions) {
      expect(email.body_text).toContain(`- ${option.label}`);
      expect(html).toContain(`<li>${option.label}</li>`);
    }
    expect(html).toContain(
      '<a href="https://recued.test/asks/ask-email-link"',
    );
  });

  it('D-158 P2b-ii deliverAsk without answerLink stays on the P2b-i text-only shape', async () => {
    const sendEmail = emailSender();
    const channel = createEmailChannel({ sendEmail });

    await channel.deliverAsk('ask-email-text-only', askMessage, [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const email = sentEmail(sendEmail);
    expect(email).toEqual({
      subject: 'Deploy approval [#ask-email-text-only]',
      body_text:
        'Approve the production deploy?\n\n' +
        'To answer, reply to this email with just one of these options:\n' +
        '- Approve\n' +
        '- Reject\n\n' +
        'Reply with only the option text and nothing else \u2014 Recued ' +
        'reads your reply and records your answer.',
    });
    expect('body_html' in email).toBe(false);
    expect(email.body_text).not.toMatch(/one click/i);
  });

  it('D-158 P2b-ii deliverAsk escapes context links, answer URLs, and option labels in body_html', async () => {
    const sendEmail = emailSender();
    const answerUrl =
      'https://recued.test/asks/ask-html?token="abc"&next=<later>';
    const escapedAnswerUrl =
      'https://recued.test/asks/ask-html?token=&quot;abc&quot;' +
      '&amp;next=&lt;later&gt;';
    const contextUrl = 'https://recued.test/runs/1?source=email&next=review';
    const escapedContextUrl =
      'https://recued.test/runs/1?source=email&amp;next=review';
    const answerLink = vi.fn<(ask_id: string) => string>(() => answerUrl);
    const channel = createEmailChannel({ sendEmail, answerLink });

    await channel.deliverAsk(
      'ask-html',
      {
        ...askMessage,
        link_url: contextUrl,
      },
      [
        {
          id: 'approve',
          label: `Approve <script>"now" & 'yes'`,
        },
      ],
    );

    const html = requireHtmlBody(sentEmail(sendEmail));
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      `<p>More information: <a href="${escapedContextUrl}">` +
        `${escapedContextUrl}</a></p>`,
    );
    expect(html).toContain(`<a href="${escapedAnswerUrl}"`);
    expect(html).not.toContain(`href="${answerUrl}"`);
    expect(html).toContain(
      '<li>Approve &lt;script&gt;&quot;now&quot; &amp; &#39;yes&#39;</li>',
    );
  });
});
