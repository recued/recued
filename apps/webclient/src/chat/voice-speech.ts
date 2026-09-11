/** D-262 slice 4 — speaking the reply.
 *
 *  ⛔ TTS OVER THE FINAL TEXT, NOT A MODEL THAT EMITS AUDIO. Asking a
 *  tool-calling model for native audio output breaks the tool loop: the engine
 *  parses `{response, events, tool_calls}`, and a model emitting audio tokens is
 *  not reliably emitting that body. Speaking AFTER `AIOutput` is parsed composes
 *  with tools and the approval gate for free, and works on every model rather
 *  than the audio-output few. It is also the convention: OpenClaw's
 *  `tts.auto_speak`, Open WebUI and LibreChat all synthesise the text response
 *  as a separate step.
 *
 *  ⚠ The browser's own `speechSynthesis` rather than a provider: free, local,
 *  offline, no slot to configure and no audio leaving the device — which is
 *  the pitch. A server-side voice is a later decision, not a precondition.
 *
 *  ⛔ SUPPORT IS DETECTABLE; PERMISSION IS NOT. Browsers may refuse to speak
 *  without a recent user gesture, and a reply arrives seconds after the press
 *  that asked for it. `speechSynthesis` reports no error when it is throttled
 *  this way, so the honest position is: offer the setting where the API exists,
 *  and never claim the reply WAS spoken. */

/** How a reply gets spoken. Mirrors OpenClaw's `auto_speak` tri-state, with
 *  `after_voice` standing in for its `talk_mode_only`: this product has no
 *  separate talk mode, and "you spoke, so it speaks back" is the same idea. */
export type VoiceSpeakMode = 'never' | 'after_voice' | 'always';

export interface VoiceSpeaker {
  /** Speak this text, replacing anything already speaking. */
  speak(text: string): void;
  /** Stop immediately. Safe to call when nothing is speaking. */
  cancel(): void;
}

export type VoiceSpeakerFactory = VoiceSpeaker | null;

/** The globals this module touches, named so a test can supply them. */
export interface VoiceSpeechGlobals {
  speechSynthesis?: {
    speak(utterance: unknown): void;
    cancel(): void;
  };
  SpeechSynthesisUtterance?: new (text: string) => unknown;
}

/** Longest stretch spoken from one reply.
 *
 *  ⚠ A cap, not a summary. Synthesising a 900-word answer is a hostage
 *  situation — it takes minutes, cannot be skimmed, and the stop control is
 *  wherever the person is not looking. The text stays on screen in full; only
 *  the spoken rendition stops early. */
export const VOICE_SPEECH_MAX_CHARS = 700;

/** Turn a model reply into something worth hearing.
 *
 *  ⛔ READING RAW MARKDOWN ALOUD IS THE FAILURE MODE. "asterisk asterisk
 *  important asterisk asterisk" and forty lines of shell script are why a
 *  naive `speak(message.content)` gets switched off within a day. Code blocks
 *  become a spoken marker rather than their contents — someone who wants the
 *  code is reading it, not listening to it.
 *
 *  ⚠ Truncation lands on a SENTENCE boundary where one exists. Cutting
 *  mid-word sounds like a fault in the app rather than a deliberate limit. */
export const speechTextFromReply = (
  markdown: string,
  maxChars = VOICE_SPEECH_MAX_CHARS,
): string => {
  let text = markdown;
  // Fenced code → one spoken marker. Done first so nothing inside a fence is
  // mistaken for prose markup.
  text = text.replace(/```[\s\S]*?```/g, ' (code block) ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' (code block) ');
  // Inline code keeps its content — it is usually one identifier, and dropping
  // it would remove the answer's subject.
  text = text.replace(/`([^`]+)`/g, '$1');
  // Links: say the label, never the URL. A spoken https:// is unusable.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Headings, list bullets, blockquote markers, emphasis, table pipes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*\|.*\|\s*$/gm, ' ');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  // Prefer the last sentence end; fall back to the last word break.
  const sentenceEnd = Math.max(
    clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '),
  );
  if (sentenceEnd > maxChars * 0.5) return clipped.slice(0, sentenceEnd + 1);
  const wordEnd = clipped.lastIndexOf(' ');
  return (wordEnd > 0 ? clipped.slice(0, wordEnd) : clipped).trimEnd();
};

/** Build the speaker, or `null` when this browser cannot synthesise speech. */
export const browserVoiceSpeaker = (
  globals?: VoiceSpeechGlobals,
): VoiceSpeakerFactory => {
  const g: VoiceSpeechGlobals = globals ?? {
    ...(typeof speechSynthesis !== 'undefined' ? { speechSynthesis } : {}),
    ...(typeof SpeechSynthesisUtterance !== 'undefined' ? { SpeechSynthesisUtterance } : {}),
  };
  const synth = g.speechSynthesis;
  const Utterance = g.SpeechSynthesisUtterance;
  if (!synth || !Utterance) return null;

  return {
    speak(text) {
      const spoken = text.trim();
      if (spoken.length === 0) return;
      // ⛔ CANCEL FIRST. Utterances QUEUE by default, so a second reply while
      // the first is still speaking would play both back to back — and by the
      // third the audio is minutes behind the conversation on screen.
      try { synth.cancel(); } catch { /* nothing was speaking */ }
      try { synth.speak(new Utterance(spoken)); } catch {
        // Throttled, blocked, or no voice installed. Nothing is claimed about
        // whether it was heard, so there is nothing to report.
      }
    },
    cancel() {
      try { synth.cancel(); } catch { /* nothing was speaking */ }
    },
  };
};
