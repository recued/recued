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

interface FakeTrack extends EventTarget {
  stopped: boolean;
  readyState: 'live' | 'ended';
  stop(): void;
}

const makeStream = (): { stream: MediaStream; tracks: FakeTrack[] } => {
  const tracks: FakeTrack[] = [
    Object.assign(new EventTarget(), {
      stopped: false,
      readyState: 'live' as 'live' | 'ended',
      stop(): void { this.stopped = true; this.readyState = 'ended'; },
    }),
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
  onerror: (() => void) | null;
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
  stopThrows?: boolean;
  deferStop?: boolean;
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
        onerror: null,
        start(): void { this.started = true; },
        stop(): void {
          if (over.stopThrows) throw new Error('recorder failed to stop');
          if (over.deferStop) return;
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

describe('D-262 — interruptions discard incomplete audio', () => {
  it.each(['recorder error', 'microphone loss', 'unexpected stop'])('releases the microphone after %s', async (cause) => {
    const { globals, streams, recorders } = fakeGlobals();
    const onError = vi.fn();
    const session = await browserVoiceCaptureFactory(globals)!(onError);
    const recorder = recorders[0]!;
    const lateData = recorder.ondataavailable;
    const lateStop = recorder.onstop;
    lateData?.({ data: new Blob(['incomplete']) });

    if (cause === 'recorder error') recorder.onerror?.();
    else if (cause === 'microphone loss') {
      streams[0]!.tracks[0]!.readyState = 'ended';
      streams[0]!.tracks[0]!.dispatchEvent(new Event('ended'));
    } else recorder.onstop?.();

    expect(streams[0]!.tracks.every(track => track.stopped)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    lateData?.({ data: new Blob(['late bytes']) });
    lateStop?.();
    expect(await session.stop()).toBeNull();
    session.cancel();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a failed stop and settles without retaining the microphone', async () => {
    const { globals, streams } = fakeGlobals({ stopThrows: true });
    const onError = vi.fn();
    const session = await browserVoiceCaptureFactory(globals)!(onError);
    expect(await session.stop()).toBeNull();
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('discards the final browser data when an error arrives after Stop', async () => {
    const { globals, recorders } = fakeGlobals({ deferStop: true });
    const onError = vi.fn();
    const session = await browserVoiceCaptureFactory(globals)!(onError);
    const recorder = recorders[0]!;
    const lateData = recorder.ondataavailable;
    const lateStop = recorder.onstop;
    const stopped = session.stop();
    recorder.onerror?.();
    lateData?.({ data: new Blob(['partial final data']) });
    lateStop?.();
    expect(await stopped).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('quietly discards a cancelled recording while Stop is still draining', async () => {
    const { globals, recorders, streams } = fakeGlobals({ deferStop: true });
    const onError = vi.fn();
    const session = await browserVoiceCaptureFactory(globals)!(onError);
    const lateData = recorders[0]!.ondataavailable;
    const lateStop = recorders[0]!.onstop;
    const stopped = session.stop();
    session.cancel();
    lateData?.({ data: new Blob(['discarded']) });
    lateStop?.();
    expect(await stopped).toBeNull();
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(onError).not.toHaveBeenCalled();
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
  it.each(['idle', 'opening', 'recording', 'stopped'] as const)(
    'discards every capture for one destination with its latest attempt %s', async latest => {
      const owner = { sessionId: null };
      const cancels: Array<ReturnType<typeof vi.fn>> = [];
      const finish: Array<(recording: VoiceRecording) => void> = [];
      const errors: Array<(() => void) | undefined> = [];
      let grant!: () => void;
      const onRecording = vi.fn();
      const composer = createVoiceComposer({
        recordingContext: () => owner,
        factory: async onError => {
          errors.push(onError);
          const cancel = vi.fn(); cancels.push(cancel);
          const capture = { stop: () => new Promise<VoiceRecording>(resolve => { finish.push(resolve); }), cancel };
          if (latest === 'opening' && cancels.length === 3) {
            return new Promise<VoiceCaptureSession>(resolve => { grant = () => resolve(capture); });
          }
          return capture;
        },
        onRecording, onChange: () => {},
      });
      try {
        for (let n = 0; n < 2; n++) { composer.toggle(); await tick(); composer.toggle(); }
        // An idle retired attempt must not hide stopped sessions from discard.
        composer.clearError();
        if (latest !== 'idle') { composer.toggle(); await tick(); }
        if (latest === 'stopped') composer.toggle();
        composer.cancel(context => context === owner);
        expect(composer.phase()).toBe('idle');
        expect(composer.hasPendingRecordings()).toBe(false);
        if (latest === 'opening') { grant(); await tick(); }
        for (const cancel of cancels) expect(cancel).toHaveBeenCalledTimes(1);
        for (const error of errors) error?.();
        for (const complete of finish) complete({ blob: new Blob(['voice']), filename: 'Discarded.webm', mime_type: 'audio/webm' });
        await tick();
        expect(onRecording).not.toHaveBeenCalled();
        expect(composer.error()).toBeNull();
      } finally { composer.destroy(); }
    },
  );

  it.each(['opening', 'recording', 'stopped'] as const)(
    'keeps another destination’s %s capture when discarding parked audio', async latest => {
      // Identity, rather than the mutable session id, distinguishes drafts.
      const discarded = { sessionId: null };
      const retained = { sessionId: null };
      let owner = discarded;
      const cancels: Array<ReturnType<typeof vi.fn>> = [];
      const finish: Array<(recording: VoiceRecording) => void> = [];
      const errors: Array<(() => void) | undefined> = [];
      let grant!: () => void;
      const onRecording = vi.fn();
      const composer = createVoiceComposer({
        recordingContext: () => owner,
        factory: async onError => {
          errors.push(onError);
          const cancel = vi.fn(); cancels.push(cancel);
          const capture = { stop: () => new Promise<VoiceRecording>(resolve => { finish.push(resolve); }), cancel };
          if (latest === 'opening' && cancels.length === 3) {
            return new Promise<VoiceCaptureSession>(resolve => { grant = () => resolve(capture); });
          }
          return capture;
        },
        onRecording, onChange: () => {},
      });
      try {
        for (let n = 0; n < 2; n++) { composer.toggle(); await tick(); composer.toggle(); }
        composer.clearError(); owner = retained;
        composer.toggle(); await tick();
        if (latest === 'stopped') composer.toggle();
        composer.cancel(context => context === discarded);
        expect(composer.phase()).toBe(latest === 'stopped' ? 'idle' : latest);
        expect(composer.hasPendingRecordings(context => context === discarded)).toBe(false);
        expect(cancels[0]).toHaveBeenCalledTimes(1);
        expect(cancels[1]).toHaveBeenCalledTimes(1);
        expect(cancels[2]).not.toHaveBeenCalled();
        for (const n of [0, 1]) {
          errors[n]?.(); finish[n]!({ blob: new Blob(['old']), filename: 'Old.webm', mime_type: 'audio/webm' });
        }
        await tick();
        expect(onRecording).not.toHaveBeenCalled();
        expect(composer.error()).toBeNull();
        if (latest === 'opening') { grant(); await tick(); }
        if (latest !== 'stopped') composer.toggle();
        finish[2]!({ blob: new Blob(['keep']), filename: 'Keep.webm', mime_type: 'audio/webm' }); await tick();
        expect(onRecording).toHaveBeenCalledTimes(1);
        expect(onRecording.mock.calls[0]?.[1]).toBe(retained);
        expect(cancels[2]).not.toHaveBeenCalled();
      } finally { composer.destroy(); }
    },
  );

  it.each(['audio', 'empty', 'reject', 'throw', 'attachment-error'] as const)(
    'protects a stopped capture through its %s handoff', async outcome => {
      let finish!: (recording: VoiceRecording | null) => void;
      let reject!: (error: Error) => void;
      const pendingChanges: boolean[] = [];
      const onRecording = vi.fn(() => {
        expect(composer.hasPendingRecordings()).toBe(true);
        if (outcome === 'attachment-error') throw new Error('Unable to attach audio');
      });
      const composer = createVoiceComposer({
        factory: async () => ({
          stop: () => {
            if (outcome === 'throw') throw new Error('Unable to stop');
            return new Promise<VoiceRecording | null>((resolve, fail) => { finish = resolve; reject = fail; });
          },
          cancel: vi.fn(),
        }),
        onRecording, onChange: () => { pendingChanges.push(composer.hasPendingRecordings()); },
      });
      try {
        expect(composer.hasPendingRecordings()).toBe(false);
        composer.toggle(); await tick(); composer.toggle();
        expect(composer.phase()).toBe('idle');
        // The idle repaint must already see the outstanding recording.
        expect(pendingChanges[2]).toBe(true);
        if (outcome !== 'throw') {
          expect(composer.hasPendingRecordings()).toBe(true);
          if (outcome === 'reject') reject(new Error('Unable to finish'));
          else finish(outcome === 'empty' ? null
            : { blob: new Blob(['voice']), filename: 'Note.webm', mime_type: 'audio/webm' });
        }
        await tick();
        expect(composer.hasPendingRecordings()).toBe(false);
        expect(pendingChanges.at(-1)).toBe(false);
        expect(onRecording).toHaveBeenCalledTimes(outcome === 'audio' || outcome === 'attachment-error' ? 1 : 0);
        expect(composer.error() !== null).toBe(!['audio', 'empty'].includes(outcome));
      } finally { composer.destroy(); }
    },
  );

  it('clears prior feedback and ignores that attempt while fresh failures still report', async () => {
    const errors: Array<(() => void) | undefined> = [];
    const capture = recordingSession();
    const onChange = vi.fn();
    const composer = createVoiceComposer({
      factory: async (onError?: () => void) => {
        errors.push(onError);
        if (errors.length === 1) throw Object.assign(new Error('refused'), { name: 'NotAllowedError' });
        return capture.session;
      },
      onRecording: vi.fn(), onChange,
    });
    composer.toggle(); await tick();
    expect(composer.error()).toContain('permission was refused');
    onChange.mockClear();
    composer.clearError();
    expect(composer.error()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    composer.clearError();
    errors[0]?.();
    expect(composer.error()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);

    composer.toggle(); await tick();
    errors[1]?.();
    expect(composer.error()).toContain('Try recording again');
    expect(capture.cancelled()).toBe(true);
    composer.destroy();
    onChange.mockClear(); composer.clearError();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears idle feedback without discarding audio still finishing for its original context', async () => {
    let owner = 'first';
    let finish!: (recording: VoiceRecording) => void;
    let reportError: (() => void) | undefined;
    const cancel = vi.fn();
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      recordingContext: () => owner,
      factory: async (onError?: () => void) => {
        reportError = onError;
        return {
          stop: () => new Promise<VoiceRecording>(resolve => { finish = resolve; }), cancel,
        };
      },
      onRecording, onChange: () => {},
    });
    composer.toggle(); await tick(); composer.toggle();
    composer.clearError(); owner = 'second';
    reportError?.();
    expect(composer.error()).toBeNull();
    finish({ blob: new Blob(['voice']), filename: 'First.webm', mime_type: 'audio/webm' });
    await tick();
    expect(onRecording).toHaveBeenCalledTimes(1);
    expect(onRecording.mock.calls[0]?.[0].name).toBe('First.webm');
    expect(onRecording.mock.calls[0]?.[1]).toBe('first');
    expect(cancel).not.toHaveBeenCalled();
    composer.destroy();
  });

  it('cleans up a late failed Stop without reviving cleared feedback', async () => {
    let rejectStop!: (error: Error) => void;
    const cancel = vi.fn();
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      factory: async () => ({
        stop: () => new Promise<VoiceRecording>((_resolve, reject) => { rejectStop = reject; }), cancel,
      }),
      onRecording, onChange: () => {},
    });
    composer.toggle(); await tick(); composer.toggle();
    composer.clearError();
    rejectStop(new Error('old recorder failed')); await tick();
    expect(composer.phase()).toBe('idle');
    expect(composer.error()).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onRecording).not.toHaveBeenCalled();
    composer.destroy();
  });

  it.each(['opening', 'recording'] as const)('keeps the current capture valid when clearing feedback during %s', async (phase) => {
    let open!: (capture: VoiceCaptureSession) => void;
    let reportError: (() => void) | undefined;
    const capture = recordingSession();
    const composer = createVoiceComposer({
      factory: (onError?: () => void) => {
        reportError = onError;
        return new Promise(resolve => { open = resolve; });
      },
      onRecording: vi.fn(), onChange: () => {},
    });
    composer.toggle();
    if (phase === 'recording') { open(capture.session); await tick(); }
    expect(composer.phase()).toBe(phase);
    composer.clearError();
    if (phase === 'opening') { open(capture.session); await tick(); }
    expect(composer.phase()).toBe('recording');
    expect(capture.cancelled()).toBe(false);
    reportError?.();
    expect(composer.phase()).toBe('idle');
    expect(composer.error()).toContain('Try recording again');
    expect(capture.cancelled()).toBe(true);
    composer.destroy();
  });

  it('shows an interruption, clears its timer and permits a successful retry', async () => {
    const { globals, recorders, streams } = fakeGlobals();
    const onRecording = vi.fn();
    const clearTimer = vi.fn();
    const composer = createVoiceComposer({
      factory: browserVoiceCaptureFactory(globals)!, onRecording, onChange: () => {},
      setTimer: () => 1, clearTimer,
    });
    composer.toggle(); await tick();
    recorders[0]!.onerror?.();
    await tick();
    expect(composer.phase()).toBe('idle');
    expect(composer.error()).toContain('Try recording again');
    expect(clearTimer).toHaveBeenCalledWith(1);
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(onRecording).not.toHaveBeenCalled();

    composer.toggle(); await tick();
    expect(composer.phase()).toBe('recording');
    expect(composer.error()).toBeNull();
    composer.toggle(); await tick();
    expect(onRecording).toHaveBeenCalledTimes(1);
    composer.destroy();
  });

  it.each(['throw', 'reject'])('surfaces a stop that fails by %s', async (failure) => {
    const cancel = vi.fn();
    const composer = createVoiceComposer({
      factory: async () => ({
        stop: () => {
          if (failure === 'throw') throw new Error('stop failed');
          return Promise.reject(new Error('stop failed'));
        },
        cancel,
      }),
      onRecording: vi.fn(), onChange: () => {},
    });
    composer.toggle(); await tick();
    composer.toggle(); await tick();
    expect(composer.phase()).toBe('idle');
    expect(composer.error()).toContain('Try recording again');
    expect(cancel).toHaveBeenCalledTimes(1);
    composer.destroy();
  });

  it('does not let a discarded capture report an error against its replacement', async () => {
    const errors: Array<(() => void) | undefined> = [];
    const captures = [recordingSession(), recordingSession()];
    const composer = createVoiceComposer({
      factory: async (onError?: () => void) => {
        errors.push(onError);
        return captures[errors.length - 1]!.session;
      },
      onRecording: vi.fn(), onChange: () => {},
    });
    composer.toggle(); await tick(); composer.cancel();
    composer.toggle(); await tick();
    errors[0]?.();
    expect(composer.phase()).toBe('recording');
    expect(composer.error()).toBeNull();
    expect(captures[1]!.cancelled()).toBe(false);
    composer.destroy();
    errors[1]?.();
    expect(composer.error()).toBeNull();
  });

  it('cancels a capture that opens after reporting an interruption', async () => {
    const capture = recordingSession();
    let reportError: (() => void) | undefined;
    let open!: (session: VoiceCaptureSession) => void;
    const composer = createVoiceComposer({
      factory: (onError?: () => void) => {
        reportError = onError;
        return new Promise(resolve => { open = resolve; });
      },
      onRecording: vi.fn(), onChange: () => {},
    });
    composer.toggle();
    reportError?.();
    open(capture.session); await tick();
    expect(composer.phase()).toBe('idle');
    expect(composer.error()).toContain('Try recording again');
    expect(capture.cancelled()).toBe(true);
    composer.destroy();
  });

  it('does not let an older failed Stop interrupt a new recording', async () => {
    let rejectStop!: (error: Error) => void;
    const cancel = vi.fn();
    const capture = recordingSession();
    const factory = vi.fn()
      .mockResolvedValueOnce({
        stop: () => new Promise<VoiceRecording>((_resolve, reject) => { rejectStop = reject; }),
        cancel,
      })
      .mockResolvedValueOnce(capture.session);
    const composer = createVoiceComposer({ factory, onRecording: vi.fn(), onChange: () => {} });
    composer.toggle(); await tick(); composer.toggle();
    composer.toggle(); await tick();
    rejectStop(new Error('old recorder failed')); await tick();
    expect(composer.phase()).toBe('recording');
    expect(composer.error()).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(capture.cancelled()).toBe(false);
    composer.destroy();
  });

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

  it.each([
    { cancelPhase: 'opening', sameDraft: true },
    { cancelPhase: 'recording', sameDraft: true },
    { cancelPhase: 'stopped', sameDraft: true },
    { cancelPhase: 'opening', sameDraft: false },
    { cancelPhase: 'recording', sameDraft: false },
    { cancelPhase: 'stopped', sameDraft: false },
  ] as const)('keeps earlier audio when cancelling a newer $cancelPhase attempt, sameDraft=$sameDraft', async ({ cancelPhase, sameDraft }) => {
    let owner = 'a';
    let attempts = 0;
    let finishEarlier!: (recording: VoiceRecording) => void;
    let finishLater!: (recording: VoiceRecording) => void;
    let openLater!: (session: VoiceCaptureSession) => void;
    const cancelEarlier = vi.fn();
    const cancelLater = vi.fn();
    const later: VoiceCaptureSession = {
      stop: () => new Promise(resolve => { finishLater = resolve; }), cancel: cancelLater,
    };
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      recordingContext: () => owner,
      factory: () => ++attempts === 1
        ? Promise.resolve({ stop: () => new Promise<VoiceRecording>(resolve => { finishEarlier = resolve; }), cancel: cancelEarlier })
        : new Promise<VoiceCaptureSession>(resolve => { openLater = resolve; }),
      onRecording, onChange: () => {},
    });
    composer.toggle(); await tick(); composer.toggle();
    if (!sameDraft) { composer.clearError(); owner = 'b'; }
    composer.toggle();
    if (cancelPhase !== 'opening') { openLater(later); await tick(); }
    if (cancelPhase === 'stopped') composer.toggle();
    composer.cancel();
    if (cancelPhase === 'opening') openLater(later);
    if (cancelPhase === 'stopped') {
      finishLater({ blob: new Blob(['later']), filename: 'Later.webm', mime_type: 'audio/webm' });
    }
    finishEarlier({ blob: new Blob(['earlier']), filename: 'Earlier.webm', mime_type: 'audio/webm' });
    await tick();
    expect(onRecording).toHaveBeenCalledTimes(1);
    expect(onRecording.mock.calls[0]?.[0].name).toBe('Earlier.webm');
    expect(onRecording.mock.calls[0]?.[1]).toBe('a');
    expect(cancelEarlier).not.toHaveBeenCalled();
    expect(cancelLater).toHaveBeenCalledTimes(1);
    expect(composer.phase()).toBe('idle');
    expect(composer.error()).toBeNull();
    composer.destroy();
  });

  it('keeps retired audio when the next draft is discarded without another capture', async () => {
    let owner = 'a';
    let finish!: (recording: VoiceRecording) => void;
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      recordingContext: () => owner,
      factory: async () => ({ stop: () => new Promise<VoiceRecording>(resolve => { finish = resolve; }), cancel: () => {} }),
      onRecording, onChange: () => {},
    });
    composer.toggle(); await tick(); composer.toggle();
    composer.clearError(); owner = 'b'; composer.cancel();
    finish({ blob: new Blob(['earlier']), filename: 'Earlier.webm', mime_type: 'audio/webm' });
    await tick();
    expect(onRecording).toHaveBeenCalledTimes(1);
    expect(onRecording.mock.calls[0]?.[1]).toBe('a');
    composer.destroy();
  });

  it('drops all pending stopped recordings after destruction', async () => {
    const finish: Array<(recording: VoiceRecording) => void> = [];
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const onRecording = vi.fn();
    const onChange = vi.fn();
    const composer = createVoiceComposer({
      factory: async () => {
        const cancel = vi.fn(); cancels.push(cancel);
        return { stop: () => new Promise<VoiceRecording>(resolve => { finish.push(resolve); }), cancel };
      },
      onRecording, onChange,
    });
    composer.toggle(); await tick(); composer.toggle();
    composer.toggle(); await tick(); composer.toggle();
    composer.toggle(); await tick();
    expect(composer.hasPendingRecordings()).toBe(true);
    composer.destroy();
    expect(composer.hasPendingRecordings()).toBe(false);
    expect(cancels).toHaveLength(3);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledTimes(1);
    onChange.mockClear();
    for (const complete of finish) complete({ blob: new Blob(['voice']), filename: 'Discarded.webm', mime_type: 'audio/webm' });
    await tick();
    expect(onRecording).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not attach a stopped recording after its draft was explicitly discarded', async () => {
    let finish!: (recording: VoiceRecording) => void;
    const recording = new Promise<VoiceRecording>(resolve => { finish = resolve; });
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      factory: async () => ({ stop: () => recording, cancel: () => {} }),
      onRecording, onChange: () => {},
    });
    composer.toggle(); await tick();
    composer.toggle();
    composer.cancel();
    finish({ blob: new Blob(['voice']), filename: 'Discarded.webm', mime_type: 'audio/webm' });
    await tick();
    expect(onRecording).not.toHaveBeenCalled();
    composer.destroy();
  });

  it('keeps each recording destination when two stopped recordings finish in reverse order', async () => {
    let owner = 'first';
    const finish: Array<(recording: VoiceRecording) => void> = [];
    const onRecording = vi.fn();
    const composer = createVoiceComposer({
      recordingContext: () => owner,
      factory: async () => ({
        stop: () => new Promise<VoiceRecording>(resolve => { finish.push(resolve); }),
        cancel: () => {},
      }),
      onRecording, onChange: () => {},
    });
    composer.toggle(); await tick(); composer.toggle();
    owner = 'second';
    composer.toggle(); await tick(); composer.toggle();
    expect(composer.hasPendingRecordings(context => context === 'first')).toBe(true);
    expect(composer.hasPendingRecordings(context => context === 'second')).toBe(true);
    expect(composer.hasPendingRecordings(context => context === 'other')).toBe(false);
    finish[1]!({ blob: new Blob(['second']), filename: 'Second.webm', mime_type: 'audio/webm' });
    await tick();
    expect(composer.hasPendingRecordings(context => context === 'first')).toBe(true);
    expect(composer.hasPendingRecordings(context => context === 'second')).toBe(false);
    finish[0]!({ blob: new Blob(['first']), filename: 'First.webm', mime_type: 'audio/webm' });
    await tick();
    expect(composer.hasPendingRecordings()).toBe(false);
    expect(onRecording.mock.calls.map(([file, context]) => [file.name, context])).toEqual([
      ['Second.webm', 'second'], ['First.webm', 'first'],
    ]);
    composer.destroy();
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

  it('releases a microphone granted after its pending request was cancelled', async () => {
    const { globals } = fakeGlobals();
    const made = makeStream();
    let allow!: (stream: MediaStream) => void;
    globals.mediaDevices!.getUserMedia = () => new Promise(resolve => { allow = resolve; });
    const onRecording = vi.fn();
    const setTimer = vi.fn();
    const composer = createVoiceComposer({
      factory: browserVoiceCaptureFactory(globals)!, onRecording, setTimer, onChange: () => {},
    });
    composer.toggle();
    expect(composer.phase()).toBe('opening');
    composer.cancel();
    allow(made.stream); await tick();
    expect(made.tracks[0]!.stopped).toBe(true);
    expect(composer.phase()).toBe('idle');
    expect(composer.error()).toBeNull();
    expect(setTimer).not.toHaveBeenCalled();
    expect(onRecording).not.toHaveBeenCalled();
    composer.destroy();
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
  const globalsThatFail = (where: 'construct' | 'start') => {
    const made = makeStream();
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
