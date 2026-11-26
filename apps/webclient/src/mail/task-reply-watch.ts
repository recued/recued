import { MAIL_FOLLOW_UP_STATES, mailFollowUpHref, mailFollowUpReplyHref, mailFollowUpReportHref, mailFollowUpLabel, mailFollowUpAutomaticReplyNotice,
  readMailFollowUpTaskRef, sameMailFollowUpTaskRef, type MailFollowUp, type MailFollowUpTaskRef, type MailFollowUpTaskLinks } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

type List = (args: { tasks: MailFollowUpTaskRef[] }) => Promise<MailFollowUpTaskLinks>;
const keyOf = (ref: MailFollowUpTaskRef) => JSON.stringify([ref.id, ref.source_id, ref.source_record_id ?? null, ref.created_at]);
type WatchFocus = { key: string; control: string };
export const taskReplyWatchSlot = (ref: MailFollowUpTaskRef | null | undefined): string => ref
  ? `<div data-task-reply-watch="${e(JSON.stringify(ref))}" hidden></div>` : '';

/** A read-only attachment to existing task readers and Today rows. Its own
 * updates preserve the task reader, text selection, and completion controls. */
export const createTaskReplyWatchSlots = (list: List | undefined, now = Date.now) => {
  let root: HTMLElement | undefined, signature = '', generation = 0, disposed = false, loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refs: MailFollowUpTaskRef[] = [], slots = new Map<string, HTMLElement[]>();
  const values = new Map<string, { watch?: MailFollowUp; unavailable?: boolean }>();
  let error = false, unsupported = false;
  const paint = () => {
    for (const [key, elements] of slots) for (const element of elements) {
      const value = values.get(key), watch = value?.watch;
      const failed = value?.unavailable || error && (watch || key === keyOf(refs[0]!));
      element.hidden = unsupported || !watch && !failed;
      if (element.hidden) { element.replaceChildren(); continue; }
      const focused = element.contains(element.ownerDocument.activeElement)
        ? (element.ownerDocument.activeElement as HTMLElement).getAttribute('data-task-watch-control') : null;
      const label = watch?.state === 'waiting' && watch.check_at <= now() ? 'Reply check due' : watch ? mailFollowUpLabel(watch) : '';
      element.innerHTML = `<section aria-label="Task email reply watch"><p role="status">${failed ? 'Reply-watch status could not be confirmed.' : e(label)}</p>
        ${!failed && watch && mailFollowUpAutomaticReplyNotice(watch) ? `<p>${e(mailFollowUpAutomaticReplyNotice(watch)!)}</p>` : ''}
        ${!failed && watch?.state === 'delivery_failed' && watch.delivery_failure ? `<p>Reported reason: ${e(watch.delivery_failure.reason ?? watch.delivery_failure.status)}. Task status is unchanged.</p><a href="${e(mailFollowUpReportHref(watch.id))}" data-task-watch-control="report">Review delivery report</a>` : ''}
        ${watch ? `<a href="${e(mailFollowUpHref(watch.id))}" data-task-watch-control="watch">View reply watch</a>
          ${!failed && watch.state === 'replied' && watch.reply_ref ? `<a href="${e(mailFollowUpReplyHref(watch.id))}" data-task-watch-control="reply">Review received reply</a><p>Review the reply before deciding whether this task is complete.</p>` : ''}` : ''}
        <button type="button" data-task-watch-refresh data-task-watch-control="refresh">${loading ? 'Refreshing…' : 'Refresh reply status'}</button></section>`;
      if (focused) element.querySelector<HTMLElement>(`[data-task-watch-control="${focused}"]`)?.focus({ preventScroll: true });
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && refs.length && !unsupported) timer = setTimeout(() => {
      if (root?.isConnected && root.ownerDocument.visibilityState !== 'hidden') void refresh(); else schedule();
    }, 30000);
  };
  const refresh = async () => {
    if (!list || disposed || loading || !refs.length || unsupported) return;
    const ticket = generation, requestedRefs = refs.slice(); loading = true; error = false; paint();
    try {
      const next = new Map<string, { watch?: MailFollowUp; unavailable?: boolean }>();
      for (let offset = 0; offset < requestedRefs.length; offset += 100) {
        const requested = requestedRefs.slice(offset, offset + 100), wanted = new Map(requested.map(ref => [keyOf(ref), ref]));
        const page = await list({ tasks: requested });
        if (disposed || generation !== ticket) return;
        if (page.available === false) { unsupported = true; values.clear(); return; }
        if (page.available !== true) throw Error('Task watch support could not be confirmed');
        if (!Array.isArray(page.links) || !Array.isArray(page.unavailable) || page.links.length + page.unavailable.length > requested.length) throw Error('Invalid task watch page');
        const seen = new Set<string>();
        for (const link of page.links) {
          const ref = readMailFollowUpTaskRef(link.task_ref), saved = readMailFollowUpTaskRef(link.watch?.task_ref);
          if (!ref || !saved || !sameMailFollowUpTaskRef(ref, saved) || !wanted.has(keyOf(ref)) || seen.has(keyOf(ref)) || !MAIL_FOLLOW_UP_STATES.includes(link.watch.state)) throw Error('Wrong task watch scope');
          mailFollowUpHref(link.watch.id); seen.add(keyOf(ref)); next.set(keyOf(ref), { watch: link.watch });
        }
        for (const raw of page.unavailable) {
          const ref = readMailFollowUpTaskRef(raw);
          if (!ref || !wanted.has(keyOf(ref)) || seen.has(keyOf(ref))) throw Error('Wrong task watch scope');
          seen.add(keyOf(ref)); next.set(keyOf(ref), { unavailable: true });
        }
      }
      if (generation === ticket && !disposed) { values.clear(); for (const [key, value] of next) values.set(key, value); }
    } catch (cause) {
      if (generation !== ticket || disposed) return;
      if (classifyRpcError(cause).code === 'unknown_method') unsupported = true; else error = true;
    } finally {
      if (generation === ticket && !disposed) { loading = false; paint(); schedule(); }
    }
  };
  const click = (event: Event) => {
    if ((event.target as Element | null)?.closest('[data-task-watch-refresh]')) { event.preventDefault(); void refresh(); }
  };
  return {
    captureFocus(): WatchFocus | undefined {
      const active = root?.ownerDocument.activeElement as HTMLElement | null, control = active?.getAttribute('data-task-watch-control');
      if (active && control) for (const [key, elements] of slots) if (elements.some(element => element.contains(active))) return { key, control };
      return undefined;
    },
    focus(held: WatchFocus | undefined): boolean {
      if (!held) return false;
      for (const element of slots.get(held.key) ?? []) {
        const target = [...element.querySelectorAll<HTMLElement>('[data-task-watch-control]')].find(node => node.dataset.taskWatchControl === held.control)
          ?? element.querySelector<HTMLElement>('[data-task-watch-refresh]');
        if (target && !element.hidden) { target.focus({ preventScroll: true }); return true; }
      }
      return false;
    },
    mount(nextRoot: HTMLElement) {
      if (!list || disposed) return;
      if (root !== nextRoot) { root?.removeEventListener('click', click); root = nextRoot; root.addEventListener('click', click); }
      const nextSlots = new Map<string, HTMLElement[]>(), nextRefs = new Map<string, MailFollowUpTaskRef>();
      for (const element of nextRoot.querySelectorAll<HTMLElement>('[data-task-reply-watch]')) {
        let ref: MailFollowUpTaskRef | null = null;
        try { ref = readMailFollowUpTaskRef(JSON.parse(element.dataset.taskReplyWatch!)); } catch { /* Invalid slots stay hidden. */ }
        if (!ref) continue; const key = keyOf(ref); nextRefs.set(key, ref); nextSlots.set(key, [...nextSlots.get(key) ?? [], element]);
      }
      slots = nextSlots; refs = [...nextRefs.values()];
      const nextSignature = [...nextRefs.keys()].sort().join('\n');
      if (signature !== nextSignature) {
        signature = nextSignature; generation++; loading = false; values.clear(); error = false; clearTimeout(timer); paint(); void refresh();
      } else paint();
    },
    dispose() { disposed = true; generation++; clearTimeout(timer); root?.removeEventListener('click', click); slots.clear(); values.clear(); },
  };
};
