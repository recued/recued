# UI primitives

Low-level HTML + CSS building blocks shared by every surface of the
extension (options, kitchen, sidebar, install, popup). Each primitive:

1. Exports a **pure function** returning an HTML string.
2. Exports a **`*_STYLES` constant** with its own CSS — scoped by a
   prefixed class (`.rx-btn`, `.rx-section`, …) so nesting never
   collides with ancestor styles.
3. Draws colour from the global CSS custom properties the page shell
   defines (`--accent`, `--fail`, `--ok`, `--fg`, …) with safe fallbacks
   when a token isn't set.

Import from the barrel:

```ts
import { button, section, flashOk, statusDot, code } from '../ui-shared/primitives/index.js';
```

Primitives emit both the scoped class (`.rx-btn`) AND legacy classes
(`.btn .btn-primary`) so they coexist with pre-existing stylesheets
in `public/ui/*.html`. Surfaces migrating off inline markup can adopt
the helpers without touching their CSS.

## Available primitives

| Module | Helpers | CSS export |
|---|---|---|
| `button.ts` | `button({ variant, size, action, label, … })` | `BUTTON_STYLES` |
| `section.ts` | `section({ title, hint, body })`, `subsection({ title, body })` | `SECTION_STYLES` |
| `flash.ts` | `flash`, `flashOk`, `flashError`, `flashWarn` | `FLASH_STYLES` |
| `field.ts` | `formRow`, `textInput`, `select`, `checkbox`, `fieldHint` | `FIELD_STYLES` |
| `status.ts` | `statusDot(tone)`, `badge({ tone, label })` | `STATUS_STYLES` |
| `code.ts` | `code(text)`, `codeBlock(text)` | `CODE_STYLES` |
| `table.ts` | `.rx-table` skeleton + `dataTable({ columns, rows })` helper | `TABLE_STYLES` |
| `action-bar.ts` | `actionBar({ children, align?, bordered?, gap? })` | `ACTION_BAR_STYLES` |
| `message.ts` | `inlineError`, `inlineWarn`, `inlineOk`, `inlineHint` | `MESSAGE_STYLES` |
| `panel.ts` | `panel({ tone, title?, body, compact? })` | `PANEL_STYLES` |

`PRIMITIVE_STYLES` from `styles.ts` aggregates every constant; `options.ts`
injects it into `<head>` on mount via `ensurePrimitiveStyles()`.

## Variants & tones

**Button variants:** `primary` · `secondary` (default) · `danger` ·
`danger-text` · `link` · `oauth`
**Button sizes:** `xs` · `sm` · `md` (default)

**Flash tones:** `ok` · `error` · `warn`

**Inline message tones:** `error` · `warn` · `ok` · `hint`

**Status dot tones:** `ok` / `online` / `active` · `idle` / `configured` ·
`off` / `offline` · `none`

**Badge tones:** `neutral` · `ok` · `idle` · `off` · `accent`

**Panel tones:** `neutral` · `warn` · `danger` (red border + red-tinted bg) ·
`info` (accent border)

> Status colour is monochrome per **D-174 P6** (neutral ramp + one accent + one
> danger): `--ok` / `--warn` / `--success` alias `--fg` and their `-soft`/`-bg`
> variants alias `--surface-sunk`, so `ok` / `idle` / `warn` tones render
> **neutral — not green/amber**. Only `--danger` (and the `accent` / `info`
> tone) carries a hue.

**Action bar alignment:** `start` (default) · `end` · `center` ·
`between`. Add `bordered: true` for a top-border separator.

## Nested-safe by design

Every primitive class is a single token (`.rx-btn`, `.rx-flash-ok`)
with no descendant selectors. That means a button dropped inside a
flash banner inside a section keeps its own background, border and
hover state — the host can't accidentally override them through a
`.parent .child` rule.

Primitives also keep their **legacy class names** (`class="rx-btn btn
btn-primary"`) so they coexist with the existing inline stylesheet in
`public/ui/options.html`. A consumer that only wants the primitive
layer (e.g. a standalone preview page) can rely on `.rx-*` alone.

## Adding a new primitive

1. Create `primitives/<name>.ts` with (a) a typed props interface, (b)
   a render function, and (c) a `<NAME>_STYLES` constant.
2. Scope every rule with the `.rx-<name>` prefix — no descendant
   selectors.
3. Re-export from `primitives/index.ts`.
4. Append the new constant to the list in `primitives/styles.ts`.

That's it — no framework, no build step, no registration. If the CSS
is self-scoped and colour tokens are shared, the primitive slots in
anywhere a feature renderer emits a string.
