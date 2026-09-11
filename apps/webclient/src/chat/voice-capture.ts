/** D-262 § 5 — press-to-talk capture for the chat composer.
 *
 *  ⛔ UNTIL THIS EXISTED, NOTHING IN THE WEBCLIENT COULD REACH A MICROPHONE.
 *  `getUserMedia`, `MediaRecorder` and `SpeechRecognition` appeared nowhere in
 *  `apps/webclient/src` or `apps/bridge/src` — while the server had held a
 *  complete transcription path since D-172 A.9, wired and driven on the
 *  messenger turn. The server could hear; the owner's own surface could not
 *  speak, and mobile IS that surface.
 *
 *  ── Why a seam and not `navigator.mediaDevices` inline ────────────
 *  The webclient's test double is a fake document with no `navigator`, no
 *  `MediaRecorder` and no permission model. Reaching for globals inside the
 *  route would make every voice behaviour — the denial message, the max-length
 *  auto-stop, the filename the provider validates — testable only in a real
 *  browser, which is where they would then rot. The route takes a
 *  `VoiceCaptureFactory`; production omits it and gets
 *  `browserVoiceCaptureFactory`.
 *
 *  ── Why a null factory rather than a failing button ───────────────
 *  ⚠ CAPABILITY IS DECIDED BEFORE THE CONTROL RENDERS. An insecure context, an
 *  old browser, or a platform with no recordable container returns `null` and
 *  the mic never appears. A control that offers itself and then fails is worse
 *  than one that was never offered — the person cannot tell a broken feature
 *  from a broken microphone. */

/** What a finished recording hands back. */
export interface VoiceRecording {
  blob: Blob;
  mime_type: string;
  /** Extension-bearing name. ⛔ NOT cosmetic — the OpenAI audio endpoint
   *  validates the FILENAME's extension, so `voice-note` with no suffix is
   *  rejected before a single byte is decoded. */
  filename: string;
}

export interface VoiceCaptureSession {
  /** Stop and resolve what was recorded. Resolves `null` when the recorder
   *  produced no bytes (a denied device that opened, a zero-length press). */
  stop(): Promise<VoiceRecording | null>;
  /** Stop and discard. Safe to call twice, and after `stop`. */
  cancel(): void;
}

/** Opens the microphone. REJECTS on denial or absent device — the caller shows
 *  the reason; it is never swallowed. */
export type VoiceCaptureFactory = (() => Promise<VoiceCaptureSession>) | null;

/** The containers a browser might record, best first.
 *
 *  ⚠ Ordered by what the transcription adapters accept, not by fidelity: Opus
 *  in WebM is what Chrome/Firefox give and what whisper takes; `audio/mp4` is
 *  Safari's only answer. A platform offering none of these is unsupported —
 *  the factory returns null rather than recording something no provider reads. */
const CANDIDATE_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
] as const;

/** mime → the extension the provider will accept. */
export const voiceFileExtension = (mime_type: string): string => {
  const base = mime_type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'audio/webm') return 'webm';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/mp4') return 'm4a';
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav';
  return 'bin';
};

export const voiceFilename = (mime_type: string, at: Date): string => {
  // Local wall clock, colon-free: the name is what the person sees on the chip
  // and in `file.search`, and a colon is not a filename character everywhere.
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
    + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `voice-note-${stamp}.${voiceFileExtension(mime_type)}`;
};

/** The globals this module touches, named so a test can supply them. */
export interface VoiceCaptureGlobals {
  mediaDevices?: { getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> };
  MediaRecorder?: {
    new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorder;
    isTypeSupported?(type: string): boolean;
  };
  now?: () => Date;
}

/** Build the production factory, or `null` when this browser cannot record.
 *
 *  ⚠ Returns null for THREE distinct absences — no `mediaDevices` (an insecure
 *  context is the common one: `getUserMedia` is undefined over plain http), no
 *  `MediaRecorder`, and no supported container. The caller does not need to
 *  tell them apart: all three mean "do not offer this control here". */
export const browserVoiceCaptureFactory = (
  globals?: VoiceCaptureGlobals,
): VoiceCaptureFactory => {
  const g: VoiceCaptureGlobals = globals ?? {
    ...(typeof navigator !== 'undefined' && navigator.mediaDevices
      ? { mediaDevices: navigator.mediaDevices }
      : {}),
    ...(typeof MediaRecorder !== 'undefined' ? { MediaRecorder } : {}),
  };
  const devices = g.mediaDevices;
  const Recorder = g.MediaRecorder;
  if (!devices || typeof devices.getUserMedia !== 'function' || !Recorder) return null;

  const supported = typeof Recorder.isTypeSupported === 'function'
    ? CANDIDATE_MIMES.find((m) => Recorder.isTypeSupported?.(m) === true)
    // No `isTypeSupported` at all (older Safari) — WebM is the wrong guess
    // there, so take the container that platform actually records.
    : 'audio/mp4';
  if (!supported) return null;
  const now = g.now ?? (() => new Date());

  return async (): Promise<VoiceCaptureSession> => {
    const stream = await devices.getUserMedia({ audio: true });

    // ⛔ RELEASE THE DEVICE ON EVERY EXIT PATH. A live track keeps the
    // browser's recording indicator lit and the microphone held after the
    // person thinks they stopped — the one bug in this feature that would
    // read as spyware rather than as a defect.
    //
    // ⛔⛔ DEFINED BEFORE ANYTHING THAT CAN THROW, AND THAT ORDER IS THE FIX.
    // It used to sit BELOW `new Recorder(...)`, so the two statements between
    // `getUserMedia` resolving and this line had no cleanup at all — and both
    // can throw. `isTypeSupported` is advisory: a browser may report a MIME as
    // supported and still reject it at construction, and `start()` throws on
    // its own (a device grabbed by another app between grant and start). Every
    // such throw left the microphone OPEN with the indicator lit, which is the
    // precise failure the comment above calls unacceptable — the rule was
    // stated and the window above it was not covered.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already ended */ }
      }
    };

    try {
      const recorder = new Recorder(stream, { mimeType: supported });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event: BlobEvent): void => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };

      let settled = false;
      const finished = new Promise<VoiceRecording | null>((resolve) => {
        recorder.onstop = (): void => {
          release();
          if (chunks.length === 0) { resolve(null); return; }
          const blob = new Blob(chunks, { type: supported });
          if (blob.size === 0) { resolve(null); return; }
          resolve({ blob, mime_type: supported, filename: voiceFilename(supported, now()) });
        };
      });

      recorder.start();

      return {
        stop: async (): Promise<VoiceRecording | null> => {
          if (!settled) {
            settled = true;
            try { recorder.stop(); } catch { release(); return null; }
          }
          return finished;
        },
        cancel: (): void => {
          if (!settled) {
            settled = true;
            try { recorder.stop(); } catch { /* fall through to release */ }
          }
          release();
        },
      };
    } catch (e) {
      // The caller still sees the failure — it needs to render one. What it
      // must not inherit is a live microphone.
      release();
      throw e;
    }
  };
};

/** How long one press may run before it stops itself. A forgotten press must
 *  not climb toward the server's upload cap unattended. */
export const VOICE_MAX_MS = 5 * 60 * 1000;

export interface VoiceComposerDeps {
  factory: NonNullable<VoiceCaptureFactory>;
  /** A finished recording, ready to ride the normal attachment path. */
  onRecording: (file: File) => void;
  /** Repaint. Fired on every state change, including failures. */
  onChange: () => void;
  maxMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Injected so a test can assert the File it built without a real DOM. */
  makeFile?: (recording: VoiceRecording) => File;
}

export type VoiceComposerPhase = 'idle' | 'opening' | 'recording';

export interface VoiceComposer {
  phase(): VoiceComposerPhase;
  /** The reason the last attempt failed, shown in the composer. */
  error(): string | null;
  /** Start when idle, stop when recording. The one gesture the button has. */
  toggle(): void;
  /** Discard an in-flight recording (route teardown, or an explicit cancel). */
  cancel(): void;
  destroy(): void;
}

const defaultMakeFile = (recording: VoiceRecording): File =>
  new File([recording.blob], recording.filename, { type: recording.mime_type });

/** The press-to-talk state machine, with no DOM in it.
 *
 *  ⚠ `opening` is a real phase, not a nicety: `getUserMedia` shows a browser
 *  permission prompt the first time and can sit there for as long as the person
 *  ignores it. Without the phase the button reads "start" throughout, and a
 *  second press while the prompt is open would open a SECOND stream. */
export const createVoiceComposer = (deps: VoiceComposerDeps): VoiceComposer => {
  const maxMs = deps.maxMs ?? VOICE_MAX_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => { clearTimeout(h as ReturnType<typeof setTimeout>); });
  const makeFile = deps.makeFile ?? defaultMakeFile;

  let phase: VoiceComposerPhase = 'idle';
  let session: VoiceCaptureSession | null = null;
  let timer: unknown = null;
  let error: string | null = null;
  let destroyed = false;
  /** Guards the `opening` → `recording` handoff across `destroy` / `cancel`:
   *  the awaited factory can resolve AFTER teardown, and a stream opened for a
   *  route that no longer exists must be closed, not adopted. */
  let generation = 0;

  const clearPendingTimer = (): void => {
    if (timer !== null) { clearTimer(timer); timer = null; }
  };

  const stopRecording = (): void => {
    if (phase !== 'recording' || !session) return;
    const active = session;
    session = null;
    phase = 'idle';
    clearPendingTimer();
    deps.onChange();
    void active.stop().then((recording) => {
      if (destroyed || !recording) return;
      deps.onRecording(makeFile(recording));
    }).catch(() => {
      // A recorder that threw on stop has already released; there is nothing
      // to attach and nothing the person can act on.
    });
  };

  const start = (): void => {
    const mine = ++generation;
    phase = 'opening';
    error = null;
    deps.onChange();
    void deps.factory().then((opened) => {
      if (destroyed || mine !== generation) { opened.cancel(); return; }
      session = opened;
      phase = 'recording';
      deps.onChange();
      timer = setTimer(() => { stopRecording(); }, maxMs);
    }).catch((e: unknown) => {
      if (destroyed || mine !== generation) return;
      phase = 'idle';
      // ⚠ SAY WHICH REFUSAL IT WAS. "Microphone unavailable" over a denied
      // permission sends people to their hardware; the browser's own name for
      // the error is the only thing that distinguishes them.
      const name = (e as { name?: string } | null)?.name;
      error = name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone permission was refused. Allow it for this site to record.'
        : name === 'NotFoundError'
          ? 'No microphone was found on this device.'
          : 'The microphone could not be opened.';
      deps.onChange();
    });
  };

  return {
    phase: () => phase,
    error: () => error,
    toggle: (): void => {
      if (destroyed) return;
      if (phase === 'recording') { stopRecording(); return; }
      // ⛔ An `opening` press is ignored, not queued: the permission prompt is
      // already up, and a queued second start would open a second stream the
      // moment it is granted.
      if (phase === 'opening') return;
      start();
    },
    cancel: (): void => {
      generation++;
      clearPendingTimer();
      const active = session;
      session = null;
      phase = 'idle';
      active?.cancel();
      deps.onChange();
    },
    destroy: (): void => {
      destroyed = true;
      generation++;
      clearPendingTimer();
      session?.cancel();
      session = null;
      phase = 'idle';
    },
  };
};
