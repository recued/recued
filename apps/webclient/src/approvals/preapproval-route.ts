/** One owner review for a concrete execution. Only the explicit decision
 * controls call decide; navigation, selection and refresh cannot approve. */
import type { Conn, PreapprovalDecision, PreapprovalDecisionRequest, PreapprovalInspection,
  PreapprovalReview, ServerPendingAsk, ServerRpcRegistry } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

export const preapprovalHref = (proposalId?: string): string =>
  serializeShellRoute('approvals', 'preapproval', proposalId);

/** Remove the approval on an already pre-approved rule, from the surface the
 *  owner armed it on — no trip through the review page.
 *
 *  🔑 THE GRANT IS READ FRESH, NEVER CARRIED IN THE ROW. `preapproval.revoke`
 *  CASes on `expected_revision`, and the automation list's `preapproval`
 *  projection carries only `{ proposal_id, future_execution_ref,
 *  execution_status }` — no grant id, and any revision cached into a list
 *  rendered minutes ago is exactly the stale one the CAS exists to reject. One
 *  `get` immediately before the revoke is both the only way to build the
 *  request and the correct way to build it.
 *
 *  ⚠ AN ALREADY-INACTIVE GRANT IS SUCCESS, NOT AN ERROR. The execution can have
 *  been revoked from the review page, expired, or fired between render and
 *  click. The owner asked for it gone; it is gone. Reporting a failure would
 *  push them to press again against a grant that no longer exists.
 *
 *  `requestId` is the caller's to keep STABLE across a retry — the repository
 *  dedupes on `(request_id, responder_key)` and refuses a reused key carrying
 *  different input, so a fresh uuid per attempt would turn a lost response into
 *  a second revocation attempt rather than a replay of the first. */
export const removePreapproval = async (
  call: Conn<ServerRpcRegistry>, proposalId: string, requestId: string,
): Promise<void> => {
  const state = await call('preapproval.get', { proposal_id: proposalId });
  const grant = state.grant;
  if (!grant || grant.status !== 'active') return;
  await call('preapproval.revoke', {
    grant_id: grant.grant_id, expected_revision: grant.revision, request_id: requestId,
  });
};

export const renderPreapprovalAsk = (doc: Document, ask: ServerPendingAsk): HTMLElement | null => {
  if (!ask.owner_review) return null;
  const card = doc.createElement('article'); card.className = 'rx-ask-card';
  card.setAttribute('data-recued-preapproval-ask', ask.ask_id);
  const title = doc.createElement('h3'); title.textContent = ask.title ?? 'Review future execution'; card.append(title);
  const text = doc.createElement('p'); text.textContent = ask.text; card.append(text);
  const link = doc.createElement('a'); link.href = preapprovalHref(ask.owner_review.proposal_id);
  link.textContent = 'Review execution'; card.append(link);
  return card;
};

export const bootstrapPreapprovalRoute = (opts: {
  root: HTMLElement; document?: Document; proposalId?: string; call: Conn<ServerRpcRegistry>; now?: () => number;
}) => {
  const doc = opts.document ?? document; const now = opts.now ?? Date.now;
  const host = doc.createElement('section'); host.setAttribute('data-recued-preapproval-route', '');
  host.style.cssText = 'max-width:960px;margin:auto;padding:24px;color:var(--fg)'; opts.root.append(host);
  let disposed = false, busy = false, generation = 0;
  type ReviewMaterial = Omit<PreapprovalReview, 'challenge' | 'challenge_expires_at'>
    & Partial<Pick<PreapprovalReview, 'challenge' | 'challenge_expires_at'>>;
  let error = '', review: ReviewMaterial | null = null, inspection: PreapprovalInspection | null = null;
  let entries: PreapprovalInspection[] = [], nextCursor: string | null = null;
  let selection = new Set<string>();
  let pendingDecision: PreapprovalDecisionRequest | null = null;
  let pendingRevoke: { grant_id: string; expected_revision: number; request_id: string } | null = null;
  let loaded: Promise<void> = Promise.resolve();
  let renderedExpired = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; return value;
  };
  const link = (label: string, href: string): HTMLAnchorElement => { const value = node('a', label); value.href = href; return value; };
  const status = (value: string): string => value.replaceAll('_', ' ');
  const date = (value: number, zone?: string): string => new Date(value).toLocaleString(undefined,
    zone ? { timeZone: zone, timeZoneName: 'short' } : { timeZoneName: 'short' });
  const button = (label: string, action: () => void, disabled = false): HTMLButtonElement => {
    const value = node('button', label); value.type = 'button'; value.disabled = busy || disabled;
    value.style.cssText = 'margin:4px 8px 4px 0;padding:8px 12px;font:inherit'; value.onclick = action; return value;
  };
  const changedSelection = (): boolean => review !== null && review.members.some(member => member.parent_member_id === null
    && selection.has(member.member_id) !== review!.selected_member_ids.includes(member.member_id));
  const render = (): void => {
    if (disposed) return;
    host.replaceChildren(); host.append(link('Approvals', serializeShellRoute('approvals')));
    host.append(node('h1', opts.proposalId ? review?.recipe.display_name ?? inspection?.retired_review?.recipe_name ?? 'Reviewed execution' : 'Reviewed executions'));
    host.append(button(busy ? 'Loading…' : 'Refresh', () => { void refresh(); }));
    if (error) { const message = node('p', error); message.setAttribute('role', 'alert'); host.append(message); }
    if (!opts.proposalId) {
      if (!busy && entries.length === 0 && !error) host.append(node('p', 'No reviewed executions yet.'));
      const list = node('ul');
      for (const entry of entries) {
        const item = node('li'); item.append(link(`${entry.members[0]?.label ?? 'Execution'} · ${entry.members.length} operations`,
          preapprovalHref(entry.proposal_id)), node('p', `${status(entry.execution_status)} · Requested ${date(entry.created_at)}`));
        list.append(item);
      }
      host.append(list);
      if (nextCursor) host.append(button('Load more', () => { void refresh(nextCursor!); }));
      return;
    }
    host.append(link('All reviewed executions', preapprovalHref()));
    if (inspection) {
      const state = node('p', `Execution: ${status(inspection.execution_status)}`); state.setAttribute('role', 'status'); host.append(state);
      if (inspection.status_reason) host.append(node('p', status(inspection.status_reason)));
      if (inspection.decision) host.append(node('p', `Owner decision: ${status(inspection.decision.decision)} · ${date(inspection.decision.decided_at)}`));
      if (inspection.retired_review) host.append(node('p', `Review content expired on ${date(inspection.retired_review.at)}. The decision and operation outcomes remain available.`));
    }
    if (review) {
      const selectable = (id: string, ancestors = new Set<string>()): boolean => {
        const member = review!.members.find(item => item.member_id === id);
        if (!member?.eligible || ancestors.has(id)) return false;
        const next = new Set(ancestors); next.add(id);
        return member.required_child_ids.every(child => selectable(child, next));
      };
      const who = review.requested_through;
      host.append(node('p', `Requested through ${who.display_name}${who.credential_label ? ` · ${who.credential_label}` : ''}`));
      if (who.contract_id) host.append(node('p', `Contract: ${who.contract_id}`));
      host.append(node('p', review.scheduled_for !== null ? `Scheduled for ${date(review.scheduled_for, review.time_zone)}`
        : `Applies to the ${status(review.activation.kind)} occurrence.`));
      if (review.activation.kind !== 'one_shot') host.append(node('p',
        'This approval covers the next eligible execution only. Later executions keep their ordinary approval requirements.'));
      host.append(node('p', `Decide by ${date(review.decision_deadline, review.time_zone)}. Operations must start by ${date(review.dispatch_deadline, review.time_zone)}.`));
      host.append(node('p', review.coverage === 'complete'
        ? 'One decision covers every reviewed operation and its required reads in this execution.'
        : 'Partial coverage. The calls listed as uncovered keep their normal approval requirements.'));
      for (const note of review.interaction_notes) host.append(node('p', note));
      const selectedByServer = new Set(review.selected_member_ids);
      for (const member of review.members) {
        const section = node('article'); section.style.cssText = 'border:1px solid var(--border);padding:16px;margin:12px 0';
        if (member.parent_member_id) section.style.marginLeft = '20px';
        const label = node('label');
        if (member.parent_member_id === null && inspection?.status === 'awaiting_owner') {
          const check = node('input'); check.type = 'checkbox'; check.checked = selection.has(member.member_id);
          check.disabled = busy || !selectable(member.member_id);
          check.setAttribute('data-preapproval-member', member.member_id);
          check.onchange = () => {
            if (check.checked) selection.add(member.member_id); else selection.delete(member.member_id);
            render();
            host.querySelector<HTMLInputElement>(`[data-preapproval-member="${CSS.escape(member.member_id)}"]`)?.focus();
          };
          label.append(check);
        }
        label.append(doc.createTextNode(`${member.parent_member_id ? 'Required read or sub-operation: ' : ''}${member.label}`)); section.append(label);
        // ⛔ THE TIER LEADS. `always` / `destructive` became reviewable on
        // 2026-09-06, so a member can now be the deletion of a real record —
        // and until this line the review showed content hashes the owner cannot
        // verify by eye while withholding the one fact that decides the answer.
        const tier = node('p', member.risk === 'destructive' ? 'Destructive — this permanently changes or removes data.'
          : member.risk === 'admin' ? 'Admin — this changes account or workspace settings.'
            : member.risk === 'write' ? 'Writes data.' : 'Reads only.');
        tier.setAttribute('data-preapproval-risk', member.risk);
        if (member.risk === 'destructive' || member.risk === 'admin') tier.style.cssText = 'font-weight:650;color:var(--danger)';
        section.append(tier);
        section.append(node('p', member.detail), node('p', member.op_id));
        if (member.conditional) section.append(node('p', 'Runs only when its reviewed condition passes.'));
        if (!selectedByServer.has(member.member_id)) section.append(node('p', member.reason ?? 'Uncovered: not selected.'));
        const content = node('pre', JSON.stringify(member.arguments, null, 2));
        content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; section.append(content);
        if (Object.keys(member.output).length) section.append(node('pre', JSON.stringify(member.output, null, 2)));
        if (member.connection_id) section.append(node('p', `Connection: ${member.connection_id}`));
        if (member.account_id) section.append(node('p', `Account: ${member.account_id}`));
        for (const resource of member.resources) section.append(node('p', `${resource.kind}: ${resource.key} · version ${resource.revision} · ${resource.content_hash}`));
        host.append(section);
      }
      for (const call of review.uncovered) host.append(node('p', `Uncovered ${call.op_id ?? 'call'}: ${call.reason}`));
      if (inspection?.status === 'awaiting_owner') {
        const dirty = changedSelection();
        if (dirty) host.append(button('Update review', () => { void mutate(async () => {
          await opts.call('preapproval.select', { proposal_id: review!.proposal_id, expected_revision: review!.revision, member_ids: [...selection] });
          pendingDecision = null;
        }); }, selection.size === 0));
        const expired = now() >= Math.min(review.challenge_expires_at ?? 0, review.decision_deadline);
        renderedExpired = expired;
        if (expired) host.append(node('p', 'This review needs refreshing before you can decide.'));
        const decide = (decision: PreapprovalDecision): void => {
          if (!review || !review.challenge || busy || dirty || expired) return;
          if (!pendingDecision || pendingDecision.decision !== decision || pendingDecision.expected_revision !== review.revision) {
            pendingDecision = { proposal_id: review.proposal_id, expected_revision: review.revision,
              review_digest: review.review_digest, challenge: review.challenge, decision, request_id: crypto.randomUUID() };
          }
          void mutate(async () => { await opts.call('preapproval.decide', pendingDecision!); });
        };
        host.append(button(review.activation.kind === 'one_shot' || review.activation.kind === 'next_schedule'
          ? 'Approve and schedule' : 'Approve and arm', () => decide('approve'), dirty || expired),
        button('Decline', () => decide('deny'), dirty || expired), button('Cancel action', () => decide('cancel'), dirty || expired));
      }
    }
    if (inspection?.grant?.status === 'active') host.append(button('Revoke unused approval', () => { void mutate(async () => {
      const grant = inspection!.grant!;
      if (!pendingRevoke || pendingRevoke.grant_id !== grant.grant_id || pendingRevoke.expected_revision !== grant.revision) {
        pendingRevoke = { grant_id: grant.grant_id, expected_revision: grant.revision, request_id: crypto.randomUUID() };
      }
      await opts.call('preapproval.revoke', pendingRevoke);
    }); }));
    if (inspection?.decision) {
      host.append(node('h2', 'Operation receipts'));
      for (const member of inspection.members) {
        const row = node('p', `${member.label}: ${status(member.status)}${member.status_message ? ` · ${member.status_message}` : ''}`);
        if (member.commit_id) row.append(doc.createTextNode(` · Receipt ${member.commit_id}`));
        if (member.run_id) row.append(doc.createTextNode(' · '), link('View run', serializeShellRoute('logs', member.run_id)));
        host.append(row);
      }
    }
  };
  const load = async (cursor?: string): Promise<void> => {
    const current = ++generation;
    if (opts.proposalId) {
      const state = await opts.call('preapproval.get', { proposal_id: opts.proposalId });
      const material = state.status === 'awaiting_owner' ? await opts.call('preapproval.review', { proposal_id: opts.proposalId }) : state.reviewed ?? null;
      if (disposed || current !== generation) return;
      inspection = state; review = material;
      pendingDecision = null;
      selection = new Set(material?.members.filter(member => member.parent_member_id === null
        && material.selected_member_ids.includes(member.member_id)).map(member => member.member_id) ?? []);
    } else {
      const page = await opts.call('preapproval.list', cursor ? { cursor } : {});
      if (disposed || current !== generation) return;
      entries = cursor ? [...entries, ...page.proposals] : page.proposals; nextCursor = page.next_cursor;
    }
  };
  const refresh = async (cursor?: string): Promise<void> => {
    if (disposed || busy) return;
    busy = true; error = ''; render();
    try { await load(cursor); } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not load the review.'; }
    finally { busy = false; render(); }
  };
  const mutate = async (action: () => Promise<void>): Promise<void> => {
    if (disposed || busy) return;
    busy = true; error = ''; render();
    try { await action(); await load(); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'The decision could not be confirmed. Refresh to check its status.'; }
    finally { busy = false; render(); }
  };
  loaded = refresh();
  const timer = setInterval(() => {
    if (review?.challenge_expires_at && inspection?.status === 'awaiting_owner' && !busy && !renderedExpired
      && now() >= Math.min(review.challenge_expires_at, review.decision_deadline)) render();
  }, 1_000);
  return { refresh: () => { loaded = refresh(); return loaded; }, whenLoaded: () => loaded,
    hasInFlightWork: () => busy,
    dispose() { disposed = true; generation++; clearInterval(timer); host.remove(); },
  };
};
