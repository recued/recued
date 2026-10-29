import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, ASSET_EXPECTED_PATTERNS, ASSET_IDENTIFYING_FIELD_NOTE, ASSET_STATUSES, HOME_ASSISTANT_WRITER_SETUP, PROACTIVE_PROPOSAL_KINDS, assetDocumentDetails, isAssetDate, occasionNextDate, type Asset, type AssetClassPreset, type FileAttachmentSelection,
  type AssetEvidence, type AssetPatch, type AssetRule, type ContactRecord, type Episode, type EpisodeInput, type Link, type Occasion, type ProactiveProposal,
  type TimelineRequest, type TimelineResponse, type TripDetails, type YoursAssetFilter, type YoursAssetSphere, type YoursCommand, type YoursCommandResult, type YoursReadRequest, type YoursSnapshot } from '@recued/contracts';
import type { DataCommitmentCloseCaller } from '../data/bootstrap-data-route.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { serializeLogsRunAddress, serializeSourceRecordAddress } from '../shell/route.js';
import { runPageObject, type RunPageContext } from '../shell/run-page-context.js';
import { openFilePreview, type FilePreviewCallers } from '../files/file-preview.js';
import { mountAssetFactsEditor } from './asset-facts-editor.js';
import { assetRuleWhenWords, mountAssetRuleEditor, parseReminderOffsets, ruleOffsetWords } from './asset-rule-editor.js';
import { assetObservationFieldName, mountAssetObservationEditor } from './asset-observation-editor.js';
import { mountAssetSummary } from './asset-summary.js';
import { assetEvidenceText, changedAssetPatch, renderAssetSource } from './asset-provenance.js';
import { lastTimeClassName } from './last-time-words.js';
import { dayAfter, dueOnText, renewalDateWords, taskDueWords } from './due-words.js';
export { parseReminderOffsets } from './asset-rule-editor.js';
import { mountAssetPicker, type AssetPicker } from './asset-picker.js';
import { assetChatContext, type ChatAssetContext } from '../chat/asset-context.js';
import { YOURS_STYLES } from './yours-styles.js';
import { yoursActions, yoursDisclosure, yoursEmpty, yoursList, yoursMenu, yoursNavigation, yoursPageHeader, yoursToolbar } from './yours-view.js';
import { focusListTarget, readListContinuity, readListScroll, restoreListScroll, updateListContinuity } from '../shell/list-preview-continuity.js';
import { mountAssetContextInspector } from './asset-context-inspector.js';
import { mountAssetWriterSetup, type AssetWriterSetupCallers } from './asset-writer-setup.js';
import { mountAssetTextFactEditor } from './asset-text-fact-editor.js';
import { mountAssetWriterEditor } from './asset-writer-editor.js';
import { mountAssetEvidenceEditor } from './asset-evidence-editor.js';
import { clearYoursFieldErrors, yoursFieldError } from './yours-field-errors.js';
import { factName } from './fact-words.js';
import { mountClassFieldsEditor } from './class-fields-editor.js';
import { proposalPreview, reminderTimingWords } from './proposal-preview.js';
import { episodeDateWords, yoursCalendarDate, yoursDateTime } from './yours-dates.js';
import { mountCountryChoice } from './country-choice.js';
import { renderAssetComparisons } from './asset-comparisons.js';

const TABS = ['assets', 'proposals', 'occurrences', 'occasions', 'episodes'] as const;
type Tab = typeof TABS[number];
// §15.2 amendment — the occurrences tab reads "Due": what is listed is due, overdue
// or coming up. Its address stays `#yours/occurrences`, which links already use.
const TAB_LABELS: Readonly<Record<Tab, string>> = { assets: 'Assets', proposals: 'Proposals', occurrences: 'Due', occasions: 'Occasions', episodes: 'Episodes' };
const continuityScopes = new WeakMap<object, string>(); let nextContinuityScope = 0;
export interface YoursRouteOptions {
  container: HTMLElement;
  segments?: readonly string[];
  read(input: YoursReadRequest): Promise<YoursSnapshot>;
  change(input: YoursCommand): Promise<YoursCommandResult>;
  closeCommitment: DataCommitmentCloseCaller;
  contacts?(): Promise<ContactRecord[]>;
  links?(id: string): Promise<Link[]>;
  timeline?(input: TimelineRequest): Promise<TimelineResponse>;
  files?: FilePreviewCallers & {
    get(input: { record_id: string }): Promise<FileAttachmentSelection>;
    list(input: import('@recued/contracts').FileAttachmentListRequest): Promise<import('@recued/contracts').FileAttachmentListResult>;
  };
  subscribe?: BroadcastSubscriber['on'];
  subscribeReady?: (listener: () => void) => () => void;
  recordOpened?: (ref: import('@recued/contracts').SituationRef) => void;
  askAsset?: (context: ChatAssetContext) => void;
  prepareFileUpload?: (asset: { id: string; name: string }) => void;
  /** Connection identity keeps private list state separate across server profiles. */
  continuityOwner?: object;
  context?(input: import('@recued/contracts').AssetFactContextRequest): Promise<import('@recued/contracts').AssetFactContext>;
  writerSetup?: AssetWriterSetupCallers;
}
type Editor = { type: 'asset'; asset?: Asset; proposal?: ProactiveProposal; correction?: ProactiveProposal; creation_key?: string }
  | { type: 'rule'; asset: Asset; rule?: AssetRule; proposal?: ProactiveProposal; classPreset?: AssetClassPreset; classCreating?: boolean; classDirty?: boolean; classFocus?: EditorReturnFocus; initialField?: { group: 'dates' | 'readings' | 'observations'; field: string } }
  | { type: 'trip'; proposal: ProactiveProposal }
  | { type: 'relation'; proposal: ProactiveProposal }
  | { type: 'learning'; proposal: ProactiveProposal }
  | { type: 'close'; proposal: ProactiveProposal }
  | { type: 'recall'; proposal: ProactiveProposal }
  | { type: 'reading'; asset: Asset; field?: string }
  | { type: 'condition'; asset: Asset; field?: string }
  | { type: 'date'; asset: Asset; field: string }
  | { type: 'fact'; asset: Asset; field?: string; group: 'attributes' | 'settings' }
  | { type: 'attribute_reading'; asset: Asset; attribute: string; request_id: string }
  | { type: 'context'; request: import('@recued/contracts').AssetFactContextRequest }
  | { type: 'writer'; asset: Asset; field?: string; recipe_id?: string }
  | { type: 'writer_setup'; asset: Asset; field?: string }
  | { type: 'evidence'; asset: Asset; group: 'readings' | 'observations'; field: string }
  | { type: 'document'; asset: Asset; file: Link; filename: string }
  | { type: 'parent'; asset: Asset }
  | { type: 'same_thing'; asset: Asset }
  | { type: 'class'; preset: AssetClassPreset; creating?: boolean }
  | { type: 'occasion'; occasion?: Occasion; proposal?: ProactiveProposal }
  | { type: 'occasion_rule'; occasion: Occasion; rule?: AssetRule; proposal?: ProactiveProposal }
  | { type: 'episode'; episode?: EpisodeInput; correction?: ProactiveProposal };
type EditorReturnFocus = { key: string; asset_id: string; scope?: string; menu?: string };
const scheduleText = (rule: AssetRule) => rule.schedule.before.map(ruleOffsetWords).join(', ');
const ASSET_STATUS_WORDS: Record<Asset['status'], string> = { active: 'Active', lent: 'Lent', sold: 'Sold', lost: 'Lost', retired: 'Retired' };
const newClassId = () => `owner_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
/** §4.7 — the ladder an episode stands on (its `basis`), in the owner's words. */
const EPISODE_BASIS_WORDS: Record<EpisodeInput['basis'], string> = { declared: 'your record', derived: 'planned, and shown to have happened', inferred: 'pieced together from traces' };
/** P47 — the schedule as it will be sent: a clock that lapses on its due day
 * (`strict_expire`) has no repeats, whatever its repeat field says. */
export const ruleScheduleSummary = (rule: AssetRule): string => {
  const points = [scheduleText(rule) && `${scheduleText(rule)} before`, rule.schedule.on_day ? 'on the day' : ''].filter(Boolean);
  const after = rule.schedule.after;
  const timing = points.length ? `remind ${points.join(', ')}` : after && rule.expiry_policy !== 'strict_expire'
    ? 'No reminders before or on the due day' : 'No scheduled reminders';
  return timing + (!after ? '' : rule.expiry_policy === 'strict_expire' ? '; it lapses on the due day, so it does not repeat'
    : `; then every ${ruleOffsetWords(after)}`);
};
export const bootstrapYoursRoute = (options: YoursRouteOptions) => {
  const doc = options.container.ownerDocument;
  if (!doc.head.querySelector('style[data-recued-yours-styles]')) { const style = doc.createElement('style'); style.setAttribute('data-recued-yours-styles', ''); style.textContent = YOURS_STYLES; doc.head.append(style); }
  const root = doc.createElement('main'); root.setAttribute('data-recued-yours', ''); options.container.append(root);
  const continuityOwner = options.continuityOwner ?? options.container;
  if (!continuityScopes.has(continuityOwner)) continuityScopes.set(continuityOwner, `yours-assets-${nextContinuityScope++}`);
  const continuityKey = continuityScopes.get(continuityOwner)!;
  const scrollHost = options.container;
  let restoreListPosition = true;
  let openedAsset: { id: string; kind: 'name' | 'open' } | undefined;
  root.addEventListener('click', event => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    const row = anchor?.closest<HTMLElement>('[data-yours-asset]');
    if (row?.dataset.yoursAsset && anchor?.getAttribute('href')?.startsWith('#yours/asset/'))
      openedAsset = { id: row.dataset.yoursAsset, kind: anchor.hasAttribute('data-yours-open-asset') ? 'open' : 'name' };
  }, true);
  let content: HTMLElement = root;
  let openingTrigger: EditorReturnFocus | undefined;
  const openDisclosures = new Map<string, boolean>();
  let refreshContext: (() => Promise<void>) | undefined;
  let writerSetup: ReturnType<typeof mountAssetWriterSetup> | undefined; let writerBusy = false;
  let inputAddressFocused = false;
  let refreshingFocus: EditorReturnFocus | undefined;
  const segments = options.segments ?? [];
  const tab: Tab = TABS.includes(segments[0] as Tab) ? segments[0] as Tab : 'assets';
  const selected = segments[0] === 'asset' ? segments[1] : undefined;
  const selectedOccasion = segments[0] === 'occasions' && segments[1] === 'occasion' ? segments[2] : undefined;
  const selectedEpisode = segments[0] === 'episodes' && segments[1] === 'episode' ? segments[2] : undefined;
  const selectedTrace = segments[0] === 'episodes' && segments[1] === 'trace' ? segments[2] : undefined;
  const classesView = segments[0] === 'classes' || segments[1] === 'classes';
  const assetList = tab === 'assets' && !selected && !classesView;
  let proposalKind: import('@recued/contracts').ProactiveProposalKind | '' = segments[1] === 'kind' && PROACTIVE_PROPOSAL_KINDS.includes(segments[2] as import('@recued/contracts').ProactiveProposalKind) ? segments[2] as import('@recued/contracts').ProactiveProposalKind : '';
  const pageAt = proposalKind ? 3 : 1;
  const pageNumber = (value: string | undefined) => { const number = Number(value); return Number.isSafeInteger(number) && number > 0 && Number.isSafeInteger((number - 1) * 50) ? number - 1 : 0; };
  let page = segments[pageAt] === 'page' ? pageNumber(segments[pageAt + 1]) : 0;
  let assetFilter: YoursAssetFilter | '' = ''; let assetSphere: YoursAssetSphere | '' = ''; let search = '';
  if (segments[0] === 'assets' && !classesView) for (let at = 1; at + 1 < segments.length; at += 2) {
    const value = segments[at + 1]!;
    if (segments[at] === 'filter' && (value === 'missing_facts' || value === 'overdue')) assetFilter = value;
    if (segments[at] === 'sphere' && (value === 'personal' || value === 'professional' || value === 'unsorted')) assetSphere = value;
    if (segments[at] === 'search') search = value;
    if (segments[at] === 'page') page = pageNumber(value);
  }
  const assetListHash = (targetPage = 0, filter = assetFilter) => `#yours/assets${filter ? `/filter/${filter}` : ''}${assetSphere ? `/sphere/${assetSphere}` : ''}${search ? `/search/${encodeURIComponent(search)}` : ''}${targetPage ? `/page/${targetPage + 1}` : ''}`;
  const assetFiltersApplied = (result: YoursSnapshot) => (!assetFilter || result.asset_filter?.kind === assetFilter) && (!assetSphere || result.asset_sphere === assetSphere);
  const navigateAssets = (targetPage = 0, replaceHistory = false) => {
    const hash = assetListHash(targetPage); const win = doc.defaultView;
    dirty = false; typing = false;
    if (win && win.location.hash !== hash) {
      if (replaceHistory) win.location.replace(hash); else win.location.hash = hash;
      return Promise.resolve();
    }
    page = targetPage; return refresh(true);
  };
  let snapshot: YoursSnapshot | undefined; let contacts: ContactRecord[] = []; let files: Link[] = [];
  let filesAvailable = false;
  let timeline: TimelineResponse | undefined; let editor: Editor | undefined; let routeEditorOpened = false;
  let editorReturnFocus: EditorReturnFocus | undefined;
  let disposed = false; let dirty = false; let typing = false; let busy = false; let loading = false; let generation = 0;
  let draftVersion = 0;
  let editorIntent = 0;
  let openingIntent = 0;
  root.addEventListener('input', () => { draftVersion++; });
  let message = ''; let error = ''; let errorVersion = 0; let pending = Promise.resolve();
  let openedRecorded = false; let sphereFilter = '';
  const routeAbort = new AbortController();
  doc.addEventListener('pointerdown', event => {
    for (const menu of root.querySelectorAll<HTMLDetailsElement>('[data-yours-menu][open]')) if (!menu.contains(event.target as Node)) menu.open = false;
  }, { signal: routeAbort.signal });
  const assetPickers: AssetPicker[] = [];
  const navigationDisposers: Array<() => void> = [];
  const fileMetadata = new Map<string, Promise<FileAttachmentSelection>>();
  // Four metadata reads at a time; queued reads from a replaced snapshot never
  // reach the server. A metadata read does not download file content.
  const metadataLanes = Array.from({ length: 4 }, () => Promise.resolve()); let metadataLane = 0;
  const readFileMetadata = (record_id: string) => {
    let result = fileMetadata.get(record_id);
    if (!result) {
      const version = generation; const lane = metadataLane++ % metadataLanes.length;
      result = metadataLanes[lane]!.then(async () => {
        if (disposed || version !== generation) throw new Error('File view changed');
        const file = await options.files!.get({ record_id });
        if (file.file_id !== record_id) throw new Error('File details no longer match this attachment');
        return file;
      });
      metadataLanes[lane] = result.then(() => {}, () => {}); fileMetadata.set(record_id, result);
    }
    return result;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; parent?.append(node); return node;
  };
  const link = (parent: HTMLElement, label: string, hash: string) => { const node = el('a', label, parent); node.href = hash; return node; };
  const focusTarget = (node: HTMLElement | null | undefined): EditorReturnFocus | undefined => {
    if (!node || !root.contains(node) || !node.dataset.yoursFocus) return;
    return { key: node.dataset.yoursFocus, asset_id: node.closest<HTMLElement>('[data-yours-asset]')?.dataset.yoursAsset ?? selected ?? '',
      scope: node.closest<HTMLElement>('[data-yours-focus-scope]')?.dataset.yoursFocusScope,
      menu: node.closest<HTMLDetailsElement>('[data-yours-menu]')?.dataset.yoursMenu };
  };
  const focusAction = (target: EditorReturnFocus) => [...root.querySelectorAll<HTMLElement>('[data-yours-focus]')].find(node => {
    const candidate = focusTarget(node);
    return candidate?.key === target.key && candidate.scope === target.scope && candidate.menu === target.menu && !node.closest('[hidden]');
  });
  const button = (parent: HTMLElement, label: string, action: (origin: EditorReturnFocus) => void | Promise<void>, key = label) => {
    const node = el('button', label, parent); node.type = 'button'; node.dataset.yoursFocus = key; node.disabled = busy;
    node.addEventListener('click', () => { const origin = focusTarget(node); if (!origin) return; void Promise.resolve().then(() => {
      const previous = openingTrigger; openingTrigger = origin;
      try { return action(origin); } finally { openingTrigger = previous; }
    }).catch(showError); }); return node;
  };
  const setError = (value: string) => { error = value; errorVersion++; };
  const showError = (value: unknown) => { setError(value instanceof Error ? value.message : String(value)); paintStatus(); };
  const paintStatus = () => {
    const opening = openingIntent !== 0 && openingIntent === editorIntent;
    const status = root.querySelector('[data-yours-status]'); if (status) status.textContent = loading && snapshot ? 'Refreshing Yours…' : opening ? 'Opening editor…' : message;
    const alert = root.querySelector<HTMLElement>('[data-yours-error]'); if (alert) alert.textContent = error;
    const refreshButton = root.querySelector<HTMLButtonElement>('[data-yours-focus="refresh"]');
    // D-325 — disabling the active Refresh button moves focus to the body.
    // Keep its identity, but restore it only if the owner has not focused elsewhere.
    if (loading && refreshButton === doc.activeElement) refreshingFocus = focusTarget(refreshButton);
    if (!loading) refreshingFocus = undefined;
    if (refreshButton) { refreshButton.textContent = loading ? 'Refreshing…' : 'Refresh'; refreshButton.disabled = busy || loading; }
    root.setAttribute('aria-busy', String(busy || loading || opening));
  };
  const restoreEditorFocus = (target: EditorReturnFocus | undefined) => {
    if (!target) return;
    const action = focusAction(target);
    let more = action?.closest<HTMLDetailsElement>('details');
    while (more) { more.open = true; more = more.parentElement?.closest<HTMLDetailsElement>('details'); }
    const asset = [...root.querySelectorAll<HTMLElement>('[data-yours-asset]')].find(node => node.dataset.yoursAsset === target.asset_id);
    const menu = target.menu ? [...root.querySelectorAll<HTMLDetailsElement>('[data-yours-menu]')].find(node => node.dataset.yoursMenu === target.menu && !node.closest('[hidden]')) : undefined;
    const scope = target.scope ? [...root.querySelectorAll<HTMLElement>('[data-yours-focus-scope]')].find(node => node.dataset.yoursFocusScope === target.scope && !node.closest('[hidden]')) : undefined;
    const fallback = action ?? menu?.querySelector<HTMLElement>('summary') ?? asset?.querySelector<HTMLElement>('[data-yours-open-asset]')
      ?? scope?.querySelector<HTMLElement>('h2,h3') ?? root.querySelector<HTMLElement>('[data-yours-heading]');
    if (fallback?.matches('h2,h3')) fallback.tabIndex = -1;
    fallback?.focus();
  };
  const write = async (action: () => Promise<YoursCommandResult>, keepEditor = false) => {
    if (busy || disposed) return;
    editorIntent++;
    const focus = doc.activeElement as HTMLElement | null;
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')]
      .map(node => ({ node, disabled: node.disabled }));
    busy = true; setError(''); paintStatus();
    controls.forEach(({ node }) => { node.disabled = true; });
    try {
      const result = await action(); if (disposed) return;
      message = result.message;
      if (result.failed?.length) { setError(result.failed.map(item => item.reason).join(' ')); return; }
      const createdAsset = editor?.type === 'asset' && !editor.asset && !editor.proposal && result.id;
      const returnFocus = !keepEditor ? editorReturnFocus : undefined;
      if (!keepEditor) { editor = undefined; dirty = false; editorReturnFocus = undefined; }
      if (createdAsset && doc.defaultView) { busy = false; doc.defaultView.location.hash = `#yours/asset/${encodeURIComponent(createdAsset)}`; return; }
      busy = false; await refresh(true);
      restoreEditorFocus(returnFocus);
    } catch (value) { if (!disposed) showError(value); }
    finally { busy = false; if (!disposed) {
      controls.forEach(({ node, disabled }) => { if (node.isConnected) node.disabled = disabled; });
      if (!doc.activeElement || doc.activeElement === doc.body) {
        (focus?.isConnected ? focus : root.querySelector<HTMLElement>('[data-yours-heading]'))?.focus();
      }
      paintStatus();
    } }
  };
  const change = (input: YoursCommand, keep = false) => write(() => options.change(input), keep);
  const writerEditor = (field: string): 'writer_setup' | 'writer' => options.writerSetup &&
    Object.hasOwn(HOME_ASSISTANT_WRITER_SETUP.fields, field) ? 'writer_setup' : 'writer';
  const open = (value: Editor, returnFocus?: EditorReturnFocus) => {
    if (disposed) return;
    if (value.type === 'class' && value.preset.origin !== 'owner') value = { ...value, creating: true, preset: { ...value.preset, id: newClassId(), origin: 'owner', version: 1 } };
    editorIntent++;
    // Internal draft steps keep the page action that opened the whole editor.
    // Async actions pass their captured origin rather than sampling later focus.
    const origin = returnFocus ?? (editor ? editorReturnFocus : openingTrigger ?? focusTarget(doc.activeElement as HTMLElement | null));
    editor = value; editorReturnFocus = origin; dirty = false; render();
    const control = value.type === 'fact' && value.field ? '[name=fact-value]' : value.type === 'reading' && value.field ? '[name=observation-value]'
      : value.type === 'condition' && value.field ? '[name=observation-state]' : 'form input:enabled,form select:enabled';
    root.querySelector<HTMLElement>(value.type === 'context' ? '[data-yours-context-heading]' : value.type === 'writer_setup' ? '[data-yours-writer-setup] h2' : control)?.focus();
  };
  const loadEditor = (read: () => Promise<Editor | undefined>) => async (origin: EditorReturnFocus) => {
    if (disposed) return;
    const control = focusAction(origin) as HTMLButtonElement | undefined;
    if (control?.hasAttribute('data-yours-opening')) return;
    const intent = ++editorIntent; const draftAtStart = draftVersion;
    openingIntent = intent;
    const title = control?.textContent ?? '';
    if (control) { control.dataset.yoursOpening = ''; control.textContent = 'Opening…'; control.disabled = true; }
    paintStatus();
    // A newer request wins before either read finishes. Opening and closing
    // another editor, writing or typing cannot make an older load current again.
    const current = () => !disposed && intent === editorIntent && draftAtStart === draftVersion;
    let value: Editor | undefined;
    try { value = await read(); if (current() && value) open(value, origin); }
    catch (error) { if (current()) showError(error); }
    finally {
      if (openingIntent === intent) openingIntent = 0;
      if (control?.isConnected) { delete control.dataset.yoursOpening; control.textContent = title; control.disabled = busy; }
      if (!disposed) paintStatus();
    }
  };
  const section = (parent: HTMLElement, title: string) => { const node = el('section', undefined, parent); node.className = 'yours-section'; el('h3', title, node); return node; };
  const sectionActions = (parent: HTMLElement) => {
    const heading = parent.querySelector('h3')!; const row = el('div'); row.className = 'yours-section-heading'; parent.insertBefore(row, heading); row.append(heading); return yoursActions(row);
  };
  const placementFor = (ref: import('@recued/contracts').SituationRef) => snapshot?.sphere_placements.find(row => row.ref.collection === ref.collection && row.ref.id === ref.id);
  const placementChip = (parent: HTMLElement, ref: import('@recued/contracts').SituationRef) => {
    const placement = placementFor(ref); const host = el('details', undefined, parent); host.dataset.yoursSphere = '';
    el('summary', placement?.sphere === 'personal' ? 'Personal' : placement?.sphere === 'professional' ? 'Work' : 'Unsorted', host);
    el('p', `Placement: ${placement?.reason ?? 'unknown'}`, host).className = 'yours-muted';
    el('p', 'Placement controls which AI contracts may read this record.', host);
    const choice = select(host, 'This record’s sphere', `sphere-${ref.collection}-${ref.id}`, [['', 'Use source placement'], ['personal', 'Personal'], ['professional', 'Work']], placement?.pinned ? placement.sphere : '');
    // Choosing a facet is an immediate change, not an unsaved editor draft.
    choice.addEventListener('change', () => { dirty = false; });
    button(host, 'Change', () => change({ action: 'sphere.item', ref, sphere: choice.value as 'personal' | 'professional' || null }));
    button(host, 'Reset', () => change({ action: 'sphere.item', ref, sphere: null }));
  };
  const card = (parent: HTMLElement, title: string, ref?: import('@recued/contracts').SituationRef, identity = ref ? [ref.collection, ref.id] : undefined) => {
    const node = el('article', undefined, parent); node.className = 'yours-card'; el('h3', title, node);
    if (identity) node.dataset.yoursFocusScope = JSON.stringify(identity);
    if (ref) { node.hidden = !assetList && !!sphereFilter && (placementFor(ref)?.sphere ?? 'unsorted') !== sphereFilter; placementChip(node, ref); }
    return node;
  };
  // A transient field (a search box) holds off broadcast refreshes but is never an
  // unsaved change, so leaving the page does not ask to discard it.
  const label = (parent: HTMLElement, title: string, name: string, value = '', type = 'text', transient = false) => {
    const host = el('label', title, parent); const input = el('input', undefined, host); input.type = type; input.name = name; input.value = value; input.dataset.yoursFocus = name;
    input.setAttribute('aria-label', title);
    input.addEventListener('input', () => { if (transient) typing = true; else dirty = true; }); return input;
  };
  const select = (parent: HTMLElement, title: string, name: string, choices: Array<[string, string]>, value = '') => {
    const host = el('label', title, parent); const input = el('select', undefined, host); input.name = name; input.dataset.yoursFocus = name;
    input.setAttribute('aria-label', title);
    for (const [id, title] of choices) { const option = el('option', title, input); option.value = id; } input.value = value;
    input.addEventListener('change', () => { dirty = true; }); return input;
  };
  const checked = (parent: HTMLElement, title: string, name: string, value: boolean) => { const input = label(parent, title, name, '', 'checkbox'); input.checked = value; return input; };
  const form = (title: string, save: (form: HTMLFormElement) => Promise<void>) => {
    const node = el('form', undefined, content); node.className = 'yours-editor'; node.setAttribute('data-yours-editor', ''); el('h2', title, node);
    node.addEventListener('input', () => { clearYoursFieldErrors(node); if (error) { setError(''); paintStatus(); } });
    node.addEventListener('submit', event => { event.preventDefault(); clearYoursFieldErrors(node); void save(node).catch(showError); });
    return node;
  };
  const formActions = (node: HTMLFormElement, label = 'Save', back?: () => void) => { const actions = el('div', undefined, node); actions.className = 'yours-actions';
    actions.dataset.yoursEditorActions = '';
    const alert = root.querySelector<HTMLElement>('[data-yours-error]')!; alert.dataset.yoursFormError = ''; actions.append(alert);
    const save = el('button', label, actions); save.type = 'submit'; save.dataset.yoursFocus = 'save'; save.className = 'yours-primary';
    button(actions, 'Cancel', () => { if (dirty && doc.defaultView?.confirm && !doc.defaultView.confirm('Discard these unsaved changes?')) return; if (back) { back(); return; }
      editorIntent++; const returnFocus = editorReturnFocus; editor = undefined; dirty = false; editorReturnFocus = undefined; render(); restoreEditorFocus(returnFocus); }); };
  const field = (node: HTMLFormElement, key: string) => (node.elements.namedItem(key) as HTMLInputElement | null)?.value ?? '';
  const yes = (node: HTMLFormElement, key: string) => (node.elements.namedItem(key) as HTMLInputElement | null)?.checked === true;
  const personChoices = (): Array<[string, string]> => [['', 'Unknown'], ...contacts.map(person => [person.contact_id ?? person.email, person.name ?? person.email] as [string, string])];
  /** §15.3 — a holder by name: the server's lookup for the open asset, else the loaded contacts. */
  const holderName = (id: string): string => {
    if (snapshot?.holder?.contact_id === id) return snapshot.holder.name ?? 'a contact no longer on file';
    const person = contacts.find(row => (row.contact_id ?? row.email) === id); return person ? person.name ?? person.email : id;
  };
  const presetForAsset = (asset: Asset): AssetClassPreset => ({ id: newClassId(), name: asset.name,
    version: 1, origin: 'owner', fields: { dates: Object.fromEntries(Object.keys(asset.dates).map(key => [key, null])),
      readings: Object.fromEntries(Object.keys(asset.readings).map(key => [key, null])), observations: Object.fromEntries(Object.keys(asset.observations).map(key => [key, null])), settings: {} },
    rules: structuredClone(asset.rules).map(rule => ({ ...rule, pinned: false })), audience: asset.audience ?? 'owner', retirement: asset.retirement,
    ...(asset.sphere ? { sphere: asset.sphere } : {}) });
  const assetPicker = (parent: HTMLElement, id: string, title: string, value?: string,
    allowed?: Parameters<typeof mountAssetPicker>[1]['allowed'], onChange?: (selection: import('@recued/ui-shared').RefPicker.RefPickerSelection | null) => void) => {
    const picker = mountAssetPicker(parent, { id: `yours-${id}`, label: title, ...(value ? { value } : {}),
      assets: [...(snapshot?.assets ?? []), ...(snapshot?.related_assets ?? [])], classes: snapshot?.classes ?? [],
      read: options.read, ...(allowed ? { allowed } : {}), onInput: () => { typing = true; },
      onChange: selection => { dirty = true; onChange?.(selection); } });
    assetPickers.push(picker); return picker;
  };
  const renderEditor = () => {
    const value = editor!;
    if (value.type === 'writer_setup') {
      if (!options.writerSetup) { el('p', 'Automatic source setup is unavailable.', content); return; }
      const host = el('section', undefined, content); host.className = 'yours-editor';
      writerSetup = mountAssetWriterSetup(host, value.asset, options.writerSetup, {
        ...(value.field ? { field: value.field } : {}), isCurrent: () => !disposed && editor === value,
        dirty: changed => { dirty = changed; }, busy: changed => { writerBusy = changed; },
        close: () => { if (dirty && doc.defaultView?.confirm && !doc.defaultView.confirm('Discard these unsaved changes?')) return;
          editorIntent++; const target = editorReturnFocus; editor = undefined; dirty = false; editorReturnFocus = undefined; render(); restoreEditorFocus(target); },
      });
      return;
    }
    if (value.type === 'evidence') {
      let evidence: ReturnType<typeof mountAssetEvidenceEditor>;
      const node = form(`Add evidence · ${assetObservationFieldName(value.field)}`, async () => { await change(evidence.read()); });
      evidence = mountAssetEvidenceEditor(node, value.asset, value.group, value.field, files, () => { dirty = true; }, options.files ? (id, retry) => {
        if (retry) fileMetadata.delete(id); return readFileMetadata(id);
      } : undefined, () => !disposed && editor === value && node.isConnected);
      formActions(node, 'Add evidence'); return;
    }
    if (value.type === 'writer') {
      let writer: ReturnType<typeof mountAssetWriterEditor>;
      const node = form('Keep updated from a source', async () => { await change(writer.read()); });
      writer = mountAssetWriterEditor(node, value.asset, snapshot!, () => { dirty = true; }, value);
      formActions(node, 'Enroll writer'); return;
    }
    if (value.type === 'context') {
      refreshContext = mountAssetContextInspector(content, value.request, {
        read: input => options.context ? options.context(input) : Promise.reject(new Error('Context is unavailable on this server.')),
        isCurrent: () => !disposed && editor === value,
        close: () => { editorIntent++; const target = editorReturnFocus; editor = undefined; editorReturnFocus = undefined; render(); restoreEditorFocus(target); }, sourceLink,
      }).refresh;
      return;
    }
    if (value.type === 'attribute_reading') {
      const { asset, attribute } = value; const text = asset.attributes[attribute];
      if (typeof text !== 'string' || attribute === ASSET_DOCUMENT_DETAILS_ATTRIBUTE) throw new Error('Choose a saved text attribute');
      const node = form('Record as a reading', async () => {
        const patch = observation.read(); const [field, reading] = Object.entries(patch.readings ?? {})[0] ?? [];
        if (!field || !reading) throw new Error('Confirm the reading and its observation time');
        await change({ action: 'asset.record_attribute_reading', id: asset.id, request_id: value.request_id, attribute,
          expected_source: { value: text, source: asset.field_sources[`attributes.${attribute}`] ?? null }, field,
          expected_target: { exists: Object.hasOwn(asset.readings, field), value: asset.readings[field] ?? null, source: asset.field_sources[`readings.${field}`] ?? null },
          reading: { value: reading.value, unit: reading.unit, as_of: reading.as_of } });
      });
      el('p', `Original text · ${assetObservationFieldName(attribute)}`, node).className = 'yours-muted';
      el('blockquote', text, node).className = 'yours-source-note';
      el('p', 'This makes an independent reading. Your original text stays unchanged. Editing it later will not update the reading.', node);
      const observation = mountAssetObservationEditor(node, asset, 'reading', () => { dirty = true; }, undefined,
        { newOrUnknownOnly: true, blankTime: true, suggestedNewField: attribute });
      formActions(node, 'Record reading'); return;
    }
    if (value.type === 'fact') {
      let fields: ReturnType<typeof mountAssetTextFactEditor>;
      const node = form(value.field ? `Edit ${assetObservationFieldName(value.field)}` : 'Add fact', async () => {
        const patch = fields.read();
        if (patch) { await change({ action: 'asset.update', id: value.asset.id, patch }); return; }
        editorIntent++; const target = editorReturnFocus; editor = undefined; editorReturnFocus = undefined; dirty = false;
        message = 'No changes to save.'; render(); restoreEditorFocus(target);
      });
      fields = mountAssetTextFactEditor(node, value.asset, value.group, value.field, () => { dirty = true; });
      formActions(node, 'Save fact'); return;
    }
    if (value.type === 'parent' || value.type === 'same_thing') {
      const asset = value.asset; const isParent = value.type === 'parent'; let picker: AssetPicker;
      const node = form(isParent ? `Choose a parent for ${asset.name}` : `Link another record for ${asset.name}`, async () => {
        const id = picker.read(!isParent || !asset.belongs_to);
        await change(isParent ? { action: 'asset.link', id: asset.id, parent_id: id }
          : { action: 'asset.same_thing', id: asset.id, other_id: id!, merge: false });
      });
      el('p', isParent ? 'Choose the larger asset or place this belongs to. It can inherit the parent’s place, and who sees its reminders.'
        : 'Use this when two asset records describe the same thing. Both records keep their own history.', node);
      picker = assetPicker(node, isParent ? 'parent' : 'same-thing', isParent ? 'Parent asset' : 'Other record', isParent ? asset.belongs_to : undefined,
        (candidate, known) => {
          if (!isParent) return candidate.id !== asset.id;
          const assets = new Map(known.map(row => [row.id, row])); const seen = new Set<string>(); let current: Asset | undefined = candidate;
          while (current) {
            if (current.id === asset.id || seen.has(current.id)) return false;
            seen.add(current.id); current = current.belongs_to ? assets.get(current.belongs_to) : undefined;
          }
          return ['live', 'stale_unreachable'].includes(candidate.sync_state);
        });
      if (isParent && asset.belongs_to) el('p', 'Clear the selection and save to remove the current parent.', node);
      formActions(node, isParent ? 'Save parent' : 'Link records'); return;
    }
    if (value.type === 'document') {
      const details = assetDocumentDetails(value.asset, value.file.to_id);
      const node = form('Document details', async node => change({ action: 'file.details', asset_id: value.asset.id,
        link_id: value.file._id, record_id: value.file.to_id,
        details: { purpose: field(node, 'purpose'), applies_to: field(node, 'applies_to'), revision: field(node, 'revision') } }));
      el('p', value.filename, node);
      label(node, 'Purpose (optional)', 'purpose', details.purpose).maxLength = 200;
      label(node, 'Applies to (optional)', 'applies_to', details.applies_to).maxLength = 200;
      label(node, 'Document revision (optional)', 'revision', details.revision).maxLength = 100;
      el('p', 'For example: Manual · Boiler model B24 · Edition 2025. These details apply to this asset’s attachment.', node);
      formActions(node, 'Save details'); return;
    }
    if (value.type === 'learning') {
      const proposal = value.proposal;
      const relation = proposal.payload.relation as { target_class?: string; sphere?: string } | undefined;
      const node = form(`Edit ${proposal.title}`, async node => {
        const payload = proposal.kind === 'ranking' ? { ...proposal.payload, ranking_factor: Number(field(node, 'factor')) }
          : { ...proposal.payload, relation: { ...relation, target_class: field(node, 'class'), sphere: field(node, 'sphere') || undefined } };
        await change({ action: 'proposal.edit', id: proposal.id, payload });
      });
      el('p', proposal.explanation, node);
      if (proposal.kind === 'ranking') {
        const input = label(node, 'Ranking factor (0.5 to 1.5)', 'factor', String(proposal.payload.ranking_factor), 'number'); input.min = '0.5'; input.max = '1.5'; input.step = '0.1';
      } else {
        select(node, 'Related asset class', 'class', snapshot?.classes.map(row => [row.id, row.name] as [string, string]) ?? [], relation?.target_class);
        select(node, 'Sphere', 'sphere', [['', 'Unsorted'], ['personal', 'Personal'], ['professional', 'Professional']], relation?.sphere ?? '');
      }
      formActions(node); return;
    }
    if (value.type === 'asset') {
      const simpleCreation = !value.asset && !value.proposal;
      const creationKey = value.asset || value.proposal ? undefined : value.creation_key ??= `yours:${globalThis.crypto.randomUUID()}`;
      // P38 — a part edits only its own values; what it inherits stays live, so an
      // inherited place, address or audience is shown but never saved as its own.
      const inherited = value.asset?.inherited_fields ?? {};
      const own: Partial<Asset> = value.asset ? { ...value.asset,
        ...(inherited.audience ? { audience: undefined } : {}), ...(inherited.exact_address ? { exact_address: undefined } : {}),
        ...(inherited.anchors ? { anchors: value.asset.anchors.filter(anchor => anchor.kind !== 'place') } : {}) }
        : (value.proposal?.payload.asset as Partial<Asset> | undefined) ?? {};
      const parentName = own.belongs_to ? snapshot?.related_assets.find(row => row.id === own.belongs_to)?.name ?? 'the asset it belongs to' : '';
      let chosenClass = own.class_id ?? ''; const dates = { ...own.dates }; let initialAudience = '';
      let showNationality = true;
      // The built-in visa class, or a pack's (`travel_visa`).
      const visaClass = () => /(^|_)visa$/u.test(chosenClass);
      let facts: ReturnType<typeof mountAssetFactsEditor>;
      // A visa may be tied to a passport it ends with, as an ESTA or eTA does. Only a passport
      // is offered, and a parent that is not one is left alone unless the owner picks a passport instead.
      const isPassport = (asset: Asset) => asset.class_id === 'passport' || asset.settings?.travel_document === true;
      const currentParent = own.belongs_to ? snapshot?.related_assets.find(row => row.id === own.belongs_to) : undefined;
      const passportParent = currentParent && isPassport(currentParent) ? currentParent.id : undefined;
      let passportPicker: AssetPicker | undefined;
      let moreDetails: HTMLDetailsElement | undefined;
      const node = form(value.proposal ? `Review ${value.proposal.title}` : value.asset ? `Edit ${value.asset.name}` : 'Create asset', async node => {
        let detailPatch: AssetPatch;
        try { detailPatch = facts.read(); }
        catch (error) {
          if (moreDetails) { moreDetails.open = true; if (!node.querySelector('[aria-invalid=true]')) moreDetails.querySelector('summary')?.focus(); }
          throw error;
        }
        const country = showNationality ? nationality.read() : '';
        const visaFor = visaClass() ? visaCountry.read() : '';
        const visaSetting = visaFor ? { valid_for: visaFor } : own.settings?.valid_for ? { valid_for: null } : {};
        const chosenPassport = visaClass() ? passportPicker?.read(false) : undefined;
        const passportLink = chosenPassport === undefined ? {} : chosenPassport ? chosenPassport === own.belongs_to ? {} : { belongs_to: chosenPassport }
          : passportParent ? { belongs_to: null } : {};
        const patch: AssetPatch = { name: field(node, 'name').trim(), status: field(node, 'status') as Asset['status'],
          holder_contact: field(node, 'holder') || null, sphere_override: field(node, 'sphere') as Asset['sphere_override'] || null,
          // Empty is the class default on a new asset, or the parent's on a part. An
          // audience left as the form first showed it is not a choice: an unset one
          // shows as "Only me", and saving that would pin it.
          ...(field(node, 'audience') === initialAudience ? {} : field(node, 'audience') ? { audience: field(node, 'audience') as Asset['audience'] } : value.asset ? { audience: null } : {}),
          class_id: field(node, 'class') || null, dates: Object.fromEntries([...dateHost.querySelectorAll<HTMLInputElement>('input[data-date-field]')].map(input => [input.dataset.dateField!, input.value || null])),
          settings: { ...own.settings, ...(country ? { nationality: country } : own.settings?.nationality ? { nationality: null } : {}), ...visaSetting },
          document_number: field(node, 'document_number') || null, serial_number: field(node, 'serial_number') || null, exact_address: field(node, 'exact_address') || null,
          ...passportLink, ...detailPatch };
        patch.settings = { ...patch.settings, ...(country ? { nationality: country } : own.settings?.nationality ? { nationality: null } : {}), ...visaSetting };
        const retirement = value.asset && patch.status && ['sold', 'lost', 'retired'].includes(patch.status) && patch.status !== value.asset.status;
        if (retirement && doc.defaultView?.confirm && !doc.defaultView.confirm(`${snapshot?.retirement_impact?.parts ?? 0} parts go with it; ${snapshot?.retirement_impact?.contracts ?? 0} contracts become tasks under Due, to cancel or transfer. Continue?`)) return;
        await write(async () => {
          // An edit or a correction sends only what changed (`changedAssetPatch`).
          if (value.correction && value.asset) return options.change({ action: 'proposal.dismiss', id: value.correction.id, code: 'wrong', correction: { asset_id: value.asset.id, patch: changedAssetPatch(patch, own) } });
          if (value.proposal) {
            await options.change({ action: 'proposal.edit', id: value.proposal.id, payload: { ...value.proposal.payload, asset: { ...own, ...patch } } });
            return options.change({ action: 'proposal.accept', ids: [value.proposal.id] });
          }
          if (value.asset) {
            if (patch.class_id && patch.class_id !== value.asset.class_id) await options.change({ action: 'class.apply', asset_id: value.asset.id, class_id: patch.class_id });
            const result = await options.change({ action: 'asset.update', id: value.asset.id, patch: changedAssetPatch(patch, own), confirm_retirement: !!retirement });
            await options.change({ action: 'sphere.item', ref: { collection: 'asset', id: value.asset.id }, sphere: patch.sphere_override ?? null });
            return result;
          }
          return options.change({ action: 'asset.create', input: { ...patch, name: patch.name!, idempotency_key: creationKey }, ...(patch.class_id ? { class_id: patch.class_id } : {}) });
        });
      });
      label(node, 'Name', 'name', own.name ?? '').required = true;
      const classChoice = select(node, simpleCreation ? 'Type (optional)' : 'Class', 'class', [['', simpleCreation ? 'Choose later' : 'Unclassified'], ...(snapshot?.classes.map(preset => [preset.id, preset.name] as [string, string]) ?? [])], chosenClass);
      const typeHint = simpleCreation ? el('p', undefined, node) : null;
      if (typeHint) typeHint.className = 'yours-muted';
      const requiredDetails = simpleCreation ? el('div', undefined, node) : null;
      let detailsHost: HTMLElement = node;
      if (simpleCreation) {
        const more = el('details', undefined, node); more.dataset.yoursAssetMore = '';
        moreDetails = more;
        // Defer native reporting until the expanded section has laid out, so
        // WebKit can focus the invalid control and show its validation message.
        let revealingInvalid = false;
        more.addEventListener('invalid', event => {
          if (more.open && !revealingInvalid) return;
          event.preventDefault();
          more.open = true;
          if (revealingInvalid) return;
          revealingInvalid = true;
          doc.defaultView?.requestAnimationFrame(() => {
            revealingInvalid = false;
            if (!more.isConnected || !more.open) return;
            const invalid = node.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:invalid,select:invalid,textarea:invalid');
            invalid?.focus(); invalid?.reportValidity();
          });
        }, true);
        el('summary', 'More details (optional)', more);
        detailsHost = el('div', undefined, more); detailsHost.className = 'yours-asset-details';
      }
      select(detailsHost, 'Status', 'status', ASSET_STATUSES.map(status => [status, ASSET_STATUS_WORDS[status]] as [string, string]), own.status ?? 'active');
      const holderChoices = personChoices(); if (own.holder_contact && !holderChoices.some(([id]) => id === own.holder_contact)) holderChoices.push([own.holder_contact, holderName(own.holder_contact)]);
      const holder = select(detailsHost, 'Holder', 'holder', holderChoices, own.holder_contact);
      const nationalityHost = el('div', undefined, detailsHost);
      const nationality = mountCountryChoice(nationalityHost, 'Passport nationality (optional)', 'nationality', typeof own.settings?.nationality === 'string' ? own.settings.nationality : '', () => { dirty = true; });
      // Which country the visa lets its holder into. Nothing checks it; an AI you connect reads it.
      const visaHost = el('div', undefined, detailsHost);
      const visaCountry = mountCountryChoice(visaHost, 'Visa valid for', 'valid_for', typeof own.settings?.valid_for === 'string' ? own.settings.valid_for : '', () => { dirty = true; });
      passportPicker = assetPicker(visaHost, 'visa-passport', 'Tied to passport', passportParent,
        candidate => isPassport(candidate) && candidate.id !== value.asset?.id && ['live', 'stale_unreachable'].includes(candidate.sync_state));
      el('small', 'Optional. Tie it only if the visa stops working when you get a new passport, as an ESTA or eTA does. Retiring that passport then retires the visa too. A trip check lists the traveller’s visas either way.', visaHost).className = 'yours-muted';
      const audienceName = (audience?: string) => audience === 'household' ? 'Me and my household' : 'Only me';
      const classAudience = () => audienceName(snapshot?.classes.find(preset => preset.id === chosenClass)?.audience);
      const audienceDefault: [string, string] | null = value.asset
        ? own.belongs_to ? ['', `Same as ${parentName}${inherited.audience ? ` (${audienceName(value.asset.audience)})` : ''}`] : null
        : ['', `Class default (${classAudience()})`];
      initialAudience = own.audience ?? (audienceDefault ? '' : 'owner');
      const audience = select(detailsHost, 'Who sees its reminders', 'audience', [...(audienceDefault ? [audienceDefault] : []), ['owner', 'Only me'], ['household', 'Me and my household']], initialAudience);
      // What the choice resolves to: its own, else a part's parent's (inherited now, or
      // read from the parent when the part has its own), else a new asset's class's.
      const effectiveAudience = () => audience.value || (value.asset
        ? (inherited.audience ? value.asset.audience : undefined) ?? snapshot?.related_assets.find(row => row.id === own.belongs_to)?.audience
        : snapshot?.classes.find(preset => preset.id === chosenClass)?.audience) || 'owner';
      // §15.7 amendment — a shared asset's reminders go somewhere the owner set up in
      // Settings. Say where, or that nothing takes them yet, so the choice is not a
      // word with nothing behind it. Only an enrolled destination counts, as sending does.
      const audienceHint = el('p', undefined, detailsHost); audienceHint.dataset.yoursAudienceHint = '';
      const updateAudienceHint = () => {
        const household = snapshot?.household; audienceHint.replaceChildren();
        audienceHint.hidden = !household || effectiveAudience() !== 'household'; if (!household || audienceHint.hidden) return;
        const selected = household.telegram, ha = household.home_assistant?.selection;
        const group = selected && household.telegram_connections.find(row => row.name === selected.connection_name && row.enrolled_at === selected.connection_enrolled_at);
        const places = [...(group ? [`${group.display_name || group.name} on Telegram`] : []), ...(ha && household.home_assistant!.connections
          .some(row => row.name === ha.connection_name && row.enrolled_at === ha.connection_enrolled_at) ? ['your Home Assistant to-do list'] : [])];
        if (places.length) { audienceHint.textContent = `Its reminders also go to ${places.join(' and ')}.`; return; }
        audienceHint.textContent = 'No household group is set up yet, so its reminders reach only you for now. ';
        link(audienceHint, 'Set up household reminders', '#settings/notifications');
      };
      const ownPlacement = value.asset ? snapshot?.sphere_placements.find(item => item.ref.id === value.asset!.id) : undefined;
      select(detailsHost, 'Sphere', 'sphere', [['', 'Use source placement'], ['personal', 'Personal'], ['professional', 'Professional']], ownPlacement?.pinned ? ownPlacement.sphere : own.sphere_override ?? '');
      el('p', 'Changing the sphere can change which AI contracts may read this item.', detailsHost);
      const dateHost = el('fieldset', undefined, detailsHost); el('legend', 'Dates', dateHost);
      const fillDates = () => { dateHost.querySelectorAll('label').forEach(label => label.remove()); const preset = snapshot?.classes.find(preset => preset.id === chosenClass);
        for (const name of new Set([...Object.keys(preset?.fields.dates ?? {}), ...Object.keys(dates)])) {
          const input = label(dateHost, name.replaceAll('_', ' '), `date-${name}`, dates[name] ?? '', 'date'); input.dataset.dateField = name; input.addEventListener('input', () => { dates[name] = input.value || null; });
        } };
      const updateTypeHint = () => {
        updateAudienceHint();
        if (!typeHint) return;
        const preset = snapshot?.classes.find(preset => preset.id === chosenClass);
        typeHint.textContent = preset?.rules.some(rule => rule.enabled && rule.reaction.notify)
          ? `Includes reminders, ${effectiveAudience() === 'household' ? 'shared with your household' : 'for you only'}. You can add documents after saving.`
          : 'You can add documents and more details after saving.';
      };
      const updateType = () => {
        chosenClass = classChoice.value; fillDates();
        if (!value.asset && audience.options[0]?.value === '') audience.options[0].textContent = `Class default (${classAudience()})`;
        if (requiredDetails) {
          const preset = snapshot?.classes.find(preset => preset.id === chosenClass);
          holder.required = ['passport', 'id_card', 'visa', 'driving_licence'].includes(chosenClass) || preset?.fields.settings.holder_required === true;
          requiredDetails.hidden = !holder.required;
          if (holder.required) requiredDetails.append(holder.parentElement!);
          else detailsHost.insertBefore(holder.parentElement!, nationalityHost);
          showNationality = chosenClass === 'passport' || preset?.fields.settings.travel_document === true;
          nationalityHost.hidden = !showNationality;
        }
        visaHost.hidden = !visaClass();
        updateTypeHint();
      };
      classChoice.addEventListener('change', updateType); audience.addEventListener('change', updateTypeHint); updateType();
      const newDate = label(detailsHost, 'Add a date field (for example last_tuned_on)', 'new-date');
      button(detailsHost, 'Add date field', () => { if (!/^[a-z][a-z0-9_]{0,63}$/u.test(newDate.value)) throw new Error('Use a field name such as last_tuned_on'); dates[newDate.value] ??= null; fillDates(); dirty = true; });
      for (const [key, title] of [['document_number', 'Document number'], ['serial_number', 'Serial number'], ['exact_address', 'Exact address']] as const) {
        const input = label(detailsHost, title, key, own[key] ?? ''); const hint = el('small', ASSET_IDENTIFYING_FIELD_NOTE, input.parentElement!); hint.className = 'yours-muted';
        hint.id = `yours-${key}-hint`; input.setAttribute('aria-describedby', hint.id);
        if (key === 'exact_address' && inherited.exact_address && value.asset?.exact_address) {
          input.placeholder = value.asset.exact_address; hint.textContent = `Empty uses ${parentName}’s address. ${ASSET_IDENTIFYING_FIELD_NOTE}`;
        }
      }
      if (inherited.anchors && value.asset) {
        const places = value.asset.anchors.flatMap(anchor => anchor.kind === 'place' ? [anchor.name ?? anchor.address ?? 'a place'] : []);
        el('p', `Place: ${places.join(', ')}, from ${parentName}. Add a place below to give this one its own.`, detailsHost).className = 'yours-muted';
      }
      facts = mountAssetFactsEditor(detailsHost, own, () => { dirty = true; });
      formActions(node, value.proposal ? 'Accept' : 'Save'); return;
    }
    if (value.type === 'date') {
      const node = form(`Record a date for ${value.asset.name}`, async node => {
        const date = field(node, 'fact-date');
        if (!Object.hasOwn(value.asset.dates, value.field) || !isAssetDate(date)) throw new Error('Enter a valid calendar date.');
        await change({ action: 'asset.update', id: value.asset.id, patch: { dates: { [value.field]: date } } });
      });
      const date = label(node, assetObservationFieldName(value.field), 'fact-date', value.asset.dates[value.field] ?? '', 'date');
      date.required = true; date.min = '0001-01-01'; date.max = '9999-12-31';
      formActions(node, 'Save date'); return;
    }
    if (value.type === 'reading' || value.type === 'condition') {
      let fields: ReturnType<typeof mountAssetObservationEditor>;
      const node = form(value.type === 'reading' ? 'Record an actual reading' : 'Record a condition', async () => {
        await change({ action: 'asset.update', id: value.asset.id, patch: fields.read() });
      });
      if (editorReturnFocus) el('p', `For ${value.asset.name}`, node);
      fields = mountAssetObservationEditor(node, value.asset, value.type, () => { dirty = true; }, value.field);
      formActions(node, value.type === 'reading' ? 'Save reading' : 'Save condition'); return;
    }
    if (value.type === 'rule') {
      const own = value.rule; let fields: ReturnType<typeof mountAssetRuleEditor>;
      const node = form(own ? `Edit ${own.title}` : 'Add rule', async () => {
        const rule = fields.read();
        const stopsFloor = own?.consequence === 'floor' && own.enabled && !own.muted && (!rule.enabled || !rule.reaction.notify || rule.consequence !== 'floor'
          || rule.when.kind !== 'condition' && !rule.schedule.before.length && !rule.schedule.on_day);
        if (stopsFloor && !value.classPreset && doc.defaultView?.confirm && !doc.defaultView.confirm('Confirm stopping or lowering this safety, legal or travel clock?')) return;
        if (value.classPreset) { open({ type: 'class', creating: value.classCreating, preset: { ...value.classPreset, rules: [...value.classPreset.rules.filter(row => row.id !== rule.id), { ...rule, pinned: false }] } }); dirty = true; restoreEditorFocus(value.classFocus); }
        else if (value.proposal) await change({ action: 'proposal.edit', id: value.proposal.id, payload: { ...value.proposal.payload,
          ...(value.proposal.kind === 'schedule' ? { rule_id: rule.id, schedule: rule.schedule } : { rule: { ...rule, enabled: false, pinned: false } }) } });
        else await change({ action: 'rule.save', asset_id: value.asset.id, rule, confirm_floor_mute: !!stopsFloor });
      });
      fields = mountAssetRuleEditor(node, value.asset, own, () => { dirty = true; }, {
        classPreset: !!value.classPreset, proposal: !!value.proposal, scheduleOnly: value.proposal?.kind === 'schedule', initialField: value.initialField });
      formActions(node, value.classPreset ? 'Keep rule in draft' : value.proposal ? 'Save proposal' : 'Save', value.classPreset ? () => {
        open({ type: 'class', preset: value.classPreset!, creating: value.classCreating }); dirty = !!value.classDirty; restoreEditorFocus(value.classFocus);
      } : undefined); return;
    }
    if (value.type === 'class') {
      const own = value.preset;
      const creating = value.creating ?? !snapshot!.classes.some(row => row.id === own.id);
      const draft = (node: HTMLFormElement): AssetClassPreset => {
        return { ...own, id: field(node, 'id'), name: field(node, 'name'), origin: 'owner',
          audience: field(node, 'audience') as AssetClassPreset['audience'], retirement: field(node, 'retirement') as Asset['retirement'],
          fields: fields.read(),
          rules: own.rules.map(rule => {
            let before: AssetRule['schedule']['before'] = [];
            try { before = parseReminderOffsets(field(node, `before-${rule.id}`)); }
            catch (error) { yoursFieldError(node.elements.namedItem(`before-${rule.id}`) as HTMLInputElement, (error as Error).message); }
            return { ...rule, pinned: false, schedule: { ...rule.schedule, before } };
          }) };
      };
      const node = form(creating ? 'Create class preset' : 'Edit class preset', async node => {
        const preset = draft(node); const id = node.elements.namedItem('id') as HTMLInputElement;
        if (!/^[a-z][a-z0-9_]{0,127}$/u.test(preset.id)) yoursFieldError(id, 'Use a class id such as home_boiler.');
        if (creating && snapshot!.classes.some(row => row.id === preset.id)) yoursFieldError(id, 'This class id already exists. Choose a different id or edit the existing class.');
        await change({ action: 'class.save', preset, create: creating });
      });
      node.dataset.yoursFocusScope = JSON.stringify(['class-draft']);
      label(node, 'Name', 'name', own.name).required = true;
      const identity = yoursDisclosure(node, 'Advanced identity');
      label(identity, 'Class id', 'id', own.id).readOnly = !creating;
      el('small', 'A unique identifier for this template. Editing keeps its existing identity.', identity);
      const fields = mountClassFieldsEditor(node, own, () => { dirty = true; });
      select(node, 'Who sees its reminders by default', 'audience', [['owner', 'Only me'], ['household', 'Me and my household']], own.audience);
      select(node, 'When its parent retires', 'retirement', [['part', 'Goes with its parent'], ['cancel_or_transfer', 'Needs cancelling or transferring']], own.retirement);
      const editRule = (rule?: AssetRule, classFocus?: EditorReturnFocus) => {
        const preset = draft(node);
        const asset: Asset = { ...preset.fields, id: 'class-draft', source_id: 'recued.asset', name: preset.name, status: 'active', audience: preset.audience,
          retirement: preset.retirement, rules: preset.rules, values: [], anchors: [], attributes: {}, field_sources: {}, created_at: 0, updated_at: 0, last_seen_at: 0, sync_state: 'live', conflict_policy: 'recued_wins' };
        open({ type: 'rule', asset, ...(rule ? { rule } : {}), classPreset: preset, classCreating: creating, classDirty: dirty, classFocus });
      };
      for (const rule of own.rules) { const row = card(node, rule.title, undefined, ['class-draft-rule', rule.id]); label(row, `${rule.title}: remind before`, `before-${rule.id}`, scheduleText(rule));
        button(row, 'Edit preset rule', origin => editRule(rule, origin)); button(row, 'Remove preset rule', () => { const preset = draft(node); open({ type: 'class', creating, preset: { ...preset, rules: preset.rules.filter(row => row.id !== rule.id) } }); dirty = true; }); }
      button(node, 'Add preset rule', origin => editRule(undefined, origin));
      el('p', 'Search keywords apply to assets of this type immediately. Existing assets keep their own fact and reminder rows until you accept applying the preset.', node); formActions(node); return;
    }
    if (value.type === 'occasion') {
      const own = value.occasion;
      const node = form(own ? 'Edit occasion' : 'Create occasion', async node => {
        const once = !own?.source && field(node, 'repeat') === 'once';
        const date = field(node, 'date');
        if (once && !isAssetDate(date)) throw new Error('Choose a date for this one-time occasion');
        const { source_next_on: _previousDate, ...base } = own ?? {};
        const occasion = { ...base, ...(own?.source && own.source_next_on !== undefined ? { source_next_on: own.source_next_on } : {}),
          ...(own?.id ? { id: own.id } : {}), title: field(node, 'title'),
          month_day: once ? date.slice(-5) : field(node, 'month-day'), ...(once ? { source_next_on: date } : {}),
          people: [...new Set([...(own?.people.slice(1) ?? []), ...(field(node, 'person') ? [field(node, 'person')] : [])])], muted: yes(node, 'muted'), rules: own?.rules ?? [] };
        const confirmFloor = !!own?.rules.some(rule => rule.consequence === 'floor' && rule.enabled && !rule.muted) && occasion.muted;
        if (confirmFloor && doc.defaultView?.confirm && !doc.defaultView.confirm('Confirm stopping this safety, legal or travel clock?')) return;
        await change(value.proposal ? { action: 'proposal.edit', id: value.proposal.id, payload: { ...value.proposal.payload, occasion } } : { action: 'occasion.save', occasion, confirm_floor_mute: confirmFloor }); });
      label(node, 'Name', 'title', own?.title ?? '');
      const repeat = !own?.source ? select(node, 'Repeat', 'repeat', [['yearly', 'Every year'], ['once', 'One time']], own?.source_next_on !== undefined ? 'once' : 'yearly') : null;
      const annual = label(node, 'Annual date (MM-DD)', 'month-day', own?.month_day ?? '');
      const date = !own?.source ? label(node, 'Date', 'date', own?.source_next_on ?? '', 'date') : null;
      const showDate = () => {
        const once = repeat?.value === 'once';
        annual.parentElement!.hidden = once; annual.disabled = once;
        if (date) { date.parentElement!.hidden = !once; date.disabled = !once; }
      };
      repeat?.addEventListener('change', showDate); showDate();
      const choices = personChoices();
      if (own?.people[0] && !choices.some(([id]) => id === own.people[0])) choices.push([own.people[0], holderName(own.people[0])]);
      select(node, 'Person', 'person', choices, own?.people[0]); checked(node, 'Muted', 'muted', own?.muted ?? false); formActions(node); return;
    }
    if (value.type === 'occasion_rule') {
      const own = value.rule;
      const node = form(own ? `Edit ${own.title}` : value.occasion.source_next_on !== undefined && !value.occasion.source ? 'Add reminder' : 'Add annual habit', async node => {
        const offset = field(node, 'offset').trim();
        if (offset && (!Number.isSafeInteger(Number(offset)) || Number(offset) < 0)) throw new Error('Use a whole, non-negative offset');
        const rule: AssetRule = { id: own?.id ?? `habit_${globalThis.crypto.randomUUID().replaceAll('-', '')}`, title: field(node, 'title'),
          when: { kind: 'expiry', field: 'next_on', ...(offset && Number(offset) > 0 ? { offset: { amount: Number(offset), unit: field(node, 'offset-unit') as 'days' | 'weeks' | 'months' } } : {}) },
          enabled: yes(node, 'enabled'), muted: own?.muted ?? false, pinned: true, consequence: field(node, 'consequence') as 'floor' | 'routine',
          reaction: { notify: yes(node, 'notify'), occurrence: field(node, 'reaction') as 'action' | 'notice', emit: own?.reaction.emit ?? false },
          expiry_policy: 'strict_expire', schedule: { before: parseReminderOffsets(field(node, 'before')), on_day: yes(node, 'on-day') } };
        const stopping = own?.consequence === 'floor' && own.enabled && !own.muted && (!rule.enabled || !rule.reaction.notify || rule.consequence !== 'floor'
          || !rule.schedule.before.length && !rule.schedule.on_day);
        if (stopping && doc.defaultView?.confirm && !doc.defaultView.confirm('Confirm stopping or lowering this safety, legal or travel clock?')) return;
        if (value.proposal) await change({ action: 'proposal.edit', id: value.proposal.id, payload: { ...value.proposal.payload,
          ...(value.proposal.kind === 'schedule' ? { schedule: rule.schedule } : { rule: { ...rule, enabled: false, pinned: false } }) } });
        else await change({ action: 'occasion.save', occasion: { ...value.occasion, rules: [...value.occasion.rules.filter(row => row.id !== rule.id), rule] }, confirm_floor_mute: !!stopping });
      });
      label(node, 'Title', 'title', own?.title ?? 'Annual task');
      select(node, 'Creates', 'reaction', [['action', 'A task to complete'], ['notice', 'A notice with nothing to complete']], own?.reaction.occurrence ?? 'action');
      label(node, 'Due before the occasion (blank for the occasion date)', 'offset', own?.when.kind === 'expiry' && own.when.offset ? String(own.when.offset.amount) : '', 'number');
      select(node, 'Due offset unit', 'offset-unit', [['days', 'days'], ['weeks', 'weeks'], ['months', 'months']], own?.when.kind === 'expiry' ? own.when.offset?.unit ?? 'days' : 'days');
      label(node, 'Remind before the due date', 'before', own ? scheduleText(own) : '1 week'); checked(node, 'On the day', 'on-day', own?.schedule.on_day ?? true);
      select(node, 'Consequence', 'consequence', [['routine', 'Routine'], ['floor', 'Safety, legal or travel']], own?.consequence ?? 'routine');
      checked(node, 'Enabled', 'enabled', own?.enabled ?? true); checked(node, 'Notify', 'notify', own?.reaction.notify ?? true);
      el('p', 'The task lapses after its due day. The next year is a separate cycle.', node); formActions(node); return;
    }
    if (value.type === 'recall') {
      const node = form('Review the repeat task', async node => { await change({ action: 'proposal.edit', id: value.proposal.id,
        payload: { ...value.proposal.payload, statement: field(node, 'statement'), on: field(node, 'on') } }); });
      el('p', value.proposal.explanation, node); label(node, 'Task', 'statement', String(value.proposal.payload.statement ?? ''));
      label(node, 'Due date', 'on', String(value.proposal.payload.on ?? ''), 'date'); formActions(node, 'Save proposal'); return;
    }
    if (value.type === 'trip') {
      const own = value.proposal.payload.trip as TripDetails;
      const node = form('Trip travellers and dates', async node => {
        const travellers = [...node.querySelectorAll<HTMLInputElement>('input[data-traveller]')].filter(input => input.checked).map(input => input.value);
        const trip: TripDetails = { ...own, travellers, destination_country: field(node, 'country').trim().toUpperCase(), entry_on: field(node, 'entry'), exit_on: field(node, 'exit'), special_entry_status: yes(node, 'special-entry') };
        await write(async () => { await options.change({ action: 'proposal.edit', id: value.proposal.id, payload: { ...value.proposal.payload, trip } }); return options.change({ action: 'proposal.accept', ids: [value.proposal.id] }); });
      });
      label(node, 'Destination country (two-letter code)', 'country', own.destination_country ?? '').maxLength = 2;
      label(node, 'Entry date', 'entry', own.entry_on ?? '', 'date'); label(node, 'Exit date', 'exit', own.exit_on ?? '', 'date');
      const people = el('fieldset', undefined, node); el('legend', 'Travellers', people);
      const choices = new Map(contacts.map(person => [person.contact_id ?? person.email, person.name ?? person.email]));
      for (const id of own.travellers) if (!choices.has(id)) choices.set(id, id);
      for (const [id, name] of choices) { const input = checked(people, name, `traveller-${id}`, own.travellers.includes(id)); input.value = id; input.dataset.traveller = ''; }
      if (!choices.size) link(people, 'Add the travellers in Contacts', '#data/contact');
      checked(node, 'A residence permit or special family entry route applies', 'special-entry', own.special_entry_status ?? false);
      formActions(node, 'Save and check'); return;
    }
    if (value.type === 'relation' || value.type === 'close') {
      const own = value.proposal;
      let primary: AssetPicker; let related: AssetPicker;
      const node = form(`Edit ${own.title}`, async node => {
        const payload = { ...own.payload, ...(value.type === 'close' ? { on: field(node, 'on') } : { asset_id: primary.read(),
          [own.kind === 'merge' || own.payload.same_thing === true ? 'other_id' : 'parent_id']: related.read() }) };
        await change({ action: 'proposal.edit', id: own.id, title: field(node, 'title'), payload });
      });
      label(node, 'Title', 'title', own.title);
      if (value.type === 'close') label(node, 'Actual evidence date', 'on', String(own.payload.on ?? ''), 'date');
      else {
        primary = assetPicker(node, 'proposal-asset', 'Asset', String(own.payload.asset_id ?? ''), undefined,
          selection => { if (selection?.id === related?.getValue()?.id) related.setValue(null); });
        related = assetPicker(node, 'proposal-related', 'Related asset', String(own.payload.other_id ?? own.payload.parent_id ?? ''),
          candidate => candidate.id !== primary.getValue()?.id);
      }
      formActions(node, 'Save proposal'); return;
    }
    const own = value.episode;
    const localDateTime = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
    const node = form(own ? 'Correct episode' : 'Record something you did', async node => { const episode: EpisodeInput = {
      ...own, ...(own?.id ? { id: own.id } : {}), title: field(node, 'title'), when: { from: Date.parse(field(node, 'from')), to: Date.parse(field(node, 'to')) },
      people: field(node, 'person') ? [field(node, 'person')] : [], ...(field(node, 'place') ? { where: { key: `label:${field(node, 'place').toLocaleLowerCase('en')}`, name: field(node, 'place') } } : {}),
      subjects: own?.subjects ?? [], evidence: own?.evidence ?? [], sensitive: own?.sensitive ?? [], basis: 'declared', storage_reason: 'owner_record', notes: field(node, 'notes') };
      episode.sphere = field(node, 'episode-sphere') as 'personal' | 'professional' || undefined;
      await change(value.correction ? { action: 'proposal.dismiss', id: value.correction.id, code: 'wrong', episode_correction: episode } : { action: 'episode.save', episode }); });
    label(node, 'What happened', 'title', own?.title ?? ''); label(node, 'From', 'from', own ? localDateTime(own.when.from) : '', 'datetime-local'); label(node, 'To', 'to', own ? localDateTime(own.when.to) : '', 'datetime-local');
    label(node, 'Place', 'place', own?.where?.name ?? ''); select(node, 'With', 'person', personChoices(), own?.people[0]); select(node, 'Sphere', 'episode-sphere', [['', 'Unsorted'], ['personal', 'Personal'], ['professional', 'Work']], own?.sphere); label(node, 'Notes', 'notes', own?.notes ?? ''); formActions(node);
  };
  const renderOccurrence = (parent: HTMLElement, occurrence: YoursSnapshot['occurrences'][number]) => {
    const item = card(parent, occurrence.title, occurrence.commitment
      ? { collection: 'commitment', id: occurrence.commitment.id } : { collection: occurrence.subject_kind === 'occasion' ? 'occasion' : 'asset', id: occurrence.asset_id });
    link(item, occurrence.subject_kind === 'occasion' ? 'Open occasion' : 'Open asset', occurrence.subject_kind === 'occasion'
      ? `#yours/occasions/occasion/${encodeURIComponent(occurrence.asset_id)}` : `#yours/asset/${encodeURIComponent(occurrence.asset_id)}`);
    if (occurrence.question) {
      el('p', 'Last-done date unknown; no deadline has been assumed.', item); const date = label(item, 'Actual last-done date', `last-done-${occurrence.id}`, '', 'date');
      button(item, 'Save date', () => change({ action: 'occurrence.last_done', id: occurrence.id, on: date.value }));
      button(item, 'I don’t know', () => change({ action: 'occurrence.last_done', id: occurrence.id, on: null })); return;
    }
    const commitment = occurrence.commitment;
    if (!commitment) el('p', `Notice${occurrence.due_on ? ` · ${dueOnText(occurrence.due_on)}` : ''}`, item);
    if (commitment) {
      el('p', taskDueWords(commitment), item);
      // §15.7 (2026-10-24) — a renewal is done by its new date, never by Done alone: Done
      // kept the old date, and the clock that would have reminded again went quiet.
      const renewal = commitment.lifecycle_state === 'pending' ? occurrence.renewal : undefined;
      const date = renewal ? label(item, renewalDateWords(renewal.field), `renewal-${occurrence.id}`, '', 'date') : null;
      if (date && renewal) date.min = dayAfter(renewal.current) ?? '';
      const actions = yoursActions(item);
      if (commitment.lifecycle_state === 'pending') for (const outcome of ['fulfill', 'cancel'] as const) button(actions, outcome === 'fulfill' ? 'Done' : 'Cancel', () => write(async () => {
        if (outcome === 'fulfill' && date) return options.change({ action: 'occurrence.renewed', id: occurrence.id, on: date.value });
        await options.closeCommitment({ id: commitment.id, outcome }); return { message: outcome === 'fulfill' ? 'Completed.' : 'Cancelled.' };
      }), `${occurrence.id}-${outcome}`).className = outcome === 'fulfill' ? 'yours-primary' : '';
    }
  };
  /** Opens a cited record where the app can; false when it cannot. */
  const sourceLink = (parent: HTMLElement, source: { collection: string; id: string }): boolean => {
    if (source.collection === 'file' && options.files) button(parent, 'Open evidence', () => openFilePreview(doc, { record_id: source.id }, options.files!, routeAbort.signal));
    else if (source.collection === 'asset') link(parent, 'Open source asset', `#yours/asset/${encodeURIComponent(source.id)}`);
    else if (source.collection === 'episode') link(parent, 'Open precedent', `#yours/episodes/episode/${encodeURIComponent(source.id)}`);
    else if (source.collection === 'history_trace') link(parent, 'Open retained evidence', `#yours/episodes/trace/${encodeURIComponent(source.id)}`);
    else if ((source.collection === 'mail' || source.collection === 'calendar') && source.id.includes(':')) {
      const colon = source.id.indexOf(':'); link(parent, 'Open source record', serializeSourceRecordAddress({ tab: source.collection, collectionSlug: source.id.slice(0, colon), recordId: source.id.slice(colon + 1) }));
    } else return false;
    return true;
  };
  /** §15.3 — what an observation rests on: each item says what it showed and opens where it can. */
  const renderEvidence = (parent: HTMLElement, evidence: readonly AssetEvidence[]) => {
    if (!evidence.length) return;
    const list = el('ul', undefined, parent); list.setAttribute('aria-label', 'Evidence'); list.dataset.yoursEvidence = '';
    for (const item of evidence) sourceLink(el('li', assetEvidenceText(item), list), item);
  };
  /** P44 — an episode where it is cited (an occasion's history), with Correct and Hide.
   * A hidden episode leaves every list and is named under Memory exclusions (P17). */
  const renderEpisodeSummary = (item: HTMLElement, episode: EpisodeInput) => {
    item.classList.add('yours-event');
    el('p', `${episodeDateWords(episode.when)} · ${episode.where?.name ?? 'place unknown'}`, item).className = 'yours-event-date';
    el('p', EPISODE_BASIS_WORDS[episode.basis], item).className = 'yours-muted';
    if (episode.people.length) el('p', `With ${episode.people.map(id => holderName(id)).join(', ')}`, item);
    if (episode.notes) el('p', episode.notes, item);
    renderEvidence(item, episode.evidence);
  };
  const renderCitedEpisode = (parent: HTMLElement, episode: Episode) => {
    const item = card(parent, episode.title, { collection: 'episode', id: episode.id }); item.dataset.yoursCitedEpisode = episode.id;
    renderEpisodeSummary(item, episode);
    button(item, 'Correct', () => open({ type: 'episode', episode }), `correct-${episode.id}`);
    button(item, 'Hide', () => change({ action: 'episode.hide', id: episode.id }), `hide-${episode.id}`);
  };
  const renderProposal = (parent: HTMLElement, proposal: ProactiveProposal) => {
    const item = card(parent, proposal.title, proposal.subject ?? proposal.sources[0], ['proposal', proposal.id]);
    item.classList.add('yours-proposal');
    const preview = proposalPreview(proposal, { assets: [...snapshot!.assets, ...snapshot!.related_assets], classes: snapshot!.classes, occasions: snapshot!.occasions });
    if (preview.subject || preview.lines.length || preview.changes.length) {
      const change = el('div', undefined, item); change.className = 'yours-change-preview'; change.dataset.yoursProposalPreview = proposal.id;
      if (preview.subject) link(change, preview.subject.name, preview.subject.href);
      for (const line of preview.lines) el('p', line, change);
      for (const difference of preview.changes) {
        const pair = el('div', undefined, change); pair.className = 'yours-change-pair';
        for (const [title, value] of [[difference.current_label, difference.current], [difference.proposed_label, difference.proposed]]) {
          const side = el('div', undefined, pair); el('h4', `${title}:`, side); el('p', value, side);
        }
      }
    }
    const why = yoursDisclosure(item, 'Why suggested'); why.dataset.yoursDisclosure = `proposal:${proposal.id}:why`;
    el('p', proposal.explanation, why);
    el('small', `${proposal.confidence} confidence · ${proposal.kind} · ${proposal.lane?.replaceAll('_', ' ') ?? proposal.origin}`, why);
    for (const source of proposal.sources) if (!sourceLink(item, source)) el('small', `${source.collection}: ${source.id}`, item);
    if (proposal.kind === 'last_done') { const date = label(item, 'Actual last-done date', `proposal-${proposal.id}-date`, '', 'date');
      button(item, 'Save date', () => change({ action: 'occurrence.last_done', id: String(proposal.payload.occurrence_id), on: date.value }));
      button(item, 'I don’t know', () => change({ action: 'occurrence.last_done', id: String(proposal.payload.occurrence_id), on: null })); return;
    }
    if (proposal.kind === 'completion') {
      const date = label(item, 'Actual service date', `completion-${proposal.id}-date`, String(proposal.payload.on ?? ''), 'date');
      const reading = proposal.payload.unit ? label(item, `Service reading (${proposal.payload.unit})`, `completion-${proposal.id}-reading`, String(proposal.payload.reading ?? ''), 'number') : null;
      if (reading) reading.step = 'any';
      button(item, 'Confirm service details', () => write(async () => {
        if (!date.value || reading && !reading.value.trim()) throw new Error('Enter the actual service date and reading');
        await options.change({ action: 'proposal.edit', id: proposal.id, payload: { ...proposal.payload, on: date.value, ...(reading ? { reading: Number(reading.value) } : {}) } });
        return options.change({ action: 'proposal.accept', ids: [proposal.id] });
      }));
      button(item, 'I don’t know', () => change({ action: 'proposal.dismiss', id: proposal.id, code: 'not_this_one' })); return;
    }
    if (proposal.kind === 'habit') { link(item, 'Review standing task in Contracts', '#contracts'); return; }
    const actions = yoursActions(item);
    if (proposal.kind === 'trip') button(actions, 'Choose travellers', () => open({ type: 'trip', proposal })).className = 'yours-primary';
    else button(actions, proposal.kind === 'asset' ? 'Add asset' : proposal.kind === 'schedule' ? 'Apply reminder change'
      : proposal.kind === 'rule' ? proposal.payload.apply_class === true ? 'Apply template' : 'Switch on'
        : 'Accept',
    () => change({ action: 'proposal.accept', ids: [proposal.id] }), 'accept-proposal').className = 'yours-primary';
    button(actions, 'Review change', loadEditor(async () => {
      if (proposal.kind === 'asset') return { type: 'asset', proposal };
      if (proposal.kind === 'recall') return { type: 'recall', proposal };
      if (proposal.kind === 'ranking' || proposal.kind === 'relation') return { type: 'learning', proposal };
      if (proposal.kind === 'trip') return { type: 'trip', proposal };
      if (proposal.kind === 'occasion') return { type: 'occasion', occasion: proposal.payload.occasion as Occasion, proposal };
      if (proposal.kind === 'link' || proposal.kind === 'merge') return { type: 'relation', proposal };
      if (proposal.kind === 'close') return { type: 'close', proposal };
      if (proposal.kind === 'rule' || proposal.kind === 'schedule') {
        if (typeof proposal.payload.occasion_id === 'string') {
          const occasion = snapshot?.occasions.find(row => row.id === proposal.payload.occasion_id) ?? (await options.read({ occasion_id: proposal.payload.occasion_id })).occasions[0];
          if (!occasion) throw new Error('Occasion not found. Refresh this proposal.');
          const original = occasion.rules.find(row => row.id === proposal.payload.rule_id);
          const rule = proposal.kind === 'rule' ? proposal.payload.rule as AssetRule : original && { ...original, schedule: proposal.payload.schedule as AssetRule['schedule'] };
          if (!rule) throw new Error('Rule not found. Refresh this proposal.');
          return { type: 'occasion_rule', occasion, rule, proposal };
        }
        const id = String(proposal.payload.asset_id); const asset = snapshot?.assets.find(row => row.id === id) ?? (await options.read({ asset_id: id })).assets[0];
        if (!asset) throw new Error('Asset not found. Refresh this proposal.');
        if (proposal.payload.apply_class === true) return { type: 'class', preset: snapshot!.classes.find(row => row.id === proposal.payload.class_id)! };
        const original = asset.rules.find(row => row.id === proposal.payload.rule_id);
        const rule = proposal.kind === 'rule' ? proposal.payload.rule as AssetRule : original && { ...original, schedule: proposal.payload.schedule as AssetRule['schedule'] };
        if (!rule) throw new Error('Rule not found. Refresh this proposal.');
        return { type: 'rule', asset, rule, proposal };
      }
    }));
    button(actions, 'Not now', () => change({ action: 'proposal.dismiss', id: proposal.id, code: 'not_now' }));
    const more = yoursMenu(actions, proposal.title, ['proposal', proposal.id]);
    button(more, proposal.kind === 'asset' ? 'Not an asset' : 'Not this one', () => change({ action: 'proposal.dismiss', id: proposal.id, code: proposal.kind === 'asset' ? 'not_an_asset' : 'not_this_one' }));
    button(more, 'Never this kind', () => change({ action: 'proposal.dismiss', id: proposal.id, code: 'never_this_kind' }));
    if (proposal.subject?.collection === 'asset') button(more, 'That’s wrong', loadEditor(async () => { const asset = snapshot?.assets.find(asset => asset.id === proposal.subject!.id) ?? (await options.read({ asset_id: proposal.subject!.id })).assets[0];
      if (asset) return { type: 'asset', asset, correction: proposal }; else throw new Error('Asset not found. Refresh this proposal.'); }));
    if (proposal.kind === 'recall') button(more, 'That’s wrong', loadEditor(async () => { const episode = (await options.read({ episode_id: String(proposal.payload.episode_id), include_derived: true })).episodes[0];
      if (!episode) throw new Error('The precedent is unavailable'); return { type: 'episode', episode, correction: proposal }; }));
    button(more, 'Delete proposal', () => { if (!doc.defaultView?.confirm || doc.defaultView.confirm('Delete this proposal?')) return change({ action: 'proposal.delete', id: proposal.id }); }).className = 'yours-danger';
    if (proposal.merchant) button(more, `Stop proposing ${proposal.merchant}`, () => change({ action: 'merchant.stop', merchant: proposal.merchant! }));
  };
  const render = () => {
    if (disposed) return;
    typing = false;
    refreshContext = undefined;
    assetPickers.splice(0).forEach(picker => picker.destroy());
    navigationDisposers.splice(0).forEach(dispose => dispose());
    const active = doc.activeElement as HTMLElement | null;
    const focusedElement = active && root.contains(active) ? active : undefined;
    const focused = focusTarget(focusedElement) ?? (active === doc.body ? refreshingFocus : undefined);
    const focusedMenu = focusedElement?.closest<HTMLDetailsElement>('[data-yours-menu]')?.dataset.yoursMenu;
    // Carry interaction state only into this repaint, by entity and full field
    // identity. An editor, removed field or closed menu must not leave a cache.
    const openMenus = new Set([...root.querySelectorAll<HTMLDetailsElement>('[data-yours-menu][open]')].map(menu => menu.dataset.yoursMenu!));
    for (const disclosure of root.querySelectorAll<HTMLDetailsElement>('[data-yours-disclosure]')) {
      const key = disclosure.dataset.yoursDisclosure!;
      openDisclosures.set(key, disclosure.open);
    }
    writerSetup?.dispose(); writerSetup = undefined;
    root.replaceChildren(); root.dataset.yoursDetail = String(!!selected);
    const masthead = el('header', undefined, root); masthead.className = 'yours-masthead';
    const introduction = el('div', undefined, masthead); const heading = el('h1', 'Yours', introduction); heading.tabIndex = -1; heading.dataset.yoursHeading = '';
    if (selected) { introduction.className = 'yours-breadcrumb';
      const back = link(introduction, 'Assets', readListContinuity<string>(doc, continuityKey)?.filter ?? '#yours/assets'); back.setAttribute('aria-label', 'Back to assets'); }
    const restoreInteraction = () => {
      const menus = new Map([...root.querySelectorAll<HTMLDetailsElement>('[data-yours-menu]')].map(menu => [menu.dataset.yoursMenu!, menu]));
      for (const key of openMenus) { const menu = menus.get(key); if (menu) menu.open = true; }
      if (focusedMenu !== undefined) {
        const menu = menus.get(focusedMenu);
        const action = menu?.open && focused ? focusAction(focused) : undefined;
        (action ?? menu?.querySelector<HTMLElement>('summary') ?? heading).focus();
      } else if (focused) restoreEditorFocus(focused);
    };
    el('p', 'Your things, the facts, and what comes next.', introduction);
    button(masthead, 'Refresh', () => editor?.type === 'context' ? refreshContext?.() : editor?.type === 'writer_setup' ? writerSetup?.refresh() : refresh(!editor), 'refresh').className = 'yours-quiet';
    const navigation = yoursNavigation(root, 'Yours'); navigationDisposers.push(navigation.dispose); const nav = navigation.nav;
    for (const id of TABS) { const node = link(nav, TAB_LABELS[id], `#yours/${id}`); node.dataset.yoursFocus = `tab-${id}`; if (id === tab) node.setAttribute('aria-current', 'page'); }
    doc.defaultView?.requestAnimationFrame(() => {
      if (!nav.isConnected) return;
      const current = nav.querySelector<HTMLElement>('[aria-current]');
      if (!current) return;
      const rail = nav.getBoundingClientRect(); const active = current.getBoundingClientRect();
      if (active.right > rail.right) nav.scrollLeft += active.right - rail.right + 8;
      else if (active.left < rail.left) nav.scrollLeft -= rail.left - active.left + 8;
    });
    const status = el('p', message, root); status.setAttribute('role', 'status'); status.dataset.yoursStatus = '';
    const alert = el('p', error, root); alert.setAttribute('role', 'alert'); alert.dataset.yoursError = '';
    if (!snapshot) { yoursEmpty(root, loading ? 'Loading Yours…' : 'Yours is unavailable. Try Refresh.'); paintStatus(); restoreInteraction(); return; }
    if (!snapshot.phone_ready && (tab === 'occurrences' || tab === 'occasions' || selected && segments[3] === 'rules')) { const warning = el('p', 'Reminders currently reach only the app. ', root); warning.className = 'yours-notice'; link(warning, 'Choose a phone channel', '#settings/notifications'); }
    content = el('div', undefined, root); content.className = 'yours-content';
    if (editor) { renderEditor(); paintStatus(); return; }
    const pageHeader = !selected ? yoursPageHeader(content, classesView ? 'Classes' : TAB_LABELS[tab],
      classesView ? 'Reusable starting points for the things you keep.' : {
        assets: 'Keep the useful details. Add reminders when you need them.',
        proposals: 'Review suggestions before they become part of your records.',
        occurrences: 'Tasks, notices and questions your rules made due, overdue first.',
        occasions: 'Dates and traditions you want to remember.',
        episodes: 'Experiences you chose to keep, with the evidence behind them.',
      }[tab]) : undefined;
    let filterToolbar: HTMLElement | undefined;
    if (!assetList && !selected && !selectedOccasion && !selectedEpisode && !classesView) {
      const toolbar = filterToolbar = yoursToolbar(content); toolbar.classList.add('yours-compact-filter');
      const filter = select(toolbar, 'Sphere on this page', 'sphere-filter', [['', 'All spheres'], ['personal', 'Personal'], ['professional', 'Work'], ['unsorted', 'Unsorted']], sphereFilter);
      filter.addEventListener('change', () => { sphereFilter = filter.value; dirty = false; render(); root.querySelector<HTMLSelectElement>('[name=sphere-filter]')?.focus(); });
    }
    if (selected) {
      const asset = snapshot.assets[0]; if (!asset) { yoursEmpty(content, 'Asset not found.'); paintStatus(); restoreInteraction(); return; }
      content.dataset.yoursFocusScope = JSON.stringify(['asset', asset.id]);
      // §15.3 — the header names the holder, and says the status and audience in words.
      const parentName = (id: string) => snapshot!.related_assets.find(row => row.id === id)?.name ?? 'its parent';
      const assetHeader = yoursPageHeader(content, asset.name, [snapshot.classes.find(item => item.id === asset.class_id)?.name ?? 'Unclassified', ASSET_STATUS_WORDS[asset.status],
        `${asset.audience === 'household' ? 'Shared with your household' : 'Only you'}${asset.inherited_fields?.audience ? ` (same as ${parentName(asset.inherited_fields.audience)})` : ''}`].join(' · '));
      assetHeader.header.classList.add('yours-asset-header');
      const editAsset = button(assetHeader.actions, 'Edit asset', () => open({ type: 'asset', asset })); editAsset.textContent = 'Edit'; editAsset.setAttribute('aria-label', 'Edit asset');
      if (options.askAsset) { const ask = button(assetHeader.actions, 'Ask about this asset', () => options.askAsset!(assetChatContext(asset, files, filesAvailable))); ask.textContent = 'Ask'; ask.setAttribute('aria-label', 'Ask about this asset'); }
      const assetMenu = yoursMenu(assetHeader.actions, asset.name, ['asset', asset.id]);
      button(assetMenu, 'Save as class', () => open({ type: 'class', preset: presetForAsset(asset), creating: true }));
      button(assetMenu, 'Delete asset', () => { if (doc.defaultView?.confirm && !doc.defaultView.confirm(`Remove ${asset.name}, its open clocks and bindings? Its ${snapshot!.retirement_impact?.parts ?? 0} parts and ${snapshot!.retirement_impact?.contracts ?? 0} contracts are shown below.`)) return; return change({ action: 'asset.delete', id: asset.id, confirmed: true }); }).className = 'yours-danger';
      const metadata = el('div', undefined, assetHeader.text); metadata.className = 'yours-asset-identity';
      if (asset.holder_contact) el('p', `Held by ${holderName(asset.holder_contact)}`, metadata).setAttribute('data-yours-holder', '');
      placementChip(metadata, { collection: 'asset', id: asset.id });
      const view = segments[2] === 'view' && ['rules', 'files', 'activity'].includes(segments[3] ?? '') ? segments[3]! : 'overview';
      const localNavigation = yoursNavigation(content, 'Asset'); navigationDisposers.push(localNavigation.dispose); const localNav = localNavigation.nav; localNav.setAttribute('aria-label', 'Asset sections');
      for (const key of ['overview', 'rules', 'files', 'activity']) {
        const tab = link(localNav, key[0]!.toUpperCase() + key.slice(1), `#yours/asset/${encodeURIComponent(asset.id)}${key === 'overview' ? '' : `/view/${key}`}`);
        if (key === view) tab.setAttribute('aria-current', 'page');
      }
      const panels = Object.fromEntries(['overview', 'rules', 'files', 'activity'].map(key => {
        const panel = el('div', undefined, content); panel.className = 'yours-content'; panel.dataset.yoursAssetPanel = key; panel.hidden = key !== view; return [key, panel];
      })) as Record<'overview' | 'rules' | 'files' | 'activity', HTMLDivElement>;
      const openItems = section(panels.overview, 'Needs attention');
      const attention = yoursDisclosure(openItems, 'Open items'); attention.className = 'yours-attention'; attention.dataset.yoursDisclosure = `attention:${asset.id}`;
      const dueDates = snapshot.occurrences.map(item => item.due_on).filter((on): on is string => !!on && isAssetDate(on)).sort();
      const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      attention.open = !!snapshot.proposals.length || snapshot.occurrences.some(item => item.question || !!item.due_on && isAssetDate(item.due_on) && item.due_on <= today);
      openItems.classList.add('yours-attention-section'); openItems.querySelector('h3')!.hidden = !attention.open;
      attention.addEventListener('toggle', () => { openItems.querySelector('h3')!.hidden = !attention.open; });
      attention.querySelector('summary')!.textContent = [
        snapshot.occurrences.length ? `${snapshot.occurrences.length} open item${snapshot.occurrences.length === 1 ? '' : 's'}` : '',
        snapshot.proposals.length ? `${snapshot.proposals.length} suggestion${snapshot.proposals.length === 1 ? '' : 's'} to review` : '',
        dueDates[0] ? `Next due ${yoursCalendarDate(dueDates[0])}` : '',
      ].filter(Boolean).join(' · ');
      const attentionBody = el('div', undefined, attention); attentionBody.className = 'yours-content';
      snapshot.occurrences.forEach(item => renderOccurrence(attentionBody, item)); snapshot.proposals.forEach(item => renderProposal(attentionBody, item));
      openItems.hidden = !snapshot.occurrences.length && !snapshot.proposals.length;
      // §5.3 — forwarded proof proposes the close of an open task.
      if (snapshot.proof_addresses?.length && snapshot.occurrences.some(item => item.closes_by_proof)) {
        el('p', `To close one with proof, forward the email that shows it was done to ${snapshot.proof_addresses.join(' or ')} from that same mailbox, then accept the proposal it makes here.`, attentionBody)
          .setAttribute('data-yours-proof-addresses', '');
      }
      const rules = section(panels.rules, 'Rules'); button(sectionActions(rules), 'Add rule', () => open({ type: 'rule', asset })).className = 'yours-primary';
      if (!asset.rules.length) yoursEmpty(rules, 'No rules yet. Add one when a fact needs a reminder or an action.');
      for (const rule of asset.rules) {
        const item = card(rules, rule.title, undefined, ['rule', asset.id, rule.id]);
        const state = el('span', `${rule.enabled ? 'Enabled' : 'Disabled'}${rule.muted ? ' · reminders muted' : ''}`, item); state.className = 'yours-state';
        el('p', `${assetRuleWhenWords(rule.when)}.`, item);
        el('p', `${ruleScheduleSummary(rule).replace(/^r/u, 'R')} · ${rule.consequence === 'floor' ? 'Safety, legal or travel' : 'Routine'}`, item).className = 'yours-muted';
        item.dataset.yoursRule = rule.id;
        item.tabIndex = -1; item.dataset.yoursFocus = JSON.stringify(['source', 'rule', rule.id]);
        if (rule.when.kind === 'condition' || rule.when.kind === 'objective') {
          const path = `${rule.when.kind === 'condition' ? 'observations' : 'readings'}.${rule.when.field}`;
          if (!(snapshot.observation_bindings ?? []).some(binding => binding.enabled && binding.available !== false && binding.asset_id === asset.id && binding.fields.includes(path))) el('p', 'Nothing writes this yet. Enroll an observation writer below, or record it yourself.', item);
        }
        const actions = yoursActions(item); button(actions, 'Edit rule', () => open({ type: 'rule', asset, rule }));
        if (options.context) button(actions, 'Explain this rule', () => open({ type: 'context', request: { root: { kind: 'rule', asset_id: asset.id, rule_id: rule.id } } }), `explain-rule-${rule.id}`);
        button(actions, rule.muted ? 'Unmute' : 'Mute', () => { const confirmed = rule.consequence !== 'floor' || rule.muted || !doc.defaultView?.confirm || doc.defaultView.confirm('Stop reminders for this safety, legal or travel clock? Its obligation stays open.');
          if (confirmed) return change({ action: 'rule.save', asset_id: asset.id, rule: { ...rule, muted: !rule.muted }, confirm_floor_mute: true }); });
        button(yoursMenu(actions, rule.title, ['rule', asset.id, rule.id]), 'Delete rule', () => { if (rule.consequence === 'floor' && doc.defaultView?.confirm && !doc.defaultView.confirm('Remove this safety, legal or travel clock and cancel its open occurrence?')) return;
          return change({ action: 'rule.delete', asset_id: asset.id, rule_id: rule.id, confirm_floor_delete: true }); }).className = 'yours-danger';
      }
      const comparisons = renderAssetComparisons(panels.overview, asset, snapshot.reading_comparisons, (field, origin) => open({ type: 'reading', asset, field }, focusTarget(origin)));
      const readings = section(panels.overview, 'Conditions and readings'); const readingActions = yoursActions(readings);
      if (comparisons) panels.overview.append(comparisons);
      readings.hidden = !Object.keys(asset.readings).length && !Object.keys(asset.observations).length;
      button(readingActions, 'Record reading', () => open({ type: 'reading', asset })); button(readingActions, 'Record condition', () => open({ type: 'condition', asset }));
      if (options.writerSetup && Object.keys(HOME_ASSISTANT_WRITER_SETUP.fields).some(path => {
        const [group, key] = path.split('.') as ['readings' | 'observations', string]; return Object.hasOwn(asset[group], key);
      })) button(readingActions, 'Automatic updates', () => open({ type: 'writer_setup', asset }), 'automatic-updates');
      const writers = yoursDisclosure(panels.rules, 'Observation writers');
      el('p', 'Choose an installed recipe and the fields it can report. A changed recipe needs your review again.', writers);
      for (const binding of snapshot.observation_bindings ?? []) if (binding.asset_id === asset.id) {
        const recipe = snapshot.observation_recipes?.find(recipe => binding.actor_ref === `recipe:${recipe.id}`);
        const item = card(writers, recipe?.name ?? 'Observation writer', undefined, ['writer', asset.id, binding.id]);
        el('p', !binding.enabled ? 'Disabled' : binding.available === false ? 'Needs enrollment or review' : 'Enabled for these fields', item);
        el('p', binding.fields.map(path => { const [group, field] = path.split('.'); return `${factName(field ?? path)} ${group === 'readings' ? 'reading' : 'condition'}`; }).join(', '), item);
        el('small', 'Can report observations for these fields. Your manual entries keep their authority.', item);
        const identity = yoursDisclosure(item, 'Writer details');
        identity.dataset.yoursDisclosure = JSON.stringify(['writer-details', asset.id, binding.id]);
        el('code', `${binding.actor_ref} · ${binding.id}`, identity);
        button(item, 'Review writer', () => open({ type: 'writer', asset, recipe_id: binding.actor_ref.replace(/^recipe:/u, '') }));
        if (binding.enabled) button(item, 'Disable writer', () => change({ action: 'binding.disable', asset_id: asset.id, id: binding.id }));
      }
      button(writers, 'Enroll writer', () => open({ type: 'writer', asset }));
      // A writer by the installed recipe's name, never its binding reference.
      const writerName = (ref: string): string => snapshot!.observation_recipes?.find(recipe => (snapshot!.observation_bindings ?? [])
        .some(binding => binding.source_ref === ref && binding.actor_ref === `recipe:${recipe.id}`))?.name ?? 'An observation writer';
      const observationControls = (item: HTMLElement, path: string, value: Asset['readings'][string] | Asset['observations'][string]) => {
        const source = asset.field_sources[path];
        if (path.startsWith('readings.')) {
          if (source) renderAssetSource(item, source, `${asset.id}:${path}`, source.kind === 'observation' ? writerName(source.ref) : undefined);
          else el('small', 'Source not recorded.', item);
        }
        if (source?.kind !== 'owner') return;
        if (asset.automatic_updates?.[path] !== undefined) {
          el('p', 'Automatic updates allowed. Your entry stays until a fresh authorized observation arrives.', item);
          if (!(snapshot!.observation_bindings ?? []).some(binding => binding.enabled && binding.available !== false && binding.asset_id === asset.id && binding.fields.includes(path)))
            el('p', 'No writer is ready for this field. Choose or review an observation writer above.', item);
        } else {
          el('p', 'Your entry takes priority over automatic updates to this field.', item);
          if (asset.sync_state === 'live' && ['active', 'lent'].includes(asset.status))
            button(item, 'Allow automatic updates', () => change({ action: 'asset.automatic_updates', id: asset.id, path, expected: { value, source } }), `allow-automatic-${path}`);
        }
      };
      for (const [name, reading] of Object.entries(asset.readings)) {
        const item = card(readings, assetObservationFieldName(name), undefined, ['field', asset.id, 'readings', name]); item.dataset.yoursReading = name;
        item.classList.add('yours-reading-row');
        item.tabIndex = -1; item.dataset.yoursFocus = JSON.stringify(['source', 'reading', name]);
        el('p', reading ? `${reading.value} ${reading.unit}` : 'Unknown', item).className = 'yours-reading-value';
        if (reading) el('small', `Observed ${yoursDateTime(reading.as_of)}`, item);
        if (reading) renderEvidence(item, reading.evidence);
        const actions = yoursActions(item); const update = button(actions, 'Update reading', () => open({ type: 'reading', asset, field: name }), `reading-${name}`); update.textContent = 'Update'; update.setAttribute('aria-label', 'Update reading');
        const more = yoursMenu(actions, `${assetObservationFieldName(name)} reading`, ['field', asset.id, 'readings', name]);
        button(more, 'Use in a rule', () => open({ type: 'rule', asset, initialField: { group: 'readings', field: name } }), `use-reading-${name}`);
        button(more, 'Keep updated from a source', () => open({ type: writerEditor(`readings.${name}`), asset, field: `readings.${name}` }), `writer-reading-${name}`);
        if (reading) button(more, 'Add evidence', () => open({ type: 'evidence', asset, group: 'readings', field: name }), `evidence-reading-${name}`);
        if (options.context) button(more, 'Used by', () => open({ type: 'context', request: { root: { kind: 'field', asset_id: asset.id, group: 'readings', field: name } } }), `used-by-reading-${name}`);
        observationControls(item, `readings.${name}`, reading);
      }
      const expected = (asset.settings[ASSET_EXPECTED_PATTERNS] ?? {}) as Record<string, { active: boolean; at: number } | undefined>;
      for (const [name, observation] of Object.entries(asset.observations)) { const item = card(readings, assetObservationFieldName(name), undefined, ['field', asset.id, 'observations', name]); item.dataset.yoursCondition = name;
        item.classList.add('yours-reading-row');
        item.dataset.yoursField = `observations.${name}`; item.tabIndex = -1; item.dataset.yoursFocus = JSON.stringify(['source', 'field', `observations.${name}`]);
        const source = asset.field_sources[`observations.${name}`];
        el('p', observation ? `${observation.active ? 'Present' : 'Clear'} · ${observation.certainty}` : 'Unknown', item).className = 'yours-reading-value';
        if (observation) {
          el('small', `Observed ${yoursDateTime(observation.as_of)}`, item);
        }
        if (source) renderAssetSource(item, source, `${asset.id}:observations.${name}`, source.kind === 'observation' ? writerName(source.ref) : undefined);
        else el('small', 'Source not recorded.', item);
        if (observation) renderEvidence(item, observation.evidence);
        const actions = yoursActions(item); button(actions, 'Update condition', () => open({ type: 'condition', asset, field: name }), `condition-${name}`);
        const more = yoursMenu(actions, `${assetObservationFieldName(name)} condition`, ['field', asset.id, 'observations', name]);
        button(more, 'Use in a rule', () => open({ type: 'rule', asset, initialField: { group: 'observations', field: name } }), `use-condition-${name}`);
        button(more, 'Keep updated from a source', () => open({ type: writerEditor(`observations.${name}`), asset, field: `observations.${name}` }), `writer-condition-${name}`);
        if (observation) button(more, 'Add evidence', () => open({ type: 'evidence', asset, group: 'observations', field: name }), `evidence-condition-${name}`);
        if (options.context) button(more, 'Used by', () => open({ type: 'context', request: { root: { kind: 'field', asset_id: asset.id, group: 'observations', field: name } } }), `used-by-condition-${name}`);
        observationControls(item, `observations.${name}`, observation);
        // §4.10 — the owner's word that a present condition is intended, kept for this asset;
        // the rule clock raises nothing for it (`assetConditionExpected`). It sends this one
        // setting: re-sending the others would mark them as typed by the owner.
        const { [name]: mark, ...otherMarks } = expected;
        if (mark) {
          el('p', `You marked this as expected on ${new Date(mark.at).toLocaleString()}. While it is present, it raises no task or reminder.`, item);
          button(item, 'Not expected after all', () => change({ action: 'asset.update', id: asset.id,
            patch: { settings: { [ASSET_EXPECTED_PATTERNS]: Object.keys(otherMarks).length ? otherMarks : null } } }), `unexpected-${name}`);
        } else if (observation?.active) button(item, 'That’s expected', () => change({ action: 'asset.update', id: asset.id, patch: { settings: {
          [ASSET_EXPECTED_PATTERNS]: { ...expected, [name]: { active: true, at: observation.as_of } } } } }), `expected-${name}`); }
      // §15.3 — each value with where it came from and what can replace it (its rank).
      const facts = section(panels.overview, 'Facts and settings'); panels.overview.insertBefore(facts, readings);
      const factActions = sectionActions(facts); button(factActions, 'Add fact', () => open({ type: 'fact', asset, group: 'attributes' })).className = 'yours-primary';
      if (readings.hidden) { const more = yoursMenu(factActions, 'facts', ['facts', asset.id]);
        button(more, 'Record reading', () => open({ type: 'reading', asset })); button(more, 'Record condition', () => open({ type: 'condition', asset })); }
      const definition = el('dl', undefined, facts); definition.className = 'yours-facts';
      const factRows: Array<[path: string, name: string, value: unknown]> = [
        ...Object.entries(asset.dates).map(([name, value]): [string, string, unknown] => [`dates.${name}`, name, value]),
        ...Object.entries(asset.attributes).filter(([key]) => key !== ASSET_DOCUMENT_DETAILS_ATTRIBUTE).map(([name, value]): [string, string, unknown] => [`attributes.${name}`, name, value]),
        ...Object.entries(asset.settings).filter(([key]) => key !== ASSET_EXPECTED_PATTERNS).map(([name, value]): [string, string, unknown] => [`settings.${name}`, name, value]),
        ...(asset.holder_contact ? [['holder_contact', 'holder', holderName(asset.holder_contact)] as [string, string, unknown]] : []),
        ...(['document_number', 'serial_number', 'exact_address'] as const).flatMap((name): Array<[string, string, unknown]> => asset[name] === undefined ? [] : [[name, name, asset[name]]]),
      ];
      for (const [path, name, value] of factRows) {
        const row = el('div', undefined, definition); row.className = 'yours-fact'; el('dt', factName(name), row);
        row.dataset.yoursField = path; row.tabIndex = -1; row.dataset.yoursFocus = JSON.stringify(['source', 'field', path]);
        const detail = el('dd', value === null ? 'Unknown' : typeof value === 'object' ? JSON.stringify(value) : path.startsWith('dates.') && typeof value === 'string' ? yoursCalendarDate(value) : String(value), row); detail.dataset.yoursFact = path;
        if (path.startsWith('dates.') && typeof value === 'string') detail.title = value;
        const inheritedFrom = asset.inherited_fields?.[path]; const source = asset.field_sources[path];
        if (inheritedFrom) el('small', `Same as ${parentName(inheritedFrom)}.`, detail);
        else if (source) renderAssetSource(detail, source, `${asset.id}:${path}`);
        if (path === 'document_number' || path === 'serial_number' || path === 'exact_address') el('small', ASSET_IDENTIFYING_FIELD_NOTE, detail);
        if (path.startsWith('dates.')) {
          const actionHost = el('dd', undefined, row); actionHost.className = 'yours-fact-actions'; const more = yoursMenu(actionHost, name.replaceAll('_', ' '), ['fact', asset.id, path]);
          button(more, 'Record date', () => open({ type: 'date', asset, field: name }), `record-date-${name}`);
          button(more, 'Use in a rule', () => open({ type: 'rule', asset, initialField: { group: 'dates', field: name } }), `use-date-${name}`);
          if (options.context) button(more, 'Used by', () => open({ type: 'context', request: { root: { kind: 'field', asset_id: asset.id, group: 'dates', field: name } } }), `used-by-date-${name}`);
        }
        if ((path.startsWith('attributes.') || path.startsWith('settings.')) && (value === null || ['string', 'number', 'boolean'].includes(typeof value)) && !['nationality', 'valid_for'].includes(name)) {
          const actionHost = el('dd', undefined, row); actionHost.className = 'yours-fact-actions';
          const more = yoursMenu(actionHost, name.replaceAll('_', ' '), ['fact', asset.id, path]);
          button(more, 'Edit fact', () => open({ type: 'fact', asset, group: path.startsWith('attributes.') ? 'attributes' : 'settings', field: name }), `edit-fact-${path}`);
          if (path.startsWith('attributes.') && typeof value === 'string') button(more, 'Record as a reading', () => open({ type: 'attribute_reading', asset, attribute: name, request_id: globalThis.crypto.randomUUID() }), `record-attribute-${name}`);
        }
      }
      if (!factRows.length) yoursEmpty(facts, 'No facts recorded yet. Add a name and a value, such as length and 25 meters.');
      const related = section(panels.overview, 'Belongs to, parts and contracts');
      const parent = snapshot.related_assets.find(row => row.id === asset.belongs_to);
      if (parent) link(related, `Belongs to ${parent.name}`, `#yours/asset/${encodeURIComponent(parent.id)}`);
      else el('p', asset.belongs_to ? 'The parent asset is unavailable.' : 'No parent asset.', related);
      for (const row of snapshot.related_assets.filter(row => row.id !== asset.belongs_to)) link(related, `${row.name} · ${row.retirement}`, `#yours/asset/${encodeURIComponent(row.id)}`);
      button(related, asset.belongs_to ? 'Change parent' : 'Choose parent', () => open({ type: 'parent', asset }));
      button(related, 'Link another record for the same thing', () => open({ type: 'same_thing', asset }));
      const attachments = section(panels.files, 'Files');
      const attached = files.filter(link => link.role === 'attachment' && link.to_collection === 'file');
      if (!attached.length) el('p', 'No attached files.', attachments);
      for (const file of attached) {
        const item = card(attachments, 'Attached file', undefined, ['document', asset.id, file._id]); item.dataset.yoursDocument = file._id;
        const title = item.querySelector('h3')!; const metadata = el('div', undefined, item);
        const details = assetDocumentDetails(asset, file.to_id);
        if (Object.keys(details).length) {
          const facts = el('dl', undefined, item);
          for (const [name, value] of [['Purpose', details.purpose], ['Applies to', details.applies_to], ['Document revision', details.revision]]) {
            if (value) { el('dt', name, facts); el('dd', value, facts); }
          }
        }
        const actions = yoursActions(item);
        let selection: FileAttachmentSelection | undefined;
        if (options.files) {
          const version = generation;
          const load = async () => {
            metadata.replaceChildren(); el('p', 'Loading file details…', metadata);
            try {
              const result = await readFileMetadata(file.to_id);
              if (disposed || version !== generation || !item.isConnected) return;
              selection = result; title.textContent = result.filename; metadata.replaceChildren();
              const size = result.size < 1024 ? `${result.size} B` : result.size < 1024 * 1024 ? `${(result.size / 1024).toFixed(1)} KB` : `${(result.size / (1024 * 1024)).toFixed(1)} MB`;
              el('p', `${result.mime_type} · ${size}`, metadata);
            } catch {
              if (disposed || version !== generation || !item.isConnected) return;
              metadata.replaceChildren(); el('p', 'File details unavailable.', metadata);
              button(metadata, 'Retry file details', () => { fileMetadata.delete(file.to_id); return load(); });
            }
          };
          if (view === 'files') void load();
          button(actions, 'Preview file', () => openFilePreview(doc, { record_id: file.to_id,
            ...(selection ? { filename: selection.filename, selection_revision: selection.selection_revision } : {}) }, options.files!, routeAbort.signal)).className = 'yours-primary';
        }
        const more = yoursMenu(actions, 'attached file', ['attachment', asset.id, file._id]);
        button(more, 'Document details', () => open({ type: 'document', asset, file, filename: selection?.filename ?? details.purpose ?? 'Attached file' }));
        button(more, 'Remove attachment', () => change({ action: 'file.detach', asset_id: asset.id, link_id: file._id, record_id: file.to_id })).className = 'yours-danger';
      }
      if (options.files) {
        const attach = yoursDisclosure(attachments, 'Attach a file'); attach.dataset.yoursDisclosure = `attach:${asset.id}`; attach.open = !attached.length;
        const query = label(attach, 'Find a file to attach', 'file-search', '', 'text', true); const browser = el('div', undefined, attach);
        let cursor: string | undefined; let browseVersion = 0;
        query.addEventListener('input', () => { browseVersion += 1; cursor = undefined; browser.replaceChildren(); });
        const browse = async (more = false) => {
          if (more && !cursor) return;
          const version = ++browseVersion; const term = query.value; const after = more ? cursor : undefined;
          if (!more) cursor = undefined;
          const current = () => !disposed && browser.isConnected && version === browseVersion && query.value === term;
          const result = await options.files!.list({ query: term, limit: 50, ...(after ? { cursor: after } : {}) })
            .catch(value => { if (current()) throw value; return undefined; });
          if (!result || !current()) return;
          if (!more) browser.replaceChildren(); else browser.querySelector('[data-yours-file-more]')?.remove();
          cursor = result.next_cursor;
          for (const file of result.files) { const item = card(browser, file.filename); el('p', file.mime_type, item);
            button(item, 'Preview', () => openFilePreview(doc, { record_id: file.file_id, selection_revision: file.selection_revision }, options.files!, routeAbort.signal));
            button(item, 'Attach', () => change({ action: 'file.attach', asset_id: asset.id, record_id: file.file_id })); }
          if (cursor) button(browser, 'More files', () => browse(true)).dataset.yoursFileMore = '';
          if (!more && !result.files.length) el('p', 'No matching files.', browser);
        };
        const actions = yoursActions(attach); button(actions, 'Browse files', () => browse());
        const upload = link(actions, 'Upload a file', '#data/files');
        upload.addEventListener('click', event => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) options.prepareFileUpload?.({ id: asset.id, name: asset.name }); });
      }
      const history = section(panels.activity, 'History'); if (!timeline?.entries.length && !snapshot.observation_handoffs?.length) yoursEmpty(history, 'No timeline entries.');
      let timelineDay = ''; let dayList: HTMLOListElement | undefined;
      for (const entry of timeline?.entries ?? []) {
        const at = new Date(entry.ts); const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        if (day !== timelineDay) { timelineDay = day; const group = el('section', undefined, history); group.className = 'yours-history-day';
          el('h4', day, group); dayList = el('ol', undefined, group); dayList.className = 'yours-timeline'; }
        const row = el('li', undefined, dayList!); const heading = el('div', undefined, row); heading.className = 'yours-timeline-heading';
        const words = entry.kind.replace(/[._-]+/gu, ' '); el('strong', words.replace(/^./u, letter => letter.toUpperCase()), heading);
        const when = el('time', at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), heading);
        if (Number.isFinite(at.getTime())) when.dateTime = at.toISOString();
        const details = yoursDisclosure(row, 'Source details'); details.classList.add('yours-source'); details.dataset.yoursDisclosure = JSON.stringify(['timeline', asset.id, entry.ts, entry.source, entry.kind]);
        el('p', `${yoursDateTime(entry.ts)} · ${entry.source} · ${entry.kind}`, details);
      }
      for (const entry of snapshot.observation_handoffs ?? []) {
        const value = entry.value; const title = assetObservationFieldName(entry.path.split('.')[1]!);
        const item = card(history, `Automatic updates allowed · ${title}`); item.dataset.yoursHandoff = entry.id;
        el('p', yoursDateTime(entry.at), item);
        el('p', `Previous manual entry: ${value === null ? 'Unknown' : 'value' in value ? `${value.value} ${value.unit}` : `${value.active ? 'Present' : 'Clear'} · ${value.certainty}`}`, item);
        el('p', `Recorded by you · ${yoursDateTime(entry.source.at)}${value ? ` · observed ${yoursDateTime(value.as_of)}` : ''}`, item);
      }
    } else if (tab === 'assets') {
      link(pageHeader!.actions, classesView ? 'Assets' : 'Classes', classesView ? '#yours/assets' : '#yours/assets/classes');
      if (classesView) {
        button(pageHeader!.actions, 'Create class', () => open({ type: 'class', creating: true, preset: { id: newClassId(), name: '', version: 1, origin: 'owner', fields: { dates: {}, readings: {}, observations: {}, settings: {} }, rules: [], audience: 'owner', retirement: 'part' } })).className = 'yours-primary';
        const list = yoursList(content);
        for (const preset of snapshot.classes) { const item = card(list, `${preset.name} · v${preset.version}`, undefined, ['class', preset.id]);
          const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
          el('p', `${count(Object.keys(preset.fields.dates).length, 'date')} · ${count(Object.keys(preset.fields.readings).length, 'reading')} · ${count(preset.rules.length, 'rule')}`, item).className = 'yours-muted';
          for (const [group, title] of [['dates', 'Dates'], ['readings', 'Readings'], ['observations', 'Conditions']] as const) {
            const names = Object.keys(preset.fields[group]).map(assetObservationFieldName);
            if (names.length) el('p', `${title}: ${names.join(', ')}`, item);
          }
          for (const rule of preset.rules) el('p', `${rule.title} · ${assetRuleWhenWords(rule.when)} · ${scheduleText(rule)}`, item);
          const actions = yoursActions(item); button(actions, preset.origin === 'owner' ? 'Edit class' : 'Make my own copy', () => open({ type: 'class', preset: structuredClone(preset) }));
          if (preset.origin === 'owner') button(yoursMenu(actions, preset.name, ['class', preset.id]), 'Delete class', () => { if (!doc.defaultView?.confirm || doc.defaultView.confirm('Delete this preset? Existing assets keep their own rules.')) return change({ action: 'class.delete', id: preset.id }); }).className = 'yours-danger'; }
      }
      else { button(pageHeader!.actions, 'Create asset', () => open({ type: 'asset' })).className = 'yours-primary';
        const toolbar = yoursToolbar(content); toolbar.classList.add('yours-asset-toolbar');
        const searchRow = el('div', undefined, toolbar); searchRow.className = 'yours-search-row';
        const query = label(searchRow, 'Find assets', 'search', search, 'search', true);
        const applySearch = () => { search = query.value.trim(); return navigateAssets(); };
        button(searchRow, 'Search', applySearch);
        query.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void applySearch(); } });
        const filters = yoursDisclosure(searchRow, 'Filters'); filters.classList.add('yours-asset-filters');
        const filter = select(filters, 'Show assets', 'asset-filter', [['', 'All assets'], ['missing_facts', 'Missing facts'], ['overdue', 'Overdue dates']], assetFilter);
        filter.addEventListener('change', () => { assetFilter = filter.value as typeof assetFilter; search = query.value.trim(); void navigateAssets(); });
        const sphere = select(filters, 'Asset sphere', 'asset-sphere', [['', 'All spheres'], ['personal', 'Personal'], ['professional', 'Work'], ['unsorted', 'Unsorted']], assetSphere);
        sphere.addEventListener('change', () => { assetSphere = sphere.value as typeof assetSphere; search = query.value.trim(); void navigateAssets(); });
        const applied = assetFiltersApplied(snapshot);
        if (assetFilter && snapshot.asset_filter?.kind !== assetFilter) el('p', 'Asset filters are unavailable on this server. Choose All assets to view your assets.', content);
        if (assetSphere && snapshot.asset_sphere !== assetSphere) el('p', 'Asset sphere filters are unavailable on this server. Choose All spheres to view your assets.', content);
        const meta = el('div', undefined, content); meta.className = 'yours-list-meta';
        if (applied) {
          const count = el('p', `${snapshot.total_assets} ${search || assetFilter || assetSphere ? 'matching ' : ''}asset${snapshot.total_assets === 1 ? '' : 's'}`, meta); count.dataset.yoursAssetCount = '';
        }
        for (const text of [assetFilter === 'missing_facts' ? 'Missing facts' : assetFilter ? 'Overdue dates' : '', assetSphere === 'personal' ? 'Personal' : assetSphere === 'professional' ? 'Work' : assetSphere ? 'Unsorted' : '', search ? `“${search}”` : ''].filter(Boolean)) el('span', text, meta).className = 'yours-filter-chip';
        if (assetFilter || assetSphere || search) button(meta, 'Clear filters', () => { assetFilter = ''; assetSphere = ''; search = ''; return navigateAssets(); }).className = 'yours-quiet';
        if (applied) {
          if (assetFilter) el('p', assetFilter === 'missing_facts' ? 'Facts required by enabled rules.' : 'Due dates before today. Estimates are labelled on each card.', content);
          if (assetFilter && snapshot.asset_filter?.unavailable) el('p', `${snapshot.asset_filter.unavailable} asset${snapshot.asset_filter.unavailable === 1 ? '' : 's'} could not be checked. Choose All assets to review ${snapshot.asset_filter.unavailable === 1 ? 'it' : 'them'}.`, content);
          if (!snapshot.assets.length) yoursEmpty(content, search || assetFilter || assetSphere ? 'No assets match these filters.' : 'No assets yet. Create one, or review the proposals from local receipts.');
        }
        if (assetFilter) link(content, 'Remove attention filter', assetListHash(0, ''));
        const list = yoursList(content);
        for (const asset of applied ? snapshot.assets : []) { const item = card(list, '', { collection: 'asset', id: asset.id }); item.dataset.yoursAsset = asset.id;
          link(item.querySelector('h3')!, asset.name, `#yours/asset/${encodeURIComponent(asset.id)}`).dataset.yoursAssetName = '';
          const identity = el('div', undefined, item); identity.className = 'yours-asset-identity';
          el('p', [snapshot.classes.find(preset => preset.id === asset.class_id)?.name ?? asset.class_id, ASSET_STATUS_WORDS[asset.status]].filter(Boolean).join(' · '), identity).className = 'yours-asset-meta';
          const sphere = item.querySelector<HTMLElement>('[data-yours-sphere]'); if (sphere) identity.append(sphere);
          mountAssetSummary(item, asset, snapshot.asset_summaries?.find(summary => summary.asset_id === asset.id), fact => {
            const [kind, field] = fact.path.split('.');
            open({ type: kind === 'dates' ? 'date' : kind === 'readings' ? 'reading' : 'condition', asset, field: field! },
              { key: `missing:${asset.id}:${fact.path}`, asset_id: asset.id, scope: JSON.stringify(['asset', asset.id]) });
          });
          const openAsset = link(item, '›', `#yours/asset/${encodeURIComponent(asset.id)}`); openAsset.setAttribute('aria-label', 'Open asset'); openAsset.title = `Open ${asset.name}`; openAsset.dataset.yoursOpenAsset = ''; } }
    } else if (tab === 'proposals') {
      const kind = select(filterToolbar ?? content, 'Proposal kind', 'proposal-kind', [['', 'All kinds'], ...PROACTIVE_PROPOSAL_KINDS.map(value => [value, value.replaceAll('_', ' ')] as [string, string])], proposalKind);
      kind.addEventListener('change', () => { proposalKind = kind.value as typeof proposalKind; page = 0; dirty = false;
        if (doc.defaultView?.location) doc.defaultView.location.hash = `#yours/proposals${proposalKind ? `/kind/${proposalKind}` : ''}`; else void refresh(true); });
      if (snapshot.subscribers?.length) {
        const host = el('details', undefined, content); el('summary', 'Event subscribers', host);
        el('p', 'Select the contract each subscriber uses for event values and subsequent reads. A revoked selection stops access. Review grants in Contracts.', host);
        for (const subscriber of snapshot.subscribers) {
          const choices: Array<[string, string]> = [['', 'Ordinary owner automation'], ...(snapshot.subscriber_contracts ?? []).map(row => [row.id, row.name] as [string, string])];
          if (subscriber.contract_id && !choices.some(([id]) => id === subscriber.contract_id)) choices.push([subscriber.contract_id, 'Selected contract is no longer available']);
          const control = select(host, `${subscriber.recipe_id} · ${subscriber.pattern}`, `subscriber-${subscriber.trigger_id}`, choices, subscriber.contract_id);
          control.addEventListener('change', () => { void change({ action: 'subscriber.contract', trigger_id: subscriber.trigger_id, contract_id: control.value || null }); });
        }
      }
      // §15.4 — what the owner answered on Today stays restorable here.
      if (snapshot.situation_dismissals?.length) {
        const host = el('details', undefined, content); host.dataset.yoursDismissals = ''; el('summary', `Hidden from Today · ${snapshot.situation_dismissals.length}`, host);
        for (const row of snapshot.situation_dismissals) {
          const item = el('p', `${row.scope === 'kind' ? `Every ${row.kind.replaceAll('_', ' ')} item` : row.label} · ${row.code === 'not_now' && row.until
            ? `until ${new Date(row.until).toLocaleString()}` : row.code === 'never_this_kind' ? 'never this kind' : 'not this one'}`, host);
          button(item, 'Show again', () => change({ action: 'situation.restore', key: row.key }), `restore-${row.key}`);
        }
      }
      for (const issue of snapshot.subscriber_issues ?? []) {
        const item = card(content, 'A situation subscriber needs reconciliation');
        el('p', 'This run may have performed an action before its result was lost. It will not run again automatically. Review its effects before acknowledging it.', item);
        link(item, 'Review run', serializeLogsRunAddress({ runId: issue.run_id }));
        button(item, 'I reconciled this run', () => {
          if (doc.defaultView?.confirm && !doc.defaultView.confirm('Have you checked the run and reconciled any uncertain effects? This acknowledges the revision without running it again.')) return;
          return change({ action: 'subscriber.reconciled', subscriber_id: issue.subscriber_id, revision: issue.revision, run_id: issue.run_id });
        });
      }
      const trust = yoursDisclosure(content, 'What is read'); el('p', 'Recued checks stored mail facts on this server for likely durable purchases. Unaccepted proposals stay here until you decide. Pharmacy and health purchases are excluded. Accepted assets remain yours.', trust);
      el('p', `${snapshot.intake.emails_read} emails read locally · ${snapshot.intake.receipts_found} source records checked · ${snapshot.intake.likely_assets} likely assets`, trust);
      for (const source of snapshot.sources) { const input = checked(trust, source.name, `source-${source.id}`, source.enabled); input.addEventListener('change', () => { void change({ action: 'source.set', id: source.id, enabled: input.checked }); }); }
      for (const suppression of snapshot.suppressions.filter(row => row.kind === 'merchant')) { const item = el('p', `Stopped: ${suppression.value}`, trust); button(item, 'Allow again', () => change({ action: 'suppression.delete', id: suppression.id })); }
      button(trust, 'Check local receipts', () => change({ action: 'intake.scan' }));
      button(trust, 'Forget unaccepted extractions', () => { if (doc.defaultView?.confirm && !doc.defaultView.confirm('Forget unaccepted extractions? Emails and assets you accepted remain yours.')) return; return change({ action: 'intake.forget', confirmed: true }); });
      for (const lane of ['likely_asset', 'gift', 'return', 'pickup', 'bundle', 'other']) {
        const proposals = snapshot.proposals.filter(proposal => {
          if (lane === 'other' ? !!proposal.lane : proposal.lane !== lane) return false;
          const ref = proposal.subject ?? proposal.sources[0];
          return !sphereFilter || (ref ? placementFor(ref)?.sphere ?? 'unsorted' : 'unsorted') === sphereFilter;
        }); if (!proposals.length) continue;
        const host = section(content, { likely_asset: 'Likely assets', gift: 'Gifts', return: 'Returns', pickup: 'Pickups', bundle: 'Bundles', other: 'Other proposals and questions' }[lane]!);
        if (lane !== 'other' && proposals.length > 1) button(host, `Accept all ${proposals.length} proposals`, () => change({ action: 'proposal.accept', ids: proposals.map(proposal => proposal.id) }));
        proposals.forEach(proposal => renderProposal(host, proposal));
      }
      if (!snapshot.proposals.length) yoursEmpty(content, 'No proposals waiting.');
      content.append(trust);
    } else if (tab === 'occurrences') {
      el('p', 'Everything still open, including what is more than seven days away.', content);
      [...snapshot.occurrences].sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999')).forEach(item => renderOccurrence(content, item));
      if (!snapshot.occurrences.length) yoursEmpty(content, 'Nothing is due. Tasks and notices from your rules appear here when they come up.');
    } else if (tab === 'occasions') {
      button(pageHeader!.actions, 'Create occasion', () => open({ type: 'occasion' })).className = 'yours-primary';
      for (const occasion of snapshot.occasions) { const item = card(content, occasion.title, { collection: 'occasion', id: occasion.id });
        item.classList.add('yours-event');
        const next = occasionNextDate(occasion, new Date().toISOString().slice(0, 10));
        el('p', `${next ? `Next ${yoursCalendarDate(next)}` : 'No upcoming date'}${occasion.muted ? ' · muted' : ''}`, item).className = 'yours-event-date';
        if (occasion.people.length) el('p', occasion.people.map(id => holderName(id)).join(', '), item);
        if (occasion.source_active === false) el('p', 'Its source was removed or hidden. Reminders are suspended.', item);
        const actions = yoursActions(item); button(actions, 'Edit occasion', () => open({ type: 'occasion', occasion })); button(yoursMenu(actions, occasion.title, ['occasion', occasion.id]), 'Delete occasion', () => { const floor = occasion.rules.some(rule => rule.enabled && rule.consequence === 'floor');
          if (floor && doc.defaultView?.confirm && !doc.defaultView.confirm('Confirm removing this safety, legal or travel clock?')) return; return change({ action: 'occasion.delete', id: occasion.id, confirm_floor_delete: floor }); });
        button(actions, occasion.source_next_on !== undefined && !occasion.source ? 'Add reminder' : 'Add habit', () => open({ type: 'occasion_rule', occasion }));
        for (const rule of occasion.rules) { const row = card(item, rule.title === occasion.title ? (occasion.source_next_on !== undefined && !occasion.source ? 'Reminder' : 'Annual reminder') : rule.title, undefined, ['occasion-rule', occasion.id, rule.id]); el('p', `${rule.reaction.occurrence === 'action' ? 'Task' : 'Notice'} · ${reminderTimingWords(rule.schedule, rule.expiry_policy)}${!rule.enabled ? ' · disabled' : rule.muted ? ' · muted' : ''}`, row);
          button(row, 'Edit occasion rule', () => open({ type: 'occasion_rule', occasion, rule }));
          button(row, rule.muted ? 'Resume' : 'Mute', () => { const needs = rule.consequence === 'floor' && !rule.muted; if (needs && doc.defaultView?.confirm && !doc.defaultView.confirm('Confirm stopping this safety, legal or travel clock?')) return;
            return change({ action: 'occasion.save', occasion: { ...occasion, rules: occasion.rules.map(value => value.id === rule.id ? { ...value, muted: !value.muted, pinned: true } : value) }, confirm_floor_mute: needs }); }); }
        for (const occurrence of snapshot.occurrences.filter(row => row.subject_kind === 'occasion' && row.asset_id === occasion.id)) renderOccurrence(item, occurrence);
        // §15.2, P44 — on its own page an occasion shows the suggestions that would change
        // it, and its history, where each episode can be corrected or hidden. The server
        // reads both for this occasion alone; the list's reads are not about it.
        if (occasion.id === selectedOccasion) {
          if (snapshot.proposals.length) { const suggestions = section(item, 'Suggestions'); snapshot.proposals.forEach(proposal => renderProposal(suggestions, proposal)); }
          const history = section(item, 'History'); snapshot.episodes.forEach(episode => renderCitedEpisode(history, episode));
          if (!snapshot.episodes.length) el('p', 'No episode of this occasion is recorded yet.', history);
        }
      }
      if (!snapshot.occasions.length) yoursEmpty(content, 'Add a yearly or one-time occasion. Birthdays also come from your contacts.');
    } else {
      button(pageHeader!.actions, 'Record episode', () => open({ type: 'episode' })).className = 'yours-primary';
      const management = section(content, 'Memory settings');
      const privacy = yoursDisclosure(management, 'Memory exclusions');
      el('p', 'These people, places and date ranges are excluded from every memory suggestion.', privacy);
      const suppressionKind = select(privacy, 'Exclude', 'exclude-kind', [['person', 'Person'], ['place', 'Place'], ['date_range', 'Date range']], 'person');
      const excludedPerson = select(privacy, 'Person to exclude', 'exclude-person', personChoices());
      const excludedPlace = label(privacy, 'Place to exclude', 'exclude-place', '');
      const blockedFrom = label(privacy, 'Block from', 'exclude-from', '', 'date'); const blockedTo = label(privacy, 'Block through', 'exclude-to', '', 'date');
      button(privacy, 'Add exclusion', () => write(async () => {
        if (suppressionKind.value === 'place') { const placed = await options.change({ action: 'place.save', name: excludedPlace.value, aliases: [] });
          if (!placed.id) throw new Error('Choose a place'); return options.change({ action: 'suppression.save', suppression: { kind: 'place', value: placed.id } }); }
        if (suppressionKind.value === 'date_range') return options.change({ action: 'suppression.save', suppression: { kind: 'date_range',
          from: Date.parse(`${blockedFrom.value}T00:00`), to: Date.parse(`${blockedTo.value}T23:59:59.999`) } });
        return options.change({ action: 'suppression.save', suppression: { kind: 'person', value: excludedPerson.value } });
      }));
      // A hidden episode is one row, by its title: the rows for its evidence go with it.
      for (const suppression of snapshot.suppressions.filter(row => ['person', 'place', 'date_range', 'episode', 'proposal_kind'].includes(row.kind) && !row.of)) {
        const row = card(privacy, suppression.kind === 'date_range' ? `${new Date(suppression.from!).toLocaleDateString()} – ${new Date(suppression.to!).toLocaleDateString()}`
          : suppression.kind === 'proposal_kind' ? `Suggestion class: ${suppression.value?.replace(/^recall:/u, '')}`
          : suppression.kind === 'episode' ? `Episode: ${suppression.label ?? 'one you hid or deleted'}`
          : `${suppression.kind === 'person' ? 'Person' : 'Place'}: ${contacts.find(contact => (contact.contact_id ?? contact.email) === suppression.value)?.name ?? suppression.value}`);
        button(row, 'Remove exclusion', () => change({ action: 'suppression.delete', id: suppression.id }));
      }
      const aliases = yoursDisclosure(management, 'Place names'); const placeName = label(aliases, 'Place name', 'place-name', ''); const placeAliases = label(aliases, 'Other names (comma-separated)', 'place-aliases', '');
      button(aliases, 'Save place names', () => change({ action: 'place.save', name: placeName.value, aliases: placeAliases.value.split(',').map(value => value.trim()).filter(Boolean) }));
      // §15.7 — the switch's home is Settings → Privacy → Learning; the rates are kept here.
      const recall = yoursDisclosure(management, 'Last time in your overview');
      el('p', `${snapshot.settings.last_time === 'on' ? 'On.' : snapshot.settings.last_time === 'off' ? 'Off.' : 'Off until you allow it.'} A kind of offer reaches your overview only after at least five scored candidates, at a rate you accept. Settings → Privacy has the same switch.`, recall);
      for (const rate of snapshot.recall_rates ?? []) {
        const row = card(recall, lastTimeClassName(rate.class_id)); el('p', `${rate.relevant} relevant of ${rate.scored} scored · ${Math.round(rate.rate * 100)}%${rate.qualified ? ' · your rate is met' : ''}`, row);
        const minimum = label(row, 'Minimum rate (%)', `rate-${rate.class_id}`, String(Math.round((rate.minimum_rate ?? rate.rate) * 100)), 'number'); minimum.min = '0'; minimum.max = '100';
        const accept = button(row, 'Accept this rate', () => change({ action: 'recall.class', class_id: rate.class_id, minimum_rate: Number(minimum.value) / 100 })); accept.disabled ||= rate.scored < 5;
      }
      if (!(snapshot.recall_rates ?? []).length) el('p', 'Nothing has been measured yet. Recued measures in private and shows no offer meanwhile.', recall);
      button(recall, snapshot.settings.last_time === 'on' ? 'Turn last time off' : 'Allow last time', () => change({ action: 'settings.update', last_time: snapshot!.settings.last_time === 'on' ? 'off' : 'on' }));
      if (snapshot.history_receipts?.length) { const receipts = section(management, 'Evidence kept before mail retention'); for (const receipt of snapshot.history_receipts) el('p', `${receipt.mailbox} · ${receipt.candidates} candidates · ${new Date(receipt.at).toLocaleDateString()}`, receipts); }
      button(recall, 'Forget retained memory evidence', () => { if (doc.defaultView?.confirm && !doc.defaultView.confirm('Forget retained memory evidence, dark scores and unaccepted recall offers? Your own records remain.')) return;
        return change({ action: 'history.forget', confirmed: true }); });
      for (const evidence of snapshot.history_evidence ?? []) { const row = card(content, evidence.title); el('p', `${episodeDateWords(evidence.when)} · ${evidence.where?.name ?? 'place unknown'} · retained ${evidence.retained_at ? new Date(evidence.retained_at).toLocaleDateString() : 'unknown'}`, row);
        el('p', 'Kept before raw mail retention.', row); renderEvidence(row, evidence.sources); }
      // P44 — the list holds stored episodes only. A derived one shows only at its own
      // address, where a proposal or occasion cites it, never as a lifelog.
      const episodes = [...snapshot.episodes, ...(selectedEpisode ? (snapshot.derived_episodes ?? []).filter(row => !snapshot!.episodes.some(value => value.id === row.id)) : [])];
      const episodeList = yoursList(content); content.insertBefore(episodeList, management);
      for (const episode of episodes) { const item = card(episodeList, episode.title, episode.id ? { collection: 'episode', id: episode.id } : undefined);
        item.dataset.yoursEpisode = episode.id ?? '';
        renderEpisodeSummary(item, episode);
        if (!snapshot.episodes.some(row => row.id === episode.id)) el('p', 'Assembled for this view. Kept only when you correct or annotate it, or a proposal cites it.', item);
        // Only its own address shows a hidden episode, so its address says so.
        if (snapshot.suppressions.some(row => row.kind === 'episode' && !row.of && row.value === episode.id)) el('p', 'You hid this episode. Remove its exclusion above to show it again.', item);
        const actions = yoursActions(item); button(actions, 'Correct or annotate', () => open({ type: 'episode', episode }));
        button(yoursMenu(actions, episode.title, ['episode', episode.id!]), 'Delete and stop suggesting', () => change({ action: 'episode.delete', id: episode.id!, suppress: true })).className = 'yours-danger';
      }
      if (!episodes.length) yoursEmpty(episodeList, 'Only episodes you record, correct, annotate or keep for a proposal or occasion are stored here.');
      content.append(management);
    }
    if (!selected && !classesView && assetFiltersApplied(snapshot)) { const pageRoute = tab === 'proposals' && proposalKind ? `${tab}/kind/${proposalKind}` : tab; const pagination = el('nav', undefined, content); pagination.className = 'yours-pages'; pagination.setAttribute('aria-label', 'Pages'); if (page > 0) link(pagination, 'Previous', assetList ? assetListHash(page - 1) : `#yours/${pageRoute}/page/${page}`);
      const more = tab === 'proposals' ? (page + 1) * 50 < (snapshot.matching_proposals ?? snapshot.total_proposals) : tab === 'assets' ? (page + 1) * 50 < snapshot.total_assets : (tab === 'episodes' ? snapshot.episodes.length + (snapshot.derived_episodes?.length ?? 0) : tab === 'occasions' ? snapshot.occasions.length : 0) === 50;
      if (more) link(pagination, 'Next', assetList ? assetListHash(page + 1) : `#yours/${pageRoute}/page/${page + 2}`); }
    if (snapshot.unmatched_replies.length) { const replies = section(content, 'Unmatched replies'); for (const reply of snapshot.unmatched_replies) { const item = card(replies, reply.reason.replaceAll('_', ' ')); el('p', reply.text, item); button(item, 'Dismiss reply', () => change({ action: 'unmatched.dismiss', id: reply.id })); } }
    for (const disclosure of root.querySelectorAll<HTMLDetailsElement>('[data-yours-disclosure]')) if (openDisclosures.has(disclosure.dataset.yoursDisclosure!)) disclosure.open = openDisclosures.get(disclosure.dataset.yoursDisclosure!)!;
    paintStatus(); restoreInteraction();
    // D-325 — source links focus their exact saved input once. Later broadcasts
    // preserve what the owner is doing instead of pulling focus back to it.
    if (selected && !editor && !inputAddressFocused && ['reading', 'rule', 'field'].includes(segments[4] ?? '') && segments[5]) {
      inputAddressFocused = true;
      const kind = segments[4] === 'reading' ? 'yoursReading' : segments[4] === 'field' ? 'yoursField' : 'yoursRule';
      const target = [...root.querySelectorAll<HTMLElement>(segments[4] === 'reading' ? '[data-yours-reading]' : segments[4] === 'field' ? '[data-yours-field]' : '[data-yours-rule]')]
        .find(node => node.dataset[kind] === segments[5] && !node.closest('[hidden]'));
      if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
      else { message = 'That saved input is no longer on file. Review the current item below.'; paintStatus(); }
    }
    if (assetList && restoreListPosition) {
      restoreListPosition = false; const remembered = readListContinuity<string>(doc, continuityKey);
      if (remembered?.filter === assetListHash(page)) doc.defaultView?.requestAnimationFrame(() => {
        if (disposed || editor) return;
        const asset = [...root.querySelectorAll<HTMLElement>('[data-yours-asset]')].find(node => node.dataset.yoursAsset === remembered.focusedId);
        focusListTarget(asset?.querySelector<HTMLElement>(remembered.focusKind === 'name' ? '[data-yours-asset-name]' : '[data-yours-open-asset]'));
        restoreListScroll(scrollHost, remembered.scroll);
      });
    }
  };
  const refresh = (force = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    // A broadcast never rebuilds the page over what the owner is typing, in an
    // editor or any other field; the owner's own save, search or Refresh does.
    if ((editor || dirty || typing) && !force) { message = editor ? 'Updates are available. Save or cancel your edit to refresh.'
      : 'Updates are available. They appear when you save what you typed, or press Refresh.'; paintStatus(); return Promise.resolve(); }
    if (!editor) { dirty = false; typing = false; }
    const editorAtStart = editor; const draftAtStart = draftVersion; const errorAtStart = errorVersion;
    // A pending read must not rebuild a form opened or a search typed meanwhile.
    const newerDraft = () => (editor !== undefined && editor !== editorAtStart) || draftVersion !== draftAtStart;
    const version = ++generation; loading = true;
    if (!snapshot) render(); else paintStatus();
    pending = (async () => {
      try {
        const result = await options.read({ ...(selected ? { asset_id: selected } : {}), ...(selectedOccasion ? { occasion_id: selectedOccasion } : {}),
          ...(assetList ? { include_asset_summaries: true, ...(assetFilter ? { asset_filter: assetFilter } : {}), ...(assetSphere ? { asset_sphere: assetSphere } : {}) } : {}),
          ...(selectedEpisode ? { episode_id: selectedEpisode } : {}), ...(selectedTrace ? { trace_id: selectedTrace } : {}), ...(tab === 'episodes' && selectedEpisode ? { include_derived: true } : {}), limit: 50, offset: page * 50,
          proposal_offset: tab === 'proposals' ? page * 50 : 0, ...(proposalKind ? { proposal_kind: proposalKind } : {}), ...(search ? { search } : {}), mark_shown: tab === 'proposals' || !!selected || !!selectedOccasion });
        if (disposed || version !== generation || newerDraft()) return;
        if (assetList && page > 0 && assetFiltersApplied(result) && page * 50 >= result.total_assets) {
          // Back must not reopen this invalid page and redirect again.
          void navigateAssets(Math.max(0, Math.ceil(result.total_assets / 50) - 1), true); return;
        }
        const extra = await Promise.allSettled([options.contacts?.() ?? Promise.resolve([]), selected ? options.links?.(selected) ?? Promise.resolve([]) : Promise.resolve([]),
          selected ? options.timeline?.({ entity_id: `asset:${selected}`, limit: 30 }) ?? Promise.resolve(undefined) : Promise.resolve(undefined)]);
        if (disposed || version !== generation || newerDraft()) return;
        snapshot = result;
        contacts = extra[0].status === 'fulfilled' ? extra[0].value : []; files = extra[1].status === 'fulfilled' ? extra[1].value : []; timeline = extra[2].status === 'fulfilled' ? extra[2].value : undefined;
        filesAvailable = options.links !== undefined && extra[1].status === 'fulfilled';
        fileMetadata.clear();
        const failures = extra.filter(result => result.status === 'rejected');
        if (failures.length) setError('Some contacts, file links or history could not be read. Refresh to retry.');
        else if (errorVersion === errorAtStart) setError('');
      } catch (value) { if (!disposed && version === generation && !newerDraft()) setError(value instanceof Error ? value.message : String(value)); }
      finally { if (!disposed && version === generation) { loading = false;
        if (newerDraft()) { message = editor ? 'Updates are available. Save or cancel your edit to refresh.' : 'Updates are available. Search or press Refresh to update the list.'; paintStatus(); }
        else {
          // This refresh may open its route's form; it must not replace a form
          // the owner opened while the read was pending, or reopen after Cancel.
          if (snapshot && segments[0] === 'new' && !editor && !routeEditorOpened) { editor = { type: 'asset' }; routeEditorOpened = true; }
          // P44 — `#yours/episodes/episode/<id>/correct` is Correct where an episode is
          // cited outside Yours (a contact's page): it opens the correction once.
          const cited = selectedEpisode && segments[3] === 'correct'
            ? [...(snapshot?.episodes ?? []), ...(snapshot?.derived_episodes ?? [])].find(row => row.id === selectedEpisode) : undefined;
          if (cited && !editor && !routeEditorOpened) { editor = { type: 'episode', episode: cited }; routeEditorOpened = true; }
          render();
          if (!openedRecorded && selected && snapshot?.assets.some(asset => asset.id === selected)) { openedRecorded = true; options.recordOpened?.({ collection: 'asset', id: selected }); }
        }
      } }
    })(); return pending;
  };
  // A sync emits a burst of warehouse events; one snapshot read follows the burst.
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const onBroadcast = () => { if (broadcastTimer !== undefined) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => { broadcastTimer = undefined; void refresh(); }, 400); };
  const unsubscribe = options.subscribe ? [options.subscribe('warehouse', onBroadcast), options.subscribe('memory', onBroadcast)] : [];
  // Initial loading can precede the socket handshake. A connected transition
  // also recovers a failed read; refresh keeps active drafts intact.
  if (options.subscribeReady) unsubscribe.push(options.subscribeReady(() => { void refresh(); }));
  void refresh();
  return { dispose() { disposed = true; routeAbort.abort(); generation += 1; if (broadcastTimer !== undefined) clearTimeout(broadcastTimer);
    if (assetList) updateListContinuity(doc, continuityKey, { filter: assetListHash(page), page,
      focusedId: openedAsset?.id ?? (doc.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-yours-asset]')?.dataset.yoursAsset,
      focusKind: openedAsset?.kind,
      scroll: readListScroll(scrollHost) });
    assetPickers.splice(0).forEach(picker => picker.destroy());
    navigationDisposers.splice(0).forEach(dispose => dispose());
    writerSetup?.dispose(); unsubscribe.forEach(unsubscribe => unsubscribe()); root.remove(); }, refresh,
    whenLoaded: () => pending, hasUnsavedChanges: () => dirty, hasInFlightWork: () => busy || writerBusy,
    getRunPageContext: (): RunPageContext | null => {
      if (disposed || loading || error || !snapshot || editor) return null;
      const asset = selected ? snapshot.assets.find(row => row.id === selected) : undefined;
      const occasion = selectedOccasion ? snapshot.occasions.find(row => row.id === selectedOccasion) : undefined;
      const episode = selectedEpisode
        ? [...snapshot.episodes, ...(snapshot.derived_episodes ?? [])].find(row => row.id === selectedEpisode)
        : undefined;
      const object = asset ? runPageObject('asset', asset.id, { ...asset })
        : occasion ? runPageObject('occasion', occasion.id, { ...occasion })
        : episode?.id ? runPageObject('episode', episode.id, { ...episode }) : null;
      return object ? { label: object.label, objects: [object] } : null;
    },
    unsavedChangesPrompt: () => 'Discard these unsaved Yours changes?', inFlightWorkPrompt: () => busy || writerBusy ? 'A Yours change is still waiting for its result. Stay until it finishes?' : null,
    getRecoveryContextFreshness: (): 'current' | 'unavailable' => snapshot && !loading && !error ? 'current' : 'unavailable' };
};
