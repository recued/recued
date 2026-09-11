/** D-262 § 5 — press-to-talk capture.
 *
 *  Driven through the real state machine with a fake recorder, because the
 *  behaviour that matters is all in the bookkeeping around the browser's own
 *  asynchrony: a permission prompt that resolves after the route is gone, a
 *  second press while the prompt is still up, and the track release that keeps
 *  the recording indicator from staying lit.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  browserVoiceCaptureFactory,
  createVoiceComposer,
  voiceFileExtension,
  voiceFilename,
  type VoiceCaptureGlobals,
  type VoiceCaptureSession,
  type VoiceRecording,
} from '../chat/voice-capture.js';

// ── the browser doubles ───────────────────────────────────────────

interface FakeTrack { stopped: boolean; stop(): void }

const makeStream = (): { stream: MediaStream; tracks: FakeTrack[] } => {
  const tracks: FakeTrack[] = [
    { stopped: false, stop(): void { this.stopped = true; } },
  ];
  return {
    stream: { getTracks: () => tracks } as unknown as MediaStream,
    tracks,
  };
};

interface FakeRecorder {
  mimeType: string;
  started: boolean;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

const fakeGlobals = (over: {
  supported?: readonly string[];
  /** Reject `getUserMedia` with this error name. */
  denyWith?: string;
  omitMediaDevices?: boolean;
  omitRecorder?: boolean;
  omitIsTypeSupported?: boolean;
  /** Bytes the recorder emits before stopping; `[]` = a silent press. */
  chunks?: string[];
} = {}) => {
  const recorders: FakeRecorder[] = [];
  const streams: Array<{ stream: MediaStream; tracks: FakeTrack[] }> = [];
  const supported = over.supported ?? ['audio/webm;codecs=opus', 'audio/webm'];

  // ⚠ The recorder is built as a named local rather than inline: `Object.assign`
  // over a constructor-shaped cast widens to a union TS cannot reconcile with
  // the declared globals — and `typecheck:tests`, not vitest (which strips
  // types), is the only gate that sees it.
  let Recorder: VoiceCaptureGlobals['MediaRecorder'];
  if (over.omitRecorder !== true) {
    const ctor = function (this: FakeRecorder, _s: MediaStream, opts?: { mimeType?: string }) {
      const rec: FakeRecorder = {
        mimeType: opts?.mimeType ?? '',
        started: false,
        ondataavailable: null,
        onstop: null,
        start(): void { this.started = true; },
        stop(): void {
          for (const chunk of over.chunks ?? ['bytes']) {
            this.ondataavailable?.({
              data: new Blob([chunk], { type: this.mimeType }),
            });
          }
          this.onstop?.();
        },
      };
      recorders.push(rec);
      return rec;
    } as unknown as NonNullable<VoiceCaptureGlobals['MediaRecorder']>;
    if (over.omitIsTypeSupported !== true) {
      ctor.isTypeSupported = (t: string): boolean => supported.includes(t);
    }
    Recorder = ctor;
  }

  const globals: VoiceCaptureGlobals = {
    ...(over.omitMediaDevices
      ? {}
      : {
          mediaDevices: {
            getUserMedia: vi.fn(async () => {
              if (over.denyWith !== undefined) {
                const e = new Error('refused');
                e.name = over.denyWith;
                throw e;
              }
              const made = makeStream();
              streams.push(made);
              return made.stream;
            }),
          },
        }),
    ...(Recorder !== undefined ? { MediaRecorder: Recorder } : {}),
    // LOCAL wall clock, matching what `voiceFilename` formats — a UTC
    // fixture here would pass or fail with the machine's zone.
    now: () => new Date(2030, 3, 2, 10, 15, 30),
  };
  return { globals, recorders, streams };
};

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── the provider-facing name ──────────────────────────────────────

describe('D-262 — the recorded file name', () => {
  it('maps each container to the extension the audio endpoint accepts', () => {
    // ⛔ NOT cosmetic: the OpenAI audio endpoint validates the FILENAME's
    // extension, so a name without one is rejected before a byte is decoded.
    expect(voiceFileExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(voiceFileExtension('audio/webm')).toBe('webm');
    expect(voiceFileExtension('audio/mp4')).toBe('m4a');
    expect(voiceFileExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(voiceFileExtension('audio/wav')).toBe('wav');
  });

  it('falls back rather than inventing an extension for an unknown container', () => {
    expect(voiceFileExtension('audio/weird')).toBe('bin');
    expect(voiceFileExtension('')).toBe('bin');
  });

  it('stamps a colon-free local time, because the name is what a person reads', () => {
    const name = voiceFilename('audio/webm', new Date(2030, 3, 2, 10, 15, 30));
    expect(name).toBe('voice-note-20300402-101530.webm');
    expect(name).not.toContain(':');
  });
});

// ── capability ────────────────────────────────────────────────────

describe('D-262 — capability is decided before the control renders', () => {
  it('is null without mediaDevices — the insecure-context case', () => {
    // `navigator.mediaDevices` is undefined over plain http, which is exactly
    // where a self-hosted server is first reached.
    expect(browserVoiceCaptureFactory(fakeGlobals({ omitMediaDevices: true }).globals))
      .toBeNull();
  });

  it('is null without MediaRecorder', () => {
    expect(browserVoiceCaptureFactory(fakeGlobals({ omitRecorder: true }).globals))
      .toBeNull();
  });

  it('is null when the platform supports none of the containers a provider reads', () => {
    expect(browserVoiceCaptureFactory(fakeGlobals({ supported: [] }).globals))
      .toBeNull();
  });

  it('picks the FIRST supported container, not merely a supported one', async () => {
    const { globals, recorders } = fakeGlobals({
      supported: ['audio/webm', 'audio/mp4'],
    });
    const factory = browserVoiceCaptureFactory(globals);
    expect(factory).not.toBeNull();
    await factory!();
    // 'audio/webm;codecs=opus' is unsupported here, so the ordered walk must
    // land on plain webm rather than on Safari's mp4.
    expect(recorders[0]?.mimeType).toBe('audio/webm');
  });

  it('assumes mp4 when the browser has no isTypeSupported at all', async () => {
    const { globals, recorders } = fakeGlobals({ omitIsTypeSupported: true });
    const factory = browserVoiceCaptureFactory(globals);
    await factory!();
    // Older Safari: guessing WebM there records something nothing can read.
    expect(recorders[0]?.mimeType).toBe('audio/mp4');
  });
});

// ── the device ────────────────────────────────────────────────────

describe('D-262 — the microphone is released on every exit', () => {
  it('stops the tracks when a recording finishes', async () => {
    const { globals, streams } = fakeGlobals();
    const session = await browserVoiceCaptureFactory(globals)!();
    expect(streams[0]!.tracks[0]!.stopped).toBe(false);
    const recording = await session.stop();
    expect(recording?.mime_type).toBe('audio/webm;codecs=opus');
    expect(recording?.filename).toBe('voice-note-20300402-101530.webm');
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('stops the tracks when a recording is discarded', async () => {
    const { globals, streams } = fakeGlobals();
    const session = await browserVoiceCaptureFactory(globals)!();
    session.cancel();
    // ⛔ The one failure here that reads as spyware rather than as a bug: a
    // live track keeps the browser's recording indicator lit after the person
    // believes they stopped.
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it('resolves null — not an empty recording — for a silent press', async () => {
    const { globals } = fakeGlobals({ chunks: [] });
    const session = await browserVoiceCaptureFactory(globals)!();
    expect(await session.stop()).toBeNull();
  });
});

// ── the state machine ─────────────────────────────────────────────

const recordingSession = (): {
  session: VoiceCaptureSession;
  stopped: () => boolean;
  cancelled: () => boolean;
} => {
  let stopped = false;
  let cancelled = false;
  return {
    session: {
      stop: async (): Promise<VoiceRecording | null> => {
        stopped = true;
        return {
          blob: new Blob(['bytes']),
          mime_type: 'audio/webm',
          filename: 'voice-note.webm',
        };
      },
      cancel: (): void => { cancelled = true; },
    },
    stopped: () => stopped,
    cancelled: () => cancelled,
  };
};

describe('D-262 — the press-to-talk state machine', () => {
  it('walks idle → opening → recording → a file on the attachment path', async () => {
    const made = recordingSession();
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      factory: async () => made.session,
      onRecording,
      onChange: () => {},
      makeFile: (r) => ({ name: r.filename, type: r.mime_type }) as unknown as File,
    });

    expect(composer.phase()).toBe('idle');
    composer.toggle();
    // ⚠ `opening` is a real phase: the browser's permission prompt can sit
    // there indefinitely, and the button must not still read "start".
    expect(composer.phase()).toBe('opening');
    await tick();
    expect(composer.phase()).toBe('recording');

    composer.toggle();
    expect(composer.phase()).toBe('idle');
    await tick();
    expect(made.stopped()).toBe(true);
    expect(onRecording).toHaveBeenCalledTimes(1);
    expect(onRecording.mock.calls[0]?.[0]).toMatchObject({ name: 'voice-note.webm' });
  });

  it('⛔ IGNORES a second press while the permission prompt is open', async () => {
    const factory = vi.fn(async () => recordingSession().session);
    const composer = createVoiceComposer({
      factory, onRecording: () => {}, onChange: () => {},
    });
    composer.toggle();
    composer.toggle();
    composer.toggle();
    await tick();
    // A queued second start would open a SECOND stream the moment the person
    // grants permission, and only one of them would ever be stopped.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(composer.phase()).toBe('recording');
  });

  it('names WHICH refusal it was', async () => {
    const denial = (name: string) => createVoiceComposer({
      factory: async () => { const e = new Error('no'); e.name = name; throw e; },
      onRecording: () => {},
      onChange: () => {},
    });

    const denied = denial('NotAllowedError');
    denied.toggle();
    await tick();
    expect(denied.phase()).toBe('idle');
    // "Microphone unavailable" over a denied permission sends people to their
    // hardware; only the browser's own error name separates the two.
    expect(denied.error()).toContain('permission was refused');

    const missing = denial('NotFoundError');
    missing.toggle();
    await tick();
    expect(missing.error()).toContain('No microphone was found');

    const other = denial('AbortError');
    other.toggle();
    await tick();
    expect(other.error()).toContain('could not be opened');
  });

  it('clears a prior refusal when the next press succeeds', async () => {
    let deny = true;
    const composer = createVoiceComposer({
      factory: async () => {
        if (deny) { const e = new Error('no'); e.name = 'NotAllowedError'; throw e; }
        return recordingSession().session;
      },
      onRecording: () => {},
      onChange: () => {},
    });
    composer.toggle();
    await tick();
    expect(composer.error()).not.toBeNull();
    deny = false;
    composer.toggle();
    await tick();
    // A stale denial next to a live recording would say the opposite of what
    // the control is doing.
    expect(composer.error()).toBeNull();
    expect(composer.phase()).toBe('recording');
  });

  it('stops itself at the cap, so a forgotten press cannot climb', async () => {
    const made = recordingSession();
    const onRecording = vi.fn();
    let fired: (() => void) | null = null;
    const composer = createVoiceComposer({
      factory: async () => made.session,
      onRecording,
      onChange: () => {},
      maxMs: 1_000,
      setTimer: (fn) => { fired = fn; return 1; },
      clearTimer: () => {},
      makeFile: () => ({}) as unknown as File,
    });
    composer.toggle();
    await tick();
    expect(fired).not.toBeNull();
    fired!();
    await tick();
    expect(composer.phase()).toBe('idle');
    expect(onRecording).toHaveBeenCalledTimes(1);
  });

  it('discards on cancel — nothing reaches the attachment path', async () => {
    const made = recordingSession();
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      factory: async () => made.session,
      onRecording,
      onChange: () => {},
    });
    composer.toggle();
    await tick();
    composer.cancel();
    await tick();
    expect(made.cancelled()).toBe(true);
    expect(onRecording).not.toHaveBeenCalled();
    expect(composer.phase()).toBe('idle');
  });

  it('⛔ CLOSES a stream that opens after teardown', async () => {
    const made = recordingSession();
    let release: ((s: VoiceCaptureSession) => void) | null = null;
    const composer = createVoiceComposer({
      factory: () => new Promise((resolve) => { release = () => resolve(made.session); }),
      onRecording: () => {},
      onChange: () => {},
    });
    composer.toggle();
    await tick();
    composer.destroy();
    // The permission prompt was still up when the route went away. The stream
    // it eventually hands back belongs to nobody — adopting it would leave the
    // microphone open with no UI to stop it.
    release!(made.session);
    await tick();
    expect(made.cancelled()).toBe(true);
  });

  it('does nothing at all after destroy', async () => {
    const factory = vi.fn(async () => recordingSession().session);
    const composer = createVoiceComposer({
      factory, onRecording: () => {}, onChange: () => {},
    });
    composer.destroy();
    composer.toggle();
    await tick();
    expect(factory).not.toHaveBeenCalled();
  });
});

// ── the window between a granted mic and a running recorder ────────
//
// ⛔⛔ REVIEW FINDING (2026-09-07). `getUserMedia` resolving is a GRANT: the
// device is live from that moment. Two statements ran between the grant and
// the `release` closure that stops the tracks, and BOTH can throw:
// `new MediaRecorder(...)` and `.start()`. Either one left the microphone open
// with the browser's recording indicator lit and no handle to stop it —
// exactly the failure the module's own comment calls "spyware rather than a
// defect", stated directly above the uncovered window.
//
// ⚠ `isTypeSupported` returning true is ADVISORY. A browser may accept a MIME
// in that query and reject it at construction, so the guard above does not
// make the constructor safe.
describe('D-262 — a failed recorder init must not keep the microphone', () => {
  const stream = (): { stream: MediaStream; tracks: { stopped: boolean }[] } => {
    const tracks = [{ stopped: false, stop(): void { this.stopped = true; } }];
    return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
  };

  const globalsThatFail = (where: 'construct' | 'start') => {
    const made = stream();
    const ctor = function (this: unknown) {
      if (where === 'construct') throw new Error('NotSupportedError');
      return {
        mimeType: 'audio/webm', ondataavailable: null, onstop: null,
        start(): void { throw new Error('device busy'); },
        stop(): void {},
      };
    } as unknown as NonNullable<VoiceCaptureGlobals['MediaRecorder']>;
    ctor.isTypeSupported = (): boolean => true;
    const globals: VoiceCaptureGlobals = {
      mediaDevices: { getUserMedia: vi.fn(async () => made.stream) },
      MediaRecorder: ctor,
      now: () => new Date(2030, 3, 2, 10, 15, 30),
    };
    return { globals, made };
  };

  it('⛔ releases the device when the CONSTRUCTOR throws', async () => {
    const { globals, made } = globalsThatFail('construct');
    const factory = browserVoiceCaptureFactory(globals);
    expect(factory).not.toBeNull();
    await expect(factory!()).rejects.toThrow();
    // The caller still learns it failed; what it must not inherit is a live mic.
    expect(made.tracks[0]!.stopped).toBe(true);
  });

  it('⛔ releases the device when start() throws', async () => {
    const { globals, made } = globalsThatFail('start');
    const factory = browserVoiceCaptureFactory(globals);
    await expect(factory!()).rejects.toThrow();
    expect(made.tracks[0]!.stopped).toBe(true);
  });

  it('⚠ and the composer surfaces the failure rather than swallowing it', async () => {
    const { globals, made } = globalsThatFail('construct');
    const factory = browserVoiceCaptureFactory(globals);
    const composer = createVoiceComposer({
      factory: factory!, onRecording: () => {}, onChange: () => {},
    });
    composer.toggle();
    await tick();
    // Both halves matter: an error the person can see, and a device released.
    expect(composer.error()).not.toBeNull();
    expect(made.tracks[0]!.stopped).toBe(true);
  });
});
