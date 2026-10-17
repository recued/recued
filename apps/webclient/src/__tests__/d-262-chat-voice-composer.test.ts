/** D-262 § 5 — the chat composer's press-to-talk, driven through the real
 *  route.
 *
 *  ⛔ THE POINT OF DRIVING THE ROUTE RATHER THAN THE MODULE: the interesting
 *  behaviour is a JOIN. `voice-capture.ts` knows nothing about uploads and
 *  `composer-attachments.ts` knows nothing about voice; what makes a spoken
 *  note reach `chat.send` as an empty message with one voice attachment is the
 *  wiring between them, and a unit test on either side proves nothing about it.
 *
 *  The webclient has no jsdom, so this rolls the same small fake document the
 *  other composer tests use, and fakes the upload engine at the seam
 *  `composer-attachments.test.ts` already fakes it at.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ChatSession } from '@recued/contracts';

import {
  bootstrapChatRoute,
  CHAT_ROUTE_INPUT_ATTR,
  CHAT_ROUTE_VOICE_ATTR,
  CHAT_ROUTE_VOICE_ERROR_ATTR,
  CHAT_ROUTE_ATTACH_INPUT_ATTR,
  CHAT_ROUTE_SEND_ATTR,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';
import type { VoiceCaptureFactory, VoiceCaptureSession } from '../chat/voice-capture.js';

// ── fake DOM ──────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  value: string;
  open: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  click(): void;
  fire(type: string): void;
  focus(): void;
}

const matchAttr = (sel: string): string | null =>
  sel.match(/^\[([\w-]+)\]$/)?.[1] ?? null;

const makeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    value: '',
    open: false,
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() { return el.children[0] ?? null; },
    setAttribute: (k, v) => el.attrs.set(k, v),
    getAttribute: (k) => el.attrs.get(k) ?? null,
    hasAttribute: (k) => el.attrs.has(k),
    removeAttribute: (k) => el.attrs.delete(k),
    appendChild: (c) => { c.parent = el; el.children.push(c); return c; },
    removeChild: (c) => {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    remove: () => {
      if (el.parent === null) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener: (t, fn) => {
      const list = el.listeners.get(t) ?? [];
      list.push(fn);
      el.listeners.set(t, list);
    },
    removeEventListener: (t, fn) => {
      const list = el.listeners.get(t);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel) => {
      const attr = matchAttr(sel);
      if (attr === null) return [];
      const out: FakeEl[] = [];
      const walk = (n: FakeEl): void => {
        for (const c of n.children) {
          if (c.attrs.has(attr)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    click: () => {
      if (el.disabled) return;
      for (const fn of [...(el.listeners.get('click') ?? [])]) fn({ target: el });
    },
    fire: (type) => {
      for (const fn of [...(el.listeners.get(type) ?? [])]) fn({ target: el });
    },
    focus: () => undefined,
  };
  return el;
};

const makeDoc = () => {
  const styles: FakeEl[] = [];
  const create = (tag: string): FakeEl => makeEl(tag);
  const body = create('body');
  return {
    body,
    activeElement: null as FakeEl | null,
    styles,
    head: {
      querySelector(sel: string) {
        const attr = sel.match(/^style\[([\w-]+)\]$/)?.[1];
        if (attr === undefined) return null;
        return styles.find((s) => s.attrs.has(attr)) ?? null;
      },
      appendChild(el: FakeEl) { styles.push(el); return el; },
    },
    createElement: create,
    // `renderAnswerText` paints a formatted reply from text nodes plus <strong>
    // (b41c8e0cd). A double is a closed list: without this, any reply with
    // **bold** threw here and the turn never reached the speaker. This fake has
    // no Text type, so a text node is a bare element carrying its text.
    createTextNode: (text: string): FakeEl => {
      const node = create('#text');
      node.textContent = text;
      return node;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
};

const collectByAttr = (root: FakeEl, attr: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl): void => {
    if (n.attrs.has(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── the fake upload engine, at the same seam the P2 test uses ─────

const withFakeEngine = async () => {
  const uiShared = await import('@recued/ui-shared');
  const engines: Array<{
    started: File | null;
    listener: ((p: Record<string, unknown>) => void) | null;
  }> = [];
  const createSpy = vi
    .spyOn(uiShared.Upload, 'createUploadEngine')
    .mockImplementation(() => {
      const rec = { started: null as File | null, listener: null as never };
      engines.push(rec as never);
      return {
        start: (f: File) => { (rec as { started: unknown }).started = f; },
        cancel: () => {},
        on: (_e: string, l: (p: Record<string, unknown>) => void) => {
          (rec as { listener: unknown }).listener = l;
          return () => {};
        },
        destroy: () => {},
      } as never;
    });
  const transportSpy = vi
    .spyOn(uiShared.Upload, 'createWsUploadTransport')
    .mockImplementation(() => ({}) as never);
  return {
    engines,
    restore: () => { createSpy.mockRestore(); transportSpy.mockRestore(); },
  };
};

// ── the route ─────────────────────────────────────────────────────

const chatSession = (): ChatSession => ({
  id: 'chat_1',
  title: 'Ops chat',
  created_at: 1_000,
  last_active_at: 2_000,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: {
    current: 'byok', provider: 'local', model_id: 'local-default', overridden: false,
  },
} as unknown as ChatSession);

const chatMessage = (): ChatMessage => ({
  id: 'msg_1', session_id: 'chat_1', role: 'assistant', content: 'Hi', ts: 2_000,
} as unknown as ChatMessage);

/** A broadcast seam a test can push events through, matching the shape the
 *  route's `subscribe` option expects. */
const makeSubscriber = () => {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const on = ((kind: string, fn: (e: unknown) => void) => {
    const list = handlers.get(kind) ?? [];
    list.push(fn);
    handlers.set(kind, list);
    return () => {};
  }) as never;
  const emit = (kind: string, event: Record<string, unknown>): void => {
    for (const fn of handlers.get(kind) ?? []) fn({ kind, ...event });
  };
  return { on, emit };
};

const makeConn = (
  transcriptionConfigured = true,
  prefs: Record<string, unknown> = {},
  // ⚠ OFF by default so every existing case keeps the shape it was written
  // against. The auto-send tests never press Send — `settleVoiceSend` calls
  // `sendMessage` directly — so they never noticed the button is disabled
  // without a chat model. A test that drives the BUTTON needs one.
  chatConfigured = false,
  sendAck?: Promise<{ turn_id: string }>,
) => {
  const calls: Array<{ method: string; args: unknown }> = [];
  const conn = ((method: string, args: unknown) => {
    calls.push({ method, args });
    if (method === 'chat.sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'chat.session.create') return Promise.resolve({ session_id: 'chat_1' });
    // D-262 § B8 — the mic renders only when the server reports a COMPLETE
    // transcription source, so every mic case needs one configured.
    if (method === 'server.getLLMConfig') {
      return Promise.resolve({
        config: {
          ...(transcriptionConfigured
            ? {
                transcription_slot: {
                  provider: 'openai', model: 'whisper-1', has_key: true,
                },
              }
            : {}),
          ...(chatConfigured
            ? { slot_1: { provider: 'openai', model: 'gpt-4.1-mini', has_key: true } }
            : {}),
        },
      });
    }
    if (method === 'prefs.get') return Promise.resolve({ prefs });
    if (method === 'chat.session.get') {
      return Promise.resolve({ ...chatSession(), messages: [chatMessage()] });
    }
    if (method === 'chat.send') return sendAck ?? Promise.resolve({ turn_id: 'turn_1' });
    return Promise.resolve({});
  }) as unknown as ChatRouteConn;
  return { conn, calls, sends: () => calls.filter((c) => c.method === 'chat.send') };
};

/** A capture session under the test's control: `release()` completes the
 *  recording the way a real `MediaRecorder.onstop` would. */
const controllableCapture = () => {
  let cancelled = false;
  const session: VoiceCaptureSession = {
    stop: async () => ({
      blob: new Blob(['opus']),
      mime_type: 'audio/webm',
      filename: 'voice-note-20300402-101530.webm',
    }),
    cancel: () => { cancelled = true; },
  };
  return { session, cancelled: () => cancelled };
};

const mount = (
  voiceCapture: VoiceCaptureFactory,
  transcriptionConfigured = true,
  extra: {
    prefs?: Record<string, unknown>;
    voiceSpeaker?: { speak(t: string): void; cancel(): void } | null;
    /** Configure a chat slot too, so the Send button is not disabled. */
    chatConfigured?: boolean;
    sendAck?: Promise<{ turn_id: string }>;
  } = {},
) => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  const { conn, sends } = makeConn(
    transcriptionConfigured, extra.prefs ?? {}, extra.chatConfigured ?? false, extra.sendAck,
  );
  const subscriber = makeSubscriber();
  const route = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn,
    uploadCallers: {} as never,
    uploadConnect: {} as never,
    voiceCapture,
    subscribe: subscriber.on,
    ...(extra.voiceSpeaker !== undefined ? { voiceSpeaker: extra.voiceSpeaker } : {}),
  } as never);
  return { doc, root, route, sends, emit: subscriber.emit };
};

/** Drive a recording all the way to a sent turn. */
const speakAndFinalize = async (
  root: FakeEl,
  engines: Array<{ started: File | null; listener: ((p: Record<string, unknown>) => void) | null }>,
): Promise<void> => {
  micButton(root)?.click();
  await tick();
  micButton(root)?.click();
  await tick();
  engines[0]?.listener?.({ sent: 10, total: 10, recordId: 'file:voice1' });
  await tick();
};

const micButtons = (root: FakeEl): FakeEl[] =>
  collectByAttr(root, CHAT_ROUTE_VOICE_ATTR);
const micButton = (root: FakeEl): FakeEl | undefined =>
  micButtons(root).find((b) => b.getAttribute(CHAT_ROUTE_VOICE_ATTR) !== 'discard');
const sendButton = (root: FakeEl): FakeEl | undefined =>
  collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0];

describe('D-262 § 5 — press-to-talk in the chat composer', () => {
  it('does NOT render the control when this context cannot record', async () => {
    const { root, route } = mount(null);
    await tick();
    // The control's presence IS the capability answer. A mic that appears and
    // then fails cannot be told apart from a broken microphone.
    expect(micButtons(root)).toHaveLength(0);
    route.dispose();
  });

  it('⛔ does NOT render the control when the server has no transcription slot', async () => {
    const { session } = controllableCapture();
    const { root, route } = mount(async () => session, false);
    await tick();
    // D-262 § B8 — the browser can record; the SERVER cannot hear. Offering the
    // mic here would let someone speak into a turn that can only answer "I
    // couldn't transcribe that", which is a worse first experience than a
    // control that was never offered.
    expect(micButtons(root)).toHaveLength(0);
    route.dispose();
  });

  it('renders the control, and its NAME says what the next press does', async () => {
    const { session } = controllableCapture();
    const { root, route } = mount(async () => session);
    await tick();

    const mic = micButton(root);
    expect(mic).toBeDefined();
    expect(mic?.getAttribute('aria-label')).toBe('Record a voice note');
    expect(mic?.getAttribute('aria-pressed')).toBe('false');

    mic?.click();
    await tick();
    const live = micButton(root);
    expect(live?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('recording');
    // A button still reading "Record a voice note" while recording tells a
    // screen reader the opposite of what it now does.
    expect(live?.getAttribute('aria-label')).toBe('Stop recording and send');
    expect(live?.getAttribute('aria-pressed')).toBe('true');
    route.dispose();
  });

  it('offers Cancel while opening and Discard while recording', async () => {
    const capture = controllableCapture();
    let open!: (session: VoiceCaptureSession) => void;
    const { root, route } = mount(() => new Promise(resolve => { open = resolve; }));
    await tick();
    expect(micButtons(root).some((b) => b.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard'))
      .toBe(false);

    micButton(root)?.click();
    expect(micButtons(root).find((b) => b.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard')?.getAttribute('aria-label'))
      .toBe('Cancel recording request');
    open(capture.session);
    await tick();
    const discard = micButtons(root)
      .find((b) => b.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard');
    expect(discard?.getAttribute('aria-label')).toBe('Discard recording');
    discard?.click();
    expect(capture.cancelled()).toBe(true);
    expect(micButtons(root).some((b) => b.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard')).toBe(false);
    route.dispose();
  });

  it.each(['cancel', 'refuse'] as const)('guards an empty composer during a microphone request until %s', async outcome => {
    const capture = controllableCapture();
    let allow!: (session: VoiceCaptureSession) => void;
    let refuse!: (error: Error) => void;
    const { root, route } = mount(() => new Promise((resolve, reject) => { allow = resolve; refuse = reject; }));
    try {
      await tick();
      expect(route.hasUnsavedChanges()).toBe(false);
      expect(route.unsavedChangesPrompt()).toBeNull();
      micButton(root)?.click();
      expect(route.hasUnsavedChanges()).toBe(true);
      expect(route.unsavedChangesPrompt()).toBe('Cancel this microphone request and leave Chat?');
      if (outcome === 'cancel') {
        micButtons(root).find(button => button.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard')!.click();
        allow(capture.session);
      } else refuse(Object.assign(new Error('Microphone refused'), { name: 'NotAllowedError' }));
      await tick();
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('idle');
      expect(route.hasUnsavedChanges()).toBe(false);
      expect(route.unsavedChangesPrompt()).toBeNull();
      expect(capture.cancelled()).toBe(outcome === 'cancel');
    } finally { route.dispose(); }
  });

  it.each(['discard', 'interrupt', 'empty-stop'] as const)('guards an empty composer while recording and clears after %s', async outcome => {
    const capture = controllableCapture();
    let interrupt: (() => void) | undefined;
    const { root, route } = mount(async onError => {
      interrupt = onError;
      return outcome === 'empty-stop' ? { ...capture.session, stop: async () => null } : capture.session;
    });
    try {
      await tick(); micButton(root)?.click(); await tick();
      expect(route.hasUnsavedChanges()).toBe(true);
      expect(route.unsavedChangesPrompt()).toBe('Discard this voice recording and leave Chat?');
      if (outcome === 'discard') micButtons(root).find(button => button.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard')!.click();
      else if (outcome === 'interrupt') interrupt?.();
      else micButton(root)?.click();
      await tick();
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('idle');
      expect(route.hasUnsavedChanges()).toBe(false);
      expect(route.unsavedChangesPrompt()).toBeNull();
    } finally { route.dispose(); }
  });

  it('keeps the typed draft protected after its recording is discarded', async () => {
    const capture = controllableCapture();
    const { root, route } = mount(async () => capture.session);
    try {
      await tick(); micButton(root)?.click(); await tick();
      const text = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
      text.value = 'Keep the typed draft'; text.fire('input');
      expect(route.unsavedChangesPrompt()).toBe('Discard this voice recording and leave Chat?');
      micButtons(root).find(button => button.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard')!.click();
      expect(route.hasUnsavedChanges()).toBe(true);
      expect(route.unsavedChangesPrompt()).toBeNull();
      expect(route.getRecoveryDraft()?.text).toBe('Keep the typed draft');
    } finally { route.dispose(); }
  });

  it('hands leave protection from recording to its retained audio attachment', async () => {
    const { engines, restore } = await withFakeEngine();
    const capture = controllableCapture();
    let finish!: (recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void;
    const stop = () => new Promise<Awaited<ReturnType<VoiceCaptureSession['stop']>>>(resolve => { finish = resolve; });
    const { root, route, sends } = mount(async () => ({ ...capture.session, stop }), true, {
      chatConfigured: true, prefs: { 'ui.voice.auto_send': false },
    });
    try {
      await tick(); micButton(root)?.click(); await tick();
      expect(route.unsavedChangesPrompt()).toBe('Discard this voice recording and leave Chat?');
      micButton(root)?.click(); await tick();
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('idle');
      expect(engines).toHaveLength(0);
      expect(route.hasUnsavedChanges()).toBe(true);
      expect(route.unsavedChangesPrompt()).toBe('Discard unfinished voice notes and leave Chat?');
      finish(await capture.session.stop()); await tick();
      expect(route.hasUnsavedChanges()).toBe(true);
      expect(route.unsavedChangesPrompt()).toBeNull();
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:retained-note' }); await tick();
      expect(route.hasUnsavedChanges()).toBe(true);
      expect(sends()).toHaveLength(0);
      sendButton(root)?.click(); await tick();
      expect(sends()).toHaveLength(1);
      await vi.waitFor(() => expect(route.hasUnsavedChanges()).toBe(false));
      expect(route.unsavedChangesPrompt()).toBeNull();
    } finally { route.dispose(); restore(); }
  });

  it.each(['empty', 'failure'] as const)('clears finishing-recording leave protection after %s', async outcome => {
    let finish!: (recording: null) => void;
    let fail!: (error: Error) => void;
    const { root, route } = mount(async () => ({
      stop: () => new Promise<null>((resolve, reject) => { finish = resolve; fail = reject; }), cancel: vi.fn(),
    }));
    try {
      await tick(); micButton(root)?.click(); await tick(); micButton(root)?.click();
      expect(route.hasUnsavedChanges()).toBe(true);
      expect(route.unsavedChangesPrompt()).toBe('Discard unfinished voice notes and leave Chat?');
      if (outcome === 'empty') finish(null); else fail(new Error('Unable to finish recording'));
      await tick();
      expect(route.hasUnsavedChanges()).toBe(false);
      expect(route.unsavedChangesPrompt()).toBeNull();
      expect(collectByAttr(root, CHAT_ROUTE_VOICE_ERROR_ATTR)).toHaveLength(outcome === 'failure' ? 1 : 0);
    } finally { route.dispose(); }
  });

  it.each(['opening', 'recording', 'finishing'] as const)('confirms New chat and discards a text-free %s capture', async phase => {
    const { engines, restore } = await withFakeEngine();
    const capture = controllableCapture();
    let allow!: () => void;
    let finish!: (recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void;
    let reportError: (() => void) | undefined;
    const { root, route, sends } = mount(onError => {
      reportError = onError;
      return new Promise(resolve => { allow = () => resolve({ ...capture.session,
        stop: () => new Promise(resolve => { finish = resolve; }),
      }); });
    }, true, { chatConfigured: true, prefs: { 'ui.voice.auto_send': false } });
    try {
      await route.whenLoaded();
      route.startNewChat();
      expect(collectByAttr(root, 'data-recued-chat-route-history-draft-guard')).toHaveLength(0);
      micButton(root)?.click();
      if (phase !== 'opening') { allow(); await tick(); }
      if (phase === 'finishing') micButton(root)?.click();
      expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
      expect(engines).toHaveLength(0);
      route.startNewChat();
      const guard = collectByAttr(root, 'data-recued-chat-route-history-draft-guard')[0]!;
      expect(guard).toBeDefined();
      guard.children.flatMap(child => child.children)
        .find(button => button.textContent === 'Throw it away and start a new one')!.click();
      if (phase === 'opening') allow();
      if (phase === 'finishing') finish(await capture.session.stop());
      reportError?.(); await tick();
      expect(capture.cancelled()).toBe(true);
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('idle');
      expect(collectByAttr(root, 'data-recued-chat-route-history-draft-guard')).toHaveLength(0);
      expect(collectByAttr(root, CHAT_ROUTE_VOICE_ERROR_ATTR)).toHaveLength(0);
      expect(route.hasUnsavedChanges()).toBe(false);
      expect(route.getRecoveryDraft()).toBeNull();
      expect(engines).toHaveLength(0); expect(sends()).toHaveLength(0);
    } finally { route.dispose(); restore(); }
  });

  it('keeps finishing notes when New chat is declined without any typed draft', async () => {
    const { engines, restore } = await withFakeEngine();
    const finish: Array<(recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void> = [];
    const cancel = vi.fn();
    const { root, route, sends } = mount(async () => ({
      stop: () => new Promise(resolve => { finish.push(resolve); }), cancel,
    }), true, { chatConfigured: true, prefs: { 'ui.voice.auto_send': false } });
    try {
      await route.whenLoaded();
      for (let n = 0; n < 2; n++) { micButton(root)?.click(); await tick(); micButton(root)?.click(); }
      route.startNewChat();
      const guard = collectByAttr(root, 'data-recued-chat-route-history-draft-guard')[0]!;
      expect(guard).toBeDefined();
      guard.children.flatMap(child => child.children).find(button => button.textContent === 'Keep writing')!.click();
      expect(route.hasUnsavedChanges()).toBe(true); expect(cancel).not.toHaveBeenCalled();
      for (const complete of finish) complete(await controllableCapture().session.stop()); await tick();
      expect(engines).toHaveLength(2);
      engines.forEach((engine, n) => engine.listener?.({ sent: 10, total: 10, recordId: `file:kept-${n}` })); await tick();
      expect(route.getRecoveryDraft()?.attachments).toHaveLength(2);
      expect(sends()).toHaveLength(0);
      expect(collectByAttr(root, 'data-recued-chat-route-history-draft-guard')).toHaveLength(0);
    } finally { route.dispose(); restore(); }
  });

  it.each(['keep', 'discard'] as const)('waits for New chat confirmation before %s when voice upload finishes', async choice => {
    const { engines, restore } = await withFakeEngine();
    let finish!: (recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void;
    const { root, route, sends } = mount(async () => ({
      stop: () => new Promise(resolve => { finish = resolve; }), cancel: vi.fn(),
    }), true, { chatConfigured: true, prefs: { 'ui.voice.auto_send': true } });
    try {
      await route.whenLoaded(); micButton(root)?.click(); await tick(); micButton(root)?.click();
      route.startNewChat();
      expect(collectByAttr(root, 'data-recued-chat-route-history-draft-guard')).toHaveLength(1);
      finish(await controllableCapture().session.stop()); await tick();
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:finished-during-confirmation' }); await tick();
      expect(sends()).toHaveLength(0);
      expect(route.getThread().session).toBeNull();
      const guard = collectByAttr(root, 'data-recued-chat-route-history-draft-guard')[0]!;
      const label = choice === 'keep' ? 'Keep writing' : 'Throw it away and start a new one';
      guard.children.flatMap(child => child.children).find(button => button.textContent === label)!.click();
      await vi.waitFor(() => expect(sends()).toHaveLength(choice === 'keep' ? 1 : 0));
      await vi.waitFor(() => expect(route.hasUnsavedChanges()).toBe(false));
      expect(collectByAttr(root, 'data-recued-chat-route-history-draft-guard')).toHaveLength(0);
      if (choice === 'discard') expect(route.getThread().session).toBeNull();
    } finally { route.dispose(); restore(); }
  });

  it('keeps a mixed draft for explicit Send after its extra file is removed during New chat confirmation', async () => {
    const { engines, restore } = await withFakeEngine();
    let finish!: (recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void;
    const { root, route, sends } = mount(async () => ({
      stop: () => new Promise(resolve => { finish = resolve; }), cancel: vi.fn(),
    }), true, { chatConfigured: true, prefs: { 'ui.voice.auto_send': true } });
    try {
      await route.whenLoaded();
      const picker = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!;
      Object.defineProperty(picker, 'files', { value: [new File(['pdf'], 'Other.pdf', { type: 'application/pdf' })] });
      picker.fire('change');
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:other' }); await tick();
      micButton(root)?.click(); await tick(); micButton(root)?.click();
      route.startNewChat();
      finish(await controllableCapture().session.stop()); await tick();
      engines[1]!.listener?.({ sent: 10, total: 10, recordId: 'file:voice' }); await tick();
      collectByAttr(root, 'data-recued-chat-route-attachment-remove')
        .find(button => button.getAttribute('aria-label') === 'Remove Other.pdf')!.click();
      const guard = collectByAttr(root, 'data-recued-chat-route-history-draft-guard')[0]!;
      guard.children.flatMap(child => child.children).find(button => button.textContent === 'Keep writing')!.click();
      expect(sendButton(root)?.disabled).toBe(false);
      await tick();
      expect(sends()).toHaveLength(0);
      expect(route.getThread().session).toBeNull();
      expect(route.getRecoveryDraft()?.attachments).toHaveLength(1);
      expect(route.hasUnsavedChanges()).toBe(true);
    } finally { route.dispose(); restore(); }
  });

  it('restores parked finishing audio without asking to discard it before guarding its reset', async () => {
    const { engines, restore } = await withFakeEngine();
    let finish!: (recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void;
    const cancel = vi.fn();
    const { root, route, sends } = mount(async () => ({
      stop: () => new Promise(resolve => { finish = resolve; }), cancel,
    }), true, { chatConfigured: true, prefs: { 'ui.voice.auto_send': false } });
    try {
      await route.whenLoaded(); micButton(root)?.click(); await tick(); micButton(root)?.click();
      await route.openSession('chat_1');
      route.startNewChat();
      expect(collectByAttr(root, 'data-recued-chat-route-history-draft-guard')).toHaveLength(0);
      expect(route.getThread().session).toBeNull(); expect(cancel).not.toHaveBeenCalled();
      route.startNewChat();
      const guard = collectByAttr(root, 'data-recued-chat-route-history-draft-guard')[0]!;
      expect(guard).toBeDefined();
      guard.children.flatMap(child => child.children).find(button => button.textContent === 'Keep writing')!.click();
      finish(await controllableCapture().session.stop()); await tick();
      expect(engines).toHaveLength(1); expect(cancel).not.toHaveBeenCalled(); expect(sends()).toHaveLength(0);
    } finally { route.dispose(); restore(); }
  });

  it.each(['parked', 'discarded'] as const)('protects only retained audio when its draft is %s', async disposition => {
    const { engines, restore } = await withFakeEngine();
    const finish: Array<(recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void> = [];
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const doc = makeDoc(); const root = doc.createElement('div');
    const base = makeConn(true, {}, true);
    const conn = (async (method: string, args: unknown) => {
      const result = await base.conn(method as never, args as never);
      return method === 'chat.session.get' ? { ...result, id: (args as { session_id: string }).session_id } : result;
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      conn, ...(disposition === 'parked' ? { initialSessionId: 'chat_1' } : { initialLanding: 'new' as const }),
      uploadCallers: {} as never, uploadConnect: {} as never,
      voiceCapture: async () => {
        const cancel = vi.fn(); cancels.push(cancel);
        return { stop: () => new Promise(resolve => { finish.push(resolve); }), cancel };
      } });
    try {
      await route.whenLoaded();
      for (const _ of [0, 1]) {
        micButton(root)?.click(); await tick(); micButton(root)?.click();
      }
      expect(route.hasUnsavedChanges()).toBe(true);
      if (disposition === 'parked') await route.openSession('chat_2');
      else {
        const text = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
        text.value = 'Draft to discard'; text.fire('input');
        route.startNewChat();
        collectByAttr(root, 'data-recued-chat-route-history-draft-guard')[0]!.children.flatMap(child => child.children)
          .find(button => button.textContent === 'Throw it away and start a new one')!.click();
      }
      expect(route.hasUnsavedChanges()).toBe(disposition === 'parked');
      expect(route.unsavedChangesPrompt()).toBe(disposition === 'parked' ? 'Discard unfinished voice notes and leave Chat?' : null);
      for (const cancel of cancels) expect(cancel).toHaveBeenCalledTimes(disposition === 'parked' ? 0 : 1);
      for (const complete of finish) complete(await controllableCapture().session.stop());
      await tick();
      expect(engines).toHaveLength(disposition === 'parked' ? 2 : 0);
      if (disposition === 'parked') {
        expect(collectByAttr(root, 'data-recued-chat-route-attachment')).toHaveLength(0);
        expect(route.hasUnsavedChanges()).toBe(true);
        expect(route.unsavedChangesPrompt()).toBeNull();
      }
      expect(base.sends()).toHaveLength(0);
    } finally { route.dispose(); restore(); }
  });

  it.each(['success', 'failure'] as const)('retires parked recordings only after deletion %s, preserving the current capture', async outcome => {
    const { engines, restore } = await withFakeEngine();
    const finish: Array<(recording: Awaited<ReturnType<VoiceCaptureSession['stop']>>) => void> = [];
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    let accept!: () => void;
    let reject!: (error: Error) => void;
    const deletion = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
    const doc = makeDoc(); const root = doc.createElement('div');
    const base = makeConn(true, { 'ui.voice.auto_send': false }, true);
    const conn = (async (method: string, args: unknown) => {
      if (method === 'chat.session.delete') return deletion;
      if (method === 'chat.sessions.list') return { sessions: ['chat_1', 'chat_2'].map(id => ({ ...chatSession(), id, message_count: 1 })) };
      const result = await base.conn(method as never, args as never);
      return method === 'chat.session.get' ? { ...result, id: (args as { session_id: string }).session_id } : result;
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      conn, initialSessionId: 'chat_1', uploadCallers: {} as never, uploadConnect: {} as never,
      voiceCapture: async () => {
        const cancel = vi.fn(); cancels.push(cancel);
        return { stop: () => new Promise(resolve => { finish.push(resolve); }), cancel };
      } });
    try {
      await route.whenLoaded();
      for (let n = 0; n < 2; n++) { micButton(root)?.click(); await tick(); micButton(root)?.click(); }
      await route.openSession('chat_2');
      micButton(root)?.click(); await tick();
      collectByAttr(root, 'data-recued-chat-route-session-delete')
        .find(button => button.getAttribute('data-recued-chat-route-session-delete') === 'chat_1')!.click();
      collectByAttr(root, 'data-recued-chat-route-session-delete-confirm')[0]!.click();
      for (const cancel of cancels) expect(cancel).not.toHaveBeenCalled();
      if (outcome === 'success') accept(); else reject(new Error('Delete refused'));
      await vi.waitFor(() => expect(collectByAttr(root, 'data-recued-chat-route-session-delete-confirm')).toHaveLength(0));
      for (const n of [0, 1]) expect(cancels[n]).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
      expect(cancels[2]).not.toHaveBeenCalled();
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('recording');
      for (const complete of finish) complete(await controllableCapture().session.stop());
      await tick();
      expect(engines).toHaveLength(outcome === 'success' ? 0 : 2);
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('recording');
      micButton(root)?.click(); finish[2]!(await controllableCapture().session.stop()); await tick();
      expect(engines).toHaveLength(outcome === 'success' ? 1 : 3);
      expect(collectByAttr(root, CHAT_ROUTE_VOICE_ERROR_ATTR)).toHaveLength(0);
      expect(base.sends()).toHaveLength(0);
    } finally { route.dispose(); restore(); }
  });

  it.each(['grant', 'refusal'] as const)('cancels a pending request and keeps its late %s out of a retry', async (outcome) => {
    const { engines, restore } = await withFakeEngine();
    let route: ReturnType<typeof bootstrapChatRoute> | undefined;
    try {
      const cancelled = controllableCapture();
      const retry = controllableCapture();
      let open!: (session: VoiceCaptureSession) => void;
      let refuse!: (error: Error) => void;
      let reportError: (() => void) | undefined;
      let attempts = 0;
      const mounted = mount((onError?: () => void) => {
        if (attempts++ > 0) return Promise.resolve(retry.session);
        reportError = onError;
        return new Promise((resolve, reject) => { open = resolve; refuse = reject; });
      }, true, { chatConfigured: true });
      route = mounted.route;
      const { root, sends } = mounted;
      await tick();
      const input = root.querySelector(`[${CHAT_ROUTE_INPUT_ATTR}]`)!;
      input.value = 'Keep this draft'; input.fire('input');
      micButton(root)?.click();
      const cancel = micButtons(root).find((b) => b.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard');
      expect(cancel?.getAttribute('aria-label')).toBe('Cancel recording request');
      expect(cancel?.textContent).toBe('Cancel');
      cancel?.click(); await tick();
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('idle');
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Record a voice note');
      expect(root.querySelector(`[${CHAT_ROUTE_INPUT_ATTR}]`)?.value).toBe('Keep this draft');
      expect(engines).toHaveLength(0);
      expect(sends()).toHaveLength(0);

      micButton(root)?.click(); await tick();
      if (outcome === 'grant') open(cancelled.session);
      else refuse(Object.assign(new Error('refused'), { name: 'NotAllowedError' }));
      await tick(); reportError?.();
      expect(cancelled.cancelled()).toBe(outcome === 'grant');
      expect(retry.cancelled()).toBe(false);
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('recording');
      expect(collectByAttr(root, CHAT_ROUTE_VOICE_ERROR_ATTR)).toHaveLength(0);
      expect(engines).toHaveLength(0);
      expect(attempts).toBe(2);
      micButton(root)?.click(); await tick();
      expect(engines).toHaveLength(1);
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:retry-voice' });
      await tick();
      expect(sends()).toHaveLength(0);
      sendButton(root)?.click(); await tick();
      expect(sends()).toHaveLength(1);
      expect(sends()[0]!.args).toMatchObject({
        message: 'Keep this draft', attachments: [{ file_id: 'file:retry-voice', media_class: 'voice' }],
      });
    } finally { route?.dispose(); restore(); }
  });

  it('sends the note as an EMPTY message with one voice attachment, once the bytes land', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const capture = controllableCapture();
      const { root, route, sends } = mount(async () => capture.session);
      await tick();

      micButton(root)?.click();
      await tick();
      micButton(root)?.click();
      await tick();

      // The recording rode the ordinary attachment path — same engine, same
      // resumable upload an attached file uses.
      expect(engines).toHaveLength(1);
      expect(engines[0]?.started?.name).toBe('voice-note-20300402-101530.webm');
      // ⛔ NOTHING SENT WHILE IT CLIMBS. `chat.send` carries finalized ids only,
      // so a send here would deliver a turn with no note on it.
      expect(sends()).toHaveLength(0);

      engines[0]?.listener?.({ sent: 10, total: 10, recordId: 'file:voice1' });
      await tick();

      const send = sends()[0]?.args as { message: string; attachments?: unknown[] };
      expect(sends()).toHaveLength(1);
      expect(send.message).toBe('');
      // Empty text + exactly one voice attachment is precisely what the
      // server's voice branch requires; anything else and it would answer with
      // the wordless-drop affordance instead of transcribing.
      expect(send.attachments).toEqual([
        { file_id: 'file:voice1', media_class: 'voice' },
      ]);
      route.dispose();
    } finally {
      restore();
    }
  });

  it.each([
    { phase: 'opening', outcome: 'accepted', upload: 'before' },
    { phase: 'opening', outcome: 'accepted', upload: 'after' },
    { phase: 'opening', outcome: 'rejected', upload: 'before' },
    { phase: 'opening', outcome: 'rejected', upload: 'after' },
    { phase: 'recording', outcome: 'accepted', upload: 'before' },
    { phase: 'recording', outcome: 'accepted', upload: 'after' },
    { phase: 'recording', outcome: 'rejected', upload: 'before' },
    { phase: 'recording', outcome: 'rejected', upload: 'after' },
  ] as const)('can stop a newer $phase capture and keep its upload $upload an $outcome send', async ({ phase, outcome, upload }) => {
    const { engines, restore } = await withFakeEngine();
    let acknowledge!: (ack: { turn_id: string }) => void;
    let reject!: (error: Error) => void;
    const sendAck = new Promise<{ turn_id: string }>((resolve, fail) => { acknowledge = resolve; reject = fail; });
    let route: ReturnType<typeof bootstrapChatRoute> | undefined;
    try {
      const earlier = controllableCapture();
      const later = controllableCapture();
      let attempts = 0;
      let allow!: (session: VoiceCaptureSession) => void;
      const mounted = mount(() => ++attempts === 1
        ? Promise.resolve(earlier.session)
        : new Promise(resolve => { allow = resolve; }), true, { chatConfigured: true, sendAck });
      route = mounted.route;
      const { root, sends } = mounted;
      await tick();
      micButton(root)?.click(); await tick();
      micButton(root)?.click(); await tick();
      micButton(root)?.click();
      if (phase === 'recording') { allow(later.session); await tick(); }
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:earlier' });
      await vi.waitFor(() => expect(sends()).toHaveLength(1));
      expect(sends()[0]?.args).toMatchObject({
        message: '', attachments: [{ file_id: 'file:earlier', media_class: 'voice' }],
      });
      if (phase === 'opening') {
        expect(micButton(root)?.disabled).toBe(false);
        expect(micButton(root)?.getAttribute('aria-disabled')).toBe('true');
        allow(later.session); await tick();
      }
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('recording');
      expect(micButton(root)?.disabled).toBe(false);
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording');
      micButton(root)?.click(); await tick();
      expect(micButton(root)?.getAttribute(CHAT_ROUTE_VOICE_ATTR)).toBe('idle');
      expect(micButton(root)?.disabled).toBe(true);
      expect(engines).toHaveLength(2);
      expect(later.cancelled()).toBe(false);
      const finish = () => engines[1]!.listener?.({ sent: 10, total: 10, recordId: 'file:later' });
      if (upload === 'before') { finish(); await tick(); }
      if (outcome === 'accepted') acknowledge({ turn_id: 'turn_1' });
      else reject(new Error('Send connection lost'));
      await tick();
      expect(micButton(root)?.disabled).toBe(false);
      if (upload === 'after') { finish(); await tick(); }
      expect(sends()).toHaveLength(1);
      expect(route.getRecoveryDraft()?.attachments?.map(file => file.file_id)).toEqual(
        outcome === 'accepted' ? ['file:later'] : ['file:earlier', 'file:later'],
      );
      sendButton(root)?.click(); await tick();
      expect(sends()).toHaveLength(2);
      expect(sends()[1]?.args).toMatchObject({
        message: '', attachments: (outcome === 'accepted' ? ['file:later'] : ['file:earlier', 'file:later'])
          .map(file_id => ({ file_id, media_class: 'voice' })),
      });
    } finally { acknowledge({ turn_id: 'turn_1' }); route?.dispose(); restore(); }
  });

  it('⚠ does NOT auto-send when the person has also typed — speak-and-type waits for Send', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const capture = controllableCapture();
      const { root, route, sends } = mount(async () => capture.session);
      await tick();

      micButton(root)?.click();
      await tick();
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and send');
      const input = root.querySelector(`[${CHAT_ROUTE_INPUT_ATTR}]`);
      expect(input).not.toBeNull();
      input!.value = 'have a look at this';
      input!.fire('input');

      // ⚠ And the control SAYS so while it is still running — promising "and
      // send" here would name an outcome that will not happen.
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and attach');
      micButton(root)?.click();
      await tick();
      engines[0]?.listener?.({ sent: 10, total: 10, recordId: 'file:voice1' });
      await tick();

      // Typed words are the utterance; the note is an ordinary attachment. And
      // the server's branch needs an empty message anyway, so auto-sending here
      // would produce a turn whose "voice note" is just a file.
      expect(sends()).toHaveLength(0);
      route.dispose();
    } finally {
      restore();
    }
  });

  it('⚠ does NOT send a FAILED upload, and says nothing new about it', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const capture = controllableCapture();
      const { root, route, sends } = mount(async () => capture.session);
      await tick();
      micButton(root)?.click();
      await tick();
      micButton(root)?.click();
      await tick();

      engines[0]?.listener?.({ sent: 3, total: 10, error: 'socket closed' });
      await tick();
      // The chip already carries the failure and the retry; a second message
      // here would contradict it.
      expect(sends()).toHaveLength(0);
      route.dispose();
    } finally {
      restore();
    }
  });

  // ⛔⛔ REVIEW FINDING (2026-09-07). THE TEST ABOVE CANNOT CATCH THIS, AND THAT
  // IS THE LESSON. It has no OTHER attachment, so `payload().length === 0` is
  // true for the right reason by accident. Add a file the person attached
  // earlier and the same check reads non-zero however the recording went —
  // so a FAILED voice note auto-sent their PDF as a wordless turn and cleared
  // the failed chip with it. "Did anything upload" is not "did MY recording
  // upload"; the fix tracks the recording's own row id.
  it('⛔⛔ a FAILED recording does not auto-send an attachment that was ALREADY there', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const capture = controllableCapture();
      const { doc, root, route, sends } = mount(async () => capture.session);
      await tick();

      // The person attached a document before speaking.
      const input = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0];
      (input as unknown as { files: unknown }).files = [
        new File(['%PDF-1.4'], 'contract.pdf', { type: 'application/pdf' }),
      ];
      // ⛔ `fire`, not `dispatchEvent` — the fake DOM has no `dispatchEvent`, and
      // `?.()` on a missing method is a SILENT no-op. The first draft of this
      // test used it, the PDF was never attached, and the test passed against
      // the BUGGY code for the same accidental reason as the one above it.
      input?.fire('change');
      await tick();
      engines[0]?.listener?.({ sent: 8, total: 8, recordId: 'file:pdf1' });
      await tick();
      // The premise, asserted: a file IS attached, so `payload().length` is
      // non-zero and the old check can no longer be right by accident.
      expect(engines[0]?.started?.name).toBe('contract.pdf');
      expect(sends()).toHaveLength(0);

      // Now they record, and the recording's upload fails.
      micButton(root)?.click();
      await tick();
      micButton(root)?.click();
      await tick();
      engines[1]?.listener?.({ sent: 3, total: 10, error: 'socket closed' });
      await tick();

      // ⛔ Nothing may be sent. The PDF is still theirs to send deliberately.
      expect(sends()).toHaveLength(0);
      void doc;
      route.dispose();
    } finally {
      restore();
    }
  });

  // ⛔⛔ REVIEW FINDING (2026-09-07). TWO INDEPENDENT SETTINGS WERE SILENTLY
  // COUPLED. Voice origin was stamped only on the auto-send branch, so with
  // `ui.voice.auto_send` OFF a recording sent by pressing Send was never marked
  // as voice-origin — and `speak replies: after voice` then declined to speak.
  // Turning off one convenience disabled an unrelated one, with nothing saying
  // so. Attribution now happens where BOTH send paths meet.
  it('⛔⛔ speaks `after_voice` for a note the owner sent MANUALLY (auto-send off)', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const spoken: string[] = [];
      const capture = controllableCapture();
      const { root, route, emit, sends } = mount(async () => capture.session, true, {
        prefs: { 'ui.voice.auto_send': false, 'ui.voice.speak_replies': 'after_voice' },
        voiceSpeaker: { speak: (t: string) => { spoken.push(t); }, cancel: () => {} },
        chatConfigured: true,
      });
      await tick();

      micButton(root)?.click();
      await tick();
      micButton(root)?.click();
      await tick();
      engines[0]?.listener?.({ sent: 10, total: 10, recordId: 'file:voice1' });
      await tick();

      // Auto-send is off, so the note is sitting attached — the premise of the
      // whole test, asserted rather than assumed.
      expect(sends()).toHaveLength(0);

      // The person presses Send themselves. It is still a voice turn.
      sendButton(root)?.click();
      await tick();
      expect(sends()).toHaveLength(1);

      emit('chat.message_complete', {
        session_id: 'chat_1',
        turn_id: 'turn_1',
        final: { id: 'msg_reply', role: 'assistant', content: 'heard you' },
      } as never);
      await tick();

      expect(spoken).toEqual(['heard you']);
      route.dispose();
    } finally {
      restore();
    }
  });

  it('correlates a reply that beats a voice send acknowledgement and never speaks another client\'s reply or a replay', async () => {
    const { engines, restore } = await withFakeEngine();
    let acknowledge!: (ack: { turn_id: string }) => void;
    const sendAck = new Promise<{ turn_id: string }>(resolve => { acknowledge = resolve; });
    try {
      const spoken: string[] = []; const capture = controllableCapture();
      const { root, route, emit, sends } = mount(async () => capture.session, true, {
        prefs: { 'ui.voice.auto_send': false, 'ui.voice.speak_replies': 'after_voice' },
        voiceSpeaker: { speak: text => { spoken.push(text); }, cancel: () => {} }, chatConfigured: true, sendAck,
      });
      await tick(); await speakAndFinalize(root, engines);
      sendButton(root)?.click();
      await vi.waitFor(() => expect(sends()).toHaveLength(1));
      const complete = (turn: string, content: string) => emit('chat.message_complete', { session_id: 'chat_1', turn_id: turn,
        final: { id: `reply-${turn}`, role: 'assistant', content },
      });
      complete('other-client', 'unrelated reply'); complete('turn_1', 'your voice reply');
      expect(spoken).toEqual([]);
      acknowledge({ turn_id: 'turn_1' });
      await vi.waitFor(() => expect(spoken).toEqual(['your voice reply']));
      complete('turn_1', 'your voice reply'); expect(spoken).toEqual(['your voice reply']);
      route.dispose();
    } finally { acknowledge({ turn_id: 'turn_1' }); restore(); }
  });

  it('discards without uploading anything', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const capture = controllableCapture();
      const { root, route, sends } = mount(async () => capture.session);
      await tick();
      micButton(root)?.click();
      await tick();
      micButtons(root)
        .find((b) => b.getAttribute(CHAT_ROUTE_VOICE_ATTR) === 'discard')
        ?.click();
      await tick();

      expect(capture.cancelled()).toBe(true);
      expect(engines).toHaveLength(0);
      expect(sends()).toHaveLength(0);
      route.dispose();
    } finally {
      restore();
    }
  });

  it('announces a recording interruption, keeps typed text and permits a new note', async () => {
    const { engines, restore } = await withFakeEngine();
    let route: ReturnType<typeof bootstrapChatRoute> | undefined;
    try {
      const capture = controllableCapture();
      let reportError: (() => void) | undefined;
      const mounted = mount(async (onError?: () => void) => {
        reportError = onError;
        return capture.session;
      }, true, { chatConfigured: true });
      route = mounted.route;
      const { root, sends } = mounted;
      await tick();
      const input = root.querySelector(`[${CHAT_ROUTE_INPUT_ATTR}]`)!;
      input.value = 'Keep this draft';
      input.fire('input');
      micButton(root)?.click(); await tick();
      reportError?.(); await tick();

      expect(capture.cancelled()).toBe(true);
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Record a voice note');
      expect(micButton(root)?.getAttribute('aria-pressed')).toBe('false');
      expect(micButton(root)?.disabled).toBe(false);
      const line = collectByAttr(root, CHAT_ROUTE_VOICE_ERROR_ATTR)[0];
      expect(line?.textContent).toContain('Try recording again');
      expect(line?.getAttribute('role')).toBe('status');
      expect(root.querySelector(`[${CHAT_ROUTE_INPUT_ATTR}]`)?.value).toBe('Keep this draft');
      expect(engines).toHaveLength(0);
      expect(sends()).toHaveLength(0);

      micButton(root)?.click(); await tick();
      expect(collectByAttr(root, CHAT_ROUTE_VOICE_ERROR_ATTR)).toHaveLength(0);
      micButton(root)?.click(); await tick();
      expect(engines).toHaveLength(1);
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:retry-voice' });
      await tick();
      expect(sends()).toHaveLength(0);
      sendButton(root)?.click(); await tick();
      expect(sends()).toHaveLength(1);
      expect(sends()[0]!.args).toMatchObject({
        message: 'Keep this draft',
        attachments: [{ file_id: 'file:retry-voice', media_class: 'voice' }],
      });
    } finally {
      route?.dispose();
      restore();
    }
  });

  it('states a refused microphone in the composer', async () => {
    const { root, route } = mount(async () => {
      const e = new Error('refused');
      e.name = 'NotAllowedError';
      throw e;
    });
    await tick();
    micButton(root)?.click();
    await tick();

    const line = collectByAttr(root, CHAT_ROUTE_VOICE_ERROR_ATTR)[0];
    // A denial that resolved into a button quietly returning to idle is
    // indistinguishable from a feature that does not work.
    expect(line?.textContent).toContain('permission was refused');
    expect(line?.getAttribute('role')).toBe('status');
    route.dispose();
  });
});

describe('D-262 slice 4 — auto-send as a setting', () => {
  it.each([
    { other: 'document', finish: 'before-recording' },
    { other: 'voice', finish: 'before-recording' },
    { other: 'document', finish: 'before-voice' },
    { other: 'voice', finish: 'before-voice' },
    { other: 'document', finish: 'after-voice' },
    { other: 'voice', finish: 'after-voice' },
  ] as const)('keeps a note for explicit Send with another $other completing $finish', async ({ other, finish }) => {
    const { engines, restore } = await withFakeEngine();
    const capture = controllableCapture();
    const { root, route, sends } = mount(async () => capture.session, true, { chatConfigured: true });
    try {
      await tick();
      const text = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
      text.value = 'Keep the first attachment'; text.fire('input');
      if (other === 'document') {
        const picker = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!;
        Object.defineProperty(picker, 'files', { value: [new File(['pdf'], 'Other.pdf', { type: 'application/pdf' })] });
        picker.fire('change'); await tick();
      } else {
        micButton(root)?.click(); await tick(); micButton(root)?.click(); await tick();
      }
      const finishOther = () => engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:other' });
      if (finish === 'before-recording') { finishOther(); await tick(); }
      const currentText = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
      currentText.value = ''; currentText.fire('input');
      micButton(root)?.click(); await tick();
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and attach');
      micButton(root)?.click(); await tick();
      expect(engines).toHaveLength(2);
      if (finish === 'before-voice') { finishOther(); await tick(); }
      engines[1]!.listener?.({ sent: 10, total: 10, recordId: 'file:note' }); await tick();
      if (finish === 'after-voice') { finishOther(); await tick(); }
      expect(sends()).toHaveLength(0);
      expect(route.getRecoveryDraft()?.attachments?.map(file => file.file_id)).toEqual(['file:other', 'file:note']);
      sendButton(root)?.click(); await tick();
      expect(sends()).toHaveLength(1);
      expect(sends()[0]?.args).toMatchObject({ message: '', attachments: [
        { file_id: 'file:other', media_class: other }, { file_id: 'file:note', media_class: 'voice' },
      ] });
    } finally { route.dispose(); restore(); }
  });

  it.each(['attached', 'failed', 'uploading'] as const)('removing an extra %s attachment after the note finishes does not start auto-send', async other => {
    const { engines, restore } = await withFakeEngine();
    const capture = controllableCapture();
    const { root, route, sends } = mount(async () => capture.session, true, { chatConfigured: true });
    try {
      await tick();
      const picker = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!;
      Object.defineProperty(picker, 'files', { value: [new File(['pdf'], 'Other.pdf', { type: 'application/pdf' })] });
      picker.fire('change'); await tick();
      if (other !== 'uploading') engines[0]!.listener?.(other === 'attached'
        ? { sent: 10, total: 10, recordId: 'file:other' }
        : { sent: 0, total: 10, error: 'Upload failed' });
      micButton(root)?.click(); await tick();
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and attach');
      micButton(root)?.click(); await tick();
      engines[1]!.listener?.({ sent: 10, total: 10, recordId: 'file:note' }); await tick();
      expect(sends()).toHaveLength(0);
      collectByAttr(root, 'data-recued-chat-route-attachment-remove')[0]!.click(); await tick();
      expect(sends()).toHaveLength(0);
      expect(route.getRecoveryDraft()?.attachments?.map(file => file.file_id)).toEqual(['file:note']);
      sendButton(root)?.click(); await tick();
      expect(sends()).toHaveLength(1);
      expect(sends()[0]?.args).toMatchObject({ message: '', attachments: [{ file_id: 'file:note', media_class: 'voice' }] });
    } finally { route.dispose(); restore(); }
  });

  it('updates the Stop action when another attachment is added and removed while recording', async () => {
    const { engines, restore } = await withFakeEngine();
    const capture = controllableCapture();
    const { root, route, sends } = mount(async () => capture.session, true, { chatConfigured: true });
    try {
      await tick(); micButton(root)?.click(); await tick();
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and send');
      const picker = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!;
      Object.defineProperty(picker, 'files', { value: [new File(['pdf'], 'Other.pdf', { type: 'application/pdf' })] });
      picker.fire('change'); await tick();
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and attach');
      collectByAttr(root, 'data-recued-chat-route-attachment-remove')[0]!.click(); await tick();
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and send');
      micButton(root)?.click(); await tick();
      engines[1]!.listener?.({ sent: 10, total: 10, recordId: 'file:note' }); await tick();
      expect(sends()).toHaveLength(1);
      expect(sends()[0]?.args).toMatchObject({ message: '', attachments: [{ file_id: 'file:note', media_class: 'voice' }] });
    } finally { route.dispose(); restore(); }
  });

  it.each([
    { autoSend: false, stopLabel: 'Stop recording and attach', automaticSends: 0 },
    { autoSend: true, stopLabel: 'Stop recording and send', automaticSends: 1 },
  ])('matches the Stop label and completed action to auto-send=$autoSend', async ({ autoSend, stopLabel, automaticSends }) => {
    const { engines, restore } = await withFakeEngine();
    try {
      const capture = controllableCapture();
      const { root, route, sends } = mount(async () => capture.session, true, {
        prefs: { 'ui.voice.auto_send': autoSend }, chatConfigured: true,
      });
      await tick();
      micButton(root)?.click(); await tick();
      expect(micButton(root)?.getAttribute('aria-label')).toBe(stopLabel);
      const input = root.querySelector(`[${CHAT_ROUTE_INPUT_ATTR}]`)!;
      input.value = 'Keep this request'; input.fire('input');
      expect(micButton(root)?.getAttribute('aria-label')).toBe('Stop recording and attach');
      input.value = ' \n '; input.fire('input');
      expect(micButton(root)?.getAttribute('aria-label')).toBe(stopLabel);
      input.value = ''; input.fire('input');
      expect(micButton(root)?.getAttribute('aria-label')).toBe(stopLabel);
      micButton(root)?.click(); await tick();
      expect(sends()).toHaveLength(0);
      expect(engines[0]?.started?.name).toContain('voice-note-');
      engines[0]?.listener?.({ sent: 10, total: 10, recordId: 'file:voice1' });
      await tick();
      expect(sends()).toHaveLength(automaticSends);
      // With auto-send off, finalized audio waits for an explicit Send.
      if (!autoSend) { sendButton(root)?.click(); await tick(); }
      expect(sends()).toHaveLength(1);
      expect(sends()[0]?.args).toMatchObject({
        message: '', attachments: [{ file_id: 'file:voice1', media_class: 'voice' }],
      });
      route.dispose();
    } finally { restore(); }
  });
});

describe('D-262 slice 4 — speaking the reply', () => {
  const recordingSpeaker = () => {
    const said: string[] = [];
    return { said, speaker: { speak: (t: string) => { said.push(t); }, cancel: () => {} } };
  };

  const completeReply = (
    emit: (kind: string, e: Record<string, unknown>) => void,
    turnId: string,
    content: string,
  ): void => {
    emit('chat.message_complete', {
      session_id: 'chat_1',
      turn_id: turnId,
      final: { id: 'msg_reply', role: 'assistant', content },
    });
  };

  it('speaks the reply to a turn that began as a VOICE note', async () => {
    const { engines, restore } = await withFakeEngine();
    try {
      const { said, speaker } = recordingSpeaker();
      const capture = controllableCapture();
      const { root, route, sends, emit } = mount(async () => capture.session, true, {
        prefs: { 'ui.voice.speak_replies': 'after_voice' },
        voiceSpeaker: speaker,
      });
      await tick();
      await speakAndFinalize(root, engines);
      expect(sends()).toHaveLength(1);

      completeReply(emit, 'turn_1', 'Moved it to **Friday**.');
      await tick();
      // Markdown is stripped on the way out — the emphasis markers are for the
      // eye, and reading them aloud is the failure this feature dies of.
      expect(said).toEqual(['Moved it to Friday.']);
      route.dispose();
    } finally { restore(); }
  });

  it('⛔ stays SILENT for a typed turn under `after_voice`', async () => {
    const { said, speaker } = recordingSpeaker();
    const { route, emit } = mount(null, true, {
      prefs: { 'ui.voice.speak_replies': 'after_voice' },
      voiceSpeaker: speaker,
    });
    await tick();
    // No voice turn was ever sent, so this reply belongs to a typed one.
    // Speaking here is the behaviour that makes people turn the feature off.
    completeReply(emit, 'turn_typed', 'Here is the answer.');
    await tick();
    expect(said).toEqual([]);
    route.dispose();
  });

  it('speaks every reply under `always`, voice or not', async () => {
    const { said, speaker } = recordingSpeaker();
    const { route, emit } = mount(null, true, {
      prefs: { 'ui.voice.speak_replies': 'always' },
      voiceSpeaker: speaker,
    });
    await tick();
    completeReply(emit, 'turn_typed', 'Here is the answer.');
    await tick();
    expect(said).toEqual(['Here is the answer.']);
    route.dispose();
  });

  it('⛔ says nothing under `never`', async () => {
    const { said, speaker } = recordingSpeaker();
    const { route, emit } = mount(null, true, {
      prefs: { 'ui.voice.speak_replies': 'never' },
      voiceSpeaker: speaker,
    });
    await tick();
    completeReply(emit, 'turn_typed', 'Here is the answer.');
    await tick();
    expect(said).toEqual([]);
    route.dispose();
  });

  it('does nothing at all where the browser cannot speak', async () => {
    // `voiceSpeaker: null` is the no-API case. The setting still exists; it
    // simply has no effect, rather than erroring on every reply.
    const { route, emit } = mount(null, true, {
      prefs: { 'ui.voice.speak_replies': 'always' },
      voiceSpeaker: null,
    });
    await tick();
    expect(() => completeReply(emit, 'turn_typed', 'Here is the answer.')).not.toThrow();
    route.dispose();
  });
});


describe('Chat native file picker ownership', () => {
  const pick = (input: FakeEl, names: string[]): void => {
    Object.defineProperty(input, 'files', { configurable: true,
      value: names.map(name => ({ name, type: 'application/pdf', size: 10 })) });
    input.fire('change');
    expect(input.value).toBe('');
  };

  it.each(['chat_1', null])('keeps late multi-file selections with their original %s draft', async source => {
    const { engines, restore } = await withFakeEngine();
    const doc = makeDoc(); const root = doc.createElement('div');
    const base = makeConn(false, {}, true);
    const conn = (async (method: string, args: unknown) => {
      const result = await base.conn(method as never, args as never);
      return method === 'chat.session.get' ? { ...result, id: (args as { session_id: string }).session_id } : result;
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({ root: root as unknown as HTMLElement, document: doc as unknown as Document,
      conn, ...(source ? { initialSessionId: source } : { initialLanding: 'new' }),
      uploadCallers: {} as never, uploadConnect: {} as never, voiceCapture: null });
    try {
      await route.whenLoaded();
      const originalInput = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!;
      pick(originalInput, []); expect(engines).toHaveLength(0);
      await route.openSession('chat_2');
      pick(originalInput, ['First.pdf', 'Second.pdf']);
      expect(engines.map(engine => engine.started?.name)).toEqual(['First.pdf', 'Second.pdf']);
      expect(collectByAttr(root, 'data-recued-chat-route-attachment')).toHaveLength(0);
      expect(route.getRecoveryDraft()).toMatchObject({ text: '', parkedDrafts: [
        { sessionId: source, draft: { interruptedUploads: [{ filename: 'First.pdf' }, { filename: 'Second.pdf' }] } },
      ] });
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:first' });
      engines[1]!.listener?.({ sent: 10, total: 10, recordId: 'file:second' });
      if (source) await route.openSession(source); else route.startNewChat();
      expect(route.getRecoveryDraft()?.attachments?.map(file => file.file_id)).toEqual(['file:first', 'file:second']);
      expect(base.sends()).toHaveLength(0); expect(route.hasUnsavedChanges()).toBe(true);
    } finally { route.dispose(); restore(); }
  });

  it.each(['discard', 'dispose'])('ignores a native picker result after %s', async action => {
    const { engines, restore } = await withFakeEngine();
    const { root, route } = mount(null, false, { chatConfigured: true });
    try {
      await route.whenLoaded();
      const originalInput = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!;
      const text = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
      text.value = 'Draft to discard'; text.fire('input');
      if (action === 'dispose') route.dispose();
      else {
        route.startNewChat();
        const guard = collectByAttr(root, 'data-recued-chat-route-history-draft-guard')[0]!;
        guard.children.flatMap(child => child.children)
          .find(button => button.textContent === 'Throw it away and start a new one')!.click();
      }
      pick(originalInput, ['Too-late.pdf']);
      expect(engines).toHaveLength(0);
      if (action === 'discard') {
        expect(route.getRecoveryDraft()).toBeNull(); expect(route.hasUnsavedChanges()).toBe(false);
        // A valid new picker still works after the retired one is ignored.
        pick(collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!, ['Current.pdf']);
        expect(engines).toHaveLength(1); expect(engines[0]!.started?.name).toBe('Current.pdf');
      }
    } finally { route.dispose(); restore(); }
  });

  it('follows a new draft into its lazy session without adding late files to the accepted send', async () => {
    const { engines, restore } = await withFakeEngine();
    const { root, route, sends } = mount(null, false, { chatConfigured: true });
    try {
      await route.whenLoaded();
      const originalInput = collectByAttr(root, CHAT_ROUTE_ATTACH_INPUT_ATTR)[0]!;
      await route.sendMessage('Create this conversation');
      expect(route.getThread().session?.id).toBe('chat_1');
      pick(originalInput, ['After-send.pdf']);
      engines[0]!.listener?.({ sent: 10, total: 10, recordId: 'file:after' });
      expect(sends()).toHaveLength(1);
      expect(sends()[0]!.args).not.toHaveProperty('attachments');
      expect(route.getRecoveryDraft()?.attachments?.[0]?.file_id).toBe('file:after');
      route.startNewChat();
      expect(route.getRecoveryDraft()).toMatchObject({ text: '', parkedDrafts: [
        { sessionId: 'chat_1', draft: { attachments: [{ file_id: 'file:after' }] } },
      ] });
      expect(collectByAttr(root, 'data-recued-chat-route-attachment')).toHaveLength(0);
    } finally { route.dispose(); restore(); }
  });
});
