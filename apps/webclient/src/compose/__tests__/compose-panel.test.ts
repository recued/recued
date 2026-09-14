/** D-174 P5 - Compose local draft route. */

import { describe, expect, it, vi } from 'vitest';
import type {
  ContactRecord,
  WorkEntity,
  WorkEntityUpsertRpcRequest,
} from '@recued/contracts';

import {
  bootstrapComposeRoute,
  COMPOSE_LOCAL_TARGETS,
  COMPOSE_ROUTE_COMMIT_ATTR,
  COMPOSE_ROUTE_CONFIRMATION_ATTR,
  COMPOSE_ROUTE_ERROR_ATTR,
  COMPOSE_ROUTE_FIELD_ATTR,
  COMPOSE_ROUTE_HEADING_ATTR,
  COMPOSE_ROUTE_HOST_ATTR,
  COMPOSE_ROUTE_INTENT_ATTR,
  COMPOSE_ROUTE_PREVIEW_ATTR,
  COMPOSE_ROUTE_STATUS_ATTR,
  COMPOSE_ROUTE_STYLES_MARKER,
  COMPOSE_ROUTE_TARGET_CHIP_ATTR,
  type ComposeContactUpsertCaller,
  type ComposeWorkEntityUpsertCaller,
} from '../compose-route.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  value: string;
  type: string;
  checked: boolean;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  querySelectorAll(sel: string): FakeEl[];
  click(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: {
    querySelector(sel: string): FakeEl | null;
    appendChild(el: FakeEl): FakeEl;
  };
  createElement(tag: string): FakeEl;
}

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

const firstByAttr = (root: FakeEl, attr: string): FakeEl | undefined =>
  collectByAttr(root, attr)[0];

const textTree = (root: FakeEl): string =>
  [root.textContent, ...root.children.map(textTree)]
    .filter((part) => part.length > 0)
    .join(' ');

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    type: '',
    checked: false,
    disabled: false,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'type') el.type = v;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    querySelectorAll(sel) {
      const m = sel.match(/^\[([\w-]+)\]$/);
      if (m === null) return [];
      return collectByAttr(el, m[1]!);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchStyleSelector = (sel: string): { attr: string } | null => {
    const m = sel.match(/^style\[([\w-]+)\]$/);
    return m === null ? null : { attr: m[1]! };
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const parsed = matchStyleSelector(sel);
        if (parsed === null) return null;
        return styleElements.find((s) => s.attrs.has(parsed.attr)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

const contactRecord = (
  overrides: Partial<ContactRecord> & { email: string },
): ContactRecord => ({
  ...overrides,
  id: overrides.email,
  canonical_id: overrides.email,
  created_at: 1,
  updated_at: 1,
  email: overrides.email,
  name: overrides.name,
} as ContactRecord);

const workEntity = (
  overrides: Record<string, unknown>,
): WorkEntity => overrides as unknown as WorkEntity;

const mountFor = (
  options: {
    contactUpsertCaller?: ComposeContactUpsertCaller;
    workEntityUpsertCaller?: ComposeWorkEntityUpsertCaller;
    initialCaptureText?: string;
  } = {},
) => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const contactUpsertCaller =
    options.contactUpsertCaller ??
    vi.fn<ComposeContactUpsertCaller>(async (args) => ({
      contact: contactRecord({
        email: args.email,
        name: args.name,
      }),
    }));
  const workEntityUpsertCaller =
    options.workEntityUpsertCaller ??
    vi.fn<ComposeWorkEntityUpsertCaller>(async (args) => ({
      entity: workEntity({
        _kind: (args as { kind: string }).kind,
        id: `${(args as { kind: string }).kind}-1`,
        ...args,
      }),
    }));
  const route = bootstrapComposeRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    contactUpsertCaller,
    workEntityUpsertCaller,
    ...(options.initialCaptureText !== undefined
      ? { initialCaptureText: options.initialCaptureText }
      : {}),
  });
  return { doc, root, route, contactUpsertCaller, workEntityUpsertCaller };
};

const fieldKeys = (root: FakeEl): string[] =>
  collectByAttr(root, COMPOSE_ROUTE_FIELD_ATTR).map((field) =>
    field.getAttribute(COMPOSE_ROUTE_FIELD_ATTR) ?? '',
  );

const targetKeys = (root: FakeEl): string[] =>
  collectByAttr(root, COMPOSE_ROUTE_TARGET_CHIP_ATTR).map((chip) =>
    chip.getAttribute(COMPOSE_ROUTE_TARGET_CHIP_ATTR) ?? '',
  );

describe('D-174 P5 Compose local draft route', () => {
  it('reports unfinished values across parked target drafts', () => {
    const { route } = mountFor();

    expect(route.hasUnsavedChanges()).toBe(false);
    route.setFieldValues({ email: 'unfinished@example.test' });
    expect(route.hasUnsavedChanges()).toBe(true);

    route.selectTarget('task');
    expect(route.hasUnsavedChanges()).toBe(true);
    route.selectTarget('contact');
    route.setFieldValues({ email: '' });
    expect(route.hasUnsavedChanges()).toBe(false);

    route.selectTarget('commitment');
    expect(route.hasUnsavedChanges()).toBe(false);
    route.setFieldValues({ direction: 'inbound' });
    expect(route.hasUnsavedChanges()).toBe(true);
    route.setFieldValues({ direction: 'outbound' });
    expect(route.hasUnsavedChanges()).toBe(false);
    route.dispose();
  });

  it('mounts local-only target chips in fixed order (incl. project), no write-back target', () => {
    const { doc, root, route } = mountFor();
    const shell = root.children[0]!;

    expect(shell.attrs.has(COMPOSE_ROUTE_HOST_ATTR)).toBe(true);
    expect(firstByAttr(shell, COMPOSE_ROUTE_HEADING_ATTR)?.textContent).toBe('Compose');
    // R18 — Project joins the fast-access create so its kind set matches Data's.
    expect(targetKeys(shell)).toEqual(['contact', 'task', 'note', 'commitment', 'project', 'booking']);
    expect(targetKeys(shell)).toEqual(COMPOSE_LOCAL_TARGETS.map((target) => target.kind));
    expect(targetKeys(shell)).toContain('project');
    // Write-back targets (calendar / CRM sync) are still NOT local-create kinds.
    expect(textTree(shell)).not.toContain('write_back_op');
    expect(textTree(shell)).not.toContain('Calendar event');
    expect(textTree(shell)).not.toContain('CRM sync');
    expect(firstByAttr(shell, COMPOSE_ROUTE_STATUS_ATTR)?.getAttribute('role')).toBe(
      'status',
    );
    expect(doc.styleElements).toHaveLength(1);
    expect(doc.styleElements[0]?.attrs.has(COMPOSE_ROUTE_STYLES_MARKER)).toBe(true);
    expect(doc.styleElements[0]?.textContent).toContain(
      `[${COMPOSE_ROUTE_TARGET_CHIP_ATTR}] {\n  min-height: 36px;`,
    );
    expect(doc.styleElements[0]?.textContent).toMatch(
      /textarea,\n[^}]*input,\n[^}]*select\s*\{[^}]*min-height:\s*36px;/s,
    );
    expect(doc.styleElements[0]?.textContent).toContain(
      `[${COMPOSE_ROUTE_COMMIT_ATTR}] {\n  justify-self: start;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  min-height: 36px;`,
    );

    route.dispose();
  });

  it('selecting each target shows the expected local fields', () => {
    const { root, route } = mountFor();

    expect(fieldKeys(root)).toEqual(['email', 'name', 'phone', 'company']);

    route.selectTarget('task');
    expect(fieldKeys(root)).toEqual(['title', 'body', 'due_at', 'priority']);

    route.selectTarget('note');
    expect(fieldKeys(root)).toEqual(['title', 'body']);

    route.selectTarget('commitment');
    expect(fieldKeys(root)).toEqual([
      'statement',
      'promised_for_at',
      'direction',
      'derivation',
      'expiry_policy',
    ]);

    // R18 — project quick-capture fields.
    route.selectTarget('project');
    expect(fieldKeys(root)).toEqual([
      'title',
      'description',
      'target_completion_at',
      'state',
    ]);

    route.dispose();
  });

  it('exposes every visually required field to assistive technology', () => {
    const { root, route } = mountFor();
    const requiredFieldKeys = (): string[] =>
      collectByAttr(root, 'aria-required').map((field) =>
        field.getAttribute(COMPOSE_ROUTE_FIELD_ATTR) ?? '',
      );

    expect(requiredFieldKeys()).toEqual(['email']);
    route.selectTarget('task');
    expect(requiredFieldKeys()).toEqual(['title']);
    route.selectTarget('note');
    expect(requiredFieldKeys()).toEqual(['body']);
    route.selectTarget('commitment');
    expect(requiredFieldKeys()).toEqual(['statement']);
    route.selectTarget('project');
    expect(requiredFieldKeys()).toEqual(['title']);

    route.dispose();
  });

  it('exposes one selected target in a named toggle group', () => {
    const { root, route } = mountFor();
    const group = collectByAttr(root, 'role').find(
      (element) => element.getAttribute('role') === 'group',
    );
    const chips = collectByAttr(root, COMPOSE_ROUTE_TARGET_CHIP_ATTR);

    expect(group?.getAttribute('aria-label')).toBe('Create type');
    // ⚠ Derived from the chip count, not a hand-counted list: this assertion
    // has been re-typed once per new target, which is how it stays a count
    // rather than a claim. What it pins is "exactly one is pressed, and it is
    // the first" — the part that is actually about the toggle group.
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(
      chips.map((_chip, index) => (index === 0 ? 'true' : 'false')),
    );
    expect(chips.filter((chip) => chip.getAttribute('aria-pressed') === 'true'))
      .toHaveLength(1);

    route.selectTarget('task');
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(
      chips.map((chip) =>
        chip.getAttribute(COMPOSE_ROUTE_TARGET_CHIP_ATTR) === 'task' ? 'true' : 'false'),
    );

    // The LAST chip is reachable too — a selection assertion that only ever
    // names index 0 or 1 would stay green if a newly added target rendered
    // unpressable.
    route.selectTarget('booking');
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(
      chips.map((chip) =>
        chip.getAttribute(COMPOSE_ROUTE_TARGET_CHIP_ATTR) === 'booking' ? 'true' : 'false'),
    );

    route.dispose();
  });

  it('preserves each unfinished target draft while switching kinds', () => {
    const { route } = mountFor();

    route.setFieldValues({
      email: 'lee@example.test',
      name: 'Lee Morgan',
    });
    route.selectTarget('contact');
    expect(route.getState().values).toMatchObject({
      email: 'lee@example.test',
      name: 'Lee Morgan',
    });

    route.selectTarget('task');
    route.setFieldValues({
      title: 'Prepare launch',
      body: 'Review the final checklist.',
    });
    route.selectTarget('contact');
    expect(route.getState().values).toMatchObject({
      email: 'lee@example.test',
      name: 'Lee Morgan',
    });

    route.selectTarget('task');
    expect(route.getState().values).toMatchObject({
      title: 'Prepare launch',
      body: 'Review the final checklist.',
    });

    route.dispose();
  });

  it('updates ordinary fields without replacing their native focus targets', () => {
    const { root, route } = mountFor();
    route.selectTarget('task');

    const title = collectByAttr(root, COMPOSE_ROUTE_FIELD_ATTR).find(
      (field) => field.getAttribute(COMPOSE_ROUTE_FIELD_ATTR) === 'title',
    )!;
    title.value = 'Draft launch';
    for (const listener of title.listeners.get('change') ?? []) listener();
    expect(collectByAttr(root, COMPOSE_ROUTE_FIELD_ATTR).find(
      (field) => field.getAttribute(COMPOSE_ROUTE_FIELD_ATTR) === 'title',
    )).toBe(title);

    const priority = collectByAttr(root, COMPOSE_ROUTE_FIELD_ATTR).find(
      (field) => field.getAttribute(COMPOSE_ROUTE_FIELD_ATTR) === 'priority',
    )!;
    priority.value = 'high';
    for (const listener of priority.listeners.get('change') ?? []) listener();
    expect(collectByAttr(root, COMPOSE_ROUTE_FIELD_ATTR).find(
      (field) => field.getAttribute(COMPOSE_ROUTE_FIELD_ATTR) === 'priority',
    )).toBe(priority);
    expect(route.getState().values).toMatchObject({
      title: 'Draft launch',
      priority: 'high',
    });

    route.dispose();
  });

  it('commits contacts through contact.upsert, confirms, and resets the draft', async () => {
    const contactUpsertCaller = vi.fn<ComposeContactUpsertCaller>(async (args) => ({
      contact: contactRecord({
        email: args.email,
        name: args.name,
        phone: args.phone,
        company: args.company,
      }),
    }));
    const { root, route } = mountFor({ contactUpsertCaller });

    route.setFieldValues({
      email: 'lee@example.com',
      name: 'Lee Morgan',
      phone: '+15555550123',
      company: 'Example Co',
    });
    await route.commitDraft();

    expect(contactUpsertCaller).toHaveBeenCalledWith({
      email: 'lee@example.com',
      name: 'Lee Morgan',
      phone: '+15555550123',
      company: 'Example Co',
    });
    expect(route.getState().stage).toBe('committed');
    expect(route.getState().capture_text).toBe('');
    expect(route.getState().values).toEqual({});
    expect(route.hasUnsavedChanges()).toBe(false);
    expect(route.getState().confirmation).toMatchObject({
      target: 'contact',
      rpc: 'contact.upsert',
      label: 'Lee Morgan',
      entity_id: 'lee@example.com',
    });
    const confirmationText = textTree(firstByAttr(root, COMPOSE_ROUTE_CONFIRMATION_ATTR)!);
    expect(confirmationText).toContain('Lee Morgan');
    // The internal RPC name must not leak into the post-commit confirmation.
    expect(confirmationText).not.toContain('contact.upsert');

    route.dispose();
  });

  it('keeps a pending commit focusable and guards duplicate writes', async () => {
    let resolveCommit!: (value: { contact: ContactRecord }) => void;
    const pendingCommit = new Promise<{ contact: ContactRecord }>((resolve) => {
      resolveCommit = resolve;
    });
    const contactUpsertCaller = vi.fn<ComposeContactUpsertCaller>(
      () => pendingCommit,
    );
    const { root, route } = mountFor({ contactUpsertCaller });
    route.setFieldValues({
      email: 'lee@example.com',
      name: 'Lee Morgan',
    });

    const firstCommit = route.commitDraft();
    const busyCommit = firstByAttr(root, COMPOSE_ROUTE_COMMIT_ATTR)!;
    expect(route.getState().stage).toBe('committing');
    expect(busyCommit.textContent).toBe('Committing…');
    expect(busyCommit.disabled).toBe(false);
    expect(busyCommit.getAttribute('aria-disabled')).toBe('true');
    expect(busyCommit.getAttribute('aria-busy')).toBe('true');

    await route.commitDraft();
    expect(contactUpsertCaller).toHaveBeenCalledTimes(1);

    resolveCommit({
      contact: contactRecord({
        email: 'lee@example.com',
        name: 'Lee Morgan',
      }),
    });
    await firstCommit;
    expect(route.getState().stage).toBe('committed');

    route.dispose();
  });

  it('uses capture text as a task draft and commits via work_entity.upsert', async () => {
    const workEntityUpsertCaller = vi.fn<ComposeWorkEntityUpsertCaller>(async (args) => ({
      entity: workEntity({
        _kind: 'task',
        id: 'task-1',
        title: (args as { title: string }).title,
      }),
    }));
    const { route } = mountFor({ workEntityUpsertCaller });

    route.setCaptureText('Call Sam');
    route.selectTarget('task');
    route.setFieldValues({
      body: 'Discuss renewal',
      due_at: '2026-06-08',
      priority: 'high',
    });
    await route.commitDraft();

    expect(workEntityUpsertCaller).toHaveBeenCalledWith({
      kind: 'task',
      title: 'Call Sam',
      body: 'Discuss renewal',
      due_at: Date.parse('2026-06-08T00:00:00.000Z'),
      priority: 'high',
    } satisfies WorkEntityUpsertRpcRequest);
    expect(route.getState().confirmation).toMatchObject({
      target: 'task',
      rpc: 'work_entity.upsert',
      label: 'Call Sam',
      entity_id: 'task-1',
    });
    expect(route.getState().capture_text).toBe('');
    expect(route.getState().values).toEqual({});

    route.dispose();
  });

  it('commits note and commitment targets with their kind-specific payloads', async () => {
    const workEntityUpsertCaller = vi.fn<ComposeWorkEntityUpsertCaller>(async (args) => ({
      entity: workEntity({
        _kind: (args as { kind: string }).kind,
        id: `${(args as { kind: string }).kind}-1`,
        ...args,
      }),
    }));
    const { route } = mountFor({ workEntityUpsertCaller });

    route.selectTarget('note');
    route.setFieldValues({
      title: 'Prep',
      body: 'Bring the final packet.',
    });
    await route.commitDraft();

    route.selectTarget('commitment');
    route.setFieldValues({
      statement: 'Send renewal terms',
      promised_for_at: '2026-06-10',
      direction: 'outbound',
      derivation: 'user_declared',
      expiry_policy: 'escalate_overdue',
    });
    await route.commitDraft();

    expect(workEntityUpsertCaller).toHaveBeenNthCalledWith(1, {
      kind: 'note',
      title: 'Prep',
      body: 'Bring the final packet.',
    } satisfies WorkEntityUpsertRpcRequest);
    expect(workEntityUpsertCaller).toHaveBeenNthCalledWith(2, {
      kind: 'commitment',
      statement: 'Send renewal terms',
      promised_for_at: Date.parse('2026-06-10T00:00:00.000Z'),
      direction: 'outbound',
      derivation: 'user_declared',
      expiry_policy: 'escalate_overdue',
    } satisfies WorkEntityUpsertRpcRequest);
    expect(route.getState().confirmation).toMatchObject({
      target: 'commitment',
      rpc: 'work_entity.upsert',
      label: 'Send renewal terms',
      entity_id: 'commitment-1',
    });

    route.dispose();
  });

  it('commits a project target via work_entity.upsert with its quick-capture fields', async () => {
    const workEntityUpsertCaller = vi.fn<ComposeWorkEntityUpsertCaller>(async (args) => ({
      entity: workEntity({
        _kind: (args as { kind: string }).kind,
        id: `${(args as { kind: string }).kind}-1`,
        ...args,
      }),
    }));
    const { route } = mountFor({ workEntityUpsertCaller });

    route.selectTarget('project');
    route.setFieldValues({
      title: 'Q3 launch',
      description: 'Coordinate the rollout.',
      target_completion_at: '2026-09-01',
      state: 'active',
    });
    await route.commitDraft();

    expect(workEntityUpsertCaller).toHaveBeenCalledWith({
      kind: 'project',
      title: 'Q3 launch',
      description: 'Coordinate the rollout.',
      target_completion_at: Date.parse('2026-09-01T00:00:00.000Z'),
      state: 'active',
    } satisfies WorkEntityUpsertRpcRequest);
    expect(route.getState().confirmation).toMatchObject({
      target: 'project',
      rpc: 'work_entity.upsert',
      label: 'Q3 launch',
      entity_id: 'project-1',
    });

    route.dispose();
  });

  it('does not expose the retired Reception endpoint generation controls', () => {
    const { root, route } = mountFor();
    const shell = root.children[0]!;

    expect(firstByAttr(shell, COMPOSE_ROUTE_COMMIT_ATTR)?.textContent).toBe(
      'Commit Contact',
    );
    expect(firstByAttr(shell, COMPOSE_ROUTE_PREVIEW_ATTR)).toBeDefined();
    expect(textTree(shell)).not.toContain('Generate preview');
    expect(textTree(shell)).not.toContain('Create endpoint');
    expect(textTree(shell)).not.toContain('Template');
    expect(targetKeys(shell)).toEqual(['contact', 'task', 'note', 'commitment', 'project', 'booking']);

    route.dispose();
  });

  it('surfaces missing local write callers as STOP-style wiring errors', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapComposeRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
    });

    route.setFieldValues({ email: 'lee@example.com' });
    await route.commitDraft();

    expect(route.getState().stage).toBe('error');
    expect(route.getState().error).toBe(
      'This server cannot save contacts yet.',
    );
    expect(firstByAttr(root, COMPOSE_ROUTE_ERROR_ATTR)?.getAttribute('data-active')).toBe(
      'true',
    );

    route.dispose();
  });
});

describe('D-267 follow-on — the Booking capture target', () => {
  const bookingRig = () => {
    const workEntityUpsertCaller = vi.fn<ComposeWorkEntityUpsertCaller>(
      async () => ({ entity: { _kind: 'booking', id: 'bk_1', title: 'Haircut' } as never }),
    );
    const rig = mountFor({ workEntityUpsertCaller });
    rig.route.selectTarget('booking');
    return { ...rig, workEntityUpsertCaller };
  };

  it('is born CONFIRMED — never the lifecycle list\'s first member', async () => {
    const { route, workEntityUpsertCaller } = bookingRig();
    // ⛔ `pending` sorts FIRST in `BOOKING_LIFECYCLE_STATES` and is explicitly
    // NOT the default; the contract names the default precisely so nobody
    // reaches for `[0]`. A booking is normally created at the moment it is
    // approved, so `confirmed` is what a hand-made one is born as too.
    expect(route.getState().values.lifecycle_state).toBe('confirmed');
    route.setFieldValues({ title: 'Haircut' });
    await route.commitDraft();
    expect(workEntityUpsertCaller).toHaveBeenCalledWith({
      kind: 'booking', title: 'Haircut', lifecycle_state: 'confirmed',
    });
  });

  it('⛔ refuses half a slot, and says which half to fix', async () => {
    const { route, workEntityUpsertCaller } = bookingRig();
    route.setFieldValues({ title: 'Haircut', slot_start_at: '2026-09-14T10:00' });
    await route.commitDraft();
    // The store refuses a start with no end — "a corrupt time, not a partly
    // known one". Caught HERE so the owner is told which field to fix instead
    // of reading a server refusal about a record they cannot see.
    expect(route.getState().error).toBe('Add an end time, or remove the start time.');
    expect(workEntityUpsertCaller).not.toHaveBeenCalled();

    route.setFieldValues({ slot_start_at: '', slot_end_at: '2026-09-14T11:00' });
    await route.commitDraft();
    expect(route.getState().error).toBe('Add a start time, or remove the end time.');

    route.setFieldValues({ slot_start_at: '2026-09-14T11:00', slot_end_at: '2026-09-14T10:00' });
    await route.commitDraft();
    expect(route.getState().error).toBe('The end time must be after the start time.');
    expect(workEntityUpsertCaller).not.toHaveBeenCalled();
  });

  it('sends a whole slot as epoch ms, and no slot at all when none is given', async () => {
    const { route, workEntityUpsertCaller } = bookingRig();
    route.setFieldValues({
      title: 'Haircut',
      slot_start_at: '2026-09-14T10:00',
      slot_end_at: '2026-09-14T11:00',
    });
    await route.commitDraft();
    const sent = workEntityUpsertCaller.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      kind: 'booking',
      slot_start_at: new Date('2026-09-14T10:00').getTime(),
      slot_end_at: new Date('2026-09-14T11:00').getTime(),
    });
    // ⚠ Duration is DERIVED server-side and must never be sent.
    expect(sent).not.toHaveProperty('duration');
    // ⛔ And provenance is the SERVER's to write: a hand-made booking must not
    // be able to claim it came from an approved visitor reservation.
    expect(sent).not.toHaveProperty('reception_record_id');

    // Absent entirely is a real state — an enquiry before a time is agreed.
    const second = bookingRig();
    second.route.setFieldValues({ title: 'Enquiry' });
    await second.route.commitDraft();
    const bare = second.workEntityUpsertCaller.mock.calls[0]?.[0];
    expect(bare).toMatchObject({ kind: 'booking', title: 'Enquiry' });
    expect(bare).not.toHaveProperty('slot_start_at');
    expect(bare).not.toHaveProperty('slot_end_at');
  });

  it('⛔ pairs money with its currency, and keeps the amount a STRING', async () => {
    const { route, workEntityUpsertCaller } = bookingRig();
    route.setFieldValues({ title: 'Haircut', monetary_amount: '45.00' });
    await route.commitDraft();
    expect(route.getState().error).toBe('Add a currency, or remove the amount.');

    route.setFieldValues({ monetary_amount: '', monetary_currency: 'gbp' });
    await route.commitDraft();
    expect(route.getState().error).toBe('Add an amount, or remove the currency.');

    route.setFieldValues({ monetary_amount: '45.005', monetary_currency: 'gbp' });
    await route.commitDraft();
    expect(route.getState().error).toBe('The amount has to be a number with no more than two decimal places.');

    route.setFieldValues({ monetary_amount: '45.00', monetary_currency: 'gbp' });
    await route.commitDraft();
    // ⛔ A STRING, never a float: parsing money to a number rounds it.
    expect(workEntityUpsertCaller).toHaveBeenCalledWith(expect.objectContaining({
      monetary_value: { amount: '45.00', currency: 'GBP' },
    }));
  });
});
