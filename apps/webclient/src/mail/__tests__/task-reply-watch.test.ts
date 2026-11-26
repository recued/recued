import { expect, it, vi } from 'vitest';
import type { MailFollowUp, MailFollowUpTaskRef } from '@recued/contracts';
import { createTaskReplyWatchSlots } from '../task-reply-watch.js';

it('keeps every task in a paged status read when Today reorders the same tasks between pages', async () => {
  const now = 1700000000000;
  const refs: MailFollowUpTaskRef[] = Array.from({ length: 201 }, (_, i) => ({ id: 'task-' + i, source_id: 'recued.task', created_at: now + i }));
  const target = refs[150]!;
  const watch: MailFollowUp = { id: 'mfw_00000000-0000-0000-0000-000000000001', revision: 1, subject: 'Estimate', task_ref: target,
    mail_ref: { slug: 'work', record_id: 'sent-1', source_id: 'mail-1', received_at: now - 1, incarnation: 'box-1' },
    state: 'waiting', check_at: now + 1000, created_at: now, updated_at: now };
  const doc = { activeElement: null, visibilityState: 'visible' };
  const elements = refs.map(ref => {
    const element = { dataset: { taskReplyWatch: JSON.stringify(ref) }, ownerDocument: doc, hidden: true, innerHTML: '', contains: () => false,
      replaceChildren: () => { element.innerHTML = ''; } };
    return element;
  });
  let order = elements.slice(), release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const requests: MailFollowUpTaskRef[][] = [];
  const list = vi.fn(async ({ tasks }: { tasks: MailFollowUpTaskRef[] }) => {
    requests.push(tasks); if (requests.length === 1) await held;
    return { available: true, links: tasks.some(ref => ref.id === target.id) ? [{ task_ref: target, watch }] : [], unavailable: [] };
  });
  const root = { ownerDocument: doc, querySelectorAll: () => order, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLElement;
  const slots = createTaskReplyWatchSlots(list, () => now);
  try {
    slots.mount(root); order = elements.slice().reverse(); slots.mount(root); release();
    await expect.poll(() => elements[150]!.hidden).toBe(false);
    expect(elements[150]!.innerHTML).toContain('Waiting for a reply');
    expect(requests.flat().map(ref => ref.id).sort()).toEqual(refs.map(ref => ref.id).sort());
  } finally { release(); slots.dispose(); }
});
