import { describe, expect, it } from 'vitest';

import {
  SECURE_ACCESS_RESUME_PARAM,
  SECURE_ACCESS_RESUME_VALUE,
  cleanConsumedPairEntryUrl,
  markSecureAccessResume,
  parsePairEntryHandoff,
} from './secure-access-resume.js';

describe('cleanConsumedPairEntryUrl', () => {
  it('removes every consumed pair input while preserving the exact return page', () => {
    expect(
      cleanConsumedPairEntryUrl(
        `https://alice.recued.cloud/webclient/?chat=session&code=PAIR%201234&journey=secure-access&${SECURE_ACCESS_RESUME_PARAM}=same-origin#chat/session/chat_1`,
      ),
    ).toBe(
      'https://alice.recued.cloud/webclient/?chat=session&journey=secure-access#chat/session/chat_1',
    );
  });

  it('removes duplicate and encoded pair keys without reserializing unrelated state', () => {
    expect(
      cleanConsumedPairEntryUrl(
        `https://alice.example/pair?keep=a%20b&%63ode=first&keep=a+b&${SECURE_ACCESS_RESUME_PARAM}=wrong&code=second&recued%5Fpair%5Fresume=same-origin&blank=#connections`,
      ),
    ).toBe(
      'https://alice.example/pair?keep=a%20b&keep=a+b&blank=#connections',
    );
  });

  it('does not broaden cleanup to similarly named or malformed parameters', () => {
    const source =
      'https://alice.example/pair?code_verifier=keep&mycode=keep&%E0%A4%A=keep#chat';
    expect(cleanConsumedPairEntryUrl(source)).toBe(source);
    expect(cleanConsumedPairEntryUrl('https://alice.example/pair?&&#chat')).toBe(
      'https://alice.example/pair?&&#chat',
    );
  });

  it('drops the query delimiter when the arrival contains only consumed inputs', () => {
    expect(
      cleanConsumedPairEntryUrl(
        `https://alice.example/pair?code=PAIR5678&&${SECURE_ACCESS_RESUME_PARAM}=same-origin&#chat`,
      ),
    ).toBe('https://alice.example/pair#chat');
  });
});

describe('secure-access same-origin resume marker', () => {
  it('appends intent without reserializing the existing query or losing the hash', () => {
    const target = new URL(
      'https://alice.recued.cloud:8443/webclient/?code=PAIR%201234#chat/session/chat_1',
    );

    markSecureAccessResume(target);

    expect(target.toString()).toBe(
      `https://alice.recued.cloud:8443/webclient/?code=PAIR%201234&${SECURE_ACCESS_RESUME_PARAM}=${SECURE_ACCESS_RESUME_VALUE}#chat/session/chat_1`,
    );
    markSecureAccessResume(target);
    expect(target.searchParams.getAll(SECURE_ACCESS_RESUME_PARAM)).toEqual([
      SECURE_ACCESS_RESUME_VALUE,
    ]);
  });

  it('overrides a stale last marker by appending the handoff marker', () => {
    const target = new URL(
      `https://alice.recued.cloud/?${SECURE_ACCESS_RESUME_PARAM}=wrong`,
    );

    markSecureAccessResume(target);

    expect(target.searchParams.getAll(SECURE_ACCESS_RESUME_PARAM)).toEqual([
      'wrong',
      SECURE_ACCESS_RESUME_VALUE,
    ]);
  });
});

describe('parsePairEntryHandoff', () => {
  const marker = `${SECURE_ACCESS_RESUME_PARAM}=${SECURE_ACCESS_RESUME_VALUE}`;

  it('derives the server only from the live HTTPS origin and carries the safe code', () => {
    const parsed = parsePairEntryHandoff(
      `https://alice.recued.cloud:8443/webclient/?url=https%3A%2F%2Fattacker.example%2Fcollect&code=%20PAIR5678%20&${marker}#chat/session/chat_1`,
    );

    expect(parsed).toEqual({
      active: true,
      seed: {
        serverUrl: 'https://alice.recued.cloud:8443',
        sameOriginResume: true,
        pairingCode: 'PAIR5678',
      },
    });
    expect(parsed.seed.serverUrl).not.toContain('attacker.example');
  });

  it('resumes from a secure origin without requiring a pairing code', () => {
    expect(
      parsePairEntryHandoff(`https://recued.example/pair?${marker}`),
    ).toEqual({
      active: true,
      seed: {
        serverUrl: 'https://recued.example',
        sameOriginResume: true,
      },
    });
  });

  it('allows potentially trustworthy loopback HTTP origins', () => {
    for (const origin of [
      'http://localhost:4319',
      'http://recued.localhost:4319',
      'http://127.0.0.1:4319',
      'http://[::1]:4319',
    ]) {
      expect(
        parsePairEntryHandoff(`${origin}/webclient/?${marker}`).seed,
        origin,
      ).toMatchObject({
        serverUrl: origin,
        sameOriginResume: true,
      });
    }
  });

  it('rejects a forged marker on plain HTTP LAN origins but retains a safe code', () => {
    expect(
      parsePairEntryHandoff(
        `http://192.168.1.42:4319/webclient/?url=https://attacker.example&code=PAIR5678&${marker}`,
      ),
    ).toEqual({
      active: true,
      seed: { pairingCode: 'PAIR5678' },
    });
  });

  it('does not mistake deceptive HTTP hostnames for loopback', () => {
    for (const origin of [
      'http://localhost.attacker.example',
      'http://127.0.0.1.attacker.example',
      'http://192.168.1.42:4319',
      'http://[::2]:4319',
    ]) {
      expect(
        parsePairEntryHandoff(`${origin}/webclient/?${marker}`),
        origin,
      ).toEqual({ active: false, seed: {} });
    }
  });

  it('keeps existing code-only links unchanged when no resume marker is present', () => {
    expect(
      parsePairEntryHandoff(
        'https://app.recued.com/pair?url=https://attacker.example&code=PAIR5678',
      ),
    ).toEqual({
      active: true,
      seed: { pairingCode: 'PAIR5678' },
    });
  });

  it('ignores wrong, shadowed, or malformed resume markers', () => {
    expect(
      parsePairEntryHandoff(
        `https://recued.example/?${marker}&${SECURE_ACCESS_RESUME_PARAM}=wrong`,
      ),
    ).toEqual({ active: false, seed: {} });
    expect(
      parsePairEntryHandoff(
        `https://recued.example/?${SECURE_ACCESS_RESUME_PARAM}=wrong`,
      ),
    ).toEqual({ active: false, seed: {} });
    expect(parsePairEntryHandoff('not an absolute URL')).toEqual({
      active: false,
      seed: {},
    });
  });
});
