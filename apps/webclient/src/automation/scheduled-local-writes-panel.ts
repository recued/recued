import type { Conn, LocalAutomationReview, ServerRpcRegistry } from '@recued/contracts';
/** Kept mounted across the automation route's background refreshes. */
export const mountScheduledLocalWritesPanel = (options: { host: HTMLElement; scheduleId: string; call: Conn<ServerRpcRegistry> }) => {
  const { host, scheduleId, call } = options, doc = host.ownerDocument;
  const content = doc.createElement('div'); content.className = 'automation-detail-section scheduled-local-writes'; host.append(content);
  let view: LocalAutomationReview | undefined, busy = false, disposed = false;
  const node = (tag: string, value: string) => { const el = doc.createElement(tag); el.textContent = value; return el; };
  const render = (error?: string) => {
    if (disposed) return;
    content.replaceChildren(); content.setAttribute('aria-busy', String(busy));
    if (error) { const message = node('p', error); message.setAttribute('role', 'alert'); content.append(message); }
    if (!view) {
      content.append(node('p', busy ? 'Loading local write permissions…' : 'Open a fresh review to continue.'));
      if (!busy) {
        const retry = node('button', 'Refresh review') as HTMLButtonElement; retry.type = 'button'; retry.className = 'automation-button';
        retry.addEventListener('click', () => { void perform(async () => { view = await call('schedules.local_writes.review', { schedule_id: scheduleId }); }); }); content.append(retry);
      }
      return;
    }
    const authorization = view.authorization;
    if (authorization) content.append(node('p', authorization.current
      ? `Allowed until ${new Date(authorization.expires_at).toLocaleString()}. ${authorization.uses_remaining} writes remain.`
      : 'The previous authorization no longer covers this schedule. Its writes need review.'));
    if (!view.supported) content.append(node('p', view.reason ?? 'This recipe has no supported local write scope.'));
    else {
      content.append(node('p', `${view.recipe_name} may update these ${view.records?.length ?? 0} existing source links using ${view.connection}.`));
      content.append(node('p', `Asset fields: ${(view.asset_fields ?? []).map(field => field === 'dates.expires_on' ? 'Expiry date' : field).join(', ') || 'None'}. Manual dates keep their priority.`));
      content.append(node('p', `Source-link bookkeeping: ${(view.record_fields ?? []).map(field => field.replaceAll('_', ' ')).join(', ')}.`));
      content.append(node('p', 'Existing asset rules continue to manage reminders when a date changes.'));
      const mappings = doc.createElement('details'); mappings.append(node('summary', 'Review source mappings'));
      for (const record of view.records ?? []) mappings.append(node('pre', JSON.stringify(record.values, null, 2)));
      content.append(mappings, node('p', 'Allow these local writes for 30 days, up to 1,000 writes. Changes to the recipe, connection, schedule or source mappings require another review.'));
    }
    const actions = doc.createElement('div'); actions.className = 'automation-row-actions';
    const button = (label: string, action: () => Promise<void>) => {
      const el = node('button', label) as HTMLButtonElement; el.type = 'button'; el.className = 'automation-button'; el.disabled = busy;
      el.addEventListener('click', () => { void perform(action); }); actions.append(el);
    };
    if (view.supported && view.review_id && !authorization?.current) button('Allow local writes for 30 days', async () => {
      view = await call('schedules.local_writes.authorize', { schedule_id: scheduleId, review_id: view!.review_id! });
    });
    if (authorization) button('Take back authorization', async () => {
      await call('schedules.local_writes.revoke', { schedule_id: scheduleId });
      view = await call('schedules.local_writes.review', { schedule_id: scheduleId });
    });
    button('Refresh review', async () => { view = await call('schedules.local_writes.review', { schedule_id: scheduleId }); });
    content.append(actions);
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy || disposed) return; busy = true; render();
    let error: string | undefined;
    try { await action(); } catch (failure) { error = failure instanceof Error ? failure.message : 'The local write permission could not be saved.'; }
    finally { busy = false; render(error); }
  };
  void perform(async () => { view = await call('schedules.local_writes.review', { schedule_id: scheduleId }); });
  return { dispose: () => { disposed = true; content.remove(); }, pending: () => busy };
};
