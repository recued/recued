#!/usr/bin/env node
/**
 * Whole-surface interaction sweep for the webclient PWA.
 *
 *   npm run audit:webclient-surface                      # every surface
 *   npm run audit:webclient-surface -- --surface packs   # one
 *   npm run audit:webclient-surface -- --json out.json --verbose
 *
 * ## What this is
 *
 * It presses every interactive control the real app renders — including the
 * ones behind menus, drawers and modals — on every surface it can reach, and
 * reports the presses that produced NOTHING observable.
 *
 * It exists because a whole class of this app's defects renders a failure as a
 * deliberate nothing: a dead button, an empty list, a blank panel. An absence
 * is unreportable — "nothing happens" is equally compatible with a stale
 * bundle, a missing permission, a legitimate empty state and a real bug — so
 * the only cheap way to find them is to press everything and diff the world.
 *
 * ## The three constraints it is built around
 *
 * 1. ⛔ **It boots the REAL composition root.** It drives
 *    `full-app-harness.html`, which boots the shipped `bootstrapWebclient` in
 *    real Chromium with real CSS; it never composes a route itself. The defect
 *    that motivated this sweep (`wireRunModal` built an overlay that the Pack
 *    Use host never appended to the document) lived ONLY in the composition
 *    root — every component below it passed its own tests, and a Playwright
 *    spec that composed the route itself and stubbed `openRunModal` passed
 *    against the broken build. A rig that composes what it audits reproduces
 *    that miss exactly.
 *
 * 2. ⛔ **It asserts OUTCOMES, never invocations.** "The handler was called" is
 *    precisely what a dead button does. The signal is a MutationObserver over
 *    `document.documentElement` plus hash change, `document.body` child delta
 *    (overlay attachment), dialog count and visible-text hash.
 *
 * 3. ⛔ **Every surface measures an idle baseline before it is judged.** "Did
 *    anything change?" is worthless on a surface that changes on its own — one
 *    spinner or realtime frame would make every control look alive and the
 *    sweep would report a clean pass it did not earn. So each state is first
 *    observed for one settle window with NO press. A state whose idle window
 *    mutates is marked NOISY and its presses are judged on the strong signals
 *    only (hash / overlay / dialog / text); a press with no strong signal on a
 *    noisy state is reported UNJUDGED — never silently counted as alive.
 *
 * ## How it reaches modals: a BFS over UI states
 *
 * Pressing only what is visible at the landing misses most of the app — on
 * `#packs` that was 30 of 37 controls, all of them behind the account menu and
 * the drawer. So a press that REVEALS controls which were not visible before is
 * recorded as an "opener", and the state it opens is queued as a new path to
 * sweep (`[opener, …]`). Paths are replayed from a fresh boot, so every press
 * is judged from a clean state rather than from whatever the previous press
 * left behind — the latch that made one real defect present as "the buttons are
 * not clickable" for a whole session.
 *
 * ## ⚠ Demo-mode values are read from the harness, never guessed
 *
 * The populated states come from `full-app-harness.ts`'s query params. An
 * unrecognised value does not error — it silently renders the empty default,
 * which sweeps clean and reports as audited. The first draft of this file
 * guessed `packs=ready`/`recipes=ready`/`data=ready`; the real values are
 * `installed`/`installed`/`contacts`. Twelve surfaces would have been swept
 * empty and reported clean. Every value below is copied from a comparison in
 * `full-app-harness.ts` — if you add a surface, grep the harness for the param
 * and copy the literal it is compared against.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SWEEP_PORT ?? 4331);
const SETTLE_MS = Number(process.env.SWEEP_SETTLE_MS ?? 450);
const BOOT_TIMEOUT_MS = 25_000;
// Depth 3, not 2. A confirm dialog inside a panel inside a settings section is
// three presses deep, and depth 2 could not see any of them: raising it reached
// the hostnames add-form, the TLS renew confirm, clear-this-browser and the
// AI-models slot-clear dialog — 13 attributes that had never rendered.
const MAX_DEPTH = Number(process.env.SWEEP_MAX_DEPTH ?? 3);
const MAX_STATES = Number(process.env.SWEEP_MAX_STATES ?? 60);
const WORKERS = Number(process.env.SWEEP_WORKERS ?? 4);
const OVERFLOW_VIEWPORT_WIDTHS = [280, 390];
const OVERFLOW_VIEWPORT_HEIGHT = 844;
// Typed input, on by default. `SWEEP_FILL_INPUTS=0` reverts to a press-only
// sweep — useful when attributing a change, since filling alters which controls
// are enabled and therefore which get pressed at all.
const FILL_INPUTS = process.env.SWEEP_FILL_INPUTS !== '0';

/**
 * Surfaces to sweep: a route hash plus the harness query that populates it.
 *
 * `reach` records how the populated state was obtained, so the report can never
 * present "not audited" as "audited, clean":
 *   • `demo`    — a fake-transport demo mode populates it
 *   • `default` — it renders off the transport's default answers
 */
const SURFACES = [
  { id: 'chat', hash: 'chat', query: '', reach: 'default' },
  { id: 'chat-session', hash: 'chat', query: 'chat=session', reach: 'demo' },
  { id: 'reception', hash: 'reception', query: 'reception=pending', reach: 'demo' },
  { id: 'reception-records', hash: 'reception/records', query: 'reception=pending', reach: 'demo' },
  { id: 'approvals-pending', hash: 'approvals', query: 'attention=pending', reach: 'demo' },
  { id: 'approvals-plan', hash: 'approvals', query: 'attention=plan', reach: 'demo' },
  { id: 'approvals-destructive', hash: 'approvals', query: 'attention=destructive', reach: 'demo' },
  { id: 'packs-installed', hash: 'packs', query: 'packs=installed', reach: 'demo' },
  { id: 'packs-default', hash: 'packs', query: '', reach: 'default' },
  // ⛔ The surface this whole audit was written for. Every Use button on
  // `#packs/<slug>` was dead for a session because the run modal was built and
  // never attached, and until now the sweep could not press one: the packs
  // panel sat at "Loading packs…" forever, because its `refreshRows` gather
  // includes reads the fake transport left pending. See the packsDemo block in
  // `full-app-harness.ts`.
  { id: 'packs-detail', hash: 'packs/installed-mail', query: 'packs=installed', reach: 'demo' },
  // The install consent dialog exists only on a pack you do NOT have.
  { id: 'packs-detail-uninstalled', hash: 'packs/installed-mail', query: 'packs=installed&packs_installed=0', reach: 'demo' },
  { id: 'packs-uninstalled-list', hash: 'packs', query: 'packs=installed&packs_installed=0', reach: 'demo' },
  { id: 'recipes-installed', hash: 'recipes', query: 'recipes=installed', reach: 'demo' },
  { id: 'recipes-paged', hash: 'recipes', query: 'recipes=paged', reach: 'demo' },
  { id: 'automation-rules', hash: 'automation', query: 'automation=rules', reach: 'demo' },
  { id: 'automation-schedules', hash: 'automation/schedules', query: 'automation=rules', reach: 'demo' },
  { id: 'automation-triggers', hash: 'automation/triggers', query: 'automation=rules', reach: 'demo' },
  { id: 'data-contacts', hash: 'data', query: 'data=contacts', reach: 'demo' },
  { id: 'data-contact-detail', hash: 'data/contact', query: 'data=contacts', reach: 'demo' },
  { id: 'data-timeline', hash: 'data', query: 'data=timeline', reach: 'demo' },
  { id: 'data-work-entities', hash: 'data', query: 'data=work-entities-paged', reach: 'demo' },
  { id: 'data-form-responses', hash: 'data', query: 'data=form-responses-paged', reach: 'demo' },
  { id: 'logs-paged', hash: 'logs', query: 'logs=paged', reach: 'demo' },
  { id: 'logs-active', hash: 'logs/active', query: 'logs=paged&logs_passes=active', reach: 'demo' },
  { id: 'contracts-paged', hash: 'contracts', query: 'contracts=paged', reach: 'demo' },
  // Detail routes, not just their lists. Settling the pending reads moved
  // coverage barely at all (35.8% → 36.5%) because the gap was never mostly
  // hanging panels — it is states behind an ID in the hash. `#contracts` shows
  // only the list attributes; the grants matrix lives under a selected
  // contract.
  { id: 'contracts-detail', hash: 'contracts/door_paged_01', query: 'contracts=paged', reach: 'demo' },
  { id: 'contracts-detail-ops', hash: 'contracts/door_paged_01/ops', query: 'contracts=paged', reach: 'demo' },
  // `permissions-panel.ts` holds 37 unreached attributes and is NOT a settings
  // panel — `bootstrap-settings-route.ts` sets `const permissions = null` with
  // the note "Permissions moved to Contracts (D-174 P2)". It mounts from
  // `bootstrap-contracts-route.ts` as the CONNECT tab of a contract detail,
  // and the tab only exists on a door that is not self / customer-template /
  // anonymous. Its siblings are `ops` and `entities`.
  { id: 'contracts-detail-connect', hash: 'contracts/door_paged_01/connect', query: 'contracts=paged', reach: 'demo' },
  { id: 'contracts-detail-entities', hash: 'contracts/door_paged_01/entities', query: 'contracts=paged', reach: 'demo' },
  { id: 'connections-grants', hash: 'connections', query: 'connection=grants', reach: 'demo' },
  { id: 'connections-source-ready', hash: 'connections', query: 'connection=source-ready', reach: 'demo' },
  { id: 'connections-first-sync', hash: 'connections', query: 'connection=first-sync', reach: 'demo' },
  { id: 'settings', hash: 'settings', query: '', reach: 'default' },
  { id: 'settings-devices', hash: 'settings/devices', query: 'devices=ready', reach: 'demo' },
  { id: 'settings-notifications', hash: 'settings/notifications', query: 'notifications=ready', reach: 'demo' },
  { id: 'settings-ai-models', hash: 'settings/ai-models', query: 'ai=two&ai_usage=ready&ai_pool=entry', reach: 'demo' },
  { id: 'settings-account', hash: 'settings/account', query: 'account=unbound', reach: 'demo' },
  { id: 'settings-server', hash: 'settings/server', query: 'server_profiles=multiple', reach: 'demo' },
  { id: 'kitchen', hash: 'kitchen', query: '', reach: 'default' },

  // ── Deep-link sub-routes ─────────────────────────────────────────────────
  //
  // Every hash below is HARVESTED from `full-app.spec.ts`, which already drives
  // it successfully — not invented. That matters twice over: a route whose id
  // does not resolve renders its parent list, sweeps clean and reports as
  // audited (`#contracts/door` reached exactly zero new attributes because the
  // paged demo mints `door_paged_01`), and the spec's hashes are the only list
  // of deep links known to work against these demo modes.
  //
  // This is the lever the coverage numbers actually respond to: two contract
  // detail surfaces reached 27 attributes nothing else rendered, against +0.7
  // points for twelve settled background reads.
  { id: 'chat-new', hash: 'chat/new', query: 'chat=session', reach: 'demo' },
  { id: 'chat-session-detail', hash: 'chat/session/chat', query: 'chat=session', reach: 'demo' },
  // ⚠ Query copied from the spec that drives this hash, not invented. Pairing
  // it with `chat=session` instead put the handoff in its `ready` branch, whose
  // only action calls focusComposer() — and the chat route had ALREADY focused
  // the composer on mount, so the button correctly did nothing and reported
  // INERT. A focus-only control, pressed where focus already sits, is
  // indistinguishable from a dead one by this method.
  { id: 'chat-source-mail', hash: 'chat/source/mail/gmail/work', query: 'ai=empty&connection=source-ready', reach: 'demo' },
  { id: 'approvals-detail', hash: 'approvals/approval-attention-1', query: 'attention=pending', reach: 'demo' },
  { id: 'connections-others', hash: 'connections/others', query: 'connection=grants', reach: 'demo' },
  { id: 'connections-webhooks', hash: 'connections/webhooks', query: 'connection=webhooks', reach: 'demo' },
  { id: 'connections-calendar', hash: 'connections/calendar/work-calendar', query: 'connection=source-ready', reach: 'demo' },
  { id: 'contracts-user', hash: 'contracts/user', query: 'contracts=paged', reach: 'demo' },
  { id: 'contracts-view-others', hash: 'contracts/view/others', query: 'contracts=paged', reach: 'demo' },
  { id: 'data-task', hash: 'data/task', query: 'data=work-entities-paged', reach: 'demo' },
  { id: 'data-booking', hash: 'data/booking', query: 'data=work-entities-paged', reach: 'demo' },
  { id: 'data-calendar', hash: 'data/calendar', query: 'data=contacts', reach: 'demo' },
  { id: 'data-crm', hash: 'data/crm', query: 'data=contacts', reach: 'demo' },
  { id: 'data-files', hash: 'data/files', query: 'data=file-download', reach: 'demo' },
  { id: 'data-form', hash: 'data/form', query: 'data=form-responses-paged', reach: 'demo' },
  { id: 'data-mail', hash: 'data/mail', query: 'data=contacts', reach: 'demo' },
  { id: 'data-records', hash: 'data/records', query: 'data=work-entities-paged', reach: 'demo' },
  { id: 'data-mail-record', hash: 'data/mail/record/work/mail-1/return/chat/chat', query: 'data=contacts', reach: 'demo' },
  { id: 'kitchen-pack', hash: 'kitchen/pack', query: '', reach: 'default' },
  { id: 'logs-run-verify', hash: 'logs/run-verify/return/chat/session/chat', query: 'logs=paged', reach: 'demo' },
  { id: 'settings-ai-setup', hash: 'settings/ai-models/setup/start', query: 'ai=two&ai_usage=ready&ai_pool=entry', reach: 'demo' },
  // ⛔ NOT `#settings/key-health` and friends. Those ids are real — they come
  // from `bootstrap-settings-route.ts` — but they name SUBTABS, not routes:
  // the buttons are `role="tab"` calling an in-page `activate(tab.id)`, with no
  // hash. `#settings/key-health` therefore renders the settings landing, sweeps
  // 122 controls and reports clean, which is a DUPLICATE surface wearing a new
  // name. Six of them were added and removed again on that evidence — an
  // unresolvable id is indistinguishable from a real one until you diff what it
  // reached. Key Health's remaining cards need BFS depth, not a route.

  // ── Seller subpages ──────────────────────────────────────────────────────
  //
  // 67 unreached attributes lived here and NONE of them were a data problem.
  // A fully populated SellerOverview — tiers, customers, usage, offers, every
  // field from its contract — bought exactly ZERO, because the panels that
  // render them are subpages the BFS never navigated to. `seller-page.ts`
  // addresses them with `serializeShellRoute('settings', 'seller', subpage)`,
  // so they are hashes, and a hash costs one line.
  //
  // Third time this lever has beaten the alternative: settling pending reads
  // (+0.7 pts), fixture data (+0.0), sub-routes (+2.2 and counting).
  ...['overview', 'offers', 'orders', 'tiers', 'customers', 'usage', 'setup']
    .map((subpage) => ({
      id: `settings-seller-${subpage}`,
      hash: `settings/seller/${subpage}`,
      query: '',
      reach: 'demo',
    })),

  // ── Failure and latency paths ────────────────────────────────────────────
  //
  // ⛔ These matter MORE than the happy paths above, and the first version of
  // this sweep contained none of them. Of the six defects from the live drive
  // that motivated the audit, most were failure paths: a resolve FAILED and its
  // error branch lived in code that pack never reached; a generic message
  // dropped the specific one sitting next to it. A surface only ever swept in
  // its success state cannot show any of that — and "0 findings" over happy
  // paths alone reads exactly like "0 findings", which is the confusion this
  // whole exercise exists to remove.
  { id: 'chat-send-fails', hash: 'chat', query: 'chat=session&chat_send_response=fail-once', reach: 'demo-failure' },
  { id: 'chat-history-action-fails', hash: 'chat', query: 'chat=session&chat_history_action_response=fail', reach: 'demo-failure' },
  { id: 'chat-plan-slow', hash: 'chat', query: 'chat=session&chat_plan_response=slow', reach: 'demo-failure' },
  { id: 'run-palette-autorun-fails', hash: 'chat', query: 'chat=session&run_palette=autorun-fail', reach: 'demo-failure' },
  { id: 'approvals-resolve-fails', hash: 'approvals', query: 'attention=pending&approval_resolve_response=fail', reach: 'demo-failure' },
  { id: 'approvals-ask-fails', hash: 'approvals', query: 'attention=pending&ask_answer_response=fail', reach: 'demo-failure' },
  { id: 'approvals-plan-fails', hash: 'approvals', query: 'attention=plan&plan_resolve_response=fail', reach: 'demo-failure' },
  { id: 'reception-refresh-fails', hash: 'reception', query: 'reception=pending&reception_refresh_after_decision=fail', reach: 'demo-failure' },
  { id: 'reception-records-fail-retry', hash: 'reception/records', query: 'reception=pending&reception_records_response=fail-once-slow-retry', reach: 'demo-failure' },
  { id: 'reception-responses-fail-retry', hash: 'reception', query: 'reception=pending&reception_responses_response=fail-twice-slow-retry', reach: 'demo-failure' },
  { id: 'data-contact-save-fails', hash: 'data/contact', query: 'data=contacts&contact_save_response=fail', reach: 'demo-failure' },
  { id: 'data-file-download', hash: 'data', query: 'data=file-download', reach: 'demo' },
  { id: 'logs-refresh-slow', hash: 'logs', query: 'logs=paged&logs_refresh_response=slow', reach: 'demo-failure' },
  { id: 'logs-control-slow', hash: 'logs', query: 'logs=paged&logs_passes=active&logs_control_response=slow', reach: 'demo-failure' },
  { id: 'logs-live-running', hash: 'logs', query: 'logs=paged&live=running', reach: 'demo' },
  { id: 'contracts-read-failures', hash: 'contracts', query: 'contracts=paged&contract_read_failures=2', reach: 'demo-failure' },
  { id: 'connections-imap-fail', hash: 'connections', query: 'connection=imap-fail', reach: 'demo-failure' },
  { id: 'connections-oauth-ready', hash: 'connections', query: 'connection=grants&oauth=ready', reach: 'demo' },
  { id: 'automation-delete', hash: 'automation', query: 'automation=delete', reach: 'demo' },
  { id: 'automation-schedule-fails', hash: 'automation/schedules', query: 'automation=rules&automation_schedule_response=fail-slow', reach: 'demo-failure' },
  { id: 'automation-delete-fails', hash: 'automation/schedules', query: 'automation=delete&automation_schedule_delete_response=fail-slow', reach: 'demo-failure' },
  { id: 'devices-revoke-fails', hash: 'settings/devices', query: 'devices=ready&device_revoke_response=fail-slow', reach: 'demo-failure' },
  { id: 'devices-retry', hash: 'settings/devices', query: 'devices=fail-twice-slow-retry', reach: 'demo-failure' },
  { id: 'notifications-fail', hash: 'settings/notifications', query: 'notifications=ready&notifications_response=fail-slow', reach: 'demo-failure' },
  { id: 'notifications-retry', hash: 'settings/notifications', query: 'notifications=fail-once-slow-retry', reach: 'demo-failure' },
  { id: 'account-conflict', hash: 'settings/account', query: 'account=conflict', reach: 'demo-failure' },
  { id: 'account-bind-fails', hash: 'settings/account', query: 'account=unbound&account_bind_response=fail-slow', reach: 'demo-failure' },
  { id: 'server-control-held', hash: 'settings/server', query: 'server_profiles=multiple&server_control_response=hold', reach: 'demo-failure' },
  { id: 'recipes-config-slow', hash: 'recipes', query: 'recipes=installed&recipe_config_response=slow', reach: 'demo-failure' },
];

/** In-page harness. Installed after every boot; the driver calls into it. */
const PRESS_HARNESS = `
window.__sweep = (() => {
  const PRESSABLE = [
    'button', 'a[href]', '[role="button"]', '[role="tab"]', '[role="switch"]',
    '[role="menuitem"]', '[role="option"]', 'input[type="checkbox"]',
    'input[type="radio"]', 'input[type="submit"]', 'input[type="button"]',
    'select', 'summary',
  ].join(', ');

  let records = [];
  const observer = new MutationObserver((muts) => { records.push(...muts); });

  // ── Orphan detector: "built a whole overlay and never put it on screen". ──
  //
  // ⛔ The generic "did anything change" signal CANNOT catch this on its own,
  // and this is not theoretical — it is how this detector came to exist. The
  // Phase-0 known positive (delete the portal.appendChild(overlay) call in
  // create-overlay.ts) was reported ALIVE by the mutation signal, because the
  // same handler also calls setDrawerOpen(false): the drawer visibly closed,
  // the DOM mutated 8 times, and the overlay that was the entire point of the
  // press never appeared. A control that does PART of its job defeats a
  // "something happened" probe — and the real defect that motivated this whole
  // sweep (wireRunModal built a modal the Pack Use host never appended) has
  // exactly that shape.
  //
  // So watch construction directly: elements created during a press that are
  // still parentless when it settles, and carry a subtree, were built and
  // thrown away. That is the kickoff's defect category "an element created but
  // never attached to the document", detected as itself rather than inferred.
  let watching = false;
  let born = [];
  // The element the current press targeted, so end() can tell "the browser
  // focused the button I just clicked" from "the handler moved focus somewhere".
  let pressedEl = null;
  // ⛔ Kept in module scope, NOT in capture(): the driver JSON round-trips the
  // capture through page.evaluate, and a DOM element cannot survive that.
  let activeBefore = null;
  let pressedSemanticBefore = null;
  let pressedIdentity = null;
  let pressedIdentityOrdinal = -1;
  const nativeCreate = document.createElement.bind(document);
  document.createElement = function (tag, options) {
    const el = nativeCreate(tag, options);
    if (watching) born.push(el);
    return el;
  };

  // A persistent quiescence tracker, separate from the measuring observer. A
  // route's async data lands in discrete bursts after mount (on #packs: one at
  // ~580ms, another at ~2140ms, then silence) — measuring across one of those
  // makes every control look alive, which HIDES dead buttons. So the driver
  // waits for quiet before each press and each baseline.
  let lastMutation = performance.now();
  new MutationObserver(() => { lastMutation = performance.now(); }).observe(
    document.documentElement,
    { childList: true, subtree: true, attributes: true, characterData: true },
  );

  const dialogCount = () => document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]'
  ).length;
  const visibleText = () => (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const hashOf = (s) => { let h = 0;
    for (let i = 0; i < s.length; i += 1) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return h; };

  const capture = () => ({
    hash: location.hash,
    bodyChildren: document.body.children.length,
    dialogs: dialogCount(),
    textHash: hashOf(visibleText()),
    elements: document.querySelectorAll('*').length,
  });

  /** Local horizontal overflow at the current viewport.
   *
   * The shell itself scrolls/clips, so documentElement can remain exactly the
   * viewport width while a route child is hundreds of pixels too wide. Inspect
   * every visible owner in the content subtree. Exclusions are explicit
   * containment contracts: named scroll rails, native form-control internals,
   * pre's own scroll box, deliberate ellipsis, and visually-hidden text. */
  const horizontalOverflow = () => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const scrollWidth = root.scrollWidth;
    const content = document.querySelector('[data-recued-webclient-content]')
      || document.body;
    const offenders = [content, ...content.querySelectorAll('*')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          el,
          rect,
          style,
          visible: rect.width > 0 && rect.height > 0
            && style.display !== 'none' && style.visibility !== 'hidden',
        };
      })
      .filter(({ el, rect, style, visible }) => {
        if (!visible || el.clientWidth <= 0 || el.scrollWidth <= el.clientWidth) {
          return false;
        }
        if (el.matches('input, select, textarea, pre')
          || el.closest('[data-recued-scroll-rail]') !== null) {
          return false;
        }
        const clipsAnEllipsis = style.textOverflow === 'ellipsis'
          && (style.overflowX === 'hidden' || style.overflowX === 'clip');
        const visuallyHidden = rect.width <= 2 && rect.height <= 2
          && (style.overflow === 'hidden' || style.overflowX === 'hidden');
        if (clipsAnEllipsis || visuallyHidden) return false;

        // clientWidth rounds the content box down, while scrollWidth rounds up.
        // A bordered/fractional box can therefore read 214 -> 216 even when
        // every child is visibly inside it. Require either a direct child that
        // crosses the border box or direct text whose own scroll span exceeds
        // that box. Direct children are intentional: a nested overflow:auto
        // rail contains its descendants and must not taint every ancestor.
        const childCrossesBox = [...el.children].some((child) => {
          const childRect = child.getBoundingClientRect();
          const childStyle = getComputedStyle(child);
          if (childRect.width <= 0 || childRect.height <= 0
            || childStyle.display === 'none' || childStyle.visibility === 'hidden') {
            return false;
          }
          return childRect.left < rect.left - 1 || childRect.right > rect.right + 1;
        });
        const hasDirectText = [...el.childNodes].some((node) =>
          node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0
        );
        const directTextCrossesBox = hasDirectText
          && el.scrollWidth > Math.ceil(rect.width) + 1;
        return childCrossesBox || directTextCrossesBox;
      })
      .sort((a, b) => (b.el.scrollWidth - b.el.clientWidth)
        - (a.el.scrollWidth - a.el.clientWidth))
      .slice(0, 8)
      .map(({ el, rect }) => {
        const crossingChildren = [...el.children].flatMap((child) => {
          const childRect = child.getBoundingClientRect();
          const childStyle = getComputedStyle(child);
          if (childRect.width <= 0 || childRect.height <= 0
            || childStyle.display === 'none' || childStyle.visibility === 'hidden'
            || (childRect.left >= rect.left - 1 && childRect.right <= rect.right + 1)) {
            return [];
          }
          return [{
            tag: child.tagName.toLowerCase(),
            id: child.id || '',
            classes: [...child.classList].slice(0, 4),
            recued: [...child.attributes].map((a) => a.name)
              .filter((name) => name.startsWith('data-recued-')).slice(0, 4),
            left: Math.round(childRect.left),
            right: Math.round(childRect.right),
            width: Math.round(childRect.width),
          }];
        });
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          classes: [...el.classList].slice(0, 4),
          recued: [...el.attributes].map((a) => a.name)
            .filter((name) => name.startsWith('data-recued-')).slice(0, 4),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          crossingChildren,
        };
      });
    const overflowing = offenders.length > 0;
    return { overflowing, clientWidth, scrollWidth, offenders };
  };

  /** A sibling carrying the same data-recued-* attribute and aria-pressed
   *  "false" — the mark of a mutually-exclusive choice rather than a toggle. */
  const hasExclusivePeer = (el) => {
    const parent = el.parentElement;
    if (parent === null) return false;
    const marks = [...el.attributes]
      .map((a) => a.name)
      .filter((n) => n.startsWith('data-recued-'));
    if (marks.length === 0) return false;
    return [...parent.children].some((sib) => sib !== el
      && sib.getAttribute('aria-pressed') === 'false'
      && marks.some((m) => sib.hasAttribute(m)));
  };

  /**
   * Fill every empty text field in the current state, then report what changed.
   *
   * ⛔ Why a press-only sweep needed this. Whole flows are gated behind typed
   * input and were structurally unreachable: the archive panel's own header
   * calls the recovery key "the IN-FLOW access gate", the hostnames add-form,
   * the seller tier form and every save path sit behind the same wall. Their
   * submit buttons render DISABLED, get skipped, and the surface behind them
   * never renders at all.
   *
   * Safety, stated plainly: this types fabricated values into forms and lets
   * their submits become pressable. That is only acceptable because the harness
   * runs on a FAKE TRANSPORT with no backend — nothing typed here reaches a
   * real store — and because native dialogs are dismissed rather than accepted,
   * so no confirm gate is ever answered "yes".
   *
   * Values are chosen by type then by name/placeholder hint, because a field
   * that validates its input rejects a generic string and re-disables the very
   * button this exists to unlock.
   */
  const fillInputs = () => {
    const FILLABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]), textarea';
    const filled = [];
    for (const el of document.querySelectorAll(FILLABLE)) {
      if (el.disabled || el.readOnly) continue;
      if ((el.value ?? '') !== '') continue;              // never overwrite
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;  // not on screen
      const hint = [
        el.getAttribute('type') || '',
        el.getAttribute('name') || '',
        el.getAttribute('placeholder') || '',
        el.getAttribute('aria-label') || '',
        [...el.attributes].map((a) => a.name).join(' '),
      ].join(' ').toLowerCase();
      let value = 'sweep';
      if (/email/.test(hint)) value = 'sweep@example.test';
      else if (/url|href|endpoint|base/.test(hint)) value = 'https://example.test';
      else if (/host|domain/.test(hint)) value = 'sweep.example.test';
      else if (/number|amount|port|count|limit/.test(hint)) value = '1';
      else if (/cron|schedule/.test(hint)) value = '0 9 * * *';
      else if (/phrase|recovery|key|token|secret|password/.test(hint)) {
        value = 'sweep-recovery-key-0000';
      } else if (/slug/.test(hint)) value = 'installed-mail';
      else if (/date/.test(hint)) value = '2026-08-03';
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push({
        value,
        recued: [...el.attributes].map((a) => a.name)
          .filter((n) => n.startsWith('data-recued-')).join(','),
      });
    }
    return filled;
  };

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none'
      && style.pointerEvents !== 'none' && Number(style.opacity) !== 0;
  };

  // Identity that survives a reboot: shape + text + an ordinal to disambiguate
  // repeated rows. Index alone is not stable across boots; text alone is not
  // unique in a list.
  const signature = (el, seen) => {
    const base = [
      el.tagName.toLowerCase(),
      el.getAttribute('role') || '',
      el.getAttribute('type') || '',
      [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-recued-')).join(','),
      (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      el.getAttribute('aria-label') || el.getAttribute('title') || '',
      el.getAttribute('href') || '',
    ].join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return base + '|#' + n;
  };

  /** State owned by the pressed control itself, excluding focus/class churn.
   *
   * A facet repaint can preserve the complete page text and element count while
   * changing aria-pressed on the replacement chip. Likewise, the theme control
   * changes its own preference attribute. Those are strong user-visible states,
   * including on a background-noisy surface, and must not be called unjudged. */
  const semanticState = (el) => JSON.stringify({
    text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
    label: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    pressed: el.getAttribute('aria-pressed'),
    selected: el.getAttribute('aria-selected'),
    checkedAria: el.getAttribute('aria-checked'),
    expanded: el.getAttribute('aria-expanded'),
    current: el.getAttribute('aria-current'),
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    hidden: el.hidden === true || el.hasAttribute('hidden'),
    checked: typeof el.checked === 'boolean' ? el.checked : null,
    value: 'value' in el ? String(el.value) : null,
    themePreference: el.getAttribute('data-theme-pref'),
  });

  /** Identity that survives an in-place control repaint. Values matter here:
   * data-facet=tag/data-value=codex must not resolve to a sibling facet chip. */
  const semanticIdentity = (el) => {
    const attrs = [...el.attributes]
      .filter((a) => a.name === 'id' || a.name === 'name'
        || a.name === 'data-facet' || a.name === 'data-value'
        || a.name.startsWith('data-recued-'))
      .map((a) => a.name + '=' + a.value)
      .sort();
    return [
      el.tagName.toLowerCase(),
      el.getAttribute('role') || '',
      el.getAttribute('type') || '',
      attrs.join(','),
    ].join('|');
  };

  const rememberPressed = (el) => {
    pressedEl = el;
    pressedSemanticBefore = semanticState(el);
    pressedIdentity = semanticIdentity(el);
    const peers = [...document.querySelectorAll(PRESSABLE)]
      .filter((candidate) => semanticIdentity(candidate) === pressedIdentity);
    pressedIdentityOrdinal = peers.indexOf(el);
  };

  const semanticTargetAfterPress = () => {
    if (pressedEl?.isConnected) return pressedEl;
    if (pressedIdentity === null || pressedIdentityOrdinal < 0) return null;
    const peers = [...document.querySelectorAll(PRESSABLE)]
      .filter((candidate) => semanticIdentity(candidate) === pressedIdentity);
    return peers[pressedIdentityOrdinal] ?? null;
  };

  const describe = () => {
    const seen = new Map();
    return [...document.querySelectorAll(PRESSABLE)].map((el, index) => ({
      index,
      sig: signature(el, seen),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      href: el.getAttribute('href') || '',
      attrs: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-recued-')),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      label: el.getAttribute('aria-label') || el.getAttribute('title') || '',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      selected: el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('aria-current') !== null
        || el.getAttribute('aria-checked') === 'true'
        || el.checked === true
        // aria-pressed is BOTH a radio-like "this one is chosen" (the Data /
        // Memory lens switcher, reception's Open / Dismissed views) and an
        // on/off toggle ("Installed only"). Only the first is a legitimate
        // no-op when pressed again — reception's handler opens with an early
        // return on state.view === view, a deliberate refusal.
        //
        // The discriminator is a PEER: a sibling carrying the same
        // data-recued-* attribute and aria-pressed="false" means these
        // buttons are mutually exclusive, so the pressed one is already
        // chosen. A lone toggle has no such sibling and is still pressed.
        // A tablist/radiogroup ancestor counts too, but requiring one was
        // too narrow: reception's toolbar is a plain div, and that surface
        // reported INERT for a button doing exactly what it should.
        || (el.getAttribute('aria-pressed') === 'true'
          && (el.closest?.('[role="tablist"], [role="radiogroup"]') !== null
            || hasExclusivePeer(el))),
      visible: isVisible(el),
    }));
  };

  const findBySig = (sig) => describe().find((c) => c.sig === sig) || null;

  const pressEl = (el) => {
    if (el.tagName.toLowerCase() === 'select') {
      const opts = [...el.options].filter((o) => !o.disabled);
      const next = opts.find((o) => o.value !== el.value);
      if (!next) return { pressed: false, reason: 'select-single-option' };
      el.value = next.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { pressed: true, via: 'select-change' };
    }
    // ⛔ A bare el.click() dispatches ONLY a click event, and not every control
    // listens for one. ref-picker/wire.ts says so in as many words — "Option
    // selection runs on pointerdown (mousedown on older/test DOMs)" — so every
    // listbox option in the app read as stone dead to the first version of this
    // sweep. Dispatch the sequence a real press produces, so a control is
    // judged on whether it responds to a USER, not on whether it happens to
    // listen for the one event the prober found convenient.
    const opts = { bubbles: true, cancelable: true, composed: true };
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
    }
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    }
    el.click();
    return { pressed: true, via: 'pointer-sequence' };
  };

  return {
    list: describe,
    /** Visible-control signature set — the basis for "this press revealed something". */
    visibleSigs: () => describe().filter((c) => c.visible).map((c) => c.sig),
    quietFor: () => performance.now() - lastMutation,
    fillInputs,
    /** Every data-recued-* attribute PRESENT IN THE DOM in this state.
     *
     *  ⚠ Not the same thing as "attributes on controls I pressed", and the
     *  difference is not cosmetic. Coverage was first computed from the pressed
     *  controls' attributes against a denominator counting every attribute in
     *  source — including panels, lists, headings and error slots, which are
     *  not pressable and never could be. That reported connections 0-of-35 for
     *  surfaces where 45 presses had just succeeded. Reach is what RENDERED. */
    domAttrs: () => {
      const out = new Set();
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes) {
          if (a.name.startsWith('data-recued-')) out.add(a.name);
        }
      }
      return [...out];
    },
    horizontalOverflow,
    capture,
    begin: () => {
      records = [];
      born = [];
      pressedEl = null;
      pressedSemanticBefore = null;
      pressedIdentity = null;
      pressedIdentityOrdinal = -1;
      activeBefore = document.activeElement;
      watching = true;
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      return capture();
    },
    end: (before) => {
      observer.takeRecords().forEach((m) => records.push(m));
      observer.disconnect();
      watching = false;
      // An orphan ROOT: created during the press, never attached to anything,
      // and carrying a subtree of its own. Elements built and appended into
      // another created element are its children, not separate findings —
      // requiring a null parentNode keeps one discarded overlay from reporting
      // as thirty.
      // The biggest subtree that DID land during this press. A renderer that
      // rebuilds in place (reception's inbox panel documents "render() rebuilds
      // the whole DOM") discards a tree and attaches a comparable one — that is
      // churn, not a dropped overlay. What makes the real defect a defect is
      // that nothing took the orphan's place.
      const attachedMax = born.reduce(
        (max, el) => (el.isConnected
          ? Math.max(max, el.querySelectorAll('*').length)
          : max),
        0,
      );
      const orphans = born
        .filter((el) => el.parentNode === null && el.children.length > 0)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          descendants: el.querySelectorAll('*').length,
          role: el.getAttribute('role') || '',
          recued: [...el.attributes].map((a) => a.name)
            .filter((n) => n.startsWith('data-recued-')).join(','),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        }))
        .filter((o) => o.descendants >= 3)
        // Nothing comparable was attached in its place.
        .filter((o) => o.descendants > attachedMax);
      born = [];
      const after = capture();
      const semanticTarget = semanticTargetAfterPress();
      const pressedSemanticAfter = semanticTarget === null
        ? null
        : semanticState(semanticTarget);
      // A dead button still takes focus, so focus/hover attribute churn on the
      // pressed element is not an outcome.
      const FOCUS_ATTRS = new Set(['data-focus-visible', 'data-focus', 'class', 'style']);
      const meaningful = records.filter((m) => !(
        m.type === 'attributes'
        && FOCUS_ATTRS.has(m.attributeName || '')
        && m.target === document.activeElement
      ));
      return {
        mutations: meaningful.length,
        rawMutations: records.length,
        orphans,
        before,
        after,
        changed: {
          // ⛔ Focus is an OUTCOME when the handler moves it somewhere, and NOT
          // an outcome when the browser merely focuses the button that was
          // clicked — a dead button does that too. Excluding focus wholesale
          // was too broad: chat's Review-first-question button exists ONLY to
          // call focusComposer(), and reported INERT for doing its job.
          focusMoved: document.activeElement !== activeBefore
            && document.activeElement !== pressedEl
            && document.activeElement !== null
            && document.activeElement !== document.body,
          hash: before.hash !== after.hash,
          bodyChildren: after.bodyChildren - before.bodyChildren,
          dialogs: after.dialogs - before.dialogs,
          text: before.textHash !== after.textHash,
          elements: after.elements - before.elements,
          controlState: pressedSemanticBefore !== null
            && pressedSemanticAfter !== null
            && pressedSemanticBefore !== pressedSemanticAfter,
        },
      };
    },
    pressSig: (sig) => {
      const seen = new Map();
      const els = [...document.querySelectorAll(PRESSABLE)];
      for (const el of els) {
        if (signature(el, seen) === sig) { rememberPressed(el); return pressEl(el); }
      }
      return { pressed: false, reason: 'not-found' };
    },
    findBySig,
  };
})();
true;
`;

// ⛔ A sweep that dies mid-run and leaves a partial log is the exact failure
// this tool exists to prevent: the surfaces it never reached look identical to
// the surfaces it passed. Round 5 stopped after 4 of 61 with no message at all.
// Anything unhandled must be loud and must exit non-zero.
process.on('unhandledRejection', (err) => {
  console.error(`\n✖ SWEEP ABORTED — unhandled rejection: ${String(err && err.stack ? err.stack : err).slice(0, 800)}`);
  process.exit(2);
});
process.on('uncaughtException', (err) => {
  console.error(`\n✖ SWEEP ABORTED — uncaught: ${String(err && err.stack ? err.stack : err).slice(0, 800)}`);
  process.exit(2);
});

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const only = flag('surface');
const jsonOut = flag('json');
const verbose = args.includes('--verbose');

const QUIET_MS = Number(process.env.SWEEP_QUIET_MS ?? 600);
const QUIET_CAP_MS = Number(process.env.SWEEP_QUIET_CAP_MS ?? 6000);

/**
 * Block until the page has not mutated for `QUIET_MS`, or give up at
 * `QUIET_CAP_MS`. Returns false when it never went quiet — that state is
 * genuinely animated and its presses cannot be judged on mutation count.
 */
const waitForQuiet = async (page) => {
  const started = Date.now();
  for (;;) {
    const since = await page.evaluate('window.__sweep.quietFor()').catch(() => QUIET_MS);
    if (since >= QUIET_MS) return true;
    if (Date.now() - started > QUIET_CAP_MS) return false;
    await page.waitForTimeout(100);
  }
};

/** Measure the same reached DOM state at both supported narrow widths, then
 * restore the traversal viewport before any idle/press signal is collected. */
const measureHorizontalOverflow = async (page) => {
  const original = page.viewportSize() ?? { width: 1280, height: 720 };
  const measurements = [];
  for (const width of OVERFLOW_VIEWPORT_WIDTHS) {
    await page.setViewportSize({ width, height: OVERFLOW_VIEWPORT_HEIGHT });
    await page.evaluate(() => new Promise((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
    }));
    measurements.push({
      width,
      ...await page.evaluate('window.__sweep.horizontalOverflow()'),
    });
  }
  await page.setViewportSize(original);
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
  return measurements;
};

/** Collapse repeated BFS measurements into stable DOM-owner identities while
 * retaining widths, sizes, occurrence count, and the first replay path. */
const summarizeOverflowOwners = (overflows) => {
  const owners = new Map();
  for (const overflow of overflows) {
    for (const offender of overflow.offenders ?? []) {
      const signature = [
        offender.tag,
        offender.id,
        offender.classes.join('.'),
        offender.recued.join(','),
      ].join('|');
      const current = owners.get(signature) ?? {
        signature,
        tag: offender.tag,
        id: offender.id,
        classes: offender.classes,
        recued: offender.recued,
        widths: new Set(),
        sizes: new Set(),
        occurrences: 0,
        firstPath: overflow.path,
      };
      current.widths.add(overflow.width);
      current.sizes.add(`${offender.clientWidth}->${offender.scrollWidth}`);
      current.occurrences += 1;
      owners.set(signature, current);
    }
  }
  return [...owners.values()].map((owner) => ({
    ...owner,
    widths: [...owner.widths].sort((a, b) => a - b),
    sizes: [...owner.sizes].sort(),
  }));
};

/**
 * A console error is only a FINDING if the app produced it. The harness runs on
 * a local static origin with no cloud behind it, so any settings panel that
 * reaches for `auth.recued.com` logs a CORS failure that says nothing about the
 * product. Classify those out — but record them, so the report states the limit
 * rather than hiding it.
 */
const EXTERNAL_ORIGIN_ERROR = /(CORS policy|net::ERR_|Failed to load resource|Failed to fetch|ERR_FAILED)/i;
const isHarnessArtifact = (err) => {
  if (!EXTERNAL_ORIGIN_ERROR.test(err.text)) return false;
  // ⚠ Judge the TARGET, not "does the string mention localhost anywhere".
  // A CORS message names BOTH — "Access to fetch at 'https://auth.recued.com/…'
  // from origin 'http://127.0.0.1:4331'" — so a naive
  // `!/127\.0\.0\.1/.test(text)` guard reads backwards and calls the harness's
  // own artifact a real product error. That mistake alone produced 197 of round
  // one's 226 findings, every one of them this single message.
  const urls = err.text.match(/https?:\/\/[^\s'"]+/g) ?? [];
  if (urls.length === 0) return true; // companion line, e.g. "net::ERR_FAILED"
  return urls.some((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u));
};

/** Boot a fresh page on a surface, then replay `path` to reach a nested state. */
const bootAt = async (browser, surface, path) => {
  const page = await browser.newPage();
  const errors = [];
  // ⛔ A native confirm() IS an outcome — the control asked the user something.
  // Playwright auto-dismisses dialogs when no handler is registered, so a
  // control gated behind `if (!confirmDiscard()) return;` swallowed its own
  // handler and reported INERT. Connections' Back button was reported dead for
  // exactly this reason and is perfectly fine.
  //
  // Dismiss rather than accept: dismissing is the non-destructive answer, and
  // the sweep only needs to know the question was ASKED.
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: String(d.message()).slice(0, 200) });
    void d.dismiss().catch(() => {});
  });
  page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e.message).split('\n')[0] }));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push({ kind: 'console', text: m.text().slice(0, 300) });
  });
  // `settle_reads=1` on every surface: the harness leaves an unrecognised read
  // pending forever, and a route whose gather includes one renders "Loading…"
  // and no controls — which a sweep cannot tell apart from a surface that is
  // genuinely clean. Opt-in there, always-on here.
  const url = `http://127.0.0.1:${PORT}/full-app-harness.html`
    + `?settle_reads=1${surface.query ? `&${surface.query}` : ''}#${surface.hash}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__app && window.__app.ready === true', { timeout: BOOT_TIMEOUT_MS });
  await page.evaluate(`window.__app.setHash(${JSON.stringify('#' + surface.hash)})`);
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(PRESS_HARNESS);
  // Replays must start from the same settled state the original traversal
  // observed. A fixed delay was enough to queue slow Packs/Recipes controls,
  // then miss them on the fresh boot used to audit the revealed state.
  await waitForQuiet(page);
  for (const step of path) {
    // A queued step can exist only after the containing state was filled. The
    // Connections Verify-and-replace action, for example, appears after Edit
    // reveals a form and fillInputs unlocks it. Reconstruct that same safe fake
    // state before looking up every replayed signature.
    const replayStarted = Date.now();
    let res;
    for (;;) {
      if (FILL_INPUTS) {
        await page.evaluate('window.__sweep.fillInputs()');
      }
      res = await page.evaluate(`window.__sweep.pressSig(${JSON.stringify(step)})`);
      if (res.pressed || Date.now() - replayStarted >= QUIET_CAP_MS) break;
      // A route can be mutation-quiet while a deliberately slow transport call
      // is still pending. Keep the exact signature (including ordinal) and wait
      // for it; never fall back to a different repeated Install/Delete action.
      await page.waitForTimeout(100);
    }
    if (!res.pressed) {
      await page.close();
      return { page: null, errors, dialogs, replayFailed: step };
    }
    await page.waitForTimeout(SETTLE_MS);
    await waitForQuiet(page);
  }
  return { page, errors, dialogs, replayFailed: null };
};

/**
 * Verdict for one press. A noisy state cannot be judged on mutation count, so
 * it needs a strong signal or the press is UNJUDGED — reported, never counted
 * as alive.
 */
/**
 * Is a discarded subtree evidence of a defect, or ordinary re-render churn?
 *
 * Both known-negative patterns discard freshly built subtrees LEGITIMATELY, and
 * both were measured on a good build rather than guessed at:
 *
 *  • a press that NAVIGATES repaints the route — six of seven false positives
 *    were drawer/brand links, discarding chat panels and AI-models tab panels
 *    the new route rebuilt anyway;
 *  • a press that NET-REMOVES elements is tearing something down — the seventh
 *    was `server-switcher-rename-save` closing its rename form (`elements: -7`)
 *    and dropping the superseded list rows.
 *
 * The true positive sits outside both: it ADDED elements (+2) while orphaning a
 * 30-node overlay. So a discard only counts when the press was building, not
 * navigating and not tearing down.
 */
const orphansWorthReporting = (result) => {
  const orphans = result.orphans ?? [];
  if (orphans.length === 0) return [];
  if (result.changed.hash) return [];      // route repaint
  if (result.changed.elements < 0) return []; // teardown
  return orphans;
};

const judge = (result, noisy) => {
  // ⛔ Checked BEFORE any liveness signal. A press that builds a subtree and
  // leaves it unattached is a defect EVEN IF the surface also changed — that is
  // the whole lesson of the Phase-0 known positive, which closed the drawer
  // (very much "something happened") while dropping the overlay on the floor.
  if (orphansWorthReporting(result).length > 0) return 'orphan';
  const c = result.changed;
  const strong = c.hash || c.bodyChildren !== 0 || c.dialogs !== 0 || c.text
    || c.elements !== 0 || c.focusMoved === true || c.controlState === true
    || c.nativeDialog === true;
  if (strong) return 'alive';
  if (noisy) return 'unjudged';
  return result.mutations > 0 ? 'alive' : 'inert';
};

/**
 * Try to get back to a state's baseline WITHOUT a reboot: Escape (dismisses the
 * overlays), restore the hash, then check the visible-control set matches. A
 * reboot costs seconds and most presses need only this. Returns true on success
 * — the caller hard-reboots when it returns false, because guessing at the state
 * is how a latched modal makes every later press look dead.
 */
const softRestore = async (page, surface, baselineVisible) => {
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    const hash = await page.evaluate('location.hash');
    if (hash !== `#${surface.hash}`) {
      await page.evaluate(`window.__app.setHash(${JSON.stringify('#' + surface.hash)})`);
      await page.waitForTimeout(SETTLE_MS);
    }
    const now = await page.evaluate('window.__sweep.visibleSigs()');
    if (now.length !== baselineVisible.size) return false;
    return now.every((s) => baselineVisible.has(s));
  } catch {
    return false;
  }
};

const sweepSurface = async (browser, surface) => {
    const entry = {
      ...surface, states: [], findings: [], mounted: false, routeStamps: [],
      error: null, controlsPressed: 0, attrsSeen: [], unreplayable: [],
      harnessArtifactCount: 0, selectsNotJudged: 0, overflows: [],
    };
    const attrsSeen = new Set();
    const queue = [[]];
    const queued = new Set(['']);
    let statesDone = 0;
    // ⛔ Press each control ONCE per surface. The shell chrome — drawer, account
    // menu, brand link, ~16 controls — re-renders in every nested state, so
    // without this the sweep re-presses it in each of them: on `#packs` that was
    // 45 states × 16 controls of pure redundancy, and the run did not finish in
    // ten minutes. Identity is the signature, so a genuinely different control
    // that merely looks similar still gets its own press.
    const pressedSigs = new Set();

    while (queue.length > 0 && statesDone < MAX_STATES) {
      const path = queue.shift();
      statesDone += 1;
      const state = { path, controls: [], noisy: false, idleMutations: 0, bootErrors: [] };

      let session = await bootAt(browser, surface, path).catch((e) => ({ page: null, errors: [], bootError: String(e).split('\n')[0] }));
      if (!session.page) {
        state.error = session.bootError || `could not replay path (${session.replayFailed})`;
        if (session.replayFailed) entry.unreplayable.push(session.replayFailed);
        entry.states.push(state);
        continue;
      }
      let { page, errors, dialogs } = session;

      if (path.length === 0) {
        const stamps = await page.evaluate(
          `[...document.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => a.name)).filter(n => /^data-recued-[a-z-]+-route$/.test(n))`,
        );
        entry.mounted = stamps.length > 0;
        entry.routeStamps = [...new Set(stamps)];
      }

      // ⛔ Fill BEFORE the idle baseline. Typing mutates the DOM, so filling
      // after it would be measured as surface noise and mark the whole state
      // unjudgeable. Filling first means the baseline describes the state the
      // presses actually run against.
      if (FILL_INPUTS) {
        state.inputsFilled = (await page.evaluate('window.__sweep.fillInputs()')).length;
      }
      // Measure the settled state, not an intermediate async repaint. Under the
      // four-worker sweep Settings could still be replacing a just-activated
      // panel here; measuring first attributed that transient child's width to
      // `.settings-shell`, while an immediate isolated replay was clean.
      state.wentQuiet = await waitForQuiet(page);
      state.overflow = await measureHorizontalOverflow(page);
      for (const measurement of state.overflow) {
        if (measurement.overflowing) {
          entry.overflows.push({ ...measurement, path });
        }
      }
      // ── Saturation guard: one settle window with NO press. ────────────────
      // Wait for the route's async bursts to land first, or the baseline just
      // measures them and the whole state is written off as unjudgeable.
      const idleBefore = await page.evaluate('window.__sweep.begin()');
      await page.waitForTimeout(SETTLE_MS);
      const idle = await page.evaluate(`window.__sweep.end(${JSON.stringify(idleBefore)})`);
      state.idleMutations = idle.mutations;
      state.noisy = idle.mutations > 0 || idle.changed.text || idle.changed.elements !== 0;
      const bootAll = errors.splice(0, errors.length);
      state.bootErrors = bootAll.filter((e) => !isHarnessArtifact(e));
      entry.harnessArtifactCount += bootAll.length - state.bootErrors.length;

      let restored = false;
      const controls = await page.evaluate('window.__sweep.list()');
      const baselineVisible = new Set(controls.filter((c) => c.visible).map((c) => c.sig));
      state.controlCount = controls.length;
      state.visibleCount = baselineVisible.size;
      for (const a of await page.evaluate('window.__sweep.domAttrs()')) attrsSeen.add(a);

      for (const control of controls) {
        if (!control.visible) continue; // reached via its own opener path, if any
        if (pressedSigs.has(control.sig)) continue; // already pressed on this surface
        pressedSigs.add(control.sig);
        const record = {
          sig: control.sig, tag: control.tag, role: control.role, attrs: control.attrs,
          text: control.text, label: control.label, href: control.href,
          disabled: control.disabled, selected: control.selected, path,
        };
        if (control.disabled) { record.verdict = 'skipped-disabled'; state.controls.push(record); continue; }
        if (control.tag === 'a' && /^https?:\/\//i.test(control.href)) {
          record.verdict = 'skipped-external'; state.controls.push(record); continue;
        }
        // A tab/toggle already in its selected state legitimately does nothing
        // on press — the KNOWN NEGATIVE this sweep must not report.
        if (control.selected) { record.verdict = 'skipped-already-selected'; state.controls.push(record); continue; }
        // Same class: a link pointing at the hash we are already on. The brand
        // "Recued" home link is alive on every other route and inert on #chat
        // for the single reason that #chat IS home. Reporting that would be
        // reporting the app for working.
        if (control.tag === 'a' && control.href.startsWith('#')
          && control.href.replace(/^#\/?/, '') === surface.hash) {
          record.verdict = 'skipped-link-to-current-route';
          state.controls.push(record);
          continue;
        }

        // Quiesce first: a mutation still in flight from the PREVIOUS press
        // would be attributed to this one and make a dead control look alive.
        record.quietBeforePress = await waitForQuiet(page);
        const before = await page.evaluate('window.__sweep.begin()');
        const pressed = await page.evaluate(`window.__sweep.pressSig(${JSON.stringify(control.sig)})`)
          .catch((e) => ({ pressed: false, reason: 'threw:' + String(e).split('\n')[0] }));
        if (!pressed.pressed) {
          await page.evaluate(`window.__sweep.end(${JSON.stringify(before)})`).catch(() => {});
          record.verdict = `skipped-${pressed.reason}`;
          state.controls.push(record);
          continue;
        }
        await page.waitForTimeout(SETTLE_MS);

        // A press can replace the DOCUMENT — a real navigation, or a <button>
        // inside a <form> whose submit was not prevented. That destroys the
        // in-page harness, so `end()` would throw. A replaced document is about
        // as observable as an outcome gets: record it and reboot.
        const survived = await page
          .evaluate('typeof window.__sweep !== "undefined"')
          .catch(() => false);
        if (!survived) {
          record.verdict = 'alive';
          record.signal = { documentReplaced: true };
          record.navigatedAway = true;
          entry.controlsPressed += 1;
          state.controls.push(record);
          await page.close();
          session = await bootAt(browser, surface, path).catch(() => ({ page: null, errors: [] }));
          if (!session.page) { state.error = 'reboot failed after navigation'; break; }
          page = session.page;
          errors = session.errors;
          dialogs = session.dialogs;
          if (FILL_INPUTS) await page.evaluate('window.__sweep.fillInputs()').catch(() => {});
          continue;
        }

        const result = await page.evaluate(`window.__sweep.end(${JSON.stringify(before)})`);
        const pressErrors = errors.splice(0, errors.length);
        const pressDialogs = dialogs.splice(0, dialogs.length);
        if (pressDialogs.length > 0) {
          result.changed.nativeDialog = true;
          record.nativeDialogs = pressDialogs;
        }
        record.verdict = judge(result, state.noisy || !state.wentQuiet);
        record.signal = result.changed;
        record.mutations = result.mutations;
        const reportableOrphans = orphansWorthReporting(result);
        if (reportableOrphans.length > 0) record.orphans = reportableOrphans;
        const realErrors = pressErrors.filter((e) => !isHarnessArtifact(e));
        const artifacts = pressErrors.filter(isHarnessArtifact);
        if (artifacts.length > 0) {
          record.harnessArtifacts = artifacts;
          entry.harnessArtifactCount += artifacts.length;
        }
        if (realErrors.length > 0) { record.verdict = 'threw'; record.errors = realErrors; }
        // ⛔ A form control that shows no outcome is NOT automatically a finding.
        // The semantic target snapshot above now sees value/checked changes when
        // the control (or its stable replacement) remains identifiable. But some
        // selects legitimately stage a value behind an explicit Apply button,
        // and a host can replace a property-only control without a stable marker.
        // Those no-signal cases still require a route assertion; say that rather
        // than bank a false dead-control finding.
        const propertyOnly = control.tag === 'select'
          || (control.tag === 'input' && /^(checkbox|radio)$/.test(control.type ?? ''));
        // ⛔ Both verdicts, not just `inert`: absence of a semantic target signal
        // is equally inconclusive on a quiet or noisy state.
        if ((record.verdict === 'inert' || record.verdict === 'unjudged') && propertyOnly) {
          record.verdict = 'property-change-no-signal';
          entry.selectsNotJudged += 1;
        }
        entry.controlsPressed += 1;

        // Did this press REVEAL controls that were not visible before? If so it
        // is an opener — queue the state it opens so its contents get swept too.
        // ⛔ Sample the DOM again AFTER the press. Coverage was collected only
        // at state START, so anything a press REVEALED — every dialog, drawer
        // and confirm the sweep opens and then restores from — was pressed but
        // never counted. The install consent dialog rendered +46 elements on
        // one press and contributed zero attributes to the measurement.
        for (const a of await page.evaluate('window.__sweep.domAttrs()')) attrsSeen.add(a);
        const nowVisible = await page.evaluate('window.__sweep.visibleSigs()');
        const revealed = nowVisible.filter((s) => !baselineVisible.has(s));
        // Queue the opened state only if it reveals controls this surface has
        // not already pressed — otherwise a menu that re-renders the same shell
        // chrome queues a state with nothing left to do in it.
        const worthVisiting = revealed.filter((s) => !pressedSigs.has(s));
        // ⛔ A press that changed the route hash NAVIGATED — it did not open
        // anything. Queuing it walks the sweep off this surface and onto
        // another route, which then reports ITS controls under THIS surface's
        // name (the first run attributed `#logs` filters and `#settings` nav
        // items to `packs-installed`). Every route has its own entry; leaving
        // is never an opener.
        if (worthVisiting.length > 0 && !result.changed.hash && path.length < MAX_DEPTH) {
          const nextPath = [...path, control.sig];
          const key = nextPath.join('»');
          if (!queued.has(key)) { queued.add(key); queue.push(nextPath); }
          record.opener = worthVisiting.length;
        }
        state.controls.push(record);
        if (['inert', 'threw', 'unjudged', 'orphan'].includes(record.verdict)) {
          entry.findings.push({ ...record, surface: surface.id });
        }

        // ── Restore a clean state before the next press. ────────────────────
        // A press that opened an overlay or navigated leaves every LATER press
        // looking dead — the latch that made one real defect present as "the
        // buttons are not clickable" for a whole session. Reboot; never guess.
        const dirty = result.changed.hash || result.changed.dialogs > 0
          || result.changed.bodyChildren > 0 || revealed.length > 0;
        if (dirty && !(await softRestore(page, surface, baselineVisible))) {
          await page.close();
          session = await bootAt(browser, surface, path).catch(() => ({ page: null, errors: [] }));
          if (!session.page) { state.error = 'reboot failed mid-state'; break; }
          page = session.page;
          errors = session.errors;
          dialogs = session.dialogs;
          restored = true;
        }
        // ⛔ A reboot throws away everything typed at state entry, and a soft
        // restore can too. Without re-filling, every press after the first
        // dirty one runs against an EMPTY form while the sweep still believes
        // the state is filled — which reported chat's Send as INERT when a
        // clean-boot probe shows it working (label flips to "Sending..."). The
        // state the sweep judges must be the state it is actually in.
        if (FILL_INPUTS && (dirty || restored)) {
          await page.evaluate('window.__sweep.fillInputs()').catch(() => {});
          restored = false;
        }
        errors.splice(0, errors.length); // restore noise is not a press outcome
      }

      if (page && !page.isClosed()) await page.close();
      entry.states.push(state);
    }

    entry.attrsSeen = [...attrsSeen].sort();
    entry.statesSwept = statesDone;
    entry.overflowOwners = summarizeOverflowOwners(entry.overflows);
    return entry;
};

const run = async () => {
  const server = spawn(
    'python3',
    ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', HERE],
    { stdio: 'ignore' },
  );
  await new Promise((r) => setTimeout(r, 900));
  const browser = await chromium.launch({ headless: true });
  // `--slice i/n` runs partition i of n, so a long sweep can be driven in
  // chunks that fit a foreground timeout and merged afterwards.
  const sliceArg = flag('slice');
  let surfaces = only ? SURFACES.filter((s) => s.id === only) : SURFACES;
  if (sliceArg) {
    const [i, n] = sliceArg.split('/').map(Number);
    surfaces = surfaces.filter((_, idx) => idx % n === (i - 1));
  }
  const report = {
    generated: new Date().toISOString(),
    settleMs: SETTLE_MS,
    overflowViewportWidths: OVERFLOW_VIEWPORT_WIDTHS,
    surfaces: [],
  };

  // `browser.newPage()` opens each page in its own context, so surfaces swept
  // concurrently cannot see each other's storage or state.
  const pending = [...surfaces];
  const worker = async () => {
    for (;;) {
      const surface = pending.shift();
      if (!surface) return;
      let entry;
      try {
        entry = await sweepSurface(browser, surface);
      } catch (e) {
        // A surface that blew up is RECORDED as blown up, never dropped —
        // otherwise it silently leaves the report and reads as "not a problem".
        entry = {
          ...surface,
          error: String(e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e).slice(0, 300),
          findings: [], states: [], controlsPressed: 0, attrsSeen: [],
          overflows: [], overflowOwners: [],
        };
      }
      report.surfaces.push(entry);
      // ⛔ The mark must reflect whether the surface was AUDITED, not just
      // whether it produced findings. A run whose browser died printed `✓` for
      // 55 surfaces that never mounted and pressed nothing, then summarised as
      // "1 finding" — a broken run wearing the face of a clean one, which is
      // the precise failure this whole sweep exists to catch. `mounted=N` with
      // no presses is NOT a pass.
      const unaudited = entry.error !== null && entry.error !== undefined
        ? true
        : !entry.mounted || entry.controlsPressed === 0;
      const overflowCount = entry.overflowOwners?.length ?? 0;
      const overflowStateCount = entry.overflows?.length ?? 0;
      const unreplayableCount = entry.unreplayable?.length ?? 0;
      const mark = unaudited
        ? '✖'
        : entry.findings.length > 0 || overflowCount > 0 || unreplayableCount > 0
          ? '⚠'
          : '✓';
      console.log(
        `${mark} ${surface.id.padEnd(24)} mounted=${entry.mounted ? 'y' : 'N'} `
        + `states=${String(entry.statesSwept ?? 0).padStart(2)} pressed=${String(entry.controlsPressed).padStart(3)} `
        + `findings=${String(entry.findings.length).padStart(2)} overflow=${String(overflowCount).padStart(2)} `
        + `overflow-states=${String(overflowStateCount).padStart(3)} `
        + `unreplayable=${String(unreplayableCount).padStart(2)} `
        + `${(entry.states ?? []).some((s) => s.noisy) ? 'NOISY ' : ''}`
        + `${(entry.states ?? []).reduce((n, s) => n + (s.bootErrors?.length ?? 0), 0) ? 'BOOT-ERRORS ' : ''}`
        + `${entry.error ? entry.error : ''}`,
      );
      if (verbose) {
        for (const f of entry.findings) {
          console.log(`     · ${f.verdict.toUpperCase()} ${f.tag} [${f.attrs.join(',') || '—'}] "${f.text}" depth=${f.path.length}`);
        }
        for (const owner of entry.overflowOwners ?? []) {
          console.log(
            `     · OVERFLOW ${owner.widths.join('/')}px `
            + `${owner.tag}${owner.id ? '#' + owner.id : ''} `
            + `${owner.sizes.join(',')} occurrences=${owner.occurrences} `
            + `depth=${owner.firstPath.length}`,
          );
        }
        for (const replay of entry.unreplayable ?? []) {
          console.log(`     · UNREPLAYABLE ${replay}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, WORKERS) }, worker));
  report.surfaces.sort((a, b) => SURFACES.findIndex((s) => s.id === a.id) - SURFACES.findIndex((s) => s.id === b.id));

  await browser.close();
  server.kill();

  const totalFindings = report.surfaces.reduce((n, s) => n + s.findings.length, 0);
  const totalOverflowStates = report.surfaces.reduce(
    (n, s) => n + (s.overflows?.length ?? 0),
    0,
  );
  const totalUnreplayable = report.surfaces.reduce(
    (n, s) => n + (s.unreplayable?.length ?? 0),
    0,
  );
  const uniqueOverflowOwners = new Set(report.surfaces.flatMap(
    (surface) => (surface.overflowOwners ?? []).map((owner) => owner.signature),
  ));
  report.overflowStateCount = totalOverflowStates;
  report.overflowOwnerCount = uniqueOverflowOwners.size;
  report.unreplayablePathCount = totalUnreplayable;
  const totalPressed = report.surfaces.reduce((n, s) => n + s.controlsPressed, 0);
  const unaudited = report.surfaces.filter(
    (s) => s.error || !s.mounted || s.controlsPressed === 0,
  );
  report.unauditedSurfaces = unaudited.map((s) => s.id);
  console.log(
    `\n── ${report.surfaces.length} surfaces · ${totalPressed} presses · `
    + `${totalFindings} findings · ${uniqueOverflowOwners.size} overflow owners `
    + `across ${totalOverflowStates} states · ${totalUnreplayable} unreplayable · `
    + `${unaudited.length} UNAUDITED`,
  );
  if (unaudited.length > 0) {
    // Loud, and above the report path so it cannot be skimmed past. An
    // unaudited surface is not a passing surface.
    console.log(
      `\n⛔ ${unaudited.length} surface(s) were NOT audited — they never mounted or `
      + `pressed nothing. Their findings count of zero means NOTHING:\n   `
      + unaudited.map((s) => s.id).join(', '),
    );
  }
  if (totalUnreplayable > 0) {
    console.log(
      `\n⛔ ${totalUnreplayable} queued state path(s) could not be replayed — their `
      + 'findings and overflow counts are incomplete.',
    );
  }
  if (jsonOut) {
    writeFileSync(resolve(process.cwd(), jsonOut), JSON.stringify(report, null, 2));
    console.log(`── report → ${jsonOut}`);
  }
  // Non-zero for a press finding, an overflow owner, an unreplayable state, or
  // an unaudited surface:
  // a run that could not look is not a run that found nothing.
  process.exitCode = totalFindings > 0 || uniqueOverflowOwners.size > 0
    || totalUnreplayable > 0 || unaudited.length > 0
    ? 1
    : 0;
};

await run();
