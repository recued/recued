import { CUSTOMER_JOB_FILTERS } from '@recued/contracts';
import { parseShellRoute } from '../shell/route.js';
import { parseReceptionAddress, receptionCustomerJobAddress, CUSTOMER_JOB_TABS, type ReceptionAddress, receptionInboxTargetAddress, receptionHierarchicalAddress } from './navigation.js';
import { mountCustomerJobsPanel, type CustomerJobsPanelOptions, type CustomerJobsBoardState } from './customer-jobs-panel.js';
import { mountQuoteSignoffReminders } from './quote-signoff-reminders.js';
import { mountQuoteCompletionReminders } from './quote-completion-reminders.js';
import { mountQuotePaymentReminders } from './quote-payment-reminders.js';
import { mountCustomerAccountPaymentReminders } from './customer-account-payment-reminders.js';
type WorkAddress = Extract<ReceptionAddress, {
    kind: 'customer-job';
}> | {
    kind: 'section';
    section: 'jobs' | 'accounts' | 'receivables' | 'followups';
};
const isWorkAddress = (a: ReceptionAddress | null): a is WorkAddress => !!a && (a.kind === 'customer-job' || a.kind === 'section' && ['jobs', 'accounts', 'receivables', 'followups'].includes(a.section));
const labels = { overview: 'Overview', activity: 'Activity', billing: 'Billing', followups: 'Follow-ups', closeout: 'Closeout' };
/** Own the board and its return position while a routed job workspace is open. */
export const mountCustomerWorkPanel = (opts: CustomerJobsPanelOptions & {
    initialAddress: ReceptionAddress;
    navigate(hash: string): void;
}) => {
    const doc = opts.document;
    const root = doc.createElement('div');
    root.setAttribute('data-customer-work', '');
    opts.host.appendChild(root);
    const boardHost = doc.createElement('div');
    root.appendChild(boardHost);
    const detailHost = doc.createElement('div');
    root.appendChild(detailHost);
    let address: WorkAddress = isWorkAddress(opts.initialAddress) ? opts.initialAddress : { kind: 'section', section: 'jobs' };
    let board: ReturnType<typeof mountCustomerJobsPanel> | undefined;
    type Panel = {
        dispose(): void;
        update?(): void;
        hasUnsavedChanges?(): boolean;
        hasInFlightWork?(): boolean;
    };
    let headerTitle: HTMLElement | undefined;
    let headerSummary: HTMLElement | undefined;
    let primary: HTMLAnchorElement | undefined;
    const revealTab = () => { const tabs = root.querySelector<HTMLElement>('[aria-label="Job sections"]'); const active = tabs?.querySelector<HTMLElement>('[aria-current=page]'); if (tabs && active) {
        tabs.scrollLeft = Math.max(0, active.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - active.clientWidth) / 2);
        const hint = root.querySelector<HTMLElement>('[data-job-tab-hint]');
        if (hint)
            hint.hidden = tabs.scrollWidth <= tabs.clientWidth + 1;
    } };
    let detail: Panel | undefined;
    let disposed = false;
    let scrollTop = 0;
    let returnJob: string | undefined;
    const pane = () => root.closest<HTMLElement>('[data-recued-webclient-content]');
    let initialState: CustomerJobsBoardState | undefined;
    const saved = doc.defaultView?.history?.state?.recuedCustomerJobs;
    if (saved && typeof saved.search === 'string' && saved.search.length <= 200 && CUSTOMER_JOB_FILTERS.includes(saved.filter)
        && ['active', 'archived', 'all'].includes(saved.archive) && Array.isArray(saved.previous) && saved.previous.length <= 100
        && saved.previous.every((v: unknown) => v === undefined || typeof v === 'string') && (saved.cursor === undefined || typeof saved.cursor === 'string')) {
        initialState = { search: saved.search, filter: saved.filter, archive: saved.archive, cursor: saved.cursor, previous: saved.previous };
        scrollTop = Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0;
        returnJob = typeof saved.returnJob === 'string' ? saved.returnJob : undefined;
    }
    let showing = false;
    let restoreBoard = false;
    let focusBoardOnReturn = false;
    const restore = () => {
        if (disposed || boardHost.hidden)
            return;
        if (returnJob || focusBoardOnReturn) {
            const target = [...boardHost.querySelectorAll<HTMLElement>('[data-job-open]')].find(n => n.getAttribute('data-job-open') === returnJob);
            const focus = target ?? boardHost.querySelector<HTMLElement>('h2');
            if (focus) {
                if (!target)
                    focus.tabIndex = -1;
                focus.focus({ preventScroll: true });
            }
        }
        const content = pane();
        if (content)
            content.scrollTop = scrollTop;
        restoreBoard = false;
        focusBoardOnReturn = false;
        save();
    };
    const save = () => {
        if (!board || address.kind !== 'section' || address.section !== 'jobs' || disposed || restoreBoard)
            return;
        const history = doc.defaultView?.history;
        try {
            history?.replaceState?.({ ...history.state, recuedCustomerJobs: { ...board.getBoardState(), scrollTop: pane()?.scrollTop ?? scrollTop, returnJob } }, '');
        }
        catch { /* Embedded browsers can deny History writes. */ }
    };
    const openJob = (id: string, tab: import('./navigation.js').CustomerJobTab) => { returnJob = id; save(); opts.navigate(receptionCustomerJobAddress(id, tab).hash); };
    const followups = (): Panel => {
        const heading = doc.createElement('h2');
        heading.textContent = 'Customer follow-ups';
        detailHost.appendChild(heading);
        if (!opts.reminders) {
            const p = doc.createElement('p');
            p.textContent = 'Connect Mail to prepare follow-up emails.';
            detailHost.appendChild(p);
            return { dispose: () => { } };
        }
        const panels: Array<Pick<ReturnType<typeof mountQuoteSignoffReminders>, 'dispose' | 'update' | 'hasOpenEmail' | 'hasUnsavedChanges' | 'hasInFlightWork'>> = [];
        type ReminderPanel = (typeof panels)[number];
        const addPanel = (label:string,mount: (options: Omit<Parameters<typeof mountQuoteSignoffReminders>[0], 'conn'> & {
            conn: CustomerJobsPanelOptions['conn'];
        }) => ReminderPanel) => {
            const group=doc.createElement('details');group.setAttribute('data-customer-followup-group','');const summary=doc.createElement('summary');summary.textContent=label;group.appendChild(summary);detailHost.appendChild(group);
            let initialized=false;
            let panel: ReminderPanel;
            panel = mount({ ...opts.reminders!, document: doc, host: group, conn: opts.conn,
                onStateChanged:()=>{const queue=group.querySelector('[data-signoff-reminder-queue],[data-completion-reminder-queue],[data-payment-reminder-queue],[data-account-payment-reminder-queue]');const failed=[...group.querySelectorAll('[role=status]')].some(node=>node.textContent?.startsWith('Could not load follow-ups.'));if(!initialized && (queue?.children.length || failed)){initialized=true;group.open=failed || !!queue?.querySelector('article');}},
                canReviewEmail: () => panels.every(other => other === panel || !other.hasOpenEmail() && !other.hasInFlightWork() && !other.hasUnsavedChanges()) });
            panels.push(panel);
        };
        addPanel('Sign-off requests',mountQuoteSignoffReminders);
        addPanel('Completion requests',mountQuoteCompletionReminders);
        addPanel('Invoice payments',mountQuotePaymentReminders);
        addPanel('Account payments',mountCustomerAccountPaymentReminders);
        return { dispose: () => panels.forEach(p => p.dispose()), update: () => panels.forEach(p => p.update()),
            hasUnsavedChanges: () => panels.some(p => p.hasUnsavedChanges() || p.hasOpenEmail()), hasInFlightWork: () => panels.some(p => p.hasInFlightWork()) };
    };
    const show = (next: WorkAddress) => {
        if (showing && address.kind === 'section' && address.section === 'jobs')
            scrollTop = pane()?.scrollTop ?? scrollTop;
        focusBoardOnReturn = showing;
        showing = true;
        address = next;
        detail?.dispose();
        detail = undefined;
        detailHost.replaceChildren();
        const isBoard = next.kind === 'section' && next.section === 'jobs';
        boardHost.hidden = !isBoard;
        detailHost.hidden = isBoard;
        // Retain board state outside the document while details are active. Hidden
        // sibling editors must not compete for label IDs or accessibility targets.
        if (isBoard)
            root.insertBefore(boardHost, detailHost);
        else {board?.suspend();boardHost.remove();}
        if (isBoard) {
            restoreBoard = true;
            if (!board)
                board = mountCustomerJobsPanel({ ...opts, host: boardHost, jobId: undefined, workspace: undefined, initialState, onOpenJob: openJob, onBoardStateChanged: () => {
                        if (restoreBoard)
                            doc.defaultView?.requestAnimationFrame(restore);
                        else
                            save();
                    } });
            else
                board.update();
            return;
        }
        if (next.kind === 'section' && next.section === 'followups') {
            detail = followups();
            return;
        }
        if (next.kind === 'customer-job') {
            returnJob = next.jobId;
            const header = doc.createElement('header');
            header.setAttribute('data-customer-job-header', '');
            detailHost.appendChild(header);
            const back = doc.createElement('a');
            back.href = '#reception/jobs';
            back.textContent = '← Back to jobs';
            header.appendChild(back);
            headerTitle = doc.createElement('h2');
            headerTitle.textContent = 'Customer job';
            header.appendChild(headerTitle);
            headerSummary = doc.createElement('p');
            header.appendChild(headerSummary);
            primary = doc.createElement('a');
            primary.className = 'customer-job-primary';
            primary.hidden = true;
            header.appendChild(primary);
            const tabs = doc.createElement('nav');
            tabs.setAttribute('aria-label', 'Job sections');
            tabs.className = 'customer-work-tabs';
            header.appendChild(tabs);
            for (const tab of CUSTOMER_JOB_TABS) {
                const a = doc.createElement('a');
                a.href = receptionCustomerJobAddress(next.jobId, tab).hash;
                a.textContent = labels[tab];
                if (tab === next.tab)
                    a.setAttribute('aria-current', 'page');
                a.addEventListener('focus',()=>{if(!a.matches(':focus-visible'))return;tabs.scrollLeft=Math.max(0,a.offsetLeft-tabs.offsetLeft-(tabs.clientWidth-a.clientWidth)/2);});
                tabs.appendChild(a);
            }
            const hint = doc.createElement('small');
            hint.textContent = 'Scroll for more sections →';
            hint.setAttribute('data-job-tab-hint', '');
            hint.hidden = true;
            header.appendChild(hint);
            doc.defaultView?.requestAnimationFrame(revealTab);
        }
        detail = mountCustomerJobsPanel({ ...opts, host: detailHost, jobId: next.kind === 'customer-job' ? next.jobId : undefined,
            tab: next.kind === 'customer-job' ? next.tab : undefined, workspace: next.kind === 'section' ? next.section as 'accounts' | 'receivables' : undefined,
            onJobLoaded: job => { if (headerTitle)
                headerTitle.textContent = job.customer + ' — ' + job.quote_label; if (headerSummary)
                headerSummary.textContent = [job.quote_reference, job.payment.status==='not_invoiced' ? 'No invoice released' : job.payment.outstanding === null ? 'Balance needs review' : job.payment.outstanding + ' ' + job.currency + ' outstanding'].filter(Boolean).join(' · '); if (primary) {
                primary.hidden = false;
                primary.textContent = job.needs_owner_review ? 'Review customer reply' : job.agreement?.task_id ? 'Open task' : 'View sign-off';
                primary.href = job.needs_owner_review ? receptionInboxTargetAddress(job.completion_matches_agreement && job.completion?.review === 'waiting' ? job.completion.completion_id : job.offer.signoff_id) : job.agreement?.task_id ? '#data/task/' + encodeURIComponent(job.agreement.task_id) : '#reception/signoffs/' + encodeURIComponent(job.offer.signoff_id);
            } revealTab(); },
            onCloseWorkspace: () => opts.navigate('#reception/jobs'), onOpenJob: openJob });
    };
    const scroller = opts.host.closest<HTMLElement>('[data-recued-webclient-content]');
    scroller?.addEventListener('scroll', save, { passive: true });
    doc.defaultView?.addEventListener('resize', revealTab);
    show(address);
    return { update: () => { if(!boardHost.hidden)board?.update(); detail?.update?.(); },
        hasUnsavedChanges: () => detail?.hasUnsavedChanges?.() ?? false,
        hasInFlightWork: () => detail?.hasInFlightWork?.() ?? false,
        navigateDeepLink: (hash: string): boolean => {
            const next = parseReceptionAddress(parseShellRoute(hash));
            if (!isWorkAddress(next))
                return false;
            if (receptionHierarchicalAddress(next).hash === receptionHierarchicalAddress(address).hash)
                return true;
            if (detail?.hasUnsavedChanges?.() || detail?.hasInFlightWork?.())
                return false;
            show(next);
            return true;
        }, dispose: () => { disposed = true; doc.defaultView?.removeEventListener('resize', revealTab); scroller?.removeEventListener('scroll', save); board?.dispose(); detail?.dispose(); root.remove(); } };
};
