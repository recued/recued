/** D-262 slice 4 — speaking the reply.
 *
 *  ⛔ THE MARKDOWN TESTS ARE THE POINT. A naive `speak(message.content)` reads
 *  "asterisk asterisk important asterisk asterisk" and then forty lines of
 *  shell script aloud, which is how this feature gets switched off on the day
 *  it ships. Everything here is about what a person can bear to LISTEN to,
 *  which is a different question from what renders well.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  browserVoiceSpeaker,
  pickOnDeviceVoice,
  speechTextFromReply,
  VOICE_SPEECH_MAX_CHARS,
  type SpeechVoiceLike,
  type VoiceSpeechGlobals,
} from '../chat/voice-speech.js';

describe('D-262 slice 4 — what actually gets spoken', () => {
  it('⛔ replaces fenced code with a marker instead of reading it out', () => {
    const out = speechTextFromReply(
      'Run this:\n\n```bash\nrm -rf /tmp/x && echo done\n```\n\nThen check the log.',
    );
    expect(out).toContain('code block');
    // Nobody listens to a shell script. Someone who wants it is reading it.
    expect(out).not.toContain('rm -rf');
    expect(out).toContain('Then check the log.');
  });

  it('keeps inline code, which is usually the answer itself', () => {
    // Dropping it would remove the subject: "set the flag to" — to what?
    expect(speechTextFromReply('Set `--max-old-space-size` to 8192.'))
      .toBe('Set --max-old-space-size to 8192.');
  });

  it('says a link\'s label and never its URL', () => {
    expect(speechTextFromReply('See [the guide](https://example.com/a/b?c=d).'))
      .toBe('See the guide.');
  });

  it('strips emphasis, headings, bullets and quote markers', () => {
    const out = speechTextFromReply(
      '## Summary\n\n- **Bold** point\n- _italic_ point\n\n> quoted line',
    );
    expect(out).not.toMatch(/[*_#>]/);
    expect(out).toContain('Bold point');
    expect(out).toContain('italic point');
    expect(out).toContain('quoted line');
  });

  it('⚠ truncates a long reply at a SENTENCE boundary, not mid-word', () => {
    const long = `${'This is a complete sentence. '.repeat(60)}`;
    const out = speechTextFromReply(long);
    expect(out.length).toBeLessThanOrEqual(VOICE_SPEECH_MAX_CHARS);
    // Cutting mid-word sounds like a fault in the app rather than a limit.
    expect(out.endsWith('.')).toBe(true);
  });

  it('falls back to a word boundary when there is no sentence to end on', () => {
    const out = speechTextFromReply('word '.repeat(400));
    expect(out.length).toBeLessThanOrEqual(VOICE_SPEECH_MAX_CHARS);
    expect(out.endsWith('word')).toBe(true);
  });

  it('leaves a short plain reply untouched', () => {
    expect(speechTextFromReply('Moved it to Friday.')).toBe('Moved it to Friday.');
  });
});

describe('D-262 § E2.2 — choosing a voice that runs on this device', () => {
  const voice = (lang: string, localService: boolean, isDefault = false): SpeechVoiceLike =>
    ({ lang, localService, default: isDefault });

  it('keeps the browser default when it is on-device', () => {
    const browserDefault = voice('en-US', true, true);
    expect(pickOnDeviceVoice([voice('en-US', true), browserDefault])).toBe(browserDefault);
  });

  it('⛔ replaces an ONLINE default with an on-device voice in the same language', () => {
    // Chrome's "Google" voices are made on a server from the reply text.
    const local = voice('en-US', true);
    expect(pickOnDeviceVoice([voice('en-US', false, true), voice('fr-FR', true), local]))
      .toBe(local);
  });

  it('prefers the exact region, then the same language in another region', () => {
    const exact = voice('en-US', true);
    const british = voice('en-GB', true);
    expect(pickOnDeviceVoice([voice('en-US', false, true), british, exact])).toBe(exact);
    expect(pickOnDeviceVoice([voice('en-US', false, true), voice('de-DE', true), british]))
      .toBe(british);
  });

  it('reads `en_US` as `en-US`, as some engines report it', () => {
    const local = voice('en_US', true);
    expect(pickOnDeviceVoice([voice('en-US', false, true), local])).toBe(local);
  });

  it('tries the page language when no default is marked, or the default\'s has no on-device voice', () => {
    const portuguese = voice('pt-PT', true);
    expect(pickOnDeviceVoice([voice('en-US', true), portuguese], 'pt-PT')).toBe(portuguese);
    expect(pickOnDeviceVoice([voice('en-US', false, true), portuguese], 'pt-PT')).toBe(portuguese);
  });

  it('⛔ prefers the page language over an online default\'s, which says nothing about the owner', () => {
    // Measured in Chrome on macOS: while its voices load it marks "Google
    // Deutsch" default on an en-US page. Its language first would read English
    // in an on-device German voice.
    const anna = voice('de-DE', true);
    const samantha = voice('en-US', true);
    expect(pickOnDeviceVoice([voice('de-DE', false, true), anna, samantha], 'en-US')).toBe(samantha);
  });

  it('falls back to the default\'s language when the page gives none', () => {
    const british = voice('en-GB', true);
    expect(pickOnDeviceVoice([voice('en-US', false, true), voice('fr-FR', true), british]))
      .toBe(british);
  });

  it('⛔ never picks an online voice, nor an on-device one in an unrelated language', () => {
    expect(pickOnDeviceVoice([voice('en-US', false, true), voice('en-GB', false)])).toBeUndefined();
    expect(pickOnDeviceVoice([voice('en-US', false, true), voice('ja-JP', true)], 'en-US'))
      .toBeUndefined();
  });

  it('is undefined for an empty list, which in Chrome can mean "not loaded yet"', () => {
    expect(pickOnDeviceVoice([], 'en-US')).toBeUndefined();
  });
});

describe('D-262 slice 4 — the speaker', () => {
  const ON_DEVICE: SpeechVoiceLike = { lang: 'en-US', localService: true, default: true };
  /** `null` voices ⇒ a browser with no `getVoices` at all. */
  const fakeGlobals = (voices: readonly SpeechVoiceLike[] | null = [ON_DEVICE]) => {
    const spoken: string[] = [];
    const utterances: Array<{ text: string; voice?: unknown; lang?: string }> = [];
    const cancels: number[] = [];
    let voiceRequests = 0;
    const globals: VoiceSpeechGlobals = {
      speechSynthesis: {
        speak: (u: unknown) => {
          const utterance = u as { text: string; voice?: unknown; lang?: string };
          utterances.push(utterance);
          spoken.push(utterance.text);
        },
        cancel: () => { cancels.push(spoken.length); },
        ...(voices !== null
          ? { getVoices: () => { voiceRequests += 1; return voices; } }
          : {}),
      },
      SpeechSynthesisUtterance: class { constructor(public text: string) {} } as never,
    };
    return { globals, spoken, utterances, cancels, voiceRequests: () => voiceRequests };
  };

  it('⛔ speaks in the on-device voice it chose, in that voice\'s language', () => {
    const { globals, utterances } = fakeGlobals();
    browserVoiceSpeaker(globals)!.speak('Moved it to Friday.');
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.voice).toBe(ON_DEVICE);
    expect(utterances[0]?.lang).toBe('en-US');
  });

  it('⛔ says NOTHING when the browser has only online voices, rather than sending the reply', () => {
    // The setting promises nothing is sent anywhere to speak a reply, and an
    // online voice is synthesised on a server from the text, names restored.
    const { globals, spoken, cancels } = fakeGlobals([
      { lang: 'en-US', localService: false, default: true },
      { lang: 'en-GB', localService: false, default: false },
    ]);
    browserVoiceSpeaker(globals)!.speak('Your meeting with Ana Castellanos is at 3.');
    expect(spoken).toEqual([]);
    // Still cancelled: a new reply replaces whatever was speaking.
    expect(cancels.length).toBe(1);
  });

  it('says nothing where no voice can be confirmed on-device: no list, or a list that throws', () => {
    const noList = fakeGlobals(null);
    browserVoiceSpeaker(noList.globals)!.speak('hello');
    expect(noList.spoken).toEqual([]);

    const spoken: string[] = [];
    const throwing = browserVoiceSpeaker({
      speechSynthesis: {
        speak: (u: unknown) => { spoken.push((u as { text: string }).text); },
        cancel: () => {},
        getVoices: () => { throw new Error('voices unavailable'); },
      },
      SpeechSynthesisUtterance: class { constructor(public text: string) {} } as never,
    })!;
    expect(() => throwing.speak('hello')).not.toThrow();
    expect(spoken).toEqual([]);
  });

  it('asks for the voice list at mount, so Chrome has loaded it when a reply arrives', () => {
    const { globals, voiceRequests } = fakeGlobals();
    browserVoiceSpeaker(globals);
    expect(voiceRequests()).toBe(1);
  });

  it('builds the speaker from the page\'s globals even where reading navigator throws', () => {
    // The chat route builds it as it mounts: a throw from `navigator` (a
    // locked-down page can make it throw) stopped the whole app starting.
    const { globals, utterances } = fakeGlobals();
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    vi.stubGlobal('speechSynthesis', globals.speechSynthesis);
    vi.stubGlobal('SpeechSynthesisUtterance', globals.SpeechSynthesisUtterance);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      get: () => { throw new Error('navigator unavailable'); },
    });
    try {
      const speaker = browserVoiceSpeaker();
      expect(speaker).not.toBeNull();
      speaker!.speak('Moved it to Friday.');
      expect(utterances[0]?.voice).toBe(ON_DEVICE);
    } finally {
      if (saved !== undefined) Object.defineProperty(globalThis, 'navigator', saved);
      else delete (globalThis as { navigator?: unknown }).navigator;
      vi.unstubAllGlobals();
    }
  });

  it('is null where the API is absent, so the setting simply has no effect', () => {
    expect(browserVoiceSpeaker({})).toBeNull();
    expect(browserVoiceSpeaker({ speechSynthesis: { speak: () => {}, cancel: () => {} } }))
      .toBeNull();
  });

  it('⛔ CANCELS BEFORE SPEAKING, because utterances queue by default', () => {
    const { globals, spoken, cancels } = fakeGlobals();
    const speaker = browserVoiceSpeaker(globals)!;
    speaker.speak('first');
    speaker.speak('second');
    // Without the cancel, a second reply plays back-to-back with the first and
    // by the third the audio is minutes behind the screen.
    expect(spoken).toEqual(['first', 'second']);
    expect(cancels.length).toBe(2);
  });

  it('says nothing for empty or whitespace text', () => {
    const { globals, spoken } = fakeGlobals();
    const speaker = browserVoiceSpeaker(globals)!;
    speaker.speak('');
    speaker.speak('   ');
    expect(spoken).toEqual([]);
  });

  it('survives a throwing synthesiser without claiming anything was heard', () => {
    let attempts = 0;
    const speaker = browserVoiceSpeaker({
      speechSynthesis: {
        speak: () => { attempts += 1; throw new Error('blocked without a user gesture'); },
        cancel: () => {},
        getVoices: () => [ON_DEVICE],
      },
      SpeechSynthesisUtterance: class { constructor(public text: string) {} } as never,
    })!;
    // Browsers throttle speech without a recent gesture and report nothing
    // useful. Swallowing is right; pretending it spoke would not be.
    expect(() => speaker.speak('hello')).not.toThrow();
    // ⚠ The throw was REACHED. With no on-device voice the speaker returns
    // before `speak`, and this test would pass without testing anything.
    expect(attempts).toBe(1);
  });

  it('cancel is safe when nothing is speaking', () => {
    const { globals } = fakeGlobals();
    const speaker = browserVoiceSpeaker(globals)!;
    expect(() => speaker.cancel()).not.toThrow();
  });
});
