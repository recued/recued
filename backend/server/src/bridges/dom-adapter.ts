/** D-169 P0 follow-on — DOM-ingredient runner consumer.
 *
 *  The first production caller of `BridgeDispatcher.dispatch(...)`. Sits
 *  in the engine's adapter registry as the `dom` slot on the server
 *  runtime and bridges between the engine's `ResolvedCall` envelope and
 *  the dispatcher's `DispatchRequest` shape. Without this slice the D-169
 *  P0 stack composes correctly but has no caller — DOM ingredients route
 *  to `unsupported('dom', ...)` and surface `INGREDIENT_ADAPTER_ALL_FAILED`.
 *
 *  Per-entry dispatch model. The bridge SW's content-script executor
 *  (`apps/bridge/src/actions/executor.ts`) consumes ONE
 *  `(action, selector, [value])` per `BridgeCommand` — `read_dom` returns
 *  `{ text }`, `fill` returns `{ filled: true }`, `click` returns
 *  `{ clicked: true }`. The recipe-level DOM ingredient's `output` map
 *  encodes MULTIPLE selectors (one per field name). To bridge this
 *  contract gap, the runner iterates the output map and emits one
 *  `BridgeCommand` per non-trigger entry — sequential roundtrips, but
 *  matches the bridge SW's flat-args expectation exactly. Aggregation
 *  follows `packages/ingredients/src/dom.ts:executeDOM`'s shape:
 *
 *    - reads only           → `Record<string, string | null>`
 *    - writes only          → `{ written, fields, failed }`
 *    - clicks only          → `{ clicked: N }`
 *    - any mixed shape      → `{ reads?, writes?, clicked? }`
 *
 *  Output entry → BridgeAction:
 *
 *    - value `"trigger"`              → URL pattern (drives target_domain_pattern;
 *                                       skipped in per-entry iteration)
 *    - value starts with `"dom."`     → `fill` — input field name follows the prefix;
 *                                       value pulled from `input[<field>]`
 *    - value `"click"` / `"enter"`    → `click` (no extra args needed)
 *    - anything else                  → `read_dom`; the value becomes the field
 *                                       name on the aggregated step output
 *
 *  Idempotency. The dispatcher's `idempotency_key` is the bridge's
 *  24h dedup primary — a retry of the SAME logical step should hit the
 *  bridge's idempotency cache and replay the prior result. The runner
 *  builds a STABLE per-entry key from `run_id:step_id:slug:entry_index`
 *  + a SHA-256 of the resolved input + the entry key/value pair, so:
 *
 *    - same run + step + input on retry → same key → bridge replays
 *    - separate runs → distinct keys → fresh dispatches
 *    - distinct steps + distinct inputs → distinct keys → fresh dispatches
 *
 *  Late binding. The dispatcher is composed inside `createWebSocketUpgrade`
 *  AFTER the executor is built. The adapter receives a `getDispatcher`
 *  thunk so the boot site can publish the live dispatcher after the WS
 *  binding is wired (parallel to `lateBound.publishExecuteDeps`). When
 *  the thunk returns undefined (test compositions without ws-server, or
 *  bridgeRegistry-less daemon paths), the adapter throws
 *  `ROLE_RESTRICTION` — same posture as the registry's default
 *  `unsupported('dom', ...)` placeholder.
 *
 *  Spec: D-169 § N.3 (per-command authority retirement),
 *  § N.9 / A.8 (multi-bridge fall-through); composes with the dispatcher
 *  from `backend/server/src/bridges/dispatcher.ts` (`ce5bb9a3`). */

import { createHash, randomUUID } from 'node:crypto';
import { currentPreapprovalIo } from '../preapproval-io-context.js';
import { captureProviderHandoffFence } from '../execution/provider-handoff.js';
import { currentRunAbortContext } from '../execution/run-abort-context.js';

import {
  BRIDGE_CLICK_LOAD_MAX_MS,
  BRIDGE_CLICK_OUTPUT_KEYS,
  BRIDGE_COMMAND_MAX_TIMEOUT_MS,
  BRIDGE_FILL_OUTPUT_KEYS,
  BRIDGE_PICK_OUTPUT_KEYS,
  BRIDGE_SUBMIT_OUTPUT_KEYS,
  BROWSER_ACT_CHECK_SECONDS,
  BROWSER_ACT_PICK_SECONDS,
  browserActStepCheckSeconds,
  browserActStepMayMove,
  browserActStepSubmits,
  browserActStepWatchSeconds,
  browserActWaitsForElement,
  parseBrowserActSteps,
  stripCorePrefix,
  BRIDGE_DESCRIBE_OUTPUT_KEYS,
  BRIDGE_INSPECT_OUTPUT_KEYS,
  BRIDGE_OPEN_OUTPUT_KEYS,
  BRIDGE_SCREENSHOT_MAX_BASE64,
  BRIDGE_SCREENSHOT_MAX_EDGE,
  BRIDGE_SCREENSHOT_OUTPUT_KEYS,
  BRIDGE_TABLE_OUTPUT_KEYS,
  BRIDGE_TABS_OUTPUT_KEYS,
  BRIDGE_WAIT_DEFAULT_MS,
  BRIDGE_WAIT_MAX_MS,
  BRIDGE_WAIT_OUTPUT_KEYS,
  browserPassSiteOf,
  isBridgeTargetGone,
  isPatternWithinGrantedOrigins,
  type ApprovalValueLabels,
  type HeldBrowserTarget,
  type HeldBrowserStep,
  type BrowserActFailure,
  type BridgeAction,
  type BridgeIngredientRef,
  type BridgeResult,
  type BridgeSurfaceKind,
  type IngredientManifest,
} from '@recued/contracts';
import {
  IngredientError,
  type Adapter,
  type ResolvedCall,
} from '@recued/ingredients';
import { browserImages, type BrowserImageStore } from './browser-images.js';
import type {
  BridgeDispatcher,
  DispatchOutcome,
  DispatchRequest,
} from './dispatcher.js';

/** Minimal manifest-registry contract the adapter needs. Mirrors the
 *  shape of `backend/server/src/manifest-loader.ts:ManifestRegistry` but
 *  declared inline so the adapter doesn't pull the whole module surface.
 *  Tests pass a hand-built `{ get }` object. */
export interface DomBridgeManifestSource {
  get(slug: string): IngredientManifest | null;
}

export interface CreateBridgeDomAdapterOptions {
  /** Synchronous manifest lookup. Throws `INGREDIENT_NOT_FOUND` from
   *  the engine's dispatch layer before reaching the adapter; this
   *  defensive read returns null only when the dispatch layer is
   *  bypassed (tests, direct rpc paths). */
  manifests: DomBridgeManifestSource;
  /** Late-bound dispatcher accessor. Resolved at every call so the
   *  boot site can publish the live dispatcher after the WS binding is
   *  built. Returns undefined when no bridge runtime is wired (test
   *  compositions, dbless harnesses); the adapter then throws
   *  `ROLE_RESTRICTION` matching the registry's default unsupported
   *  posture for browser-only ingredients on a server runtime. */
  getDispatcher: () => BridgeDispatcher | undefined;
  /** Per-call timeout override (ms). Forwarded as `request.timeout_ms`
   *  on every dispatch; the dispatcher clamps to
   *  `[1, BRIDGE_COMMAND_MAX_TIMEOUT_MS]` and falls through to the
   *  default when undefined. Optional — most callers leave it absent
   *  so the bridge's default kicks in. */
  defaultTimeoutMs?: number;
  /** D-335 slice H — where a screenshot's picture is kept while its step's
   *  output carries a reference to it. Defaults to the process's store, which
   *  the MCP server reads. */
  images?: BrowserImageStore;
}

const DOM_WRITE_PREFIX = 'dom.';
const DOM_TRIGGER_MARKER = 'trigger';
const DOM_CLICK_MARKER = 'click';
const DOM_ENTER_MARKER = 'enter';

// ── D-182 "core.dom" — the Tier-K kernel DOM-action ops. Unlike a per-tool DOM
//    ingredient (which bakes the selector→field map into its manifest `output`),
//    `core.dom.{read,write}` lower to these two backing slugs and carry the
//    selectors/target/value as op ARGS. The adapter synthesizes the per-entry
//    dispatch directly from those args (no manifest output map), then reuses the
//    same per-entry dispatch loop / idempotency / assembly as the manifest path.
const CORE_DOM_READ_SLUG = 'dom-read';
const CORE_DOM_WRITE_SLUG = 'dom-write';
/** The synthetic input field a `core.dom.write` fill entry pulls its value from
 *  (`buildArgsForEntry` reads `input[<marker after "dom.">]`). Underscore-fenced
 *  so it never collides with a real recipe field. */
const CORE_DOM_VALUE_FIELD = '__core_dom_value';
/** D-335 slice N — the suggestion a `core.dom.write` picks, in its call's input. */
const CORE_DOM_PICK_FIELD = '__core_dom_pick';

/** D-335 — `core.dom.inspect` is one `inspect` command, and `core.dom.click`
 *  one `click`, built from their args. */
const CORE_DOM_INSPECT_SLUG = 'dom-inspect';
const CORE_DOM_CLICK_SLUG = 'dom-click';
/** D-335 slice C — `core.dom.tabs` (one `list_tabs`) and `core.dom.open`
 *  (one `open_tab`). */
const CORE_DOM_TABS_SLUG = 'dom-tabs';
const CORE_DOM_OPEN_SLUG = 'dom-open';
/** D-335 slice H — `core.dom.wait` (one `wait_for_element`), `core.dom.table`
 *  (one `read_table`) and `core.dom.screenshot` (one `screenshot_page`), each on
 *  a page handle. */
const CORE_DOM_WAIT_SLUG = 'dom-wait';
const CORE_DOM_TABLE_SLUG = 'dom-table';
const CORE_DOM_SCREENSHOT_SLUG = 'dom-screenshot';
/** D-335 slice J — a sequence of steps on one page, approved once (`runBrowserActSteps`). */
const CORE_DOM_ACT_SLUG = 'dom-act';

/** D-335 slices L and N — how long a `pick` command may take: its wait for the suggestion, then the
 *  click and the page it may load. */
const PICK_COMMAND_TIMEOUT_MS = Math.min(BRIDGE_COMMAND_MAX_TIMEOUT_MS, BROWSER_ACT_PICK_SECONDS * 1000 + 20_000);

/** The ops whose one command's answer is the step's whole output. */
const WHOLE_ANSWER_SLUGS: ReadonlySet<string> = new Set([CORE_DOM_INSPECT_SLUG, CORE_DOM_TABS_SLUG, CORE_DOM_OPEN_SLUG,
  CORE_DOM_WAIT_SLUG, CORE_DOM_TABLE_SLUG, CORE_DOM_SCREENSHOT_SLUG]);
const WHOLE_ANSWER_ACTIONS: ReadonlySet<BridgeAction> = new Set(['inspect', 'list_tabs', 'open_tab',
  'wait_for_element', 'read_table', 'screenshot_page']);
/** The actions that change nothing on a page: a lost answer is a failed read. */
const READ_ACTIONS: ReadonlySet<BridgeAction> = new Set(['read_dom', 'inspect', 'describe', 'list_tabs',
  'wait_for_element', 'read_table', 'screenshot_page']);

const isCoreDomSlug = (slug: string): boolean =>
  slug === CORE_DOM_READ_SLUG || slug === CORE_DOM_WRITE_SLUG || slug === CORE_DOM_CLICK_SLUG;

/** The page, ref and selector a `core.dom` call names, checked here so a bad
 *  call fails with its reason before it reaches a Bridge (which checks them
 *  again). A ref only means something on the page it came from, so it needs
 *  that page's handle. `label` names the element, for the call's errors. */
const coreDomElement = (
  input: Record<string, unknown>,
  slug: string,
): { element: Record<string, string>; label: string } => {
  const op = slug === CORE_DOM_INSPECT_SLUG ? 'core.dom.inspect'
    : slug === CORE_DOM_CLICK_SLUG ? 'core.dom.click'
      : slug === CORE_DOM_TABLE_SLUG ? 'core.dom.table'
        : slug === CORE_DOM_SCREENSHOT_SLUG ? 'core.dom.screenshot' : 'core.dom.write';
  const optional = (key: string): string | undefined => {
    const value = input[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
      throw new IngredientError('DOM_SELECTOR_MISSING', `${op}: '${key}' must be text`, { slug, key });
    }
    return value;
  };
  const page = optional('page');
  const ref = optional('ref');
  const selector = optional('selector');
  if (ref !== undefined && selector !== undefined) {
    throw new IngredientError('DOM_SELECTOR_MISSING', `${op}: give a ref or a selector, not both`, { slug });
  }
  if (ref !== undefined && page === undefined) {
    throw new IngredientError('DOM_SELECTOR_MISSING',
      `${op}: a ref needs the page it came from — pass the page handle that inspect answered`, { slug, ref });
  }
  return {
    element: { ...(page !== undefined ? { page } : {}), ...(ref !== undefined ? { ref } : {}),
      ...(selector !== undefined ? { selector } : {}) },
    label: selector ?? (ref !== undefined ? `ref ${ref}` : 'the page'),
  };
};

/** D-335 slice H — a `core.dom.wait`: the page, what to wait for, and for how
 *  long. Its command's own budget outlasts the wait, so a page that never
 *  answers is `found: false` from the Bridge, not a command that timed out. */
const buildWaitCall = (target: string, input: Record<string, unknown>) => {
  const slug = CORE_DOM_WAIT_SLUG;
  const page = reqDomArg(input, 'page', slug);
  const selector = reqDomArg(input, 'selector', slug);
  const blank = (value: unknown) => value === undefined || value === null || value === '';
  const until = blank(input.until) ? 'shown' : input.until;
  if (until !== 'shown' && until !== 'gone') {
    throw new IngredientError('DOM_SELECTOR_MISSING', "core.dom.wait: 'until' is shown or gone", { slug, until });
  }
  const text = input.text;
  if (!blank(text) && typeof text !== 'string') {
    throw new IngredientError('DOM_SELECTOR_MISSING', "core.dom.wait: 'text' must be text", { slug });
  }
  let wait = BRIDGE_WAIT_DEFAULT_MS;
  if (!blank(input.timeout_seconds)) {
    const seconds = typeof input.timeout_seconds === 'number' ? input.timeout_seconds
      : typeof input.timeout_seconds === 'string' ? Number(input.timeout_seconds) : Number.NaN;
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new IngredientError('DOM_SELECTOR_MISSING', "core.dom.wait: 'timeout_seconds' is a number of seconds", { slug });
    }
    wait = Math.min(BRIDGE_WAIT_MAX_MS, Math.round(seconds * 1000));
  }
  return {
    target,
    action: 'wait_for_element' as const,
    args: { page, selector, until, ...(typeof text === 'string' && text !== '' ? { text } : {}), timeout_ms: wait },
    label: selector,
    timeout_ms: Math.min(BRIDGE_COMMAND_MAX_TIMEOUT_MS, wait + 10_000),
  };
};

/** A one-command `core.dom` call: its target, action and command args.
 *  `core.dom.open` checks its address here, so an address that is not a web
 *  address or not on the target fails before any Bridge is asked (the Bridge
 *  checks it again). */
const buildWholeAnswerCall = (
  slug: string,
  input: Record<string, unknown>,
): { target: string; action: BridgeAction; args: Record<string, string | number>; label: string; timeout_ms?: number } => {
  const target = reqDomArg(input, 'target', slug);
  if (slug === CORE_DOM_TABS_SLUG) return { target, action: 'list_tabs', args: {}, label: 'the open tabs' };
  if (slug === CORE_DOM_WAIT_SLUG) return buildWaitCall(target, input);
  if (slug === CORE_DOM_TABLE_SLUG || slug === CORE_DOM_SCREENSHOT_SLUG) {
    const { element, label } = coreDomElement(input, slug);
    if (element.page === undefined) {
      throw new IngredientError('DOM_SELECTOR_MISSING', `${slug === CORE_DOM_TABLE_SLUG ? 'core.dom.table' : 'core.dom.screenshot'}: `
        + 'pass the page handle that listing the tabs or opening a page answered', { slug });
    }
    return { target, action: slug === CORE_DOM_TABLE_SLUG ? 'read_table' : 'screenshot_page', args: element, label };
  }
  if (slug === CORE_DOM_OPEN_SLUG) {
    // The op takes `address`: a manifest input named `url` is an HTTP
    // ingredient's fixed endpoint, which no caller may supply. The Bridge's
    // `open_tab` still names it `url`.
    const url = reqDomArg(input, 'address', slug);
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      throw new IngredientError('DOM_PAGE_NOT_MATCHING', `core.dom.open: '${url}' is not a web address`, { slug, url });
    }
    if ((address.protocol !== 'http:' && address.protocol !== 'https:') || address.username || address.password) {
      throw new IngredientError('DOM_PAGE_NOT_MATCHING',
        'core.dom.open: only an http or https address, without a user name or password, can be opened', { slug, url });
    }
    if (!isPatternWithinGrantedOrigins(address.href, [target])) {
      throw new IngredientError('DOM_PAGE_NOT_MATCHING', `core.dom.open: ${address.href} is not on ${target}`,
        { slug, url, target });
    }
    return { target, action: 'open_tab', args: { url: address.href }, label: address.href };
  }
  const { element, label } = coreDomElement(input, CORE_DOM_INSPECT_SLUG);
  return { target, action: 'inspect', args: element, label };
};

/** Pull a required non-empty string arg off a `core.dom` op's resolved input. */
const reqDomArg = (
  input: Record<string, unknown>,
  key: string,
  slug: string,
): string => {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new IngredientError(
      'DOM_SELECTOR_MISSING',
      `core.dom op '${slug}' requires a non-empty '${key}' arg`,
      { slug, key },
    );
  }
  return v;
};

/** Synthesize the `{ domain_allowlist, entries, input }` a `core.dom.{read,write}`
 *  call dispatches, from its op args — the arg-driven counterpart to the manifest
 *  `output`-map derivation (`extractDomainAllowlist` + `collectEntries`). The
 *  `target` arg is the actuation domain (the Bridge's `domain_allowlist`); the
 *  per-entry loop then runs exactly as for a manifest DOM ingredient. */
const buildCoreDomCall = (
  slug: string,
  input: Record<string, unknown>,
): { domain_allowlist: string[]; entries: DomEntry[]; input: Record<string, unknown> } => {
  const target = reqDomArg(input, 'target', slug);
  // `target` rides in the synthesized input so it folds into the per-entry
  // idempotency hash (`buildIdempotencyKey`) — two distinct calls to the same
  // selector against different domains must not share a Bridge dedup cell. The
  // underscore-fenced key is never read by `buildArgsForEntry` (which only pulls
  // the `dom.<field>` fill value), so it affects the hash only.
  if (slug === CORE_DOM_READ_SLUG) {
    const selector = reqDomArg(input, 'selector', slug);
    // One read entry; the marker IS the output field name (`text`).
    return {
      domain_allowlist: [target],
      entries: [{ selector, marker: 'text', index: 1 }],
      input: { __core_dom_target: target },
    };
  }
  // D-335 slice B — a write or click names its element by a selector, or by a
  // page handle with a ref (or a selector) on that page, which binds it there.
  const { element, label } = coreDomElement(input, slug);
  if (element.ref === undefined && element.selector === undefined) {
    throw new IngredientError('DOM_SELECTOR_MISSING',
      `core.dom op '${slug}' needs the element: a 'selector', or a 'ref' with its 'page'`, { slug });
  }
  const bound = element.page !== undefined;
  if (slug === CORE_DOM_CLICK_SLUG) {
    return {
      domain_allowlist: [target],
      entries: [{ selector: label, marker: DOM_CLICK_MARKER, index: 1, ...(bound ? { element } : {}) }],
      input: { __core_dom_target: target, __core_dom_element: element },
    };
  }
  // core.dom.write — fill `value` into the element, then optionally press Enter
  // on `submit_selector` (the web-chat submit pattern), on the same page when
  // the write is bound to one. The fill marker is `dom.<CORE_DOM_VALUE_FIELD>`,
  // so `buildArgsForEntry` pulls the value from the synthetic input below.
  const value = reqDomArg(input, 'value', slug);
  // D-335 slice N — then the field's suggestion with this text: the Bridge's `pick`, by page only.
  const pick = typeof input.pick === 'string' && input.pick.trim() !== '' ? input.pick : undefined;
  if (pick !== undefined) {
    if (!bound) {
      throw new IngredientError('DOM_SELECTOR_MISSING',
        `core.dom op '${slug}' picks a suggestion only on a page named by its handle: give 'page' with the 'ref'`, { slug });
    }
    if (typeof input.submit_selector === 'string' && input.submit_selector !== '') {
      throw new IngredientError('DOM_WRITE_FAILED',
        `core.dom op '${slug}' cannot pick a suggestion and press Enter on another element in one call`, { slug });
    }
    return {
      domain_allowlist: [target],
      entries: [{ selector: label, marker: `${DOM_WRITE_PREFIX}${CORE_DOM_VALUE_FIELD}`, index: 1, action: 'pick', element }],
      input: { [CORE_DOM_VALUE_FIELD]: value, [CORE_DOM_PICK_FIELD]: pick, __core_dom_target: target, __core_dom_element: element },
    };
  }
  const entries: DomEntry[] = [
    { selector: label, marker: `${DOM_WRITE_PREFIX}${CORE_DOM_VALUE_FIELD}`, index: 1,
      ...(bound ? { element } : {}) },
  ];
  const submit = input.submit_selector;
  if (typeof submit === 'string' && submit.length > 0) {
    entries.push({ selector: submit, marker: DOM_ENTER_MARKER, index: 2,
      ...(bound ? { element: { page: element.page!, selector: submit } } : {}) });
  }
  return {
    domain_allowlist: [target],
    entries,
    // A selector-only write keeps the idempotency input it always had.
    input: { [CORE_DOM_VALUE_FIELD]: value, __core_dom_target: target, ...(bound ? { __core_dom_element: element } : {}) },
  };
};

interface DomEntry {
  /** Selector — the output map key. */
  selector: string;
  /** Output map value — drives action selection + field-name semantics. */
  marker: string;
  /** 1-based ordinal of the entry's position in the output map (after
   *  filtering out `'trigger'` entries). Used as a stable suffix in the
   *  idempotency key so multiple entries on the same step have distinct
   *  bridge dedup cells. */
  index: number;
  /** The action, for an entry an op synthesizes rather than a manifest's
   *  output map (`core.dom.inspect`). A manifest entry never sets it, so a
   *  field a recipe happens to call `inspect` stays a read. */
  action?: BridgeAction;
  /** D-335 slice B — the element a `core.dom` write or click names by page
   *  handle and ref (or selector), sent as the command's args in place of
   *  `{ selector }`. A manifest entry never sets it. */
  element?: Record<string, string>;
}

interface PerEntryOutcome {
  entry: DomEntry;
  action: BridgeAction;
  /** Result.outputs as the bridge returned them. Undefined when the
   *  dispatch produced a non-throwing failure that the caller already
   *  surfaced as an `IngredientError` upstream. */
  outputs: Record<string, unknown> | undefined;
}

/** Pure request builder shared by actual dispatch and D-261 preparation. */
export const describeBridgeDomCall = (
  manifest: IngredientManifest, resolved: Pick<ResolvedCall, 'slug' | 'input' | 'output'>,
) => {
  // D-335 slice J — a sequence has no commands to describe before it runs.
  if (resolved.slug === CORE_DOM_ACT_SLUG) throw sequenceNotReviewable();
  // core.dom.{read,write}: arg-driven — synthesize the allowlist + entries from
  // the op args (no manifest selector map). Otherwise derive them from the DOM
  // ingredient's manifest `output` map as before. `callInput` is what
  // `buildArgsForEntry` / `buildIdempotencyKey` read: the synthetic
  // `{ [CORE_DOM_VALUE_FIELD]: value }` for a core.dom write, else the resolved
  // step input.
  if (WHOLE_ANSWER_SLUGS.has(resolved.slug)) {
    const { target, action, args, label, timeout_ms } = buildWholeAnswerCall(resolved.slug, resolved.input);
    const entry: DomEntry = { selector: label, marker: action, index: 1, action };
    return {
      ingredient: buildIngredientRef(manifest, [target]),
      callInput: { __core_dom_target: target, ...args },
      entries: [{ entry, action, args: args as Record<string, unknown>,
        expects_output_keys: expectsKeysForAction(action), ...(timeout_ms !== undefined ? { timeout_ms } : {}) }],
    };
  }
  let domain_allowlist: string[];
  let entries: DomEntry[];
  let callInput: Record<string, unknown>;
  if (isCoreDomSlug(resolved.slug)) {
    const built = buildCoreDomCall(resolved.slug, resolved.input);
    domain_allowlist = built.domain_allowlist;
    entries = built.entries;
    callInput = built.input;
  } else {
    domain_allowlist = extractDomainAllowlist(resolved.output);
    if (domain_allowlist.length === 0) {
      throw new IngredientError(
        'DOM_PAGE_NOT_MATCHING',
        `DOM ingredient '${resolved.slug}' declares no trigger URL patterns — bridge dispatch needs at least one`,
        { slug: resolved.slug },
      );
    }
    entries = collectEntries(resolved.output);
    callInput = resolved.input;
  }

  const ingredient = buildIngredientRef(manifest, domain_allowlist);
  return { ingredient, callInput, entries: entries.map(entry => {
    const action = classifyEntryAction(entry);
    return { entry, action, args: buildArgsForEntry(entry, action, callInput, resolved.slug),
      expects_output_keys: expectsKeysForAction(action),
      // D-335 slice N — a pick waits for its suggestion inside its command.
      ...(action === 'pick' ? { timeout_ms: PICK_COMMAND_TIMEOUT_MS } : {}) } as {
      entry: DomEntry; action: BridgeAction; args: Record<string, unknown>; expects_output_keys: string[]; timeout_ms?: number };
  }) };
};

/** Build the bridge-runner adapter. Returns an `Adapter` that the
 *  engine's adapter registry installs at the `dom` slot. */
export const createBridgeDomAdapter = (
  options: CreateBridgeDomAdapterOptions,
): Adapter => {
  return async (resolved: ResolvedCall): Promise<unknown> => {
    const assertHandoff = captureProviderHandoffFence();
    assertHandoff();
    const dispatcher = options.getDispatcher();
    if (!dispatcher) {
      throw new IngredientError(
        'ROLE_RESTRICTION',
        `DOM ingredient '${resolved.slug}' requires a paired Browser Bridge — none is connected`,
        { slug: resolved.slug, kind: 'dom' },
      );
    }

    const manifest = options.manifests.get(resolved.slug);
    if (!manifest) {
      // Defensive — the engine's dispatch layer (createIngredientExecutor)
      // already throws INGREDIENT_NOT_FOUND before reaching here, so this
      // branch only fires when callers build a ResolvedCall outside the
      // engine path.
      throw new IngredientError(
        'INGREDIENT_NOT_FOUND',
        `No manifest found for DOM ingredient '${resolved.slug}'`,
        { slug: resolved.slug },
      );
    }

    // D-335 slice J — a sequence decides its commands as it goes.
    if (resolved.slug === CORE_DOM_ACT_SLUG) {
      return runBrowserActSteps({ resolved, dispatcher, manifest, assertHandoff,
        ...(options.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {}) });
    }
    const { ingredient, callInput, entries } = describeBridgeDomCall(manifest, resolved);
    // D-335 slice N — which suggestion a pick clicks is known only once they show: a run reviewed
    // before it starts cannot hold it, as it cannot hold a sequence.
    if (currentPreapprovalIo() && entries.some(({ action }) => action === 'pick')) throw pickNotReviewable();
    const recipe_run_id = buildRecipeRunId(resolved);
    const step_id = resolved.stepMeta?.step_id ?? resolved.slug;

    // Per-entry sequential dispatch. The bridge SW handles ONE action
    // per command; the recipe-level output map can encode many. Each
    // entry gets its own dispatch + its own bridge idempotency cell.
    const outcomes: PerEntryOutcome[] = [];
    for (const { entry, action, args, expects_output_keys, timeout_ms } of entries) {
      assertHandoff();
      const idempotency_key = buildIdempotencyKey({
        recipe_run_id,
        step_id,
        slug: resolved.slug,
        entry,
        input: currentPreapprovalIo() ? { ...callInput, __reviewed_invocation_path: resolved.stepMeta?.invocation_path } : callInput,
      });
      const request: DispatchRequest = {
        recipe_run_id,
        step_id,
        ingredient,
        action,
        args,
        expects_output_keys,
        idempotency_key,
        // A wait carries its own budget, longer than the wait.
        ...(timeout_ms !== undefined ? { timeout_ms }
          : options.defaultTimeoutMs !== undefined ? { timeout_ms: options.defaultTimeoutMs } : {}),
      };

      const scope = currentPreapprovalIo();
      const reviewed = scope ? await scope.prepareDomCommand(resolved, request, entry.index - 1) : undefined;
      assertHandoff();
      const outcome = await dispatcher.dispatch(request, reviewed);
      let outputs = translateDispatchOutcome(outcome, resolved.slug, entry);
      // D-335 slice H — the picture is kept here and the output refers to it.
      if (action === 'screenshot_page') outputs = keepScreenshot(outputs, options.images ?? browserImages, resolved.slug);
      outcomes.push({ entry, action, outputs });
    }

    return assembleStepOutput(outcomes);
  };
};

/** D-335 slice N — why a write that picks a suggestion cannot run in a reviewed run (D-261). */
export const PICK_NOT_REVIEWABLE_MESSAGE =
  'A write that picks a suggestion cannot be reviewed before it runs: which one it clicks is known only once they show.';
const pickNotReviewable = (): IngredientError => new IngredientError('ROLE_RESTRICTION', PICK_NOT_REVIEWABLE_MESSAGE,
  { slug: CORE_DOM_WRITE_SLUG });

/** D-335 slice J — why a sequence cannot run in a reviewed run (D-261), which prepares every
 *  command it will send before it starts: a sequence decides each once the last has answered. */
const sequenceNotReviewable = (): IngredientError => new IngredientError('ROLE_RESTRICTION',
  'core.dom.act cannot run in a reviewed run: its steps are sent one at a time, as each is reached',
  { slug: CORE_DOM_ACT_SLUG });

/** D-335 slice J (2026-11-04) — a `core.dom.act`: its steps, in order, each through the Bridge's
 *  own action (`fill`, `click`, `submit`, `wait_for_element`) with its own idempotency cell, so a
 *  retried run replays what was done rather than doing it again. After each step Recued checks:
 *  a typed value must be in its field (the Bridge confirms it), a page that then shows a CAPTCHA
 *  nobody has solved stops the sequence, and a sent form must move the page on unless the step's
 *  `success_when` says what to look for instead. The first step that fails, or whose check does
 *  not hold, ends it with an error saying how far it got and where the tab is: DOM_CHECK_FAILED
 *  for a check, the step's own code for a step. A sequence that runs through answers
 *  `{ done, of, steps, page, url, title }`.
 *
 *  Slice K — failure as it happens. A click or a send asks the Bridge to watch, alongside the
 *  page moving, for the step's `fail_when` and for an error message the step led to
 *  (`page-problems.ts`), and a wait for what `success_when` says shows races both. What decides,
 *  in order: a CAPTCHA; the step's `fail_when`; the step's `success_when`, when it holds; an error
 *  message, quoted; then whether the step did what its checks say. A click on a form's send button
 *  counts as sending it (`sent`), so it is checked as a sent form is.
 *
 *  ⚠ A step after one that loaded a new page cannot use a ref: refs belong to the page the model
 *  inspected. It is refused before it is sent, naming the step that moved the page; a step by
 *  selector goes on, on the new page. */
const runBrowserActSteps = async ({ resolved, dispatcher, manifest, assertHandoff, defaultTimeoutMs }: {
  resolved: ResolvedCall;
  dispatcher: BridgeDispatcher;
  manifest: IngredientManifest;
  assertHandoff: () => void;
  defaultTimeoutMs?: number;
}): Promise<Record<string, unknown>> => {
  const slug = CORE_DOM_ACT_SLUG;
  const target = reqDomArg(resolved.input, 'target', slug);
  let page = reqDomArg(resolved.input, 'page', slug);
  const parsed = parseBrowserActSteps(resolved.input.steps);
  if (!parsed.ok) throw new IngredientError('DOM_SELECTOR_MISSING', `core.dom.act: ${parsed.error}`, { slug });
  if (currentPreapprovalIo()) throw sequenceNotReviewable();
  const steps = parsed.steps;
  const ingredient = buildIngredientRef(manifest, [target]);
  const recipe_run_id = buildRecipeRunId(resolved);
  const step_id = resolved.stepMeta?.step_id ?? slug;
  let url: string | undefined;
  let title: string | undefined;
  /** The step that loaded a new page, after which a ref names nothing. */
  let movedAt: number | undefined;
  /** A page that started loading and was never answered: still loading at the end of the
   *  Bridge's wait, or on a site the owner listed. Nothing more can be done on it. */
  let unanswered = false;
  /** Slice K — whether the page's messages were noted before a click or a send on this same
   *  page, so a later wait can tell an error message the steps led to from one already there. */
  let noted = false;
  const done: string[] = [];
  const trimmed = (message: string) => message.trim().replace(/\.$/, '');

  const signal = currentRunAbortContext()?.signal;
  const send = async (n: number, phase: number, action: BridgeAction, args: Record<string, unknown>,
    label: string, timeout_ms?: number): Promise<Record<string, unknown>> => {
    // A run stopped between two steps sends nothing more.
    signal?.throwIfAborted();
    assertHandoff();
    const entry: DomEntry = { selector: label, marker: action, index: n * 10 + phase, action };
    const request: DispatchRequest = {
      recipe_run_id,
      step_id,
      ingredient,
      action,
      args,
      expects_output_keys: expectsKeysForAction(action),
      idempotency_key: buildIdempotencyKey({ recipe_run_id, step_id, slug, entry,
        input: { __core_dom_target: target, ...args } }),
      ...(timeout_ms !== undefined ? { timeout_ms } : defaultTimeoutMs !== undefined ? { timeout_ms: defaultTimeoutMs } : {}),
    };
    const outputs = translateDispatchOutcome(await dispatcher.dispatch(request), slug, entry) ?? {};
    if (typeof outputs.page === 'string') page = outputs.page;
    if (typeof outputs.url === 'string') url = outputs.url;
    if (typeof outputs.title === 'string') title = outputs.title;
    return outputs;
  };
  const stop = (n: number, reason: string, code: IngredientError['code'] = 'DOM_CHECK_FAILED'): never => {
    const sofar = done.length === 0 ? 'Nothing was done.'
      : `Done: ${done.map((line, i) => `${i + 1}. ${line}`).join('; ')}.`;
    const where = unanswered ? 'The tab was loading a new page.'
      : title !== undefined && url !== undefined ? `The tab shows “${title}” (${url}), page ${page}.`
        : `The tab's page is ${page}.`;
    throw new IngredientError(code, `Stopped at step ${n} of ${steps.length}: ${reason}. ${sofar} ${where}`,
      { slug, step: n, done: done.length, page });
  };
  /** A step's own failure, as the sequence reports it. */
  const failed = (n: number, error: unknown): never => {
    if (error instanceof IngredientError) return stop(n, trimmed(error.message), error.code);
    throw error;
  };
  /** Slice K — the step's `fail_when` on the page, as the Bridge watches for it. */
  const failOnPage = (fail: BrowserActFailure | undefined): { selector: string; text?: string } | undefined =>
    fail === undefined || (fail.shows === undefined && fail.text === undefined) ? undefined
      : { selector: fail.shows ?? 'body', ...(fail.text !== undefined ? { text: fail.text } : {}) };
  /** What the step's `fail_when` saw, in the stop's words. */
  const failSaw = (fail: BrowserActFailure, problem: unknown): string => {
    const saw = fail.shows !== undefined
      ? `“${fail.shows}”${fail.text !== undefined ? ` holding “${fail.text}”` : ''} shows`
      : `the text “${fail.text!}” shows`;
    return `the step's fail_when holds: ${saw}${typeof problem === 'string' ? `, and the page says “${problem}”` : ''}`;
  };
  const problemSaid = (problem: string) => `the page shows an error message: “${problem}”`;
  const checkFailUrl = (n: number, fail: BrowserActFailure | undefined) => {
    if (fail?.url_includes !== undefined && url !== undefined && url.includes(fail.url_includes)) {
      stop(n, `the step's fail_when holds: the address is ${url}, which contains “${fail.url_includes}”`);
    }
  };
  /** Waits in the page until `selector` shows (or goes), holding `text` when given; with `fail`, as
   *  long as that does not show first, and with `problems`, as long as no error message does. */
  const waitFor = async (n: number, phase: number, check: { selector: string; until: 'shown' | 'gone'; text?: string },
    seconds: number, fail: { selector: string; text?: string } | undefined, problems: boolean,
  ): Promise<Record<string, unknown>> => send(n, phase, 'wait_for_element',
    { page, selector: check.selector, until: check.until, ...(check.text !== undefined ? { text: check.text } : {}),
      timeout_ms: seconds * 1000, ...(fail !== undefined ? { fail } : {}), ...(problems ? { problems: true } : {}) },
    check.selector, Math.min(BRIDGE_COMMAND_MAX_TIMEOUT_MS, seconds * 1000 + 10_000)).catch((error: unknown) => failed(n, error));
  const waitedFor = (check: { selector: string; until: 'shown' | 'gone'; text?: string }, seconds: number) =>
    `within ${seconds} seconds “${check.selector}”${check.text !== undefined ? ` holding “${check.text}”` : ''} `
      + `did not ${check.until === 'gone' ? 'go' : 'show'}`;

  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    if (step.do === 'wait') {
      if (step.selector === undefined) {
        // A pause a stopped run cuts short.
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          const stopped = () => { clearTimeout(timer); reject(signal!.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', stopped); resolve(); }, step.seconds! * 1000);
          signal?.addEventListener('abort', stopped, { once: true });
        });
        done.push(`waited ${step.seconds} s`);
        continue;
      }
      const seconds = browserActStepCheckSeconds(step);
      const check = { selector: step.selector, until: step.until ?? 'shown' as const,
        ...(step.text !== undefined ? { text: step.text } : {}) };
      const out = await waitFor(n, 0, check, seconds, failOnPage(step.fail_when), noted);
      if (out.failed === true) stop(n, failSaw(step.fail_when!, out.problem));
      checkFailUrl(n, step.fail_when);
      if (out.found !== true) stop(n, typeof out.problem === 'string' ? problemSaid(out.problem) : waitedFor(check, seconds));
      done.push(`waited for “${step.selector}” to ${check.until === 'gone' ? 'go' : 'show'}`);
      continue;
    }

    const what = step.ref ?? `“${step.selector!}”`;
    if (step.ref !== undefined && movedAt !== undefined) {
      stop(n, `it names ${step.ref}, a ref from the page before step ${movedAt} loaded a new one: inspect the page it `
        + 'loaded to name its elements', 'DOM_SELECTOR_NOT_FOUND');
    }
    const sends = browserActStepSubmits(step);
    // Slice L — typing that picks one of the field's suggestions: the Bridge types, waits for it,
    // clicks it and checks the field took it, as one action; a send the step asks for comes after.
    const picks = step.do === 'type' && step.pick !== undefined;
    const action: BridgeAction = picks ? 'pick' : sends ? 'submit' : step.do === 'click' ? 'click' : 'fill';
    const success = step.success_when;
    const fail = action === 'fill' || action === 'pick' ? undefined : failOnPage(step.fail_when);
    // How long a click or a sent form watches for the page to move on, when its checks need it;
    // and (slice K) a click with no success_when watches as a send does if it turns out to send.
    const watch = browserActStepWatchSeconds(step);
    const sendWatch = action === 'click' && success === undefined ? browserActStepCheckSeconds(step) : undefined;
    const before = page;
    const element = step.ref !== undefined ? { ref: step.ref } : { selector: step.selector! };
    let out = await send(n, 0, action, {
      page,
      ...element,
      ...(step.do === 'type' ? { value: step.value } : {}),
      ...(picks ? { pick: step.pick, pick_ms: BROWSER_ACT_PICK_SECONDS * 1000 }
        : { ...(watch !== undefined ? { watch_ms: watch * 1000 } : {}),
          ...(sendWatch !== undefined ? { send_watch_ms: sendWatch * 1000 } : {}),
          ...(fail !== undefined ? { fail } : {}) }),
    }, step.ref ?? step.selector!, picks ? PICK_COMMAND_TIMEOUT_MS : undefined).catch((error: unknown) => failed(n, error));
    const picked = picks ? `picked “${typeof out.picked === 'string' ? out.picked : step.pick!}”` : '';
    // A pick whose suggestion loaded a new page has gone where the form would have: nothing is sent.
    const pickMoved = picks && (out.moved === true || page !== before);
    if (picks && sends && !pickMoved) {
      const sendFail = failOnPage(step.fail_when);
      const after = await send(n, 2, 'submit', { page, ...element,
        ...(watch !== undefined ? { watch_ms: watch * 1000 } : {}),
        ...(sendFail !== undefined ? { fail: sendFail } : {}) }, step.ref ?? step.selector!)
        .catch((error: unknown) => failed(n, error));
      out = { ...out, ...after };
    }
    const sent = (sends && !pickMoved) || out.sent === true;
    done.push(step.do === 'type'
      ? `typed into ${what}${picks ? (sends && !pickMoved ? `, ${picked} and sent its form` : ` and ${picked}`
        + (sends ? ', which loaded a new page, so its form was not sent' : '')) : sends ? ' and sent its form' : ''}`
      : step.do === 'click' ? `clicked ${what}${out.sent === true ? ', which sent its form' : ''}`
        : `sent the form ${what} is in`);
    if (page !== before) movedAt = n;
    const moved = out.moved === true || page !== before;
    if (out.moved === true && typeof out.page !== 'string') {
      unanswered = true;
      movedAt = n;
    }
    // Messages noted before this click or send are this page's while it stays. A pick notes none;
    // the send after it does.
    if (action === 'pick') noted = sent && page === before && !unanswered;
    else if (action !== 'fill') noted = page === before && !unanswered;

    // What decides: a CAPTCHA, the step's fail_when, its success_when when it holds, an error
    // message, then whether the step did what its checks say.
    if (typeof out.challenge === 'string') {
      stop(n, `the page now shows a ${out.challenge} CAPTCHA that nobody has solved: the owner can solve it in `
        + 'their browser, then ask again');
    }
    if (out.failed === true) stop(n, failSaw(step.fail_when!, out.problem));
    checkFailUrl(n, step.fail_when);
    const pageOk = success?.page_changes === undefined || success.page_changes === moved;
    const urlOk = success?.url_includes === undefined || (url ?? '').includes(success.url_includes);
    const succeeded = success !== undefined && !browserActWaitsForElement(success) && pageOk && urlOk;
    if (typeof out.problem === 'string' && !succeeded) stop(n, problemSaid(out.problem));
    if (success === undefined && sent && !moved) {
      stop(n, `${out.sent === true ? 'the click sent its form' : 'the form was sent'}, but within `
        + `${watch ?? sendWatch ?? BROWSER_ACT_CHECK_SECONDS} seconds the page did not move on: it may be showing an `
        + 'error, so inspect it. For a form that answers where it is, give the step a success_when, such as '
        + '{ "shows": "…" }');
    }
    if (!pageOk) {
      stop(n, success!.page_changes ? `within ${watch ?? BROWSER_ACT_CHECK_SECONDS} seconds the page did not move on, and `
        + 'the step expected it to' : 'the page moved on, and the step expected it to stay');
    }
    if (unanswered) {
      // The page it loaded cannot be read: fine at the end, and nothing after it can be done.
      const reads = success !== undefined && (success.url_includes !== undefined || browserActWaitsForElement(success));
      if (n < steps.length || reads) {
        stop(n, `the page started loading and was not ready within ${BRIDGE_CLICK_LOAD_MAX_MS / 1000} seconds, so `
          + `${reads ? 'its check' : 'the next step'} could not be done: list the tabs for its page handle, then inspect it`);
      }
      continue;
    }
    if (!urlOk) stop(n, `the address is ${url ?? 'unknown'}, which does not contain “${success!.url_includes}”`);
    if (!browserActWaitsForElement(success)) continue;
    // The step's own check, racing its failure and (after a click or a send) an error message.
    const seconds = browserActStepCheckSeconds(step);
    const check = success!.shows === undefined && success!.gone === undefined
      ? { selector: 'body', until: 'shown' as const, text: success!.text! }
      : { selector: success!.gone ?? success!.shows!, until: success!.gone !== undefined ? 'gone' as const : 'shown' as const,
        ...(success!.text !== undefined ? { text: success!.text } : {}) };
    const checked = await waitFor(n, 1, check, seconds, failOnPage(step.fail_when), action !== 'fill' && noted);
    if (checked.failed === true) stop(n, failSaw(step.fail_when!, checked.problem));
    if (checked.found !== true) {
      stop(n, typeof checked.problem === 'string' ? problemSaid(checked.problem)
        : check.selector === 'body' ? `within ${seconds} seconds the text “${check.text!}” did not show` : waitedFor(check, seconds));
    }
  }
  // A page still loading at the end has no handle yet: the model lists the tabs for it.
  return { done: done.length, of: steps.length, steps: done, ...(unanswered ? {} : { page,
    ...(url !== undefined ? { url } : {}), ...(title !== undefined ? { title } : {}) }) };
};

/** The host a URL or a match pattern names: `*://mail.google.com/*` →
 *  `mail.google.com`. Empty for a pattern on every host (the Browser
 *  Toolkit's), which names no site. */
const siteOf = (urlOrPattern: string): string => {
  const match = /^[\w*+.-]+:\/\/([^/]+)/.exec(urlOrPattern);
  if (!match) return urlOrPattern;
  return match[1] === '*' ? '' : match[1]!.replace(/^\*\./, '');
};

/** How long a hold waits for the Bridge to describe its element. The ask goes
 *  out after it, so a Bridge that does not answer costs this much, once. */
export const HELD_BROWSER_DESCRIBE_TIMEOUT_MS = 3_000;

/** D-335 slice B — the element a held `core.dom.write` or `core.dom.click`
 *  acts on, read live from the Bridge (`describe`) while the run is held, so
 *  the owner approves what the page shows rather than what a model called it.
 *  Undefined for any other call. Never throws: a Bridge that cannot be asked,
 *  or does not answer within `timeoutMs`, gives `unread` with the reason, and
 *  the ask says so. */
export const describeHeldBrowserTarget = async (options: {
  dispatcher: BridgeDispatcher | undefined;
  manifests: DomBridgeManifestSource;
  slug: string | undefined;
  input: unknown;
  run_id: string;
  step_id: string;
  timeoutMs?: number;
}): Promise<HeldBrowserTarget | undefined> => {
  const { slug, input } = options;
  if (slug === CORE_DOM_ACT_SLUG) return describeHeldBrowserSteps(options);
  if ((slug !== CORE_DOM_WRITE_SLUG && slug !== CORE_DOM_CLICK_SLUG)
    || input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const manifest = options.manifests.get(slug);
  if (!manifest) return undefined;
  let call: ReturnType<typeof describeBridgeDomCall>;
  try {
    call = describeBridgeDomCall(manifest, { slug, input: input as Record<string, unknown>, output: {} });
  } catch {
    return undefined;
  }
  const target = call.ingredient.domain_allowlist[0] ?? '';
  const first = call.entries[0];
  if (first === undefined) return undefined;
  const site = siteOf(target);
  if (!options.dispatcher) return { site, unread: 'no Browser Bridge is connected' };
  // The element the write names, without the text it would type or the suggestion it would pick.
  const { value: _value, pick: _pick, pick_ms: _pickMs, ...element } = first.args;
  const timeoutMs = options.timeoutMs ?? HELD_BROWSER_DESCRIBE_TIMEOUT_MS;
  const request: DispatchRequest = {
    recipe_run_id: options.run_id,
    step_id: `${options.step_id}:describe`,
    ingredient: call.ingredient,
    action: 'describe',
    args: element,
    expects_output_keys: [...BRIDGE_DESCRIBE_OUTPUT_KEYS],
    // A read for this ask only: never a replay of an earlier one.
    idempotency_key: `${options.run_id}:describe:${randomUUID()}`,
    timeout_ms: timeoutMs,
    target_domain_pattern: target,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>(resolve => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
    timer.unref?.();
  });
  let outcome: DispatchOutcome | 'late';
  try {
    outcome = await Promise.race([options.dispatcher.dispatch(request), late]);
  } catch {
    return { site, unread: 'the Browser Bridge could not be asked' };
  } finally {
    clearTimeout(timer);
  }
  if (outcome === 'late' || outcome.kind === 'timeout') return { site, unread: 'the Browser Bridge did not answer in time' };
  if (outcome.kind !== 'completed') {
    return { site, unread: outcome.kind === 'capacity_gap' && outcome.reason === 'bridge_update_required'
      ? 'the Browser Bridge needs an update to show it'
      : outcome.kind === 'capacity_gap' && outcome.reason === 'site_not_granted'
        ? 'the Browser Bridge is not allowed on that site' : 'no Browser Bridge can reach that page' };
  }
  const out = outcome.result.outputs;
  if (outcome.result.status !== 'ok' || !out || typeof out.url !== 'string' || typeof out.title !== 'string'
    || typeof out.role !== 'string' || typeof out.label !== 'string' || typeof out.protected !== 'boolean') {
    // 2026-11-04 — a page or an element the Bridge says will never read again: no answer to
    // the ask could make the write work, so it fails instead (`BrowserTargetHooks`).
    const gone = outcome.result.status === 'error' && isBridgeTargetGone(outcome.result.error);
    return { site, unread: outcome.result.error?.message ?? 'the Browser Bridge could not read it',
      ...(gone ? { gone: true as const } : {}) };
  }
  // Slice F — the page's origin too, which a pass on this site names.
  const origin = browserPassSiteOf(out.url);
  return {
    site: siteOf(out.url), title: out.title, role: out.role, label: out.label, protected: out.protected,
    ...(origin !== undefined ? { origin } : {}),
  };
};

/** D-335 slice J — what a held sequence acts on: each element it names, read live as a held click
 *  or typing is (`describeHeldBrowserTarget`), in order, a wait naming none. The target is the
 *  page, from the first element read; the first element the Bridge found gone makes the whole
 *  read `gone`, naming the step, so the sequence fails rather than being asked.
 *
 *  ⛔ Only the page as it is now can be read. After a click or a sent form, which may load a new
 *  page, a step named by selector acts on whatever that page has, so it is not read here: read on
 *  this page, the ask could name another element than the one it acts on, and show the password
 *  a sign-in's second page takes as text typed into the first page's box. A step by ref is read:
 *  a ref names an element of this page, and the run refuses one once the page has moved. */
const describeHeldBrowserSteps = async (options: {
  dispatcher: BridgeDispatcher | undefined;
  manifests: DomBridgeManifestSource;
  input: unknown;
  run_id: string;
  step_id: string;
  timeoutMs?: number;
}): Promise<HeldBrowserTarget | undefined> => {
  const input = options.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const call = input as Record<string, unknown>;
  const parsed = parseBrowserActSteps(call.steps);
  if (!parsed.ok || typeof call.target !== 'string' || typeof call.page !== 'string') return undefined;
  // What each step's element is, in order: read on this page, or not before the page it is on.
  let mayMove: number | undefined;
  const planned = parsed.steps.map((step, index): HeldBrowserStep | { read: Record<string, string> } => {
    if (step.do === 'wait') return { wait: true };
    // The first step that may load a new page.
    if (browserActStepMayMove(step)) mayMove ??= index + 1;
    if (step.selector !== undefined && mayMove !== undefined && mayMove <= index) {
      return { unread: `it is on the page as step ${mayMove} leaves it, which cannot be read before then` };
    }
    return { read: step.ref !== undefined ? { ref: step.ref } : { selector: step.selector! } };
  });
  // All read at once, as a held click by ref or selector is: a Bridge that does not answer costs
  // one wait, not one a step.
  const reads = await Promise.all(planned.map((plan, index) => ('read' in plan
    ? describeHeldBrowserTarget({ ...options, slug: CORE_DOM_CLICK_SLUG,
      input: { target: call.target, page: call.page, ...plan.read }, step_id: `${options.step_id}:${index + 1}` })
    : plan)));
  const steps: HeldBrowserStep[] = [];
  let page: Exclude<HeldBrowserTarget, { unread: string }> | undefined;
  let unread: string | undefined;
  for (const [index, read] of reads.entries()) {
    if (read === undefined) return undefined;
    if ('wait' in read || !('site' in read)) {
      steps.push(read);
      continue;
    }
    if ('unread' in read) {
      if (read.gone === true) return { site: read.site, unread: `Step ${index + 1}: ${read.unread}`, gone: true };
      unread ??= read.unread;
      steps.push({ unread: read.unread });
      continue;
    }
    page ??= read;
    steps.push({ role: read.role, label: read.label, protected: read.protected });
  }
  if (page !== undefined) return { ...page, steps };
  return { site: siteOf(call.target), unread: unread ?? 'nothing on the page was read', steps };
};

/** 2026-11-04 — the error a held browser write fails with, instead of being asked, when its
 *  hold's read found its page or its element gone for good (`gone`). It is the one the write
 *  would fail with once approved (`translateDispatchOutcome`), so the model reads the same
 *  words either way. Undefined for any other read, which leaves the ask.
 *
 *  Slice J — and a sequence whose steps cannot run (`parseBrowserActSteps`), with the error the
 *  run would fail with: its ask could list no steps, and an approval could only end there. */
export const heldBrowserTargetRefusal = (
  slug: string,
  target: HeldBrowserTarget | undefined,
  input?: unknown,
): IngredientError | undefined => {
  if (stripCorePrefix(slug) === CORE_DOM_ACT_SLUG) {
    const steps = input !== null && typeof input === 'object' ? (input as Record<string, unknown>).steps : undefined;
    const parsed = parseBrowserActSteps(steps);
    if (!parsed.ok) {
      return new IngredientError('DOM_SELECTOR_MISSING', `core.dom.act: ${parsed.error}`, { slug, refused_before_asking: true });
    }
  }
  return target !== undefined && 'unread' in target && target.gone === true
    ? new IngredientError(mapBridgeErrorCode('selector_not_found'), target.unread,
      { slug, bridge_error_code: 'selector_not_found', refused_before_asking: true })
    : undefined;
};

/** D-335 slice B — how a held browser call's arguments read on the approval's
 *  rows: the page handle as the page's title and site, the ref or selector as
 *  the element, and the text for a password, sign-in code or card field as
 *  not shown. Undefined when the element could not be read. */
export const heldBrowserValueLabels = (
  target: HeldBrowserTarget | undefined,
  input: unknown,
): ApprovalValueLabels | undefined => {
  if (target === undefined || 'unread' in target || input === null || typeof input !== 'object') return undefined;
  const args = input as Record<string, unknown>;
  const labels: Record<string, Record<string, string>> = {};
  const element = target.label !== '' ? `${target.role} “${target.label}”` : target.role;
  if (typeof args.page === 'string') labels.page = { [args.page]: target.title !== '' ? `“${target.title}” (${target.site})` : target.site };
  if (typeof args.ref === 'string') labels.ref = { [args.ref]: element };
  if (typeof args.selector === 'string') labels.selector = { [args.selector]: element };
  if (target.protected && typeof args.value === 'string') labels.value = { [args.value]: 'Not shown: the field is for a password, a sign-in code or a card' };
  return Object.keys(labels).length > 0 ? labels : undefined;
};

/** Classify a single output entry into the BridgeAction the bridge SW
 *  executes for it. Pure — no input lookups. Trigger entries are
 *  filtered upstream and never reach this helper. */
export const classifyEntryAction = (entry: DomEntry): BridgeAction => {
  if (entry.action !== undefined) return entry.action;
  if (entry.marker.startsWith(DOM_WRITE_PREFIX)) return 'fill';
  if (entry.marker === DOM_CLICK_MARKER || entry.marker === DOM_ENTER_MARKER) return 'click';
  return 'read_dom';
};

/** Step-level action precedence preserved for diagnostic / approval
 *  surfaces that want a single category for the whole DOM step (audit
 *  copy, capacity-gap remediation strings). The runner itself dispatches
 *  per-entry — this helper is a separate read for callers that need a
 *  representative action. Precedence is conservative: any write
 *  promotes the whole step to `'fill'`. */
export const classifyDomAction = (
  output: Record<string, string>,
): BridgeAction => {
  let hasFill = false;
  let hasClickOrEnter = false;
  for (const value of Object.values(output)) {
    if (value === DOM_TRIGGER_MARKER) continue;
    if (typeof value === 'string' && value.startsWith(DOM_WRITE_PREFIX)) {
      hasFill = true;
      continue;
    }
    if (value === DOM_CLICK_MARKER || value === DOM_ENTER_MARKER) {
      hasClickOrEnter = true;
      continue;
    }
  }
  if (hasFill) return 'fill';
  if (hasClickOrEnter) return 'click';
  return 'read_dom';
};

/** Iterate the output map, dropping `'trigger'` entries + assigning
 *  stable index numbers for idempotency-key disambiguation. Object.entries
 *  preserves insertion order in modern JS engines, so the index is
 *  deterministic per call across retries with the same manifest. */
const collectEntries = (output: Record<string, string>): DomEntry[] => {
  const out: DomEntry[] = [];
  let index = 0;
  for (const [selector, marker] of Object.entries(output)) {
    if (marker === DOM_TRIGGER_MARKER) continue;
    if (typeof marker !== 'string' || marker.length === 0) continue;
    if (selector.length === 0) continue;
    index++;
    out.push({ selector, marker, index });
  }
  return out;
};

/** Extract URL patterns from the output map. Every entry whose value is
 *  the literal `"trigger"` carries a URL pattern as its key. */
const extractDomainAllowlist = (
  output: Record<string, string>,
): string[] => {
  const out: string[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (value === DOM_TRIGGER_MARKER && key.length > 0) out.push(key);
  }
  return out;
};

/** Closed set of output keys the bridge SW promises for each action.
 *  Threads into `DispatchRequest.expects_output_keys`; bridges that
 *  return out-of-set keys fail their own outbound validation. */
const expectsKeysForAction = (action: BridgeAction): string[] => {
  switch (action) {
    case 'read_dom':
      return ['text'];
    case 'fill':
      // Slice J — and a CAPTCHA the page then shows that nobody has solved.
      return [...BRIDGE_FILL_OUTPUT_KEYS];
    case 'submit':
      return [...BRIDGE_SUBMIT_OUTPUT_KEYS];
    case 'pick':
      // Slice L — the option it clicked, and the page as a click answers it.
      return [...BRIDGE_PICK_OUTPUT_KEYS];
    case 'click':
      // 2026-11-04 — and the page its tab shows once the click settles; an older Bridge answers
      // `clicked` alone, which these allow.
      return [...BRIDGE_CLICK_OUTPUT_KEYS];
    case 'wait_for_selector':
      return ['present'];
    case 'extract_table':
      return ['rows'];
    case 'screenshot':
      return ['data_url'];
    case 'os_notification':
      return ['notification_id'];
    case 'inspect':
      return [...BRIDGE_INSPECT_OUTPUT_KEYS];
    case 'describe':
      return [...BRIDGE_DESCRIBE_OUTPUT_KEYS];
    case 'list_tabs':
      return [...BRIDGE_TABS_OUTPUT_KEYS];
    case 'open_tab':
      return [...BRIDGE_OPEN_OUTPUT_KEYS];
    case 'wait_for_element':
      return [...BRIDGE_WAIT_OUTPUT_KEYS];
    case 'read_table':
      return [...BRIDGE_TABLE_OUTPUT_KEYS];
    case 'screenshot_page':
      return [...BRIDGE_SCREENSHOT_OUTPUT_KEYS];
    default:
      return [];
  }
};

/** Build per-entry `args` matching the bridge SW's flat shape:
 *    read_dom / click → `{ selector }`
 *    fill             → `{ selector, value }` (value pulled from input[<field>])
 *
 *  Missing fill values (`input[field]` is null/undefined) raise
 *  `DOM_WRITE_FAILED` — the recipe declared the write but the resolved
 *  input doesn't carry the value. Matches `executeDOM`'s posture of
 *  failing the whole step when at least one write target failed. */
const buildArgsForEntry = (
  entry: DomEntry,
  action: BridgeAction,
  input: Record<string, unknown>,
  slug: string,
): Record<string, unknown> => {
  // D-335 slice N — the text, and the suggestion to pick once it shows.
  if (action === 'pick') {
    return { ...entry.element, value: String(input[CORE_DOM_VALUE_FIELD]), pick: String(input[CORE_DOM_PICK_FIELD]),
      pick_ms: BROWSER_ACT_PICK_SECONDS * 1000 };
  }
  if (action === 'fill') {
    const field = entry.marker.slice(DOM_WRITE_PREFIX.length);
    const raw = field.length > 0 ? input[field] : undefined;
    if (raw == null) {
      throw new IngredientError(
        'DOM_WRITE_FAILED',
        `DOM ingredient '${slug}' write target '${field}' has no value in step input`,
        { slug, field, selector: entry.selector },
      );
    }
    return { ...(entry.element ?? { selector: entry.selector }), value: String(raw) };
  }
  return entry.element ? { ...entry.element } : { selector: entry.selector };
};

/** D-335 slice G — how the owner allows the Bridge on their sites. */
const ALLOW_EVERY_SITE = 'To allow it, open the Browser Bridge\'s side panel in Chrome and choose “Allow every site”.';

/** What a step no Bridge could take says, in words an AI can pass on: the
 *  Bridge that is missing, or the site it is not allowed on. */
const capacityGapMessage = (outcome: Extract<DispatchOutcome, { kind: 'capacity_gap' }>, action: BridgeAction): string => {
  if (outcome.reason === 'bridge_update_required') return `Update the Browser Bridge: the connected one cannot run '${action}'.`;
  if (outcome.reason === 'site_not_granted') {
    const site = outcome.capacity_gap.kind === 'permission_missing' ? siteOf(outcome.capacity_gap.permission) : '';
    return `${site === '' ? 'The Browser Bridge is not allowed on every site' : `No connected Browser Bridge is allowed on ${site}`}. ${ALLOW_EVERY_SITE}`;
  }
  if (outcome.reason === 'bridge_label_unavailable') return 'The Browser Bridge this step names is not connected to this server.';
  return 'No Browser Bridge is connected to this server: open Chrome with the Recued Browser Bridge paired to it.';
};

/** D-335 slice H — what the Bridges said when none of them could take the
 *  step. A Bridge words the gap it finds for the AI to pass on ("Screenshots
 *  are off: turn on …"), and this line used to drop it for "every paired
 *  bridge reported a capacity gap", so the AI could not say how to fix it.
 *  Bridges that all say the same thing say it once, and Bridges that differ
 *  are named. A Bridge with no label is not named by its token id. The old
 *  line stands when no Bridge said anything. */
const aggregateGapMessage = (
  bridges: Extract<DispatchOutcome, { kind: 'aggregate_capacity_gap' }>['aggregate']['bridges'],
  slug: string,
  selector: string,
): string => {
  const words = bridges.map(bridge => bridge.message?.trim() ?? '');
  if (words.every(word => word === '')) {
    return `DOM ingredient '${slug}' cannot run — every paired bridge reported a capacity gap (selector '${selector}')`;
  }
  if (words.every(word => word === words[0])) return words[0]!;
  return bridges.map((bridge, i) => {
    const who = bridge.bridge_label !== bridge.bridge_id ? `Browser Bridge “${bridge.bridge_label}”` : 'A Browser Bridge';
    const word = words[i] || 'it could not take this step.';
    return `${who}: ${/[.!?]$/.test(word) ? word : `${word}.`}`;
  }).join(' ');
};

/** Map a bridge-side `BridgeErrorCode` to a recipe-error code. Falls
 *  through to `INGREDIENT_ADAPTER_ALL_FAILED` for codes the catalog
 *  doesn't yet enumerate so a new bridge error variant surfaces with a
 *  legible (not undefined-property) diagnostic. */
const mapBridgeErrorCode = (
  code: BridgeResult['error'] extends infer E
    ? E extends { code: infer C }
      ? C
      : never
    : never,
): string => {
  switch (code) {
    case 'selector_not_found':
      return 'DOM_SELECTOR_NOT_FOUND';
    case 'tab_navigation_blocked':
      return 'DOM_CROSS_ORIGIN';
    // The bridge read the element back after the write: a confirmed failure,
    // so the write is retryable rather than an uncertain effect.
    case 'value_not_applied':
      return 'DOM_WRITE_FAILED';
    // A password, sign-in code or card field: this run is not allowed the read.
    case 'field_protected':
      return 'NOT_AUTHORIZED';
    case 'capacity_gap_logged_in':
    case 'capacity_gap_tab_unavailable':
    case 'capacity_gap_permission_missing':
      // Per-bridge capacity gaps only surface inside the dispatcher's
      // single-attempt path (preferred_bridge_label). Multi-bridge
      // fall-through aggregates these and emits aggregate_capacity_gap;
      // this branch is the strict-label-mode passthrough.
      return 'ROLE_RESTRICTION';
    case 'authority_invalid':
    case 'authority_expired':
    case 'authority_invalid_grant_scope':
    case 'ingredient_domain_signature_invalid':
      return 'INGREDIENT_SCOPE_INSUFFICIENT';
    case 'idempotency_violation':
    case 'mv3_lifecycle_killed':
    case 'unknown':
    default:
      return 'INGREDIENT_ADAPTER_ALL_FAILED';
  }
};

/** Build the `BridgeIngredientRef` from a manifest. `version` becomes a
 *  string ("1", "2") matching the spec's per-version domain-grant
 *  model; pre-launch manifests with no `version` default to "1". */
const buildIngredientRef = (
  manifest: IngredientManifest,
  domain_allowlist: string[],
): BridgeIngredientRef => {
  const surface_kind: BridgeSurfaceKind = manifest.surface_kind ?? 'reading';
  return {
    slug: manifest.slug,
    publisher_id: manifest.author,
    version: String(manifest.version ?? 1),
    surface_kind,
    domain_allowlist,
    // Pre-launch: publish-time signing isn't wired yet. The bridge's
    // signature gate no-ops on empty strings during the dev window;
    // post-launch this slot is populated by the marketplace validator.
    domain_allowlist_signature: '',
  };
};

/** Use the host's actual run identity so retries within a run remain stable
 * while separate runs cannot reuse an earlier browser result. Reviewed calls
 * require explicit engine metadata. Ordinary calls may inherit the host's
 * ambient run; callers without either anchor get one fresh identity for the
 * entire adapter invocation, shared by its entries and transport retries. */
const buildRecipeRunId = (resolved: ResolvedCall): string => {
  if (resolved.stepMeta?.run_id) return resolved.stepMeta.run_id;
  if (currentPreapprovalIo()) {
    throw new IngredientError('DOM_WRITE_FAILED', 'The reviewed DOM call has no actual run id.');
  }
  return currentRunAbortContext()?.run_id || randomUUID();
};

/** Build a STABLE idempotency key. Hashed inputs:
 *
 *    - recipe_run_id (host run identity, or fresh for an unanchored invocation)
 *    - step_id
 *    - slug
 *    - entry.index + entry.selector + entry.marker (per-entry uniqueness)
 *    - resolved.input (input value drift = fresh dedup cell)
 *
 *  Two retries of the SAME logical step in the SAME run produce the SAME key →
 *  the bridge's 24h `idempotency_key → result` cache replays the prior
 *  outcome instead of re-executing the side effect. Input drift (page
 *  context changed, retry with new context) yields a fresh dedup cell.
 *
 *  SHA-256 hex → 16-char prefix is collision-safe for the per-bridge
 *  command space (24h sliding window).
 *
 *  Codex 2026-05-28 Angle 3 fold (DOM-runner consumer slice) — replaces
 *  the per-call random nonce that defeated the idempotency contract. */
const buildIdempotencyKey = (input: {
  recipe_run_id: string;
  step_id: string;
  slug: string;
  entry: DomEntry;
  input: Record<string, unknown>;
}): string => {
  const payload = JSON.stringify({
    recipe_run_id: input.recipe_run_id,
    step_id: input.step_id,
    slug: input.slug,
    entry_index: input.entry.index,
    entry_selector: input.entry.selector,
    entry_marker: input.entry.marker,
    input: input.input,
  });
  const digest = createHash('sha256').update(payload).digest('hex');
  return `${input.recipe_run_id}:${input.entry.index}:${digest.slice(0, 16)}`;
};

/** Translate a `DispatchOutcome` to the bridge result's `outputs` block,
 *  or throw an `IngredientError`. Pure — separated so tests can exercise
 *  the mapping table without spinning up a dispatcher.
 *
 *  Codex 2026-05-28 Angle 1 fold (DOM-runner consumer slice):
 *  Both timeout flavors preserve read failures. A write/click timeout cannot
 *  establish whether the page changed, so it reports delivery uncertainty.
 *  Pre-fold the bridge path defaulted to the generic recipe code while
 *  the dispatcher path returned the misleading `DOM_SELECTOR_NOT_FOUND`. */
export const translateDispatchOutcome = (
  outcome: DispatchOutcome,
  slug: string,
  entry: DomEntry,
): Record<string, unknown> | undefined => {
  const action = classifyEntryAction(entry);
  const mayChangePage = !READ_ACTIONS.has(action);
  const timeoutCode = mayChangePage ? 'ACTION_DELIVERY_UNCERTAIN' : 'INGREDIENT_ADAPTER_ALL_FAILED';
  const timeoutAdvice = mayChangePage ? ' The page may have changed; check it before retrying.' : '';
  if (outcome.kind === 'completed') {
    const { result } = outcome;
    if (result.error?.code === 'delivery_uncertain' || (mayChangePage && result.error?.code === 'mv3_lifecycle_killed')) {
      throw new IngredientError('ACTION_DELIVERY_UNCERTAIN', result.error.message, {
        slug, bridge_client_token_id: outcome.bridge_client_token_id, selector: entry.selector,
        bridge_error_code: result.error.code, ...(result.error.detail ? { detail: result.error.detail } : {}),
      });
    }
    if (result.status === 'ok') {
      return result.outputs ?? {};
    }
    if (result.status === 'cancelled') {
      throw new IngredientError(
        mayChangePage ? 'ACTION_DELIVERY_UNCERTAIN' : 'ROLE_RESTRICTION',
        `DOM ingredient '${slug}' was cancelled by the bridge (selector '${entry.selector}').${timeoutAdvice}`,
        {
          slug,
          status: result.status,
          bridge_client_token_id: outcome.bridge_client_token_id,
          selector: entry.selector,
        },
      );
    }
    if (result.status === 'rejected') {
      // The Bridge checks Chrome's own grant again (slice G): it was taken
      // back, or the server's copy of it was stale.
      throw new IngredientError(
        'INGREDIENT_SCOPE_INSUFFICIENT',
        `The Browser Bridge refused this step: it is not allowed on this site. ${ALLOW_EVERY_SITE}`,
        {
          slug,
          bridge_client_token_id: outcome.bridge_client_token_id,
          selector: entry.selector,
        },
      );
    }
    if (result.status === 'timeout') {
      throw new IngredientError(
        timeoutCode,
        `DOM ingredient '${slug}' timed out at the bridge (selector '${entry.selector}').${timeoutAdvice}`,
        {
          slug,
          bridge_client_token_id: outcome.bridge_client_token_id,
          selector: entry.selector,
          ...(result.error?.code ? { bridge_error_code: result.error.code } : {}),
        },
      );
    }
    // status: 'error'
    const code = result.error?.code;
    const recipe_code = code ? mapBridgeErrorCode(code) : 'INGREDIENT_ADAPTER_ALL_FAILED';
    throw new IngredientError(
      recipe_code,
      result.error?.message ?? `DOM ingredient '${slug}' bridge error (selector '${entry.selector}')`,
      {
        slug,
        bridge_client_token_id: outcome.bridge_client_token_id,
        selector: entry.selector,
        bridge_error_code: code,
        ...(result.error?.detail ? { detail: result.error.detail } : {}),
      },
    );
  }
  if (outcome.kind === 'capacity_gap') {
    throw new IngredientError(
      'ROLE_RESTRICTION',
      capacityGapMessage(outcome, action),
      {
        slug,
        reason: outcome.reason,
        capacity_gap: outcome.capacity_gap,
        selector: entry.selector,
      },
    );
  }
  if (outcome.kind === 'aggregate_capacity_gap') {
    throw new IngredientError(
      'ROLE_RESTRICTION',
      aggregateGapMessage(outcome.aggregate.bridges, slug, entry.selector),
      {
        slug,
        selector: entry.selector,
        bridges: outcome.aggregate.bridges.map((b) => ({
          bridge_id: b.bridge_id,
          bridge_label: b.bridge_label,
          gap_reason: b.gap_reason,
        })),
      },
    );
  }
  // outcome.kind === 'timeout' — server-side wait timeout (bridge never
  // returned in time). A successful send admits an effect, so a missing reply
  // must not become a retryable failure for writes and clicks.
  throw new IngredientError(
    timeoutCode,
    `DOM ingredient '${slug}' timed out waiting for the bridge (selector '${entry.selector}').${timeoutAdvice}`,
    {
      slug,
      command_id: outcome.command_id,
      attempts: outcome.attempts,
      selector: entry.selector,
    },
  );
};

/** D-335 slice H — a screenshot as a step's output: the Bridge's picture is put
 *  in the server's store and the output carries a `BrowserImageRef` to it, so no
 *  history, chat or audit row ever holds the picture. A picture this cannot
 *  read is a failed step, never an output with nothing in it. */
const keepScreenshot = (
  outputs: Record<string, unknown> | undefined,
  images: BrowserImageStore,
  slug: string,
): Record<string, unknown> => {
  const { page, url, title, image, mime_type, width, height } = outputs ?? {};
  const side = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= BRIDGE_SCREENSHOT_MAX_EDGE;
  if (typeof image !== 'string' || image.length === 0 || image.length > BRIDGE_SCREENSHOT_MAX_BASE64
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image) || (mime_type !== 'image/jpeg' && mime_type !== 'image/png')
    || !side(width) || !side(height)) {
    throw new IngredientError('INGREDIENT_ADAPTER_ALL_FAILED',
      'core.dom.screenshot: the Browser Bridge answered no picture that could be read', { slug });
  }
  return { page, url, title, width, height, image: images.put({ mime_type, data: image, width, height }) };
};

/** Aggregate per-entry outcomes into the `executeDOM`-shaped step output:
 *
 *    - reads only           → `Record<string, string | null>`
 *    - writes only          → `{ written, fields, failed }`
 *    - clicks only          → `{ clicked: N }`
 *    - any mixed shape      → `{ reads?, writes?, clicked? }`
 *
 *  Mirrors `packages/ingredients/src/dom.ts:executeDOM`'s return shape
 *  so existing recipes that reference `{{step.X.field}}` (reads),
 *  `{{step.X.written}}` (writes), or `{{step.X.clicked}}` (clicks) keep
 *  resolving without recipe changes when their backing manifest's
 *  dispatch flips from the legacy content-script executor to the
 *  bridge runner. */
const assembleStepOutput = (
  outcomes: PerEntryOutcome[],
): unknown => {
  // D-335 — an inspect, a tab list or an opened page is one command, and its
  // answer is the step's output.
  if (outcomes.length === 1 && WHOLE_ANSWER_ACTIONS.has(outcomes[0]!.action)) return outcomes[0]!.outputs ?? {};
  // D-335 slice N — a write that picked a suggestion: what it typed and picked, and the page its tab
  // shows, as a click answers it (a suggestion can be a link).
  if (outcomes.length === 1 && outcomes[0]!.action === 'pick') {
    const out = outcomes[0]!.outputs ?? {};
    const field = outcomes[0]!.entry.marker.slice(DOM_WRITE_PREFIX.length);
    return { written: out.filled === true ? 1 : 0, fields: out.filled === true ? [field] : [], failed: out.filled === true ? [] : [field],
      ...(typeof out.picked === 'string' ? { picked: out.picked } : {}),
      ...(typeof out.page === 'string' ? { page: out.page } : {}), ...(typeof out.url === 'string' ? { url: out.url } : {}),
      ...(typeof out.title === 'string' ? { title: out.title } : {}),
      ...(typeof out.challenge === 'string' ? { challenge: out.challenge } : {}) };
  }
  const reads: Record<string, string | null> = {};
  let readsCount = 0;
  const writtenFields: string[] = [];
  const failedFields: string[] = [];
  let writesCount = 0;
  let clickCount = 0;

  for (const o of outcomes) {
    if (o.action === 'read_dom') {
      const fieldName = o.entry.marker; // value-as-field-name, per CLAUDE.md DOM pattern
      const text = o.outputs && typeof o.outputs.text === 'string'
        ? o.outputs.text
        : null;
      reads[fieldName] = text;
      readsCount++;
      continue;
    }
    if (o.action === 'fill') {
      // marker is `dom.<field>` — recover field name for the
      // executeDOM-shaped writes block.
      const field = o.entry.marker.slice(DOM_WRITE_PREFIX.length);
      const filled = o.outputs && o.outputs.filled === true;
      writesCount++;
      if (filled) writtenFields.push(field);
      else failedFields.push(field);
      continue;
    }
    if (o.action === 'click') {
      const clicked = o.outputs && o.outputs.clicked === true;
      if (clicked) clickCount++;
      continue;
    }
  }
  // D-335 slice J — a CAPTCHA the page shows after a write or a click, which nobody has solved;
  // slice K — and an error message a click led to.
  const challenge = outcomes.map((o) => o.outputs?.challenge).find((value) => typeof value === 'string');
  const problem = outcomes.map((o) => o.outputs?.problem).find((value) => typeof value === 'string');
  const challenged = { ...(typeof challenge === 'string' ? { challenge } : {}), ...(typeof problem === 'string' ? { problem } : {}) };

  // Match executeDOM's return-shape branching exactly so recipes that
  // referenced legacy step outputs don't need to re-author.
  const hasReads = readsCount > 0;
  const hasWrites = writesCount > 0;
  const hasClicks = clickCount > 0;
  const writeResult = hasWrites
    ? { written: writtenFields.length, fields: writtenFields, failed: failedFields }
    : null;

  if (hasReads && !hasWrites && !hasClicks) return reads;
  if (!hasReads && hasWrites && !hasClicks) return { ...writeResult, ...challenged };
  if (!hasReads && !hasWrites && hasClicks) {
    // 2026-11-04 — one click by page handle answers the page its tab then shows, as opening a
    // page does: a new handle when the click loaded a page.
    const landed = outcomes.length === 1 ? outcomes[0]!.outputs : undefined;
    return landed !== undefined && typeof landed.page === 'string' && typeof landed.url === 'string'
      && typeof landed.title === 'string'
      ? { clicked: clickCount, page: landed.page, url: landed.url, title: landed.title, ...challenged }
      : { clicked: clickCount, ...challenged };
  }

  return {
    ...(hasReads ? { reads } : {}),
    ...(writeResult ? { writes: writeResult } : {}),
    ...(hasClicks ? { clicked: clickCount } : {}),
  };
};
