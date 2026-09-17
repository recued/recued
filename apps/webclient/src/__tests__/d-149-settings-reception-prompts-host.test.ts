/** D-149 follow-on § A.9 — Reception Settings prompts host acceptance.
 *
 *  `mountReceptionPromptsHost` is the fourth host element in the
 *  Reception Settings composition (after the page mount + the
 *  authoring/wizard satellite slot): it catches the page-host's
 *  `onPromptAction` bridge and renders the appropriate modal for each
 *  of the four prompt-driven forwards. These tests drive it through
 *  the DOM-free fake-host pattern every Reception mount test uses,
 *  with a fake shell that returns deterministic results.
 *
 *  The non-obvious things under test:
 *    - the four open(action, dataset) entrypoints land the right modal;
 *    - the endpoint-id-bound prompts (extend / rotate / revoke) bail
 *      on a singleton endpoint id;
 *    - the field delegator captures the per-prompt-kind data-prompt-
 *      field inputs without overlap (it uses a private namespace
 *      from the authoring mount's `data-field-control`);
 *    - submit fires the matching shell rpc, propagates errors into
 *      the inline-error slot, and on success closes the modal;
 *    - rotate-token success registers the fresh `share_url_once` via
 *      `setEndpointShare` looked up against the loaded page model;
 *    - emergency-disable-all gates submit on the literal confirm phrase. */

import { describe, expect, it, vi } from 'vitest';
import type {
  EndpointSummary,
  PacketDeclaration,
  ReceptionEndpointKind,
  ReceptionEndpointRotateResult,
  ReceptionPageConfig,
  ShareCardsInput,
} from '@recued/contracts';
import {
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
  RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND,
} from '@recued/contracts';

import {
  mountReceptionPromptsHost,
  RECEPTION_PROMPT_KINDS,
  RECEPTION_PROMPT_ACTIONS,
  RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE,
} from '../reception/prompts-host.js';
import { RECEPTION_HOST_PROMPT_ACTIONS } from '../reception/page-host.js';
import type {
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../reception/page-shell.js';
import { buildReceptionPageModel } from '../reception/spine.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────
// Fake host — captures the four event types the prompts mount listens
// for (click for actions, input + change for field commits). Same
// shape every Reception mount test uses.
// ──────────────────────────────────────────────────────────────────

const makeFakeHost = () => {
  let html = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      listeners[evt]?.delete(fn);
    },
    contains: () => true,
  } as unknown as HTMLElement;
  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };
  return {
    host,
    getHtml: () => html,
    listenerCount: () =>
      Object.values(listeners).reduce((total, set) => total + set.size, 0),
    click: (dataset: Record<string, string>) => {
      const el = { dataset, closest: () => el } as unknown;
      fire('click', el);
    },
    /** Simulate a `data-prompt-field` commit — text/textarea/date fire
     *  `input`, select + checkbox fire `change`. The mount's de-dupe
     *  gate (`resolveCommitEvent`) matches the listener's logic so the
     *  event type + tagName/type must match the natural commit event. */
    field: (opts: {
      promptField: string;
      kind: 'text' | 'date' | 'textarea' | 'select' | 'checkbox';
      value?: string;
      checked?: boolean;
    }) => {
      const dataset: Record<string, string> = { promptField: opts.promptField };
      const tagName =
        opts.kind === 'select'
          ? 'SELECT'
          : opts.kind === 'textarea'
            ? 'TEXTAREA'
            : 'INPUT';
      const type =
        opts.kind === 'checkbox'
          ? 'checkbox'
          : opts.kind === 'date'
            ? 'date'
            : 'text';
      const evt =
        opts.kind === 'select' || opts.kind === 'checkbox' ? 'change' : 'input';
      const el = {
        dataset,
        tagName,
        type,
        value: opts.value ?? '',
        checked: opts.checked ?? false,
        closest: (sel: string) => (sel === '[data-prompt-field]' ? el : null),
      } as unknown;
      fire(evt, el);
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake shell — the prompts mount only touches a narrow slice of the
// shell interface (the four rpc methods + `getState` for the rotate
// share-card lookup + `setEndpointShare`). Tests stub each rpc per
// scenario and assert call shape + setEndpointShare side effects.
// ──────────────────────────────────────────────────────────────────

const placeholderPacket = (kind: ReceptionEndpointKind): PacketDeclaration => ({
  packet_kind: RECEPTION_ENDPOINT_KIND_TO_PACKET_KIND[kind],
  source_query_ref:
    kind === 'reception_page'
      ? { kind: 'reception_page_config' }
      : { kind: 'data.calendar.combined' },
});

const summary = (
  over: Partial<EndpointSummary> & {
    endpoint_id: string;
    kind: ReceptionEndpointKind;
  },
): EndpointSummary => ({
  endpoint_id: over.endpoint_id,
  kind: over.kind,
  metadata: over.metadata ?? {},
  enabled: over.enabled ?? true,
  packet_declaration: over.packet_declaration ?? placeholderPacket(over.kind),
  expires_at: over.expires_at ?? null,
  long_lived_acknowledged_at: over.long_lived_acknowledged_at ?? null,
  revoked_at: over.revoked_at ?? null,
  revocation_reason: over.revocation_reason ?? null,
  audit_count: over.audit_count ?? 0,
  last_accessed_at: over.last_accessed_at ?? null,
  created_at: over.created_at ?? NOW - DAY_MS,
  created_by_client_id: over.created_by_client_id ?? 'cli-test',
});

const makeFakeShell = (overrides?: {
  endpoints?: ReadonlyArray<EndpointSummary>;
  rotateResult?: ReceptionEndpointRotateResult;
  rotateRejects?: Error;
  extendRejects?: Error;
  revokeRejects?: Error;
  emergencyDisableRejects?: Error;
}) => {
  // Seed a loaded page model so the rotate share-card lookup + the
  // extend hard-ceiling gate can read off `shell.getState().page`.
  const endpoints =
    overrides?.endpoints ??
    ([
      summary({ endpoint_id: 'ep-sched', kind: 'scheduling_link' }),
      summary({ endpoint_id: 'ep-drop', kind: 'drop_link', expires_at: NOW + 7 * DAY_MS }),
      summary({ endpoint_id: 'ep-intake', kind: 'intake_form' }),
    ] as const);
  let state: ReceptionPageShellState = {
    page: buildReceptionPageModel({
      endpoints,
      status: {
        reception_public: true,
        emergency_disabled: false,
        base_url: 'https://reception.example',
      },
      now: NOW,
    }),
    detail: null,
    abuse_inbox: null,
    view_as_visitor: null,
    status: {
      reception_public: true,
      emergency_disabled: false,
      base_url: 'https://reception.example',
    },
    last_error: null,
    loading: false,
  };
  const fns = {
    extendEndpoint: vi.fn((_id: string, _ts: number | null) =>
      overrides?.extendRejects
        ? Promise.reject(overrides.extendRejects)
        : Promise.resolve(undefined),
    ),
    rotateToken: vi.fn((_id: string, _reason?: string) =>
      overrides?.rotateRejects
        ? Promise.reject(overrides.rotateRejects)
        : Promise.resolve(
            overrides?.rotateResult ?? {
              bearer_secret_once: 'bs-rotated',
              share_url_once: 'https://reception.example/rotated?t=once',
            },
          ),
    ),
    revokeEndpoint: vi.fn((_id: string, _reason?: string) =>
      overrides?.revokeRejects
        ? Promise.reject(overrides.revokeRejects)
        : Promise.resolve(undefined),
    ),
    emergencyDisableAll: vi.fn((_reason?: string) =>
      overrides?.emergencyDisableRejects
        ? Promise.reject(overrides.emergencyDisableRejects)
        : Promise.resolve(undefined),
    ),
    setEndpointShare: vi.fn(
      (_endpoint_id: string, _share: ShareCardsInput): void => undefined,
    ),
  };
  const shell = {
    getState: () => state,
    setState: (next: typeof state) => {
      state = next;
    },
    ...fns,
  } as unknown as ReceptionPageShell & {
    setState: (next: ReceptionPageShellState) => void;
  };
  return { shell, fns };
};

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// ══════════════════════════════════════════════════════════════════
// Closed-list invariants
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — prompts host closed lists', () => {
  it('exports four prompt kinds — one per RECEPTION_HOST_PROMPT_ACTION', () => {
    expect(RECEPTION_PROMPT_KINDS).toHaveLength(RECEPTION_HOST_PROMPT_ACTIONS.length);
    expect(new Set(RECEPTION_PROMPT_KINDS).size).toBe(RECEPTION_PROMPT_KINDS.length);
  });

  it('exports the two prompt-modal data-action keys', () => {
    expect(new Set(RECEPTION_PROMPT_ACTIONS)).toEqual(
      new Set(['reception-prompt-submit', 'reception-prompt-cancel']),
    );
  });

  it('emergency-disable confirm phrase is the literal expected by the gate', () => {
    expect(RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE).toBe('TURN EVERYTHING OFF NOW');
  });
});

// ══════════════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionPromptsHost: lifecycle', () => {
  it('mounts an empty host (no modal until open() is called)', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    expect(h.getHtml()).toBe('');
    expect(h.listenerCount()).toBeGreaterThan(0);
    prompts.dispose();
  });

  it('dispose() detaches every listener + clears the host, idempotently', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toContain('Take this link back');
    prompts.dispose();
    expect(h.listenerCount()).toBe(0);
    expect(h.getHtml()).toBe('');
    expect(() => prompts.dispose()).not.toThrow();
  });

  it('clicks after dispose() are inert', () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.dispose();
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toBe('');
    expect(fns.revokeEndpoint).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
// open() dispatch — action-kind partition + singleton guard
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — prompts host open() dispatch', () => {
  it('lands the extend modal for reception-extend with an endpointId', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toContain('Give it more time');
    expect(h.getHtml()).toContain('ep-sched');
    prompts.dispose();
  });

  it('lands the rotate modal for reception-rotate-token with an endpointId', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-rotate-token', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toContain('Swap the secret');
    prompts.dispose();
  });

  it('lands the revoke modal for reception-revoke with an endpointId', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toContain('Take this link back');
    prompts.dispose();
  });

  it('lands the emergency-disable-all modal — no endpointId required', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-emergency-disable-all', {});
    expect(h.getHtml()).toContain('Turn Reception off right now?');
    expect(h.getHtml()).toContain(RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE);
    prompts.dispose();
  });

  it('endpoint-id-bound prompts no-op when the dataset lacks endpointId', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', {});
    expect(h.getHtml()).toBe('');
    prompts.open('reception-rotate-token', {});
    expect(h.getHtml()).toBe('');
    prompts.open('reception-revoke', {});
    expect(h.getHtml()).toBe('');
    prompts.dispose();
  });

  it('endpoint-id-bound prompts no-op when endpointId is the singleton', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    for (const action of ['reception-extend', 'reception-rotate-token', 'reception-revoke'] as const) {
      prompts.open(action, { endpointId: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID });
      expect(h.getHtml()).toBe('');
    }
    prompts.dispose();
  });

  it('opening a new prompt replaces the prior one', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toContain('Take this link back');
    prompts.open('reception-extend', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toContain('Give it more time');
    expect(h.getHtml()).not.toContain('Take this link back');
    prompts.dispose();
  });

  it('cancel button closes the open modal + fires onClose', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const onClose = vi.fn();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
      onClose,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toContain('Take this link back');
    h.click({ action: 'reception-prompt-cancel' });
    expect(h.getHtml()).toBe('');
    expect(onClose).toHaveBeenCalledWith('revoke');
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// extend prompt
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — extend prompt', () => {
  it('submits a parsed expires_at when the user picks a future date', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    // `ep-drop` has an expires_at — seed defaults never_expire off + date
    // prefilled to the current expiry. The user then picks a new date.
    prompts.open('reception-extend', { endpointId: 'ep-drop' });
    h.field({ promptField: 'expires_at_date', kind: 'date', value: '2026-06-01' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).toHaveBeenCalledTimes(1);
    const args = fns.extendEndpoint.mock.calls[0]!;
    expect(args[0]).toBe('ep-drop');
    // UTC midnight of 2026-06-01.
    expect(args[1]).toBe(Date.parse('2026-06-01'));
    expect(h.getHtml()).toBe('');
    prompts.dispose();
  });

  it('submits new_expires_at: null when "never expires" is toggled on (non-ceiling kind)', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-sched' });
    h.field({ promptField: 'never_expire', kind: 'checkbox', checked: true });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).toHaveBeenCalledWith('ep-sched', null);
    expect(h.getHtml()).toBe('');
    prompts.dispose();
  });

  it('toggling never-expire re-renders to disable the date input', () => {
    const h = makeFakeHost();
    // Seed from `ep-intake` — `intake_form` (non-ceiling kind) with a
    // non-null expires_at would default never_expire off and let the
    // toggle flip cleanly. Override the default `ep-intake` to carry an
    // expires_at so the seed defaults the toggle off.
    const { shell } = makeFakeShell({
      endpoints: [
        summary({
          endpoint_id: 'ep-intake',
          kind: 'intake_form',
          expires_at: NOW + 30 * DAY_MS,
        }),
      ],
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-intake' });
    // Before toggle: never_expire off ⇒ date input not disabled.
    expect(h.getHtml()).not.toMatch(
      /data-prompt-field="expires_at_date"[^>]*disabled/,
    );
    h.field({ promptField: 'never_expire', kind: 'checkbox', checked: true });
    // After toggle: never_expire on ⇒ date input disabled.
    expect(h.getHtml()).toMatch(
      /data-prompt-field="expires_at_date"[^>]*disabled/,
    );
    prompts.dispose();
  });

  it('hard-ceiling kinds (drop_link) disable the never-expire toggle', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-drop' });
    expect(h.getHtml()).toContain('hard expiry ceiling');
    // The toggle's input is disabled — the rendered HTML carries the
    // disabled attribute on the never_expire input element.
    expect(h.getHtml()).toMatch(/data-prompt-field="never_expire"[^>]*disabled/);
    prompts.dispose();
  });

  it('rejects an empty date with an inline error + keeps the modal open', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-sched' });
    // The seed for a currently-long-lived endpoint defaults never_expire
    // to true (preserving its state) — turn it off so the date path runs.
    h.field({ promptField: 'never_expire', kind: 'checkbox', checked: false });
    h.field({ promptField: 'expires_at_date', kind: 'date', value: '' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).not.toHaveBeenCalled();
    expect(h.getHtml()).toContain('Pick a date it should run out');
    prompts.dispose();
  });

  it('rejects a past date with an inline error', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-sched' });
    h.field({ promptField: 'never_expire', kind: 'checkbox', checked: false });
    h.field({ promptField: 'expires_at_date', kind: 'date', value: '2000-01-01' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).not.toHaveBeenCalled();
    expect(h.getHtml()).toContain('That date has already gone');
    prompts.dispose();
  });

  it('seeds never_expire from the row — currently-long-lived defaults checked, expiry-bearing defaults off with prefill', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    // Long-lived row: never_expire seeded true (preserves current state).
    prompts.open('reception-extend', { endpointId: 'ep-sched' });
    expect(h.getHtml()).toMatch(/data-prompt-field="never_expire"[^>]*checked/);
    h.click({ action: 'reception-prompt-cancel' });
    // Expiry-bearing row: never_expire off + the existing date prefills.
    prompts.open('reception-extend', { endpointId: 'ep-drop' });
    expect(h.getHtml()).not.toMatch(/data-prompt-field="never_expire"[^>]*checked/);
    const dropDate = new Date(NOW + 7 * DAY_MS).toISOString().slice(0, 10);
    expect(h.getHtml()).toContain(`value="${dropDate}"`);
    prompts.dispose();
  });

  it('surfaces an rpc rejection as an inline error + keeps the modal open', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell({
      extendRejects: new Error('endpoint_revoked_cannot_extend'),
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-sched' });
    h.field({ promptField: 'expires_at_date', kind: 'date', value: '2026-06-01' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).toHaveBeenCalledTimes(1);
    expect(h.getHtml()).toContain('endpoint_revoked_cannot_extend');
    expect(h.getHtml()).toContain('Give it more time');
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// rotate-token prompt
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — rotate-token prompt', () => {
  it('submits an undefined reason when "No reason given" is selected (default)', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-rotate-token', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.rotateToken).toHaveBeenCalledTimes(1);
    expect(fns.rotateToken.mock.calls[0]).toEqual(['ep-sched', undefined]);
    prompts.dispose();
  });

  it('submits the chosen rotate reason when the user picks one', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-rotate-token', { endpointId: 'ep-sched' });
    h.field({ promptField: 'rotate_reason', kind: 'select', value: 'suspected_leak' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.rotateToken).toHaveBeenCalledWith('ep-sched', 'suspected_leak');
    prompts.dispose();
  });

  it('registers the fresh share URL via setEndpointShare on success', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-rotate-token', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.setEndpointShare).toHaveBeenCalledTimes(1);
    const [endpoint_id, share] = fns.setEndpointShare.mock.calls[0]!;
    expect(endpoint_id).toBe('ep-sched');
    expect(share).toMatchObject({
      share_url: 'https://reception.example/rotated?t=once',
      title: expect.stringContaining('scheduling link'),
    });
    expect(h.getHtml()).toBe('');
    prompts.dispose();
  });

  it('skips share registration when the row is not in the loaded page model', async () => {
    const h = makeFakeHost();
    // Empty endpoints — the rotate succeeds but no row to compose a
    // share card against (defensive fallback per DD#4).
    const { shell, fns } = makeFakeShell({ endpoints: [] });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-rotate-token', { endpointId: 'ep-vanished' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.rotateToken).toHaveBeenCalledTimes(1);
    expect(fns.setEndpointShare).not.toHaveBeenCalled();
    expect(h.getHtml()).toBe('');
    prompts.dispose();
  });

  it('surfaces an rpc rejection as an inline error + does not register a share', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell({
      rotateRejects: new Error('endpoint_not_found'),
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-rotate-token', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.setEndpointShare).not.toHaveBeenCalled();
    expect(h.getHtml()).toContain('endpoint_not_found');
    expect(h.getHtml()).toContain('Swap the secret');
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// revoke prompt
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — revoke prompt', () => {
  it('submits an undefined reason when the textarea is empty', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.revokeEndpoint).toHaveBeenCalledWith('ep-sched', undefined);
    prompts.dispose();
  });

  it('submits the typed reason when the textarea has content', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    h.field({ promptField: 'revoke_reason', kind: 'textarea', value: 'no longer needed' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.revokeEndpoint).toHaveBeenCalledWith('ep-sched', 'no longer needed');
    prompts.dispose();
  });

  it('trims whitespace-only reasons to undefined', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    h.field({ promptField: 'revoke_reason', kind: 'textarea', value: '   ' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.revokeEndpoint).toHaveBeenCalledWith('ep-sched', undefined);
    prompts.dispose();
  });

  it('surfaces an rpc rejection as an inline error + keeps the modal open', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell({
      revokeRejects: new Error('endpoint_already_revoked'),
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.revokeEndpoint).toHaveBeenCalledTimes(1);
    expect(h.getHtml()).toContain('endpoint_already_revoked');
    expect(h.getHtml()).toContain('Take this link back');
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// emergency-disable-all prompt
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — emergency-disable-all prompt', () => {
  it('gates submit on the exact confirm phrase', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-emergency-disable-all', {});
    // Click submit without typing the phrase — gated, no rpc fires.
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.emergencyDisableAll).not.toHaveBeenCalled();
    // HTML-escaped — the inline error renders with `e(...)` from the
    // template helper, so quotes become &quot;.
    expect(h.getHtml()).toContain(
      `Type &quot;${RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE}&quot; exactly`,
    );
    prompts.dispose();
  });

  it('refuses near-match phrases (case / whitespace strict)', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-emergency-disable-all', {});
    h.field({ promptField: 'confirm_phrase', kind: 'text', value: 'emergency disable all' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.emergencyDisableAll).not.toHaveBeenCalled();
    h.field({
      promptField: 'confirm_phrase',
      kind: 'text',
      value: ' EMERGENCY DISABLE ALL ',
    });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.emergencyDisableAll).not.toHaveBeenCalled();
    prompts.dispose();
  });

  it('fires emergencyDisableAll when the phrase matches exactly', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-emergency-disable-all', {});
    h.field({
      promptField: 'confirm_phrase',
      kind: 'text',
      value: RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE,
    });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.emergencyDisableAll).toHaveBeenCalledWith(undefined);
    expect(h.getHtml()).toBe('');
    prompts.dispose();
  });

  it('forwards the typed reason when present', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-emergency-disable-all', {});
    h.field({
      promptField: 'disable_all_reason',
      kind: 'textarea',
      value: 'phishing wave',
    });
    h.field({
      promptField: 'confirm_phrase',
      kind: 'text',
      value: RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE,
    });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.emergencyDisableAll).toHaveBeenCalledWith('phishing wave');
    prompts.dispose();
  });

  it('surfaces an rpc rejection as an inline error', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell({
      emergencyDisableRejects: new Error('emergency_disable_failed'),
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-emergency-disable-all', {});
    h.field({
      promptField: 'confirm_phrase',
      kind: 'text',
      value: RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE,
    });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.emergencyDisableAll).toHaveBeenCalledTimes(1);
    expect(h.getHtml()).toContain('emergency_disable_failed');
    expect(h.getHtml()).toContain('Turn Reception off right now?');
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Integration shape — page-host onPromptAction → prompts-host open()
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — page-host bridging', () => {
  it('every RECEPTION_HOST_PROMPT_ACTION has a corresponding open() seed', () => {
    const h = makeFakeHost();
    const { shell } = makeFakeShell();
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    for (const action of RECEPTION_HOST_PROMPT_ACTIONS) {
      prompts.open(action, { endpointId: 'ep-sched' });
      expect(h.getHtml().length).toBeGreaterThan(0);
      // Close before the next iteration so each open() seeds fresh.
      h.click({ action: 'reception-prompt-cancel' });
    }
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Page singleton — exposed via the page model, never via the prompt
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — singleton interaction', () => {
  it('a page-config singleton in the loaded model still does not open a prompt against the singleton id', () => {
    const h = makeFakeHost();
    const cfg: ReceptionPageConfig = {
      display_overrides: {
        display_name: 'Mary',
        tagline: '',
        tz_label: 'America/Los_Angeles',
        preferred_contact_methods: [],
      },
      sections_enabled: {},
      linked_endpoints: {},
    };
    const endpoints = [
      summary({
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
        kind: 'reception_page',
        metadata: cfg as unknown as Record<string, unknown>,
      }),
      summary({ endpoint_id: 'ep-sched', kind: 'scheduling_link' }),
    ];
    const { shell } = makeFakeShell({ endpoints });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-revoke', {
      endpointId: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
    });
    expect(h.getHtml()).toBe('');
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Codex P2 — DD#7: preserve the original expiry's time-of-day on
// un-edited submit.
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — extend prompt: original-epoch preservation', () => {
  it('submits the row\'s original expires_at verbatim when the user has not edited the date input', async () => {
    const h = makeFakeHost();
    // Pick an expiry with a non-midnight time-of-day: 14:30 UTC of a
    // future date. The user opens extend + clicks submit without ever
    // touching the date input. Submitting the parsed yyyy-mm-dd would
    // truncate to UTC midnight (shorter expiry); the fold preserves
    // the original epoch.
    const futureDateAt1430 =
      Date.parse('2026-12-01') + 14 * 60 * 60 * 1000 + 30 * 60 * 1000;
    const { shell, fns } = makeFakeShell({
      endpoints: [
        summary({
          endpoint_id: 'ep-tod',
          kind: 'scheduling_link',
          expires_at: futureDateAt1430,
        }),
      ],
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-tod' });
    // Untouched date input — the user just clicks Submit.
    h.field({ promptField: 'never_expire', kind: 'checkbox', checked: false });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).toHaveBeenCalledTimes(1);
    expect(fns.extendEndpoint).toHaveBeenCalledWith('ep-tod', futureDateAt1430);
    prompts.dispose();
  });

  it('parses the typed date once the user edits the input (typed date wins)', async () => {
    const h = makeFakeHost();
    const futureDateAt1430 =
      Date.parse('2026-12-01') + 14 * 60 * 60 * 1000 + 30 * 60 * 1000;
    const { shell, fns } = makeFakeShell({
      endpoints: [
        summary({
          endpoint_id: 'ep-tod',
          kind: 'scheduling_link',
          expires_at: futureDateAt1430,
        }),
      ],
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-tod' });
    h.field({ promptField: 'never_expire', kind: 'checkbox', checked: false });
    h.field({ promptField: 'expires_at_date', kind: 'date', value: '2027-01-15' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    // User-typed date — UTC midnight of 2027-01-15, NOT the original
    // 14:30 UTC.
    expect(fns.extendEndpoint).toHaveBeenCalledWith(
      'ep-tod',
      Date.parse('2027-01-15'),
    );
    prompts.dispose();
  });

  it('typing the same yyyy-mm-dd back also forces the typed path (date_edited flips on every edit)', async () => {
    // Edge: user types the seeded value back identically — we still
    // treat it as an explicit edit, since the keystroke means the user
    // saw + chose this representation. UTC midnight is the result.
    const h = makeFakeHost();
    const futureDateAt1430 =
      Date.parse('2026-12-01') + 14 * 60 * 60 * 1000 + 30 * 60 * 1000;
    const { shell, fns } = makeFakeShell({
      endpoints: [
        summary({
          endpoint_id: 'ep-tod',
          kind: 'scheduling_link',
          expires_at: futureDateAt1430,
        }),
      ],
    });
    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });
    prompts.open('reception-extend', { endpointId: 'ep-tod' });
    h.field({ promptField: 'never_expire', kind: 'checkbox', checked: false });
    h.field({ promptField: 'expires_at_date', kind: 'date', value: '2026-12-01' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.extendEndpoint).toHaveBeenCalledWith(
      'ep-tod',
      Date.parse('2026-12-01'),
    );
    expect(fns.extendEndpoint).not.toHaveBeenCalledWith('ep-tod', futureDateAt1430);
    prompts.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Codex P2 — DD#8: stale completions never touch a later modal.
// ══════════════════════════════════════════════════════════════════

/** Build a manually-resolvable promise — used to interleave a slow
 *  rpc completion with user input that should invalidate it. */
const makeDeferred = <T,>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('D-149 follow-on — stale-completion guard', () => {
  it('a slow rotate that settles after cancel+open does not register a share or close the new modal', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    // Replace rotateToken with a deferred path so we can land its
    // success completion AFTER the user has moved on.
    const deferred = makeDeferred<ReceptionEndpointRotateResult>();
    fns.rotateToken.mockImplementation(() => deferred.promise);

    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });

    // 1. Open rotate prompt for ep-sched + submit (rotate is now in flight).
    prompts.open('reception-rotate-token', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    expect(fns.rotateToken).toHaveBeenCalledTimes(1);

    // 2. User cancels the rotate prompt + opens a fresh revoke prompt
    //    for a different endpoint. The rotate rpc is still in flight.
    h.click({ action: 'reception-prompt-cancel' });
    prompts.open('reception-revoke', { endpointId: 'ep-drop' });
    expect(h.getHtml()).toContain('Take this link back');

    // 3. Now resolve the stale rotate. The success path should NOT
    //    register a share (the user moved on) and NOT close the revoke
    //    modal (its token is fresh).
    deferred.resolve({
      bearer_secret_once: 'bs-stale',
      share_url_once: 'https://reception.example/stale?t=once',
    });
    await flush();
    expect(fns.setEndpointShare).not.toHaveBeenCalled();
    // The revoke modal is still up.
    expect(h.getHtml()).toContain('Take this link back');
    prompts.dispose();
  });

  it('a slow rejected rotate that settles after cancel+open does not paint its error onto the new modal', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const deferred = makeDeferred<ReceptionEndpointRotateResult>();
    fns.rotateToken.mockImplementation(() => deferred.promise);

    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });

    prompts.open('reception-rotate-token', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    h.click({ action: 'reception-prompt-cancel' });
    prompts.open('reception-revoke', { endpointId: 'ep-drop' });

    deferred.reject(new Error('stale_rotate_failure'));
    await flush();
    // The revoke modal must NOT carry the stale rotate's error message.
    expect(h.getHtml()).not.toContain('stale_rotate_failure');
    expect(h.getHtml()).toContain('Take this link back');
    prompts.dispose();
  });

  it('a slow rpc that settles after dispose() is fully inert', async () => {
    const h = makeFakeHost();
    const { shell, fns } = makeFakeShell();
    const deferred = makeDeferred<undefined>();
    fns.revokeEndpoint.mockImplementation(() => deferred.promise);

    const prompts = mountReceptionPromptsHost({
      host: h.host,
      shell,
      now: () => NOW,
    });

    prompts.open('reception-revoke', { endpointId: 'ep-sched' });
    h.click({ action: 'reception-prompt-submit' });
    await flush();
    prompts.dispose();
    deferred.resolve(undefined);
    await flush();
    // Nothing to assert positively — the test passes if no
    // unhandled-rejection / postdispose host mutation occurs. Confirm
    // the host stayed cleared.
    expect(h.getHtml()).toBe('');
  });
});
