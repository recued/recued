/** "Watch this element" — stable CSS selector engine (brick 2).
 *
 *  The element picker overlay (overlay.ts) lets the user point at an
 *  on-page element; this module turns the chosen element into a CSS
 *  selector that (a) uniquely matches it now and (b) is as resilient to
 *  DOM rot / re-render as we can make it without the user editing it.
 *
 *  Stability bias (the hard part the handover flagged):
 *    1. id            — `#id` when the id is a valid, human-looking
 *                        identifier (NOT a framework-generated hash).
 *    2. test/data hook — `tag[data-test-id="…"]` etc. — automation hooks
 *                        are the most stable thing a page exposes.
 *    3. semantic attr  — name / aria-label / role / type / … — describes
 *                        the element by purpose, survives restyling.
 *    4. positional     — `tag:nth-of-type(n)` walked up the ancestor
 *                        chain until unique. The deterministic last
 *                        resort.
 *  Auto-generated ids / classes (emotion `css-1q2w3e`, styled-components
 *  `sc-bdfBwQ`, React `:r0:`, Ember `ember123`, CSS-module `Btn__a1b2`,
 *  uuids, long hashes) are *rejected* — they change on every build /
 *  mount and would silently break the watch. Styling classes are kept
 *  out of the derived selector entirely (a watch should not couple to a
 *  page's CSS); the user can add one back by editing.
 *
 *  Purity: the engine works over the `ElementView` adapter + an injected
 *  `matchCount(selector) => number` probe, so it is fully unit-testable
 *  without a DOM (the bridge runs node-side vitest, no jsdom). The
 *  content script supplies a real-`document`-backed adapter +
 *  `document.querySelectorAll(sel).length` probe; tests supply fakes.
 */

/** A read-only view of a DOM element — the only surface the selector
 *  engine touches. `elementViewFromDom` wraps a real `Element`; tests
 *  build literals. */
export interface ElementView {
  /** Lowercase tag name (e.g. `'div'`). */
  readonly tag: string;
  /** The element's id, or `''` when absent. */
  readonly id: string;
  /** Class tokens, in document order. */
  readonly classes: readonly string[];
  /** `[name, value]` for every attribute EXCEPT id/class/style, names
   *  lowercased, in document order. */
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  /** The parent element view, or `null` at the root. */
  readonly parent: ElementView | null;
  /** 1-based index among same-tag siblings — drives `:nth-of-type(n)`. */
  readonly nthOfType: number;
}

/** Probe: how many elements in the document match `selector`. Returns a
 *  non-negative count, or `-1` when the selector is syntactically
 *  invalid (the engine treats that as "not unique" and keeps walking).
 *  The content script binds this to `document.querySelectorAll`. */
export type MatchCountProbe = (selector: string) => number;

export interface DeriveSelectorOptions {
  /** Ancestor walk cap. A selector this deep is already fragile; past
   *  it we return the best-effort path and let the preview's match count
   *  prompt the user to edit. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;

/** Longest attribute value we will embed in a selector. A long value is
 *  usually descriptive prose (a title / aria-label) that is more likely
 *  to be re-worded than a short identifier — and it bloats the selector. */
const MAX_ATTR_VALUE_LEN = 80;

/** Data/test-hook attributes, most-stable first. These exist precisely
 *  to give automation a durable handle, so they outrank everything. */
const DATA_HOOK_ATTRS: readonly string[] = [
  'data-test-id',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'data-automation-id',
  'data-automationid',
  'data-component',
  'data-tracking-id',
  'data-name',
  'data-id',
  'data-key',
];

/** Semantic identifier attributes — id-like values, so they get the
 *  auto-generated-value filter. The descriptive attrs interleaved into
 *  the precedence list below (aria-label / placeholder / title / alt) are
 *  human text and are length-capped only. */
const SEMANTIC_IDENTIFIER_ATTRS: readonly string[] = ['name', 'role', 'type', 'for'];

/** Attribute precedence for token selection (highest first). */
const ATTR_PRECEDENCE: readonly string[] = [
  ...DATA_HOOK_ATTRS,
  'name',
  'aria-label',
  'role',
  'type',
  'placeholder',
  'title',
  'alt',
  'for',
];

/** Attrs whose values are identifier-like (vs human prose) — only these
 *  are rejected when they look framework-generated. */
const IDENTIFIER_LIKE_SET = new Set([...DATA_HOOK_ATTRS, ...SEMANTIC_IDENTIFIER_ATTRS]);

/** Framework-generated id / class patterns. Anything matching is treated
 *  as volatile and skipped. Kept deliberately conservative so we don't
 *  reject human-authored names. */
const AUTO_GENERATED_PATTERNS: readonly RegExp[] = [
  /:r[0-9a-z]+:/i, // React useId — `:r0:`, `:r1a:`
  /«r[0-9a-z]+»/i, // React useId (older delimiter)
  /^css-[a-z0-9]{4,}$/i, // emotion — `css-1q2w3e`
  /^sc-[a-zA-Z0-9]{4,}/, // styled-components — `sc-bdfBwQ`, `sc-bdfBwQ-0`
  /^ember\d+$/i, // Ember — `ember123`
  /^mui-\d+$/i, // legacy MUI — `mui-42`
  /^radix-/i, // Radix UI — `radix-:r0:`, `radix-123`
  /headlessui-/i, // Headless UI — `headlessui-menu-button-:r1:`
  // CSS-modules `[name]__[hash]` / `[name]___[hash]` tail — the hash is
  // ≥4 chars AND carries a digit (`Btn__a1b2`, `Block__element___2Xyz9`).
  // Requiring a digit avoids false-flagging human BEM names whose
  // `block__element` halves are plain words (`checkout__form`, `nav__item`).
  /_{2,}(?=[a-z0-9]{4,}$)[a-z0-9]*\d[a-z0-9]*$/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, // uuid
  /^[0-9a-f]{8,}$/i, // bare hex hash — `a1b2c3d4`
  /\d{6,}/, // a 6+ digit run — counters / timestamps
];

/** True when `value` looks like a build/render-time hash rather than a
 *  durable, human-chosen identifier. */
export const looksAutoGenerated = (value: string): boolean =>
  AUTO_GENERATED_PATTERNS.some((re) => re.test(value));

/** D-335 slice W — these rules as data, for a function injected into a page, which can import
 *  nothing: `describePageElement` derives the same selector for an element it is about to act on
 *  (`page-inspect.ts`). The patterns travel as their source and flags. */
export interface SelectorRules {
  precedence: readonly string[];
  identifier_like: readonly string[];
  generated: ReadonlyArray<readonly [string, string]>;
  max_value_chars: number;
  max_depth: number;
}
export const SELECTOR_RULES: SelectorRules = {
  precedence: ATTR_PRECEDENCE,
  identifier_like: [...IDENTIFIER_LIKE_SET],
  generated: AUTO_GENERATED_PATTERNS.map((re) => [re.source, re.flags] as const),
  max_value_chars: MAX_ATTR_VALUE_LEN,
  max_depth: DEFAULT_MAX_DEPTH,
};

/** A simple CSS identifier safe to use after `#` / `.` without escaping
 *  (letters, digits, `_`, `-`, not leading with a digit or `--`). */
const SIMPLE_IDENT = /^-?[A-Za-z_][\w-]*$/;

const isSimpleIdent = (value: string): boolean => SIMPLE_IDENT.test(value);

/** Escape a value for embedding inside a `[attr="…"]` selector. */
const escapeAttrValue = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** A value usable inside `[attr="…"]`: single-line, bounded length, and
 *  free of `{{` — a literal `{{` would later be rejected as a template
 *  ref by the dom-watch sugar validator (trigger-sugar.ts), so never let
 *  one into a derived selector. */
const isUsableAttrValue = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_ATTR_VALUE_LEN &&
  !/[\n\r\t]/.test(value) &&
  !value.includes('{{');

/** The id token for an element, or `null` when the id is absent / a
 *  framework hash / unusable. Uses `#id` for a simple identifier and the
 *  `[id="…"]` attribute form otherwise (still id-anchored, just escaped). */
const idToken = (el: ElementView): string | null => {
  const id = el.id;
  if (id.length === 0 || looksAutoGenerated(id) || id.includes('{{')) return null;
  if (isSimpleIdent(id)) return `#${id}`;
  if (!isUsableAttrValue(id)) return null;
  return `${el.tag}[id="${escapeAttrValue(id)}"]`;
};

/** The best attribute token for an element, or `null`. Walks
 *  `ATTR_PRECEDENCE`; skips auto-generated values on identifier-like
 *  attrs; length-caps descriptive ones. */
const attrToken = (el: ElementView): string | null => {
  const present = new Map(el.attributes.map(([n, v]) => [n, v] as const));
  for (const name of ATTR_PRECEDENCE) {
    const value = present.get(name);
    if (value === undefined || !isUsableAttrValue(value)) continue;
    // Identifier-like attrs (data-hooks, name/role/type/for) carry id-ish
    // values, so reject framework hashes; descriptive attrs (aria-label,
    // title, …) are human text and only length-capped (above).
    if (IDENTIFIER_LIKE_SET.has(name) && looksAutoGenerated(value)) continue;
    return `${el.tag}[${name}="${escapeAttrValue(value)}"]`;
  }
  return null;
};

/** The "strong" content-based token for an element — id, then a stable
 *  attribute. `null` when the element exposes no durable handle (we then
 *  fall back to a positional `:nth-of-type` token in the path). */
export const strongToken = (el: ElementView): string | null => idToken(el) ?? attrToken(el);

/** The token used for one hop of the descendant path. Prefers a strong
 *  token (already sibling-unique by construction); otherwise a
 *  positional `tag:nth-of-type(n)` which is guaranteed sibling-unique. */
const pathToken = (el: ElementView): string => strongToken(el) ?? `${el.tag}:nth-of-type(${el.nthOfType})`;

export interface DerivedSelector {
  /** The CSS selector. Always matches the picked element; `unique` says
   *  whether it matches ONLY that element in the probed document. */
  readonly selector: string;
  /** True when the selector matched exactly one element at derive time. */
  readonly unique: boolean;
  /** How the leaf was anchored — surfaced for tests / future UX copy. */
  readonly anchor: 'id' | 'attr' | 'positional';
}

const leafAnchor = (el: ElementView): DerivedSelector['anchor'] => {
  if (idToken(el) !== null) return 'id';
  if (attrToken(el) !== null) return 'attr';
  return 'positional';
};

/** Derive a stable, unique-as-possible CSS selector for `el`.
 *
 *  Strategy: try the element's own strong token globally first (a good
 *  id / data-hook is often unique page-wide → a short, robust selector).
 *  Otherwise build a `>` descendant path from the leaf upward, adding one
 *  ancestor hop at a time and stopping the moment the path matches
 *  exactly one element. Past `maxDepth` we return the best-effort path
 *  (the overlay's live match count tells the user to tighten it). */
export const deriveSelector = (
  el: ElementView,
  matchCount: MatchCountProbe,
  options: DeriveSelectorOptions = {},
): DerivedSelector => {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const anchor = leafAnchor(el);

  // 1. A strong leaf token that is already globally unique wins — no path.
  const strong = strongToken(el);
  if (strong !== null && matchCount(strong) === 1) {
    return { selector: strong, unique: true, anchor };
  }

  // 2. Build the descendant path leaf→root, stopping at uniqueness.
  const parts: string[] = [pathToken(el)];
  {
    const selector = parts.join(' > ');
    if (matchCount(selector) === 1) {
      return { selector, unique: true, anchor };
    }
  }
  let node = el.parent;
  let depth = 0;
  while (node !== null && depth < maxDepth) {
    parts.unshift(pathToken(node));
    const selector = parts.join(' > ');
    if (matchCount(selector) === 1) {
      return { selector, unique: true, anchor };
    }
    node = node.parent;
    depth += 1;
  }

  const selector = parts.join(' > ');
  return { selector, unique: matchCount(selector) === 1, anchor };
};

// ───────────────────────────── real-DOM adapter ────────────────────────────

/** 1-based index of `el` among its same-tag siblings (`:nth-of-type`). */
const computeNthOfType = (el: Element): number => {
  let n = 1;
  let sib = el.previousElementSibling;
  while (sib !== null) {
    if (sib.tagName === el.tagName) n += 1;
    sib = sib.previousElementSibling;
  }
  return n;
};

/** Wrap a live `Element` as an `ElementView`. Parent is resolved lazily
 *  so wrapping a deep element doesn't walk the whole ancestor chain up
 *  front (the engine only climbs as far as it needs for uniqueness). */
export const elementViewFromDom = (el: Element): ElementView => ({
  tag: el.tagName.toLowerCase(),
  id: el.id ?? '',
  classes: Array.from(el.classList),
  attributes: Array.from(el.attributes)
    .filter((a) => a.name !== 'id' && a.name !== 'class' && a.name !== 'style')
    .map((a) => [a.name.toLowerCase(), a.value] as const),
  get parent(): ElementView | null {
    const p = el.parentElement;
    return p !== null ? elementViewFromDom(p) : null;
  },
  nthOfType: computeNthOfType(el),
});
