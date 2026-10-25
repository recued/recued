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
 *  ⚠ The browser's own `speechSynthesis` rather than a provider: free, no slot
 *  to configure, and on this device — but only in an on-device VOICE, which a
 *  browser's default is not always (`pickOnDeviceVoice`, D-262 § E2.2). A
 *  server-side voice is a later decision, not a precondition.
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

/** What the speaker reads from one of the browser's voices. The DOM's
 *  `SpeechSynthesisVoice` satisfies it; a test supplies plain objects. */
export interface SpeechVoiceLike {
  readonly lang: string;
  /** The browser's own word on whether this voice runs on this device. */
  readonly localService: boolean;
  readonly default: boolean;
}

/** The globals this module touches, named so a test can supply them. */
export interface VoiceSpeechGlobals {
  speechSynthesis?: {
    speak(utterance: unknown): void;
    cancel(): void;
    /** Absent ⇒ no voice can be confirmed on-device, so nothing is spoken. */
    getVoices?(): readonly SpeechVoiceLike[];
  };
  SpeechSynthesisUtterance?: new (text: string) => unknown;
  /** The page's language (`navigator.language`), tried FIRST when the browser
   *  default is not an on-device voice. */
  language?: string;
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

/** The voice a reply is spoken in: the browser's default when it runs on this
 *  device, else an on-device voice in the page's language or the default's,
 *  else none.
 *
 *  ⛔ ON-DEVICE OR SILENT (D-262 § E2.2). The setting tells the owner nothing is
 *  sent anywhere to speak a reply, and a browser's default voice can be an
 *  online one — Chrome lists "Google" voices and Edge "Online (Natural)" ones,
 *  synthesised on a server from the reply TEXT with real names already
 *  restored. `localService` is the browser's own word on which is which, and
 *  the only word there is. With no on-device voice to use, the reply is not
 *  spoken rather than sent.
 *
 *  ⚠ An empty list means "not loaded yet" as often as "none" (Chrome fills it
 *  in after the first `getVoices()`), and silence is the honest answer to both:
 *  nothing ever claims a reply WAS spoken.
 *
 *  ⚠ THE PAGE'S LANGUAGE COMES FIRST, because an online default says nothing
 *  about the owner. Measured in Chrome on macOS with its usual components
 *  (2026-10-23): ~100 ms after the first ask the list was 19 online voices with
 *  "Google Deutsch (de-DE)" marked default on an en-US page; ~3 s later the
 *  Mac's 180 voices joined and "Samantha (en-US)" took the default. Where an
 *  online default meets on-device voices, trying its language first reads
 *  English in an on-device German voice ("Anna", simulated on that real list). */
export const pickOnDeviceVoice = <V extends SpeechVoiceLike>(
  voices: readonly V[],
  language?: string,
): V | undefined => {
  const browserDefault = voices.find((voice) => voice.default);
  if (browserDefault?.localService === true) return browserDefault;
  const onDevice = voices.filter((voice) => voice.localService);
  for (const wanted of [language, browserDefault?.lang]) {
    if (wanted === undefined || wanted.trim() === '') continue;
    const tag = normaliseLang(wanted);
    const match = onDevice.find((voice) => normaliseLang(voice.lang) === tag)
      ?? onDevice.find((voice) => primaryLang(voice.lang) === primaryLang(tag));
    if (match !== undefined) return match;
  }
  return undefined;
};

/** `en_US`, `en-us` and `en-US` are one language; some engines report the first. */
const normaliseLang = (lang: string): string => lang.trim().replace(/_/g, '-').toLowerCase();
const primaryLang = (lang: string): string => normaliseLang(lang).split('-')[0] ?? '';

/** The page's language, or none where reading `navigator` throws, as a
 *  locked-down page can make it do. The chat route builds the speaker as it
 *  mounts, so a throw here stopped the app from starting. */
const pageLanguage = (): string | undefined => {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.language === 'string'
      ? navigator.language
      : undefined;
  } catch {
    return undefined;
  }
};

/** Build the speaker, or `null` when this browser cannot synthesise speech. */
export const browserVoiceSpeaker = (
  globals?: VoiceSpeechGlobals,
): VoiceSpeakerFactory => {
  const language = globals === undefined ? pageLanguage() : undefined;
  const g: VoiceSpeechGlobals = globals ?? {
    ...(typeof speechSynthesis !== 'undefined' ? { speechSynthesis } : {}),
    ...(typeof SpeechSynthesisUtterance !== 'undefined' ? { SpeechSynthesisUtterance } : {}),
    ...(language !== undefined ? { language } : {}),
  };
  const synth = g.speechSynthesis;
  const Utterance = g.SpeechSynthesisUtterance;
  if (!synth || !Utterance) return null;
  const voices = (): readonly SpeechVoiceLike[] => {
    try { return synth.getVoices?.() ?? []; } catch { return []; }
  };
  // Ask once now: Chrome loads its voice list on the first request and answers
  // that one empty, so asking at mount has the list ready when a reply arrives.
  voices();

  return {
    speak(text) {
      const spoken = text.trim();
      if (spoken.length === 0) return;
      // ⛔ CANCEL FIRST. Utterances QUEUE by default, so a second reply while
      // the first is still speaking would play both back to back — and by the
      // third the audio is minutes behind the conversation on screen.
      try { synth.cancel(); } catch { /* nothing was speaking */ }
      const voice = pickOnDeviceVoice(voices(), g.language);
      if (voice === undefined) return;
      try {
        const utterance = new Utterance(spoken) as { voice?: unknown; lang?: string };
        // `lang` as well: an engine that picks by language, not by `voice`,
        // still speaks the one the chosen voice is in.
        utterance.voice = voice;
        utterance.lang = voice.lang;
        synth.speak(utterance);
      } catch {
        // Throttled, blocked, or no voice installed. Nothing is claimed about
        // whether it was heard, so there is nothing to report.
      }
    },
    cancel() {
      try { synth.cancel(); } catch { /* nothing was speaking */ }
    },
  };
};
