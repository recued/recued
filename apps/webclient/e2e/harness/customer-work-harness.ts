import { mountCustomerWorkPanel } from '../../src/reception/customer-work-panel.js';
import type { CustomerJobsPanelOptions } from '../../src/reception/customer-jobs-panel.js';
import { parseReceptionAddress, receptionHierarchicalAddress, type ReceptionAddress } from '../../src/reception/navigation.js';
import { parseShellRoute } from '../../src/shell/route.js';
import { RECEPTION_SECTION_NAV_STYLES } from '../../src/reception/sections.js';
/** Component lanes use the production workspace and a small shell boundary.
 * The full-app lane separately proves the real shell's history/leave guards. */
export const mountCustomerWorkHarness = (opts: CustomerJobsPanelOptions, initial: ReceptionAddress = { kind: 'section', section: 'jobs' }) => {
    const doc = opts.document;
    const host = opts.host;
    const style = doc.createElement('style');
    style.textContent = RECEPTION_SECTION_NAV_STYLES;
    host.appendChild(style);
    const nav = doc.createElement('nav');
    nav.className = 'customer-work-tabs';
    nav.setAttribute('aria-label', 'Customer work');
    host.appendChild(nav);
    for (const [id, label] of [['jobs', 'Jobs'], ['accounts', 'Customer accounts'], ['receivables', 'Receivables aging'], ['followups', 'Follow-ups']]) {
        const a = doc.createElement('a');
        a.href = '#reception/' + id;
        a.textContent = label!;
        nav.appendChild(a);
    }
    const target = doc.createElement('div');
    host.appendChild(target);
    let currentHash = receptionHierarchicalAddress(initial).hash;
    history.replaceState(null, '', currentHash);
    const mount = (address: ReceptionAddress) => mountCustomerWorkPanel({ ...opts, host: target, initialAddress: address, navigate: hash => { location.hash = hash; } });
    let panel = mount(initial);
    let disposed = false;
    const navigate = () => {
        if (disposed)
            return;
        const next = location.hash;
        if (next === currentHash)
            return;
        if (panel.hasUnsavedChanges() || panel.hasInFlightWork()) {
            if (!confirm('Leave this customer workspace and discard unsaved edits?')) {
                history.replaceState(history.state, '', currentHash);
                return;
            }
            panel.dispose();
            panel = mount(parseReceptionAddress(parseShellRoute(next)) ?? initial);
        }
        else if (!panel.navigateDeepLink(next)) {
            return;
        }
        currentHash = next;
    };
    window.addEventListener('hashchange', navigate);
    return { update: () => panel.update(), hasUnsavedChanges: () => panel.hasUnsavedChanges(), hasInFlightWork: () => panel.hasInFlightWork(),
        dispose: () => { disposed = true; window.removeEventListener('hashchange', navigate); panel.dispose(); nav.remove(); style.remove(); } };
};
