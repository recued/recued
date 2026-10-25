/** One owner review for a concrete execution. Only the explicit decision
 * controls call decide; navigation, selection and refresh cannot approve. */
import type { Conn, PreapprovalDecision, PreapprovalDecisionRequest, PreapprovalInspection,
  PreapprovalContinuationRequest, PreapprovalReview, ServerPendingAsk, ServerRpcRegistry } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';
import { renderResourceReview, parsePreapprovalContinuation, PREAPPROVAL_LIMITS } from '@recued/contracts';
import { localUpdateUndoControl } from './local-update-undo.js';
import { localChangesHref } from './local-change-sets-route.js';
import { createApprovalReviewLayout } from './review-layout.js';
import { hasLocalUpdateResources, type LocalChangeSetPrepare } from '@recued/contracts';
import { stampZone } from '@recued/ui-shared';
import { RUN_REVIEW_LABEL, RUN_REVIEW_LINK_ATTR, runReviewHref } from '../logs/run-review.js';

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
  const title = doc.createElement('h3'); title.textContent = ask.title ?? 'Look at a future run'; card.append(title);
  const text = doc.createElement('p'); text.textContent = ask.text; card.append(text);
  const link = doc.createElement('a'); link.href = preapprovalHref(ask.owner_review.proposal_id);
  link.textContent = 'Look at this run'; card.append(link);
  return card;
};

export const bootstrapPreapprovalRoute = (opts: {
  root: HTMLElement; document?: Document; proposalId?: string; call: Conn<ServerRpcRegistry>; now?: () => number;
  serverTimeZone?: () => string | undefined;
}) => {
  const doc = opts.document ?? document; const now = opts.now ?? Date.now;
  const host = doc.createElement('section'); host.setAttribute('data-recued-preapproval-route', '');
  opts.root.append(host);
  let disposed = false, busy = false, generation = 0;
  type ReviewMaterial = Omit<PreapprovalReview, 'challenge' | 'challenge_expires_at'>
    & Partial<Pick<PreapprovalReview, 'challenge' | 'challenge_expires_at'>>;
  let error = '', review: ReviewMaterial | null = null, inspection: PreapprovalInspection | null = null;
  let entries: PreapprovalInspection[] = [], nextCursor: string | null = null;
  let selection = new Set<string>();
  let pendingDecision: PreapprovalDecisionRequest | null = null;
  let pendingRevoke: { grant_id: string; expected_revision: number; request_id: string } | null = null;
  let continuationTime = '';
  let pendingContinuation: { time: string; request: PreapprovalContinuationRequest } | null = null;
  let pendingAtomic: LocalChangeSetPrepare | null = null;
  const verificationMessages = new Map<string, string>();
  let pendingVerification: string | null = null;
  let loaded: Promise<void> = Promise.resolve();
  let renderedExpired = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; return value;
  };
  const link = (label: string, href: string): HTMLAnchorElement => { const value = node('a', label); value.href = href; return value; };
  const runLink = (runId: string): HTMLAnchorElement | null => {
    const href = runReviewHref(runId, opts.proposalId === undefined ? {} : {
      returnToWorkspace: { surface: 'approvals', proposalId: opts.proposalId },
    });
    if (href === null) return null;
    const value = link(RUN_REVIEW_LABEL, href);
    value.setAttribute(RUN_REVIEW_LINK_ATTR, '');
    return value;
  };
  const status = (value: string): string => value.replaceAll('_', ' ');
  const date = (value: number, zone?: string): string => new Date(value).toLocaleString(undefined,
    zone ? { timeZone: zone, timeZoneName: 'short' } : { timeZoneName: 'short' });
  const button = (label: string, action: () => void, disabled = false, tone: 'default' | 'primary' = 'default'): HTMLButtonElement => {
    const value = node('button', label); value.type = 'button'; value.disabled = busy || disabled;
    value.className = 'approval-review-button' + (tone === 'primary' ? ' approval-review-button-primary' : '');
    value.onclick = action; return value;
  };
  const changedSelection = (): boolean => review !== null && review.members.some(member => member.parent_member_id === null
    && selection.has(member.member_id) !== review!.selected_member_ids.includes(member.member_id));
  const render = (): void => {
    if (disposed) return;
    const focused = host.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.preapprovalVerifyFocus : undefined;
    host.replaceChildren();
    const layout = createApprovalReviewLayout(doc, host, {
      title: opts.proposalId ? review?.recipe.display_name ?? inspection?.retired_review?.recipe_name ?? 'Run you have looked at' : 'Runs you have looked at',
      view: 'runs',
      refresh: button(busy ? 'Loading…' : 'Refresh', () => { void refresh(); }),
    });
    if (error) { const message = node('p', error); message.setAttribute('role', 'alert'); layout.summary.append(message); }
    if (!opts.proposalId) {
      if (!busy && entries.length === 0 && !error) layout.content.append(node('p', 'You have not looked at any runs yet.'));
      const list = node('ul'); list.className = 'approval-review-list';
      for (const entry of entries) {
        const item = node('li'); item.append(link(`${entry.members[0]?.label ?? 'Execution'} · ${entry.members.length} operations`,
          preapprovalHref(entry.proposal_id)), node('p', `${status(entry.execution_status)} · Requested ${date(entry.created_at)}`));
        list.append(item);
      }
      layout.content.append(list);
      if (nextCursor) layout.content.append(button('Load more', () => { void refresh(nextCursor!); }));
      return;
    }
    layout.content.append(link('Every run you have looked at', preapprovalHref()));
    if (inspection) {
      const state = node('p', `Execution: ${status(inspection.execution_status)}`); state.setAttribute('role', 'status'); state.setAttribute('data-review-status', inspection.execution_status); layout.summary.append(state);
      if (inspection.status_reason) layout.summary.append(node('p', status(inspection.status_reason)));
      if (inspection.decision) layout.summary.append(node('p', `Owner decision: ${status(inspection.decision.decision)} · ${date(inspection.decision.decided_at)}`));
      if (inspection.retired_review) layout.summary.append(node('p', `This stopped being valid on ${date(inspection.retired_review.at)}. The decision and operation outcomes remain available.`));
    }
    if (review) {
      if (review.continuation) {
        layout.content.append(node('p', 'This continues an earlier run. The unfinished changes below need a new decision.'),
          link('Original review', preapprovalHref(review.continuation.proposal_id)));
        if (review.continuation.completed.length) {
          layout.content.append(node('h2', 'Completed earlier'));
          const completed = node('ul'); completed.setAttribute('data-preapproval-completed', '');
          for (const item of review.continuation.completed) {
            const row = node('li', item.label + ' · Receipt ' + (item.commit_id ?? item.action_ref) + ' · ');
            row.append(link('Original review', preapprovalHref(item.proposal_id)));
            const run = item.run_id ? runLink(item.run_id) : null;
            if (run) row.append(doc.createTextNode(' · '), run);
            completed.append(row);
          }
          layout.content.append(completed);
        }
      }
      const selectable = (id: string, ancestors = new Set<string>()): boolean => {
        const member = review!.members.find(item => item.member_id === id);
        if (!member?.eligible || ancestors.has(id)) return false;
        const next = new Set(ancestors); next.add(id);
        return member.required_child_ids.every(child => selectable(child, next));
      };
      const who = review.requested_through;
      layout.summary.append(node('p', `Asked for through ${who.display_name}${who.credential_label ? ` · ${who.credential_label}` : ''}`));
      if (who.contract_id) layout.summary.append(node('p', `Contract: ${who.contract_id}`));
      layout.summary.append(node('p', review.scheduled_for !== null ? `Scheduled for ${date(review.scheduled_for, review.time_zone)}`
        : `Applies to the ${status(review.activation.kind)} occurrence.`));
      if (review.activation.kind !== 'one_shot') layout.summary.append(node('p',
        'This says yes to the next run only. Later runs still ask you as usual.'));
      if (inspection?.status === 'awaiting_owner' && review.activation.kind === 'one_shot' && !review.continuation
        && review.coverage === 'complete' && review.selected_member_ids.length === review.members.length
        && review.members.length > 0 && review.members.every(member => !member.parent_member_id && !member.conditional
          && member.required_child_ids.length === 0 && member.resource_review && hasLocalUpdateResources(member.resource_review))) {
        layout.summary.append(button('Review as one atomic change set',() => {
          void mutate(async () => {
            pendingAtomic ??= { proposal_id: opts.proposalId!,request_id: crypto.randomUUID() };
            const next = await opts.call('local_changes.prepare',pendingAtomic);
            if (!disposed) doc.defaultView?.location.assign(localChangesHref(next.change_set_id));
          });
        },changedSelection()));
      }
      layout.summary.append(node('p', `Decide by ${date(review.decision_deadline, review.time_zone)}. Operations must start by ${date(review.dispatch_deadline, review.time_zone)}.`));
      layout.summary.append(node('p', review.coverage === 'complete'
        ? 'One yes covers everything listed here, and the files it needs to read.'
        : 'This does not cover everything. Anything marked as not covered will still ask you.'));
      for (const note of review.interaction_notes) layout.summary.append(node('p', note));
      const selectedByServer = new Set(review.selected_member_ids);
      for (const member of review.members) {
        const section = node('article'); section.className = 'approval-review-member';
        section.setAttribute('aria-label', member.label);
        if (member.parent_member_id) section.className += ' approval-review-member-child';
        const label = node('label');
        if (member.parent_member_id === null && inspection?.status === 'awaiting_owner' && !review.continuation) {
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
        label.append(doc.createTextNode(`${member.parent_member_id ? 'Also needs to read or do: ' : ''}${member.label}`)); section.append(label);
        // ⛔ THE TIER LEADS. `always` / `destructive` became reviewable on
        // 2026-09-06, so a member can now be the deletion of a real record —
        // and until this line the review showed content hashes the owner cannot
        // verify by eye while withholding the one fact that decides the answer.
        const tier = node('p', member.risk === 'destructive' ? 'This changes or deletes things for good.'
          : member.risk === 'admin' ? 'This changes your account or workspace settings.'
            : member.risk === 'write' ? 'This writes things.' : 'This only looks at things.');
        tier.setAttribute('data-preapproval-risk', member.risk);
        if (member.risk === 'destructive' || member.risk === 'admin') tier.style.cssText = 'font-weight:650;color:var(--danger)';
        section.append(tier);
        section.append(node('p', member.detail), node('p', member.op_id));
        if (member.conditional) section.append(node('p', 'Runs only when the condition you saw is true.'));
        if (!selectedByServer.has(member.member_id)) section.append(node('p', member.reason ?? 'Not covered: you did not pick it.'));
        const content = node('pre', JSON.stringify(member.arguments, null, 2));
        content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; section.append(content);
        if (member.resource_review) {
          const changes = node('pre', renderResourceReview(member.resource_review));
          changes.setAttribute('data-preapproval-resource-review', member.member_id);
          changes.setAttribute('role', 'region');
          changes.setAttribute('aria-label', 'Reviewed changes for ' + member.label);
          changes.tabIndex = 0;
          changes.style.cssText = 'max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere';
          section.append(changes);
        }
        if (Object.keys(member.output).length) section.append(node('pre', JSON.stringify(member.output, null, 2)));
        if (member.connection_id) section.append(node('p', `Connection: ${member.connection_id}`));
        if (member.account_id) section.append(node('p', `Account: ${member.account_id}`));
        for (const resource of member.resources) section.append(node('p', `${resource.kind}: ${resource.key} · version ${resource.revision} · ${resource.content_hash}`));
        layout.content.append(section);
      }
      for (const call of review.uncovered) layout.content.append(node('p', `Uncovered ${call.op_id ?? 'call'}: ${call.reason}`));
      if (inspection?.status === 'awaiting_owner') {
        const dirty = changedSelection();
        if (dirty) layout.actions.append(button('Bring this up to date', () => { void mutate(async () => {
          await opts.call('preapproval.select', { proposal_id: review!.proposal_id, expected_revision: review!.revision, member_ids: [...selection] });
          pendingDecision = null;
        }); }, selection.size === 0));
        const expired = now() >= Math.min(review.challenge_expires_at ?? 0, review.decision_deadline);
        renderedExpired = expired;
        if (expired) layout.actions.append(node('p', 'Bring this up to date before you decide.'));
        const decide = (decision: PreapprovalDecision): void => {
          if (!review || !review.challenge || busy || dirty || expired) return;
          if (!pendingDecision || pendingDecision.decision !== decision || pendingDecision.expected_revision !== review.revision) {
            pendingDecision = { proposal_id: review.proposal_id, expected_revision: review.revision,
              review_digest: review.review_digest, challenge: review.challenge, decision, request_id: crypto.randomUUID() };
          }
          void mutate(async () => { await opts.call('preapproval.decide', pendingDecision!); });
        };
        layout.actions.append(button(review.activation.kind === 'one_shot' || review.activation.kind === 'next_schedule'
          ? 'Say yes and schedule it' : 'Say yes and set it up', () => decide('approve'), dirty || expired, 'primary'),
        button('Decline', () => decide('deny'), dirty || expired), button('Cancel action', () => decide('cancel'), dirty || expired));
      }
    }
    if (inspection?.grant?.status === 'active') layout.actions.append(button('Take back this yes', () => { void mutate(async () => {
      const grant = inspection!.grant!;
      if (!pendingRevoke || pendingRevoke.grant_id !== grant.grant_id || pendingRevoke.expected_revision !== grant.revision) {
        pendingRevoke = { grant_id: grant.grant_id, expected_revision: grant.revision, request_id: crypto.randomUUID() };
      }
      await opts.call('preapproval.revoke', pendingRevoke);
    }); }));
    if (inspection?.decision) {
      layout.content.append(node('h2', 'What happened'));
      for (const member of inspection.members) {
        const row = node('p', `${member.label}: ${status(member.status)}${member.status_message ? ` · ${member.status_message}` : ''}`);
        if (member.reconciled_outcome) row.append(doc.createTextNode(' · Verified outcome: ' + status(member.reconciled_outcome)));
        if (member.status === 'in_doubt' && !member.reconciled_outcome && member.provider_verification === 'mail' && !inspection.retired_review) {
          const verify = button('Verify mail outcome', () => {
            // Safari does not focus a clicked button. Own this explicit action
            // before repainting so the verification-status handoff can follow it.
            verify.focus({ preventScroll: true });
            pendingVerification = member.member_id;void mutate(async () => {
            const result = await opts.call('preapproval.reconcile', { proposal_id: inspection!.proposal_id, member_id: member.member_id });
            if (!disposed) verificationMessages.set(member.member_id, result.message);
          }).finally(() => { pendingVerification = null;render(); }); });
          verify.dataset.preapprovalVerifyFocus = member.member_id;
          row.append(verify);
        }
        if (member.status === 'in_doubt' && member.op_id === 'core.mail.send') {
          const notice = node('span', pendingVerification === member.member_id ? 'Checking the original attempt…' : verificationMessages.get(member.member_id) ?? 'Verification does not send mail or resume this run.');
          notice.setAttribute('role', 'status');notice.tabIndex = -1;notice.dataset.preapprovalVerifyStatus = member.member_id;
          notice.dataset.preapprovalVerifyFocus = member.member_id;row.append(notice);
        }
        if (member.local_receipt) {
          const receipt = member.local_receipt;
          const proof = node('span', ` · ${receipt.kind === 'records' ? 'Records' : 'Calendar'} change confirmed · ${date(receipt.committed_at)}`);
          proof.setAttribute('data-local-mutation-receipt', receipt.receipt_id);
          row.append(proof);
          row.append(localUpdateUndoControl(doc, {
            get: args => opts.call('local_undo.get', args),
            review: args => opts.call('local_undo.review', args), decide: args => opts.call('local_undo.decide', args),
          }, receipt.receipt_id));
        }
        if (member.commit_id) row.append(doc.createTextNode(` · Receipt ${member.commit_id}`));
        const run = member.run_id ? runLink(member.run_id) : null;
        if (run) row.append(doc.createTextNode(' · '), run);
        layout.content.append(row);
      }
    }
    if (inspection?.recovery) {
      const recovery = inspection.recovery;
      if (recovery.successor_proposal_id) layout.actions.append(link('Open continuation review', preapprovalHref(recovery.successor_proposal_id)));
      else if (recovery.eligible) {
        layout.content.append(node('h2', 'Review unfinished changes'), node('p',
          'Completed operations keep their receipts. The next review uses current data and the original requester’s permissions. It applies no changes until you decide.'));
        const form = node('form'); form.className = 'approval-review-member';
        const label = node('label', 'Run at (your time) ');
        const runAt = node('input'); runAt.type = 'datetime-local'; runAt.required = true; runAt.disabled = busy;
        runAt.style.cssText = 'display:block;width:100%;max-width:100%;min-width:0;box-sizing:border-box;padding:8px;font:inherit';
        runAt.setAttribute('data-preapproval-continuation-time', '');
        if (!continuationTime) {
          const value = new Date(now() + 10 * 60_000);
          continuationTime = new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        }
        runAt.value = continuationTime;
        runAt.addEventListener('input', () => { continuationTime = runAt.value; pendingContinuation = null; });
        label.append(runAt); form.append(label);
        const submit = button('Prepare continuation review', () => form.requestSubmit());
        form.append(submit);
        form.addEventListener('submit', event => {
          event.preventDefault();
          void mutate(async () => {
            const time = new Date(continuationTime).getTime();
            if (!Number.isFinite(time) || time <= now()) throw new Error('Pick a run time in the future.');
            if (!pendingContinuation || pendingContinuation.time !== continuationTime) pendingContinuation = {
              time: continuationTime, request: parsePreapprovalContinuation({
                proposal_id: inspection!.proposal_id, idempotency_key: crypto.randomUUID(),
                // D-269 — the SERVER's zone: the continuation runs server-side,
                // so a run arranged from a laptop abroad must not carry the travel zone.
                activation: { kind: 'one_shot', run_at: time, time_zone: stampZone(opts.serverTimeZone) },
                decision_deadline: Math.min(time, now() + PREAPPROVAL_LIMITS.default_decision_ms),
                dispatch_deadline: time + PREAPPROVAL_LIMITS.default_dispatch_grace_ms,
              }),
            };
            const next = await opts.call('preapproval.continue', pendingContinuation.request);
            if (!disposed) doc.defaultView?.location.assign(preapprovalHref(next.proposal_id));
          });
        });
        layout.content.append(form);
      } else if (recovery.reason) layout.summary.append(node('p', recovery.reason));
    }
    if (focused && (!doc.activeElement || doc.activeElement === doc.body || host.contains(doc.activeElement))) {
      const target = [...host.querySelectorAll<HTMLElement>('[data-preapproval-verify-status]')].find(item => item.dataset.preapprovalVerifyStatus === focused);
      target?.focus({ preventScroll: true });
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
    try { await load(cursor); } catch (cause) { error = cause instanceof Error ? cause.message : 'Recued could not load this.'; }
    finally { busy = false; render(); }
  };
  const mutate = async (action: () => Promise<void>): Promise<void> => {
    if (disposed || busy) return;
    busy = true; error = ''; render();
    try { await action(); await load(); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Recued could not check your decision. Load the page again to see where it got to.'; }
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
