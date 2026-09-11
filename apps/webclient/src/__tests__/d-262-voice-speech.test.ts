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
  speechTextFromReply,
  VOICE_SPEECH_MAX_CHARS,
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

describe('D-262 slice 4 — the speaker', () => {
  const fakeGlobals = () => {
    const spoken: string[] = [];
    const cancels: number[] = [];
    const globals: VoiceSpeechGlobals = {
      speechSynthesis: {
        speak: (u: unknown) => { spoken.push((u as { text: string }).text); },
        cancel: () => { cancels.push(spoken.length); },
      },
      SpeechSynthesisUtterance: class { constructor(public text: string) {} } as never,
    };
    return { globals, spoken, cancels };
  };

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
    const speaker = browserVoiceSpeaker({
      speechSynthesis: {
        speak: () => { throw new Error('blocked without a user gesture'); },
        cancel: () => {},
      },
      SpeechSynthesisUtterance: class { constructor(public text: string) {} } as never,
    })!;
    // Browsers throttle speech without a recent gesture and report nothing
    // useful. Swallowing is right; pretending it spoke would not be.
    expect(() => speaker.speak('hello')).not.toThrow();
  });

  it('cancel is safe when nothing is speaking', () => {
    const { globals } = fakeGlobals();
    const speaker = browserVoiceSpeaker(globals)!;
    expect(() => speaker.cancel()).not.toThrow();
  });
});
