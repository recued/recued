import type { ContactMergeCandidate, ContactMergeSplitPreview, ContactMergeSplitInspection, ContactMergeSplitRequest, ContactRecord } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

export interface ContactMergeRecoveryCallers {
  list(input: { status: 'merged'; limit: number; cursor?: string }): Promise<{ candidates: ContactMergeCandidate[]; next_cursor?: string }>;
  preview(input: { merged_email: string; other_email?: string }): Promise<ContactMergeSplitInspection>;
  split(input: ContactMergeSplitRequest): Promise<{ canonicals: ContactRecord[] }>;
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const vendorName = (vendor: string) => vendor === 'hubspot' ? 'HubSpot'
  : vendor === 'salesforce' ? 'Salesforce' : vendor === 'dynamics' ? 'Dynamics 365' : vendor;
const label = (record: ContactRecord) => record.name?.trim() || record.email;
const message = (value: unknown) => (value as { code?: string })?.code === 'unknown_method'
  ? 'Update your Recued server to review and separate merged contacts.'
  : value instanceof Error ? value.message : 'This request could not be completed. Try reading the current state again.';
const readbackNotice = (preview: ContactMergeSplitPreview, choices: string[], inspection: Extract<ContactMergeSplitInspection, { status: 'separate' }>): string => {
  const identity = (record: { email: string; contact_id?: string }) => JSON.stringify([record.email, record.contact_id ?? null]);
  const sameMembers = (email: string, expected: ContactRecord[]) => {
    const actual = inspection.groups?.find(group => group.canonical_email === email)?.members;
    return !!actual && actual.length === expected.length
      && actual.map(identity).sort().join('|') === expected.map(identity).sort().join('|');
  };
  if (!sameMembers(preview.merged_email, preview.separating) || !sameMembers(preview.survivor_email, preview.remaining)) {
    return 'The contacts are separate, but other contacts from the preview are now grouped differently or could not be confirmed. Review both contact records.';
  }
  const linksMatch = preview.links.every((link, index) => inspection.groups.find(group => group.canonical_email === choices[index])?.links.some(actual =>
    actual.vendor === link.entry.vendor && actual.platform_id === link.entry.platform_id && actual.connection_name === link.connection_name));
  return linksMatch ? '' : 'The contacts are separate, but connected-record ownership no longer matches your choices. Review both contact records before making another change.';
};
export const MERGE_RECOVERY_PREFIX = 'merge-recovery-';
export const MERGE_RECOVERY_STYLES = `
.contact-merge-recovery { display:grid; gap:16px; }
.contact-merge-recovery h3,.contact-merge-recovery h4,.contact-merge-recovery p { margin:0; }
.contact-merge-views .data-button { min-height:var(--wc-control-h,44px); }
[data-recued-data-route] .contact-merge-views .data-button[aria-pressed=true] { border-color:var(--accent,#007a99); color:var(--accent,#007a99); background:var(--surface,#fff); }
.contact-merge-history { list-style:none; padding:0; margin:0; display:grid; gap:12px; }
.contact-merge-history li,.contact-merge-group { border:1px solid var(--border); border-radius:12px; padding:16px; overflow-wrap:anywhere; }
.contact-merge-history li { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.contact-merge-history p + p { margin-top:6px; }
.contact-merge-groups { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.contact-merge-group ul { padding-left:20px; margin-bottom:0; }
.contact-merge-links { display:grid; gap:12px; }
.contact-merge-links label { display:grid; grid-template-columns:minmax(0,1fr) minmax(160px,1fr); align-items:center; gap:12px; overflow-wrap:anywhere; }
.contact-merge-recovery .data-button { min-height:var(--wc-control-h,44px); }
.contact-merge-recovery .data-input { min-height:var(--wc-control-h,44px); width:100%; min-width:0; max-width:100%; }
.contact-merge-recovery [role=alert] { color:var(--danger,#b42318); }
.contact-merge-recovery [role=status] { padding:12px; border:1px solid var(--border); border-radius:10px; }
@media(max-width:600px) { .contact-merge-groups,.contact-merge-links label { grid-template-columns:1fr; } .contact-merge-history li { align-items:stretch; flex-direction:column; } }
`;

/** Read previews retire on navigation. Writes are never retried automatically. */
export const createContactMergeRecovery = (callers: ContactMergeRecoveryCallers | undefined, changed: (focus?: string) => void, separated: () => void = () => {}) => {
  let open = false, loading = false, busy = false, disposed = false, sequence = 0;
  let error = '', rows: ContactMergeCandidate[] = [], cursor: string | undefined;
  let preview: ContactMergeSplitPreview | undefined;
  let assignments: string[] = [];
  let receipt: ContactRecord[] | undefined;
  let receiptNotice = "";
  const current = (token: number) => !disposed && open && token === sequence;
  const publish = (focus?: string) => { if (!disposed) changed(focus); };
  const load = async (more = false) => {
    if (!callers || busy || loading) return;
    const token = ++sequence; loading = true; error = ''; preview = undefined; receipt = undefined; receiptNotice = "";
    if (!more) { rows = []; cursor = undefined; }
    publish();
    try {
      const result = await callers.list({ status: 'merged', limit: 30, ...(more && cursor ? { cursor } : {}) });
      if (!current(token)) return;
      rows = [...new Map([...(more ? rows : []), ...result.candidates].map(row => [row.id, row])).values()]; cursor = result.next_cursor;
    } catch (value) { if (current(token)) error = message(value); }
    finally { if (current(token)) { loading = false; publish('heading'); } }
  };
  const review = async (id: string) => {
    const row = rows.find(item => item.id === id);
    if (!callers || !row || loading || busy) return;
    const token = ++sequence; loading = true; error = ''; receipt = undefined; receiptNotice = ''; publish();
    try {
      const inspection = await callers.preview({ merged_email: row.email_a, other_email: row.email_b });
      if (!current(token)) return;
      if (inspection.status === 'separate') receipt = inspection.canonicals;
      else {
        const result = inspection.preview;
        preview = result;
        const detached = new Set(result.separating.map(contact => contact.email));
        // Defaults describe current ownership, not a guessed historical owner.
        assignments = result.links.map(link => detached.has(link.owner_email) ? result.merged_email : result.survivor_email);
      }
    } catch (value) { if (current(token)) error = message(value); }
    finally { if (current(token)) { loading = false; publish('heading'); } }
  };
  const separate = async () => {
    if (!callers || !preview || busy || loading) return;
    const reviewed = preview; const choices = [...assignments]; const token = ++sequence;
    receiptNotice = "";
    busy = true; error = ''; publish('separate');
    try {
      const result = await callers.split({ merged_email: reviewed.merged_email, expected_preview: reviewed.token,
        platform_id_redistribution: reviewed.links.map((link, index) => ({ platform_id_entry: link.entry, target_canonical_email: choices[index]! })) });
      if (!current(token)) return;
      receipt = result.canonicals; preview = undefined;
    } catch (value) {
      if (!current(token)) return;
      // A reply may be lost after commit. Confirm the result with reads; never
      // submit the write again just because the network reported a failure.
      try {
        const inspection = await callers.preview({ merged_email: reviewed.merged_email, other_email: reviewed.survivor_email });
        if (!current(token)) return;
        if (inspection.status === 'separate') { receipt = inspection.canonicals; receiptNotice = readbackNotice(reviewed, choices, inspection); preview = undefined; }
        else { error = message(value); preview = undefined; }
      } catch { if (current(token)) { error = 'Separation could not be confirmed. Refresh and review the current contacts before trying again.'; preview = undefined; } }
    } finally { if (current(token)) { busy = false; publish('heading'); if (receipt) separated(); } }
  };
  const button = (action: string, text: string, extra = '', focus = action) => `<button type="button" class="data-button" data-action="${MERGE_RECOVERY_PREFIX}${action}" data-merge-recovery-focus="${escape(focus)}" ${extra}${busy || loading ? ' disabled' : ''}>${text}</button>`;
  return {
    available: () => !!callers,
    isOpen: () => open,
    busy: () => busy,
    close() { if (busy) return; open = false; loading = false; sequence++; preview = undefined; receipt = undefined; receiptNotice = ""; },
    dispose() { disposed = true; sequence++; },
    assign(index: number, email: string) { if (!busy && preview && index >= 0 && index < assignments.length && [preview.merged_email, preview.survivor_email].includes(email)) assignments[index] = email; },
    handle(action: string, id?: string): boolean {
      if (!action.startsWith(MERGE_RECOVERY_PREFIX)) return false;
      if (busy) return true;
      const name = action.slice(MERGE_RECOVERY_PREFIX.length);
      if (name === 'open') { open = true; void load(); }
      else if (name === 'refresh') void load();
      else if (name === 'more' && cursor) void load(true);
      else if (name === 'review' && id) void review(id);
      else if (name === 'separate') void separate();
      else if (name === 'back') { sequence++; loading = false; preview = undefined; receipt = undefined; receiptNotice = ""; error = ''; publish('heading'); }
      return true;
    },
    render(): string {
      if (!open) return '';
      const heading = `<h3 tabindex="-1" data-merge-recovery-focus="heading">${preview ? 'Review separation' : receipt ? 'Contacts are separate' : 'Merged history'}</h3>`;
      let body: string;
      if (receipt) body = `${receiptNotice ? `<p role="alert">${escape(receiptNotice)}</p>` : ""}<p role="status">The individual contact records are available. Open each one to review its details.</p><ul>${receipt.map(contact => `<li><a href="${escape(serializeShellRoute('data', 'contact', contact.email))}">${escape(label(contact))}</a> · ${escape(contact.email)}</li>`).join('')}</ul>${button('back', 'Back to merged history')}`;
      else if (preview) {
        const person = (email: string) => label([...preview!.separating, ...preview!.remaining].find(contact => contact.email === email)!);
        const group = (title: string, records: ContactRecord[]) => `<section class="contact-merge-group"><h4>${title}</h4><ul>${records.map(contact => `<li>${escape(label(contact))}<br><span class="data-row-subtle">${escape(contact.email)}</span></li>`).join('')}</ul></section>`;
        body = `<p>Review the two people and their connected records before separating. A merged branch stays together.</p>
          <div class="contact-merge-groups">${group('Contact to separate', preview.separating)}${group('Remaining contact', preview.remaining)}</div>
          <p>Field values and email aliases stay with the contacts where they were recorded. Later edits stay with the contact that received them. Notes and links moved by the original merge stay with their current contact.</p>
          ${preview.links.length ? `<section class="contact-merge-links"><h4>Who owns each connected record?</h4><p>Selections start with current ownership. Choose a different person where needed.</p>${preview.links.map((link, index) => `<label><span>${escape(vendorName(link.entry.vendor))}${link.connection_name ? ` · ${escape(link.connection_name)}` : ''} · ${escape(link.entry.platform_id)}</span><select class="data-input" data-merge-recovery-link="${index}" data-merge-recovery-focus="link-${index}"${busy ? ' disabled' : ''}>${[preview!.survivor_email, preview!.merged_email].map(email => `<option value="${escape(email)}"${assignments[index] === email ? ' selected' : ''}>${escape(person(email))} (${escape(email)})</option>`).join('')}</select></label>`).join('')}</section>` : '<p>No connected provider records need reassignment.</p>'}
          <p>Recued will treat these groups as different people in future duplicate checks. This changes local Recued identities only.</p>
          <div class="data-contact-toolbar">${button('back', 'Keep merged')}${button('separate', busy ? 'Separating…' : 'Separate contacts')}</div>`;
      } else body = `<p>Review previous merges and separate contacts that belong to different people. The preview uses their current state.</p>
        ${button('refresh', 'Refresh history')}${loading ? '<p role="status">Loading merged contacts…</p>' : ''}
        <ul class="contact-merge-history">${rows.map(row => `<li><div><p>${escape(row.email_a)}<br>${escape(row.email_b)}</p><p class="data-row-subtle">Merged ${row.resolved_at === undefined ? 'time not recorded' : escape(new Date(row.resolved_at).toLocaleString())}</p></div>${button('review', 'Review separation', `data-merge-recovery-id="${escape(row.id)}"`, `review-${row.id}`)}</li>`).join('')}</ul>
        ${!loading && !rows.length && !error ? '<p>No merged contacts are recorded here.</p>' : ''}${cursor ? button('more', 'Load more merges') : ''}`;
      return `<section class="contact-merge-recovery" aria-label="Contact merge recovery" aria-busy="${loading || busy}">${heading}${error ? `<p role="alert">${escape(error)}</p>` : ''}${body}</section>`;
    },
  };
};
