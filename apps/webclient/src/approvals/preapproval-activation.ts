/** Manual automation review prepares the same owner proposal as a kernel
 * request. Only the shared review page can record an owner decision. */
import { parsePreparePreapproval, PREAPPROVAL_LIMITS, type PreparePreapproval, type PreapprovalResult } from '@recued/contracts';
import { RunModal, wireFocusTrap } from '@recued/ui-shared';

export const openPreapprovalActivation = (opts: {
  document: Document; recipe_id: string; publisher_id: string; name: string;
  activation: PreparePreapproval['activation'];
  scheduledFor?: number | null;
  prepare(request: PreparePreapproval): Promise<PreapprovalResult>;
  onPrepared(result: PreapprovalResult): void;
  onClose?(): void;
}) => {
  const doc = opts.document;
  const overlay = doc.createElement('div');
  overlay.setAttribute(RunModal.RUN_MODAL_OVERLAY_ATTR, opts.recipe_id);
  overlay.setAttribute('data-recued-preapproval-activation', opts.recipe_id);
  const style = doc.createElement('style'); style.textContent = RunModal.RUN_MODAL_STYLES; overlay.append(style);
  const panel = doc.createElement('section'); panel.className = 'run-modal-panel'; panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', 'Look at the next run');
  const header = doc.createElement('header'); header.className = 'run-modal-header';
  const title = doc.createElement('h2'); title.className = 'run-modal-title'; title.textContent = 'Look at the next run'; header.append(title);
  const close = doc.createElement('button'); close.type = 'button'; close.className = 'run-modal-button run-modal-close'; close.textContent = 'Close'; header.append(close);
  panel.append(header);
  const form = doc.createElement('form'); form.className = 'run-modal-body';
  const description = doc.createElement('p'); description.textContent = `${opts.name} — look at the next run that qualifies, using the settings it already has.`; form.append(description);
  const label = doc.createElement('label'); label.textContent = 'Run before this time (your time)';
  const until = doc.createElement('input'); until.type = 'datetime-local'; until.required = true;
  until.setAttribute('data-recued-preapproval-run-before', '');
  const defaultUntil = new Date(Math.max(Date.now() + PREAPPROVAL_LIMITS.default_decision_ms, opts.scheduledFor ?? 0)
    + PREAPPROVAL_LIMITS.default_dispatch_grace_ms);
  until.value = new Date(defaultUntil.getTime() - defaultUntil.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  label.append(until); form.append(label);
  const note = doc.createElement('p'); note.textContent = 'This says yes to the next run only. Later runs still ask you as usual. '
    + (opts.activation.kind === 'next_auto_run' ? 'Checks that watch for changes still ask you as usual. ' : '')
    + 'The next page shows what will happen, which files get read, and anything that still needs your yes.'; form.append(note);
  const error = doc.createElement('p'); error.setAttribute('role', 'alert'); form.append(error);
  const submit = doc.createElement('button'); submit.type = 'submit'; submit.className = 'run-modal-button run-modal-button--primary'; submit.textContent = 'Look at this run'; form.append(submit);
  panel.append(form); overlay.append(panel); doc.body.append(overlay);
  const focus = wireFocusTrap({ document: doc, getContainer: () => panel });
  let destroyed = false;
  let busy = false;
  let pending: { until: number; request: PreparePreapproval } | undefined;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true; focus.release(); overlay.remove(); opts.onClose?.();
  };
  close.addEventListener('click', destroy);
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); destroy(); }
  });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || destroyed) return;
    void (async () => {
      try {
        const deadline = new Date(until.value).getTime();
        if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Pick a time in the future.');
        if (pending?.until !== deadline) pending = { until: deadline, request: parsePreparePreapproval({
          idempotency_key: crypto.randomUUID(),
          subject: { kind: 'recipe', recipe_id: opts.recipe_id, publisher_id: opts.publisher_id, config: {} },
          activation: opts.activation,
          decision_deadline: Math.min(deadline - 1, Date.now() + PREAPPROVAL_LIMITS.default_decision_ms),
          dispatch_deadline: deadline,
        }) };
        busy = true; submit.disabled = true; until.disabled = true; submit.textContent = 'Opening review…'; error.textContent = '';
        const result = await opts.prepare(pending.request);
        if (destroyed) return;
        destroy(); opts.onPrepared(result);
      } catch (failure) {
        if (!destroyed) error.textContent = failure instanceof Error ? failure.message : 'Recued could not get this ready. Try again.';
      } finally {
        busy = false;
        if (!destroyed) { submit.disabled = false; until.disabled = false; submit.textContent = 'Look at this run'; }
      }
    })();
  });
  return { destroy, hasInFlightWork: () => busy };
};
