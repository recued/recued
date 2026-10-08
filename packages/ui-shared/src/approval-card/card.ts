/** D-169 P2 Slice 3 — shared approval (D-158 `ask`) card.
 *
 *  ONE interactive primitive both the webclient and the bridge side panel
 *  render for a pending D-158 `notification.ask` (I-12 / TR-9 / O-3 — no
 *  per-client copy). It renders the ask's title / body + one button per
 *  option; safe answers fire `onAnswer(optionId)` directly, while an
 *  approving answer on a generated write/admin/destructive ask requires a
 *  deliberate confirmation click. The host owns the
 *  actual submit — the bridge side panel round-trips to its service worker,
 *  which calls the `notification.submitAnswer` rpc; the webclient (a
 *  Slice-3b follow-on) will call the same rpc — and the notification block
 *  dedups first-answer-wins across every surface (D-158 I-6).
 *
 *  ⚠️  Render model — DOM node, not an HTML string. Most `@recued/ui-shared`
 *  primitives return an HTML string wired by `data-action` delegation, but
 *  the bridge side panel (the primary consumer) is a DOM-node builder with
 *  no `innerHTML` and no delegation dispatcher, and an *interactive* card
 *  needs real click handlers. Returning an `HTMLElement` + taking an
 *  `onAnswer` callback fits both consumers (each `appendChild`s the node)
 *  and keeps the click wiring inside the primitive. All user / server
 *  derived text is set via `textContent` — inert, no HTML injection.
 *
 *  ⚠️  Prop is a STRUCTURAL shape, NOT an import of `PendingAsk` from
 *  `@recued/notification` — `@recued/ui-shared` keeps zero dependency on
 *  the notification block. Both the bridge side-panel store row and the
 *  contracts `ServerPendingAsk` wire type satisfy `AskCardModel`
 *  (`AskOption` is just `{ id, label }`).
 *
 *  Spec: D-169 § N.5 #4 / I-11 / I-12 / TR-9. */

import { WRITE_STAYS_IN_RECUED_CLAUSE } from '@recued/contracts';

import { formatClientDateTime } from '../date-time.js';

/** One answer choice — mirrors the D-158 `AskOption` ({ id, label }) and
 *  the `ServerPendingAsk.options[]` wire shape without importing either. */
export interface AskCardOption {
  /** Stable option slug — the value submitted as the answer. */
  id: string;
  /** Human-readable button label. */
  label: string;
}

/** The renderable subset of a pending ask. Satisfied by the bridge
 *  side-panel store's approval row and the contracts `ServerPendingAsk`. */
export interface AskCardModel {
  ask_id: string;
  title?: string;
  text: string;
  options: ReadonlyArray<AskCardOption>;
  /** D-234 § 234.3 — "read the thing this is about", already absolute.
   *  Mirrors `NotificationMessage.link_url` / `ServerPendingAsk.link_url`
   *  without importing either (this shape stays structural). Absent ⇒ no
   *  link element at all. */
  link_url?: string;
  /** D-234 § 234.4e — invite a written reason with the answer. `'required'`
   *  will not submit without one. Absent ⇒ no note field is rendered.
   *  Mirrors `ServerPendingAsk.note_prompt` without importing it. */
  note_prompt?: 'optional' | 'required';
  /** D-234 § 234.4f — the document the answerer reads before deciding. Rendered
   *  COLLAPSED: the question is the decision, the body is the evidence, and a
   *  card that opens four pages by default stops being a card. */
  body?: string;
  /** D-270 — the SERVER-RESOLVED "what will happen" rows, and when present they
   *  REPLACE the scraped highlights rather than sitting beside them.
   *
   *  ⛔⛔ THE CARD HAS ALWAYS SHOWN VALUES — BY REGEX OVER ITS OWN PROSE.
   *  `projectGeneratedApprovalAsk(model.text)` parses the rendered sentence,
   *  keeps at most THREE fields chosen from a hardcoded key list
   *  (`to · subject · title · statement · summary · event.summary · body ·
   *  top_tier_kind`), and buries the rest behind
   *  "The technical bits". So an operation whose decisive field is not on that
   *  list shows none of it in the summary, and every value is whatever the prose
   *  happened to say rather than what the held op currently holds.
   *
   *  🔑 That is the hazard the landing contract names, already happening: two
   *  surfaces deriving the same fact two ways, where *"the one that is wrong is
   *  the one nobody is looking at."* These rows come from the checkpoint through
   *  the operation's pack-declared `editable_args` allowlist — complete, not
   *  capped, and rendered in a NAMED zone for `datetime`.
   *
   *  ⛔ REPLACES, NEVER APPENDS. Two summary blocks on one card is strictly
   *  worse than either alone: the reader cannot tell which is authoritative.
   *
   *  ⛔ Absent ⇒ the card renders exactly as it did before, scraped highlights
   *  and all. An unresolvable case is just an ordinary card — no notice, no empty
   *  block (owner ruling 2026-09-13). And the set is ALL-OR-NOTHING: partial rows
   *  would promise "what this commits to" while hiding a value.
   *
   *  ⚠ THE SCRAPED FIELDS STILL FILL "The technical bits", AND THAT IS A
   *  DELIBERATE TRADE, NOT AN OVERSIGHT. These rows come from the operation's
   *  `editable_args` — the REVIEWABLE fields, which is a narrower set than the
   *  args the call dispatches. Suppressing the technical block when they are
   *  present would hide every non-reviewable argument the card used to show, so
   *  the block stays. The residual cost is that one field can render twice, in
   *  two formats, when it appears in both — the summary row is the authoritative
   *  one (resolved from the held op, in a named zone). Reopen if a real case
   *  shows the two DISAGREEING on a value rather than on formatting.
   *
   *  Mirrors `ServerPendingAsk.details` structurally, like every other field
   *  here. */
  details?: ReadonlyArray<{ label: string; value: string }>;
  /** Unix-ms the ask was raised — `PendingAsk.created_at`, already carried on
   *  `ServerPendingAsk` and forwarded by the `notification.pending_asks`
   *  projection. Rendered as a compact age so a decision that has been waiting
   *  is visibly waiting.
   *
   *  ⛔ THE FIELD WAS ALWAYS ON THE WIRE AND NOTHING READ IT. Every surface
   *  showed a flat list in which an ask raised four days ago is indistinguishable
   *  from one raised four seconds ago, and the only thing that ever resolved an
   *  ignored one was the `preflight.stale_after_days` guard silently reaping it.
   *  Absent ⇒ no age element (a caller that does not carry the field renders
   *  exactly as before). */
  created_at?: number;
}

export interface AskCardHandlers {
  /** Fired with the chosen option's `id` when the user clicks its button.
   *  The host submits the answer via the `notification.submitAnswer` rpc.
   *  MAY be async: while the returned promise is pending the card guards all
   *  options with `aria-disabled` while keeping the chosen option focusable
   *  and visibly busy. On success the host removes the card (the answered ask
   *  drops out of the list). If the promise REJECTS (transient failure / not
   *  paired) the card clears the guard + shows a brief inline error so the
   *  user can retry — the busy state is in-flight-only, never sticky. */
  onAnswer: (optionId: string, note?: string) => void | Promise<void>;
}

/** Optional host-owned async state. A composed queue can rebuild the card
 *  during a submit (for example after a live queue event) without losing the
 *  exact option that owns progress or its failure message. */
export interface AskCardOptions {
  busy?: boolean;
  busyOptionId?: string;
  errorMessage?: string | null;
  /** Clock for the waiting-age label ({@link AskCardModel.created_at}).
   *  Injectable so a test can assert a rendered age deterministically —
   *  asserting against `Date.now()` is how an age test flakes at a boundary. */
  now?: number;
}

/** Stable hook on the card root — the value is the `ask_id` so a host can
 *  query a specific card. */
export const ASK_CARD_ATTR = 'data-recued-ask-card';
/** Stable hook on each option button — the value is the `AskOption.id`. */
export const ASK_CARD_OPTION_ATTR = 'data-recued-ask-option';
/** D-234 § 234.4e — stable hook on the written-reason field; the value is the
 *  `ask_id`, so a test or host can address one card's note box. */
export const ASK_CARD_NOTE_ATTR = 'data-recued-ask-note';
/** D-234 § 234.4f — stable hook on the readable-body disclosure; the value is
 *  the `ask_id`. */
export const ASK_CARD_BODY_ATTR = 'data-recued-ask-body';
/** Stable hook on the inline submit-error line (hidden until a submit fails). */
export const ASK_CARD_ERROR_ATTR = 'data-recued-ask-error';
/** Stable hook on the D-234 § 234.3 "read it" link (absent when unlinked). */
export const ASK_CARD_LINK_ATTR = 'data-recued-ask-link';
/** Concise action/target/highlight projection for generated write asks. */
export const ASK_CARD_SUMMARY_ATTR = 'data-recued-ask-summary';
/** Collapsed technical details for generated write asks. */
export const ASK_CARD_DETAILS_ATTR = 'data-recued-ask-details';
/** Deliberate second-step prompt for an externally mutating answer. */
export const ASK_CARD_CONFIRM_ATTR = 'data-recued-ask-confirm';
/** The waiting-age element on an ask card. */
export const ASK_CARD_AGE_ATTR = 'data-recued-ask-age';

/** Compact waiting age for an approval card — `just now` / `12m` / `3h` /
 *  `4d` / `3w`.
 *
 *  ⚠ NOT `formatRelative` (`@recued/renderer`), deliberately: that one is
 *  DAY-granular and collapses the entire first day to `today`, which is
 *  precisely the range an approvals queue needs resolution in — an ask raised
 *  twenty minutes ago and one raised twenty hours ago are a different decision
 *  and would read identically. It also takes an ISO string where an ask carries
 *  unix-ms. Different input, different granularity requirement.
 *
 *  Clamps a future `created_at` to `just now` rather than rendering a negative
 *  age: a clock skew between server and client is not worth showing the owner
 *  `-3m`, and the ask is real regardless. */
export const formatAskAge = (created_at: number, now: number): string => {
  if (!Number.isFinite(created_at)) return '';
  const ms = now - created_at;
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

/** Treat a blank / whitespace-only title as absent (matches the bridge
 *  side panel's `nonBlankTitle`) so a present-but-empty title doesn't
 *  render a blank heading line. */
const nonBlankAskTitle = (title: string | undefined): string | undefined =>
  title !== undefined && title.trim() !== '' ? title : undefined;

/** Keep compact visible controls distinguishable when several decision cards
 *  share a queue. Prefer the card's human subject; title-less asks fall back
 *  to the first meaningful line of their prompt, then their stable id. */
const askActionSubject = (model: AskCardModel): string => {
  const title = nonBlankAskTitle(model.title);
  if (title !== undefined) return title;
  const firstLine = model.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  return firstLine ?? `request ${model.ask_id}`;
};

const contextualActionLabel = (label: string, subject: string): string =>
  `${label}: ${subject}`;

interface ProjectedApprovalAsk {
  operation: string;
  target: string | null;
  recipe: string;
  step: string;
  reason: string | null;
  /** D-161 Part B — who STARTED the run, present only when it came in through
   *  a door (a public form, or an outside AI). Absent for the owner's own runs,
   *  which is the overwhelmingly common case and must stay silent. */
  origin: string | null;
  fields: ReadonlyArray<{ key: string; value: string }>;
  highlights: ReadonlyArray<{ key: string; value: string }>;
  /** What the action changes, in the composer's words — see
   *  {@link askConsequence}. Null ⇒ the card states no consequence. */
  consequence: string | null;
}

/** The composer's "why it was held" clause — line 2 of a generated ask
 *  (`buildPreflightAsk`): *"Write actions change your data in Recued, so
 *  Recued held it for you."* → *"Write actions change your data in Recued."*
 *
 *  ⛔ THE CARD USED TO HARDCODE "This action changes data outside Recued." on
 *  every projected ask — a second derivation of a fact the composer already
 *  states, and a false one for a booking, a commitment or an event on the local
 *  calendar, none of which leave the server (found on a live drive,
 *  2026-10-07). It was wrong for `destructive` too, which removes data rather
 *  than changing it elsewhere. The card now repeats the composer.
 *
 *  ⚠ LINE 2 ONLY, and only under a generated opening. `Reason:` is interpolated
 *  into the body raw and lands later, so scanning for the pattern anywhere
 *  would let a reason supply the sentence the owner reads as Recued's. */
const askConsequence = (text: string): string | null => {
  const lines = text.split(/\r?\n/);
  if (!/^(?:Recipe .+ wants to run |An AI agent wants to run )/.test(lines[0]?.trim() ?? '')) {
    return null;
  }
  const held = (lines[1] ?? '').trim().match(/^(.+), so Recued held (?:it|them) for you\.$/);
  return held === null ? null : `${held[1]!}.`;
};

/** The notification block's generated approval prose has a stable first line
 *  followed by an indented key/value payload. Project it conservatively; an
 *  arbitrary/custom ask that does not match keeps its original text verbatim. */
const projectGeneratedApprovalAsk = (text: string): ProjectedApprovalAsk | null => {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  const operation = first.match(
    /^Recipe (.+?) wants to run (.+?)(?: on (.+?))? \(step (.+?)\)\.$/,
  );
  if (operation === null) return null;

  const fields: Array<{ key: string; value: string }> = [];
  let reason: string | null = null;
  let origin: string | null = null;
  // The notification block groups fields nested under a shared path beneath
  // a value-less header (`metadata:` then its leaves, indented further).
  //
  // ⛔ THE GROUP PREFIX MUST BE RE-APPLIED BEFORE THE FILTER BELOW READS THE
  // KEY. Reading a grouped child as its bare leaf makes `metadata.timeline`
  // arrive as `timeline`, which passes a filter written to reject exactly
  // that field — so the card would start showing the producer bookkeeping it
  // exists to keep out, and the change that did it would look like a
  // rendering tweak two packages away.
  let group = '';
  let groupIndent = -1;
  for (const line of lines.slice(1)) {
    const field = line.match(/^(\s{2,})([^:]+):\s*(.*)$/);
    if (field !== null) {
      const indent = field[1]!.length;
      const leaf = field[2]!.trim();
      const value = field[3]!.trim();
      // Back out to (or past) the header's own indent ⇒ the group is over.
      if (group !== '' && indent <= groupIndent) {
        group = '';
        groupIndent = -1;
      }
      // A value-less line opens a group. `renderInline` never yields the
      // empty string — an empty object renders `(empty)` — so this cannot
      // collide with a real field.
      if (value === '') {
        group = leaf;
        groupIndent = indent;
        continue;
      }
      const key = group === '' ? leaf : `${group}.${leaf}`;
      // Generated metadata is producer bookkeeping, not a decision input.
      // Keep it in the server-side ask for enforcement/audit, but do not
      // project it into the approval card's user-facing technical details.
      if (key !== 'metadata' && !key.startsWith('metadata.')) {
        fields.push({ key, value });
      }
      continue;
    }
    const reasonLine = line.trim().match(/^Reason:\s*(.+)$/i);
    if (reasonLine !== null) reason = reasonLine[1]!.trim();
    // D-161 Part B — the composer emits this FLUSH-LEFT so it never reaches the
    // field rule above. Claimed here explicitly rather than left to fall
    // through as ignored prose: a projected card renders only what it projects,
    // so an unclaimed line is a line the owner never sees — which is precisely
    // the failure this sentence exists to fix.
    const originLine = line.trim().match(/^Started by:\s*(.+)$/i);
    // ⛔ FIRST MATCH WINS — `origin ?? `, never plain assignment.
    //
    // `reason` is interpolated into the body RAW (`\n\nReason: ${reason}`, no
    // whitespace collapse) and lands AFTER this line. Were a later match to
    // overwrite, any text reaching `reason` that carried a newline plus its own
    // "Started by: …" would REPLACE the substrate's provenance claim with one of
    // its own choosing — a forged answer to the exact question this row exists to
    // answer. The composer emits its line before anything but its own two
    // sentences, so taking the first occurrence closes that by construction
    // rather than by trusting every present and future `reason` producer.
    if (originLine !== null) origin ??= originLine[1]!.trim().replace(/\.$/, '');
  }

  const fieldByKey = new Map(fields.map((field) => [field.key, field.value]));
  const highlights: Array<{ key: string; value: string }> = [];
  // `statement` names a commitment and `event.summary` a calendar event: without
  // them those cards showed only the action, their subject hidden in the
  // technical bits. (Server-resolved rows replace this list when they resolve.)
  for (const key of ['to', 'subject', 'title', 'statement', 'summary', 'event.summary', 'body', 'top_tier_kind']) {
    const value = fieldByKey.get(key);
    if (value !== undefined && value !== '' && value !== '(null)') {
      highlights.push({ key, value });
    }
    if (highlights.length === 3) break;
  }

  return {
    recipe: operation[1]!,
    operation: operation[2]!,
    target: operation[3] ?? null,
    step: operation[4]!,
    reason,
    origin,
    fields,
    highlights,
    consequence: askConsequence(text),
  };
};

const humanizeAskField = (key: string): string => {
  const withoutMetadata = key.replace(/^metadata\./, '');
  const words = withoutMetadata.replace(/[._-]+/g, ' ');
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
};

/** The label a D-270 detail row is shown under, on every surface that shows one.
 *  A pack-declared label stands as written; the raw arg key a server falls back
 *  to is humanized. ⚠ ONLY an identifier-shaped label: humanizing splits on
 *  `[._-]`, which would mangle a real label like "e-mail" into "E mail". Shared
 *  so the Approvals card and the top-bar tray cannot name one value two ways. */
export const askDetailLabel = (label: string): string =>
  /^[a-z][a-z0-9._]*$/.test(label) ? humanizeAskField(label) : label;

type AskOptionIntent = 'approve' | 'reject' | 'neutral';

const askOptionIntent = (option: AskCardOption): AskOptionIntent => {
  const value = `${option.id} ${option.label}`.toLocaleLowerCase();
  if (/\b(approve|allow|accept|send|confirm|yes)\b/.test(value)) return 'approve';
  if (/\b(deny|reject|decline|discard|cancel|no)\b/.test(value)) return 'reject';
  return 'neutral';
};

const askRisk = (title: string | undefined): 'write' | 'admin' | 'destructive' | null => {
  const match = title?.match(/\((write|admin|destructive)\)\s*$/i);
  return match === undefined || match === null
    ? null
    : match[1]!.toLocaleLowerCase() as 'write' | 'admin' | 'destructive';
};

/** Render one pending ask as an interactive card. Returns a detached
 *  `HTMLElement` the host appends into its panel. */
export const renderAskCard = (
  doc: Document,
  model: AskCardModel,
  handlers: AskCardHandlers,
  options: AskCardOptions = {},
): HTMLElement => {
  const card = doc.createElement('div');
  card.className = 'rx-ask-card';
  card.setAttribute(ASK_CARD_ATTR, model.ask_id);
  const actionSubject = askActionSubject(model);

  const projected = projectGeneratedApprovalAsk(model.text);
  const risk = askRisk(model.title);
  const title = projected !== null && risk !== null
    ? `Approve ${risk} action`
    : nonBlankAskTitle(model.title);
  if (title !== undefined) {
    const heading = doc.createElement('div');
    heading.className = 'rx-ask-card-title';
    heading.textContent = title;
    card.appendChild(heading);
  }

  if (model.created_at !== undefined) {
    const age = doc.createElement('div');
    age.className = 'rx-ask-card-age';
    age.setAttribute(ASK_CARD_AGE_ATTR, String(model.created_at));
    const label = formatAskAge(model.created_at, options.now ?? Date.now());
    age.textContent = label === 'just now' ? 'Raised just now' : `Waiting ${label}`;
    // The machine-readable instant rides `title`, so a card that says "4d" can
    // still answer "since when" on hover without a second element.
    age.title = new Date(model.created_at).toLocaleString();
    card.appendChild(age);
  }

  if (projected === null) {
    const body = doc.createElement('div');
    body.className = 'rx-ask-card-text';
    body.textContent = model.text;
    card.appendChild(body);
  } else {
    if (projected.consequence !== null) {
      const consequence = doc.createElement('p');
      // The warning colour is for a consequence that warns. A write that stays
      // in Recued is still held, but painting its sentence red says the
      // opposite of what it says in words.
      consequence.className = projected.consequence === `${WRITE_STAYS_IN_RECUED_CLAUSE}.`
        ? 'rx-ask-card-consequence rx-ask-card-consequence--local'
        : 'rx-ask-card-consequence';
      consequence.textContent = projected.consequence;
      card.appendChild(consequence);
    }

    const summary = doc.createElement('dl');
    summary.className = 'rx-ask-card-summary';
    summary.setAttribute(ASK_CARD_SUMMARY_ATTR, '');
    const appendSummaryRow = (labelText: string, valueText: string): void => {
      const row = doc.createElement('div');
      row.className = 'rx-ask-card-summary-row';
      const label = doc.createElement('dt');
      label.textContent = labelText;
      const value = doc.createElement('dd');
      value.textContent = valueText;
      row.appendChild(label);
      row.appendChild(value);
      summary.appendChild(row);
    };
    appendSummaryRow('Action', projected.operation);
    if (projected.target !== null) appendSummaryRow('Target', projected.target);
    // D-161 Part B — ABOVE the highlights, not inside Technical details. The
    // highlights are the values the call would send; who supplied them changes
    // how a reviewer reads every one of them, so it cannot sit behind a
    // disclosure the reviewer may never open.
    if (projected.origin !== null) appendSummaryRow('Started by', projected.origin);
    // D-270 — server-resolved rows win over the prose scrape. The scraped
    // highlights stay as the fallback for every ask the server could not resolve
    // (owner ruling: that case is just an ordinary card), so this is a
    // replacement at the row level and never a second block.
    if (model.details !== undefined && model.details.length > 0) {
      // ⛔ HUMANIZE AN UNLABELLED ROW, OR THIS REPLACEMENT IS A REGRESSION.
      // `buildAskLandingDetails` falls back to the RAW arg key when a field
      // declares no label, while the scraped path it replaces always ran
      // `humanizeAskField`. Without this, making the server rows authoritative
      // turns "Top tier kind" into `top_tier_kind` on exactly the fields whose
      // pack never bothered to name them.
      // ⚠ Applied ONLY to an identifier-shaped label, never to a declared one:
      // `humanizeAskField` splits on `[._-]`, which would mangle a real label
      // like "e-mail" into "E mail".
      for (const row of model.details) appendSummaryRow(askDetailLabel(row.label), row.value);
    } else {
      for (const field of projected.highlights) {
        appendSummaryRow(humanizeAskField(field.key), field.value);
      }
    }
    card.appendChild(summary);

    const details = doc.createElement('details');
    details.className = 'rx-ask-card-details';
    details.setAttribute(ASK_CARD_DETAILS_ATTR, '');
    const detailsSummary = doc.createElement('summary');
    const technicalDetailCount = projected.fields.length
      + 2
      + (projected.target === null ? 0 : 1)
      + (projected.reason === null ? 0 : 1);
    detailsSummary.textContent = `The technical bits (${technicalDetailCount})`;
    detailsSummary.setAttribute(
      'aria-label',
      `The technical bits for ${actionSubject} (${technicalDetailCount})`,
    );
    details.appendChild(detailsSummary);
    const detailsList = doc.createElement('dl');
    const appendDetail = (labelText: string, valueText: string): void => {
      const row = doc.createElement('div');
      row.className = 'rx-ask-card-detail-row';
      const label = doc.createElement('dt');
      label.textContent = labelText;
      const value = doc.createElement('dd');
      value.textContent = valueText;
      row.appendChild(label);
      row.appendChild(value);
      detailsList.appendChild(row);
    };
    appendDetail('Recipe', projected.recipe);
    appendDetail('Step', projected.step);
    if (projected.target !== null) appendDetail('Target', projected.target);
    if (projected.reason !== null) appendDetail('Reason', projected.reason);
    for (const field of projected.fields) {
      appendDetail(humanizeAskField(field.key), field.value);
    }
    details.appendChild(detailsList);
    card.appendChild(details);
  }

  // D-234 § 234.3 — the READ affordance, between the body and the buttons.
  //
  // ⛔ EVERY OTHER STRING ON THIS CARD IS `textContent`; AN `href` IS NOT. The
  // module contract above says all server-derived text is set inert — that
  // guarantee does not extend to an attribute the browser NAVIGATES, where
  // `htmlEscape`-style handling leaves `javascript:` intact. Hence a scheme
  // allowlist, duplicated rather than imported: `packages/ui-shared` keeps zero
  // dependency on the notification block, so this is the same rule as
  // `safeHttpUrl`, enforced where the anchor is actually built.
  //
  // ⚠ Not a button and not `onAnswer` — reading is not answering. The card
  // stays a decision surface; this only says where the subject can be read.
  const linkHref = typeof model.link_url === 'string'
    && /^https?:\/\//i.test(model.link_url)
    ? model.link_url
    : null;
  if (linkHref !== null) {
    const link = doc.createElement('a');
    link.className = 'rx-ask-card-link';
    link.setAttribute(ASK_CARD_LINK_ATTR, model.ask_id);
    link.setAttribute('href', linkHref);
    link.textContent = 'Open the full details';
    link.setAttribute('aria-label', `Open the full details for ${actionSubject}`);
    card.appendChild(link);
  }

  // Inline error line — hidden until a submit fails. Created up front so
  // the click handlers can toggle it; appended after the action row.
  const errorEl = doc.createElement('div');
  errorEl.className = 'rx-ask-card-error';
  errorEl.setAttribute(ASK_CARD_ERROR_ATTR, model.ask_id);
  errorEl.setAttribute('role', 'alert');
  errorEl.textContent = options.errorMessage ?? 'Recued could not send that. Try again.';
  errorEl.hidden = options.errorMessage == null;

  // D-234 § 234.4f — the document behind the question, in a disclosure. ⛔ It is
  // rendered from the ASK RECORD, never from `message.text` — the notification
  // that reaches Slack / Telegram / email carries the question alone, and this
  // element only ever exists on a surface the owner is signed in to.
  const bodyWrap = doc.createElement('details');
  bodyWrap.className = 'rx-ask-card-body';
  if (model.body !== undefined && model.body !== '') {
    bodyWrap.setAttribute(ASK_CARD_BODY_ATTR, model.ask_id);
    const bodySummary = doc.createElement('summary');
    bodySummary.className = 'rx-ask-card-body-summary';
    bodySummary.textContent = 'Read what this is about';
    const bodyText = doc.createElement('pre');
    bodyText.className = 'rx-ask-card-body-text';
    // ⚠ `textContent`, never `innerHTML` — this string was written by ANOTHER
    // SERVER'S OWNER and arrives verbatim. The card is DOM-built precisely so a
    // peer cannot put markup on the reader's screen.
    bodyText.textContent = model.body;
    bodyWrap.appendChild(bodySummary);
    bodyWrap.appendChild(bodyText);
  }

  // D-234 § 234.4e — the written reason. Rendered ONLY when the ask invited one,
  // so an ordinary approval card is unchanged (no field, no label, no extra tab
  // stop). A textarea rather than an input: a reason is prose, and a
  // single-line box silently truncates the reader's attention to a phrase.
  const noteWrap = doc.createElement('div');
  noteWrap.className = 'rx-ask-card-note';
  const noteEl = doc.createElement('textarea');
  let noteRequiredError: HTMLElement | null = null;
  if (model.note_prompt !== undefined) {
    const required = model.note_prompt === 'required';
    const noteId = `rx-ask-note-${model.ask_id}`;
    const label = doc.createElement('label');
    label.className = 'rx-ask-card-note-label';
    label.setAttribute('for', noteId);
    // ⚠ The label says which it is. "Why (required)" is the difference between a
    // user who types and one who hits a guard they did not see coming.
    label.textContent = required ? 'Why? (required)' : 'Why? (optional)';
    noteEl.id = noteId;
    noteEl.className = 'rx-ask-card-note-input';
    noteEl.setAttribute(ASK_CARD_NOTE_ATTR, model.ask_id);
    noteEl.rows = 3;
    // ⚠ MIRRORS THE SERVER'S `ASK_NOTE_MAX`. The block caps at 600 on entry, so
    // an unbounded box would silently discard the tail of what someone wrote —
    // the surface must not let them type what will not survive.
    noteEl.maxLength = 600;
    if (required) noteEl.required = true;
    noteEl.placeholder = required
      ? 'Say why — this answer needs a reason'
      : 'Add a reason (optional)';
    noteRequiredError = doc.createElement('div');
    noteRequiredError.className = 'rx-ask-card-note-error';
    noteRequiredError.setAttribute('role', 'alert');
    noteRequiredError.textContent = 'A reason is required before you can answer.';
    noteRequiredError.hidden = true;
    noteWrap.appendChild(label);
    noteWrap.appendChild(noteEl);
    noteWrap.appendChild(noteRequiredError);
  } else {
    noteWrap.hidden = true;
  }

  const actions = doc.createElement('div');
  actions.className = 'rx-ask-card-actions';

  const confirmation = doc.createElement('div');
  confirmation.className = 'rx-ask-card-confirm';
  confirmation.setAttribute(ASK_CARD_CONFIRM_ATTR, model.ask_id);
  confirmation.setAttribute('role', 'status');
  // The composer's own clause when the ask carries one; the hedge only when it
  // does not (a custom ask, or one composed with no tier).
  const consequenceText = askConsequence(model.text);
  confirmation.textContent = consequenceText !== null
    ? `Say yes to this. ${consequenceText}`
    : 'Say yes to this. It may change things outside Recued.';
  confirmation.hidden = true;

  const buttonOptions: Array<{ button: HTMLButtonElement; option: AskCardOption }> = [];
  let pending = options.busy === true;
  let armedOptionId: string | null = null;
  const setOptionLabel = (
    button: HTMLButtonElement,
    label: string,
  ): void => {
    button.textContent = label;
    button.setAttribute(
      'aria-label',
      contextualActionLabel(label, actionSubject),
    );
  };
  const pendingLabel = (option: AskCardOption): string => {
    const intent = askOptionIntent(option);
    return intent === 'approve'
      ? 'Approving…'
      : intent === 'reject'
        ? 'Rejecting…'
        : 'Submitting…';
  };
  const setBusy = (optionId: string | undefined): void => {
    for (const row of buttonOptions) {
      row.button.setAttribute('aria-disabled', 'true');
      if (row.option.id === optionId) {
        row.button.setAttribute('aria-busy', 'true');
        setOptionLabel(row.button, pendingLabel(row.option));
      } else {
        row.button.removeAttribute('aria-busy');
        setOptionLabel(row.button, row.option.label);
      }
    }
  };
  const clearBusy = (): void => {
    for (const row of buttonOptions) {
      row.button.removeAttribute('aria-disabled');
      row.button.removeAttribute('aria-busy');
    }
  };
  const resetOptionButtons = (): void => {
    for (const row of buttonOptions) {
      const intent = askOptionIntent(row.option);
      row.button.className = `rx-ask-card-btn rx-ask-card-btn--${intent}`;
      setOptionLabel(row.button, row.option.label);
      row.button.setAttribute('aria-pressed', 'false');
    }
  };
  for (const option of model.options) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    const intent = askOptionIntent(option);
    btn.className = `rx-ask-card-btn rx-ask-card-btn--${intent}`;
    btn.setAttribute(ASK_CARD_OPTION_ATTR, option.id);
    btn.setAttribute('data-intent', intent);
    btn.setAttribute('aria-pressed', 'false');
    setOptionLabel(btn, option.label);
    btn.addEventListener('click', () => {
      // `aria-disabled` deliberately keeps the active option in the tab order,
      // so every activation path needs this explicit single-flight guard.
      if (pending) return;
      if (risk !== null && intent === 'approve' && armedOptionId !== option.id) {
        armedOptionId = option.id;
        resetOptionButtons();
        btn.className = 'rx-ask-card-btn rx-ask-card-btn--confirming';
        setOptionLabel(btn, `Confirm ${option.label}`);
        btn.setAttribute('aria-pressed', 'true');
        confirmation.hidden = false;
        return;
      }
      if (intent !== 'approve' && armedOptionId !== null) {
        armedOptionId = null;
        confirmation.hidden = true;
        resetOptionButtons();
      }
      // First submitted answer wins on this surface. Keep the chosen button
      // focusable while every option is guarded, so keyboard focus and visible
      // progress retain the exact async owner instead of falling to <body>.
      // ⛔ ENFORCE `required` HERE, BEFORE anything is submitted. The server
      // treats a missing required note as an INVALID reply and no-ops it — which
      // on this surface would look like a click that did nothing and an ask that
      // stayed open. Catching it client-side turns a silent no-op into a
      // sentence. (The server check remains the authority; this is the
      // affordance, not the gate.)
      if (model.note_prompt === 'required' && noteEl.value.trim() === '') {
        if (noteRequiredError !== null) noteRequiredError.hidden = false;
        noteEl.focus({ preventScroll: true });
        return;
      }
      if (noteRequiredError !== null) noteRequiredError.hidden = true;
      const ownedFocus = doc.activeElement === btn;
      const settledLabel = btn.textContent ?? option.label;
      pending = true;
      setBusy(option.id);
      const focusAfterBusy = doc.activeElement;
      errorEl.hidden = true;
      // Call `onAnswer` SYNCHRONOUSLY (the async IIFE body runs up to the
      // first `await` before suspending), so a click fires the submit in
      // the same tick — then await its promise only to drive the reject →
      // re-enable + inline-error path.
      void (async () => {
        try {
          // ⚠ Trimmed, and the second argument is OMITTED entirely when there is
          // no note — not passed as `undefined`.
          //
          // ⛔ THAT DISTINCTION IS NOT PEDANTRY: it is what keeps the call shape
          // BYTE-IDENTICAL for the ~all asks that invite no reason. Passing an
          // explicit `undefined` changed `toHaveBeenCalledWith(id)` for every
          // existing consumer and broke two shipped tests — a silent behaviour
          // change to every approval card in the product, to carry a field they
          // do not have. An ask with no note field has no note argument.
          const typed = model.note_prompt !== undefined ? noteEl.value.trim() : '';
          if (typed === '') await handlers.onAnswer(option.id);
          else await handlers.onAnswer(option.id, typed);
        } catch {
          pending = false;
          clearBusy();
          setOptionLabel(btn, settledLabel);
          errorEl.hidden = false;
          if (ownedFocus && doc.activeElement === focusAfterBusy) {
            btn.focus({ preventScroll: true });
          }
        }
      })();
    });
    buttonOptions.push({ button: btn, option });
    actions.appendChild(btn);
  }
  if (pending) setBusy(options.busyOptionId);
  card.appendChild(confirmation);
  // D-234 § 234.4e — the reason sits ABOVE the buttons, deliberately: a field
  // discovered after the decision is a field nobody fills. Hidden entirely when
  // the ask invited no note, so an ordinary approval card is byte-identical.
  // The evidence comes before the reason, and both before the buttons: read,
  // then explain, then decide.
  if (model.body !== undefined && model.body !== '') card.appendChild(bodyWrap);
  if (model.note_prompt !== undefined) card.appendChild(noteWrap);
  card.appendChild(actions);
  card.appendChild(errorEl);
  return card;
};

export type ApprovalCardDecision = 'approve' | 'reject';

/** Renderable subset of a server-side pending approval. Kept structural
 *  instead of importing `ServerPendingApproval` so `ui-shared` stays a
 *  leaf renderer for every client surface. */
export interface ApprovalCardModel {
  approval_id: string;
  recipe_id: string;
  step_id: string;
  ingredient_slug: string;
  risk_tier: 'write' | 'admin' | 'destructive';
  description: string;
  resolved_input: Record<string, unknown>;
  created_at: number;
  timeout_at: number;
  initiator_instance: string;
  /** D-174 #4 — optional route-resolved display names. The card prefers
   *  them over the raw ids in the meta line; absent → renders the id
   *  (back-compat: `recipe_id` / `initiator_instance` stay authoritative
   *  for the recipe href + any keying). */
  recipe_name?: string;
  initiator_label?: string;
}

export interface ApprovalCardLinks {
  recipeHref?: string;
  connectionHref?: string;
  runHref?: string;
}

export interface ApprovalCardHandlers {
  onResolve: (decision: ApprovalCardDecision) => void | Promise<void>;
  /** R20 — a `destructive` gate does not resolve on the first Approve click;
   *  it arms a confirm step. `onArm` fires on that first click (the host marks
   *  the card armed + re-renders → the danger-styled Confirm replaces Approve);
   *  `onDisarm` fires on Cancel. The host owns the armed flag so a confirm-in-
   *  progress survives a benign re-render (a background bus event shouldn't yank
   *  it away). There is NO auto-confirm — resolving needs a deliberate Confirm
   *  click — and a pending gate is immutable, so the armed decision stays bound
   *  to exactly the reviewed operation. Both are no-ops for non-destructive
   *  tiers, and an absent `onArm` makes a destructive card fall back to
   *  immediate resolve (back-compat for any non-route consumer). */
  onArm?: () => void;
  onDisarm?: () => void;
}

export interface ApprovalCardOptions {
  links?: ApprovalCardLinks;
  /** Permanently unavailable (for example a timed-out gate). Uses native
   * disabled semantics because there is no pending action to retain. */
  disabled?: boolean;
  /** Temporarily settling. Actions remain focusable but guarded with ARIA so
   * the initiating control can visibly own progress through route repaints. */
  busy?: boolean;
  /** `APPROVAL_CARD_ACTION_ATTR` value of the action that owns `busy`. */
  busyAction?: string;
  disabledReason?: string;
  errorMessage?: string | null;
  /** R20 — host-owned armed state for a `destructive` gate's confirm step
   *  (see `ApprovalCardHandlers.onArm`). Ignored for non-destructive tiers. */
  armed?: boolean;
}

/** Stable hook on the server-approval card root. */
export const APPROVAL_CARD_ATTR = 'data-recued-approval-card';
/** Stable hook on approve/reject buttons. */
export const APPROVAL_CARD_ACTION_ATTR = 'data-recued-approval-action';
/** Stable hook on cross-route links. */
export const APPROVAL_CARD_LINK_ATTR = 'data-recued-approval-link';
/** Stable hook on the inline resolve-error line. */
export const APPROVAL_CARD_ERROR_ATTR = 'data-recued-approval-error';
/** Stable hook on the stale/disabled reason line. */
export const APPROVAL_CARD_STATUS_ATTR = 'data-recued-approval-status';
/** Stable hook on the destructive-confirm caution line (armed state only). */
export const APPROVAL_CARD_CAUTION_ATTR = 'data-recued-approval-caution';

const formatEpochMs = (value: number): string => {
  if (!Number.isFinite(value)) return 'unknown time';
  return formatClientDateTime(value, { invalidText: 'unknown time' });
};

const formatResolvedInput = (input: Record<string, unknown>): string => {
  try {
    const text = JSON.stringify(input);
    if (text === undefined || text === '{}') return 'No resolved input';
    return text.length > 320 ? `${text.slice(0, 317)}...` : text;
  } catch {
    return 'Resolved input could not be displayed';
  }
};

/** Render one server-side pending approval as an interactive card. */
export const renderApprovalCard = (
  doc: Document,
  model: ApprovalCardModel,
  handlers: ApprovalCardHandlers,
  options: ApprovalCardOptions = {},
): HTMLElement => {
  const card = doc.createElement('div');
  card.className = 'rx-approval-card';
  card.setAttribute(APPROVAL_CARD_ATTR, model.approval_id);
  const actionSubject = model.description.trim() || `approval ${model.approval_id}`;

  const heading = doc.createElement('div');
  heading.className = 'rx-approval-card-title';
  heading.textContent = model.description;
  card.appendChild(heading);

  const meta = doc.createElement('div');
  meta.className = 'rx-approval-card-meta';
  meta.textContent = [
    model.ingredient_slug,
    model.risk_tier,
    `recipe ${model.recipe_name ?? model.recipe_id}`,
    `step ${model.step_id}`,
    `from ${model.initiator_label ?? model.initiator_instance}`,
  ].join(' · ');
  card.appendChild(meta);

  const timing = doc.createElement('div');
  timing.className = 'rx-approval-card-meta';
  timing.textContent = `requested ${formatEpochMs(model.created_at)} · expires ${formatEpochMs(model.timeout_at)}`;
  card.appendChild(timing);

  const input = doc.createElement('pre');
  input.className = 'rx-approval-card-input';
  input.textContent = formatResolvedInput(model.resolved_input);
  card.appendChild(input);

  const links = doc.createElement('div');
  links.className = 'rx-approval-card-links';
  const appendLink = (
    kind: 'recipe' | 'connection' | 'run',
    label: string,
    href: string | undefined,
  ): void => {
    if (href === undefined) return;
    const link = doc.createElement('a');
    link.setAttribute('href', href);
    link.setAttribute(APPROVAL_CARD_LINK_ATTR, kind);
    link.textContent = label;
    link.setAttribute('aria-label', `${label} for ${actionSubject}`);
    links.appendChild(link);
  };
  appendLink('recipe', 'Recipe', options.links?.recipeHref);
  appendLink('connection', 'Connection', options.links?.connectionHref);
  appendLink('run', 'Run audit', options.links?.runHref);
  if (links.children.length > 0) card.appendChild(links);

  const errorEl = doc.createElement('div');
  errorEl.className = 'rx-approval-card-error';
  errorEl.setAttribute(APPROVAL_CARD_ERROR_ATTR, model.approval_id);
  errorEl.setAttribute('role', 'alert');
  errorEl.textContent = options.errorMessage ?? 'Could not resolve approval - try again.';
  errorEl.hidden = options.errorMessage === undefined || options.errorMessage === null;

  const statusEl = doc.createElement('div');
  statusEl.className = 'rx-approval-card-status';
  statusEl.setAttribute(APPROVAL_CARD_STATUS_ATTR, model.approval_id);
  statusEl.textContent = options.disabledReason ?? '';
  statusEl.hidden = options.disabledReason === undefined;

  const isDestructive = model.risk_tier === 'destructive';
  const armed = options.armed === true;
  // A destructive gate arms a confirm step on the first Approve click (R20).
  // Without an `onArm` handler the card keeps the immediate-resolve behavior
  // (back-compat for non-route consumers).
  const usesDestructiveConfirm = isDestructive && handlers.onArm !== undefined;

  const actions = doc.createElement('div');
  actions.className = 'rx-approval-card-actions';

  const buttons: HTMLButtonElement[] = [];
  let pending = false;
  const accessibleVerb = (action: string, label: string): string =>
    action === 'cancel' ? 'Cancel confirmation' : label;
  const setActionLabel = (
    button: HTMLButtonElement,
    action: string,
    label: string,
  ): void => {
    button.textContent = label;
    button.setAttribute(
      'aria-label',
      contextualActionLabel(accessibleVerb(action, label), actionSubject),
    );
  };
  const setDisabled = (disabled: boolean): void => {
    for (const b of buttons) b.disabled = disabled;
  };
  const idleLabels = new Map<HTMLButtonElement, string>();
  const busyLabel = (action: string, fallback: string): string =>
    action === 'reject'
      ? 'Rejecting…'
      : action === 'approve' || action === 'confirm'
        ? 'Approving…'
        : fallback;
  const setBusy = (busy: boolean, ownerAction?: string): void => {
    for (const button of buttons) {
      const action = button.getAttribute(APPROVAL_CARD_ACTION_ATTR) ?? '';
      const idleLabel = idleLabels.get(button) ?? button.textContent ?? '';
      if (busy) {
        button.setAttribute('aria-disabled', 'true');
        if (action === ownerAction) {
          button.setAttribute('aria-busy', 'true');
          setActionLabel(button, action, busyLabel(action, idleLabel));
        } else {
          button.removeAttribute('aria-busy');
          setActionLabel(button, action, idleLabel);
        }
      } else {
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy');
        setActionLabel(button, action, idleLabel);
      }
    }
  };
  /** A resolve button — fires `onResolve(decision)` behind the in-flight
   *  guard. `actionAttr` is decoupled from `decision` so the destructive
   *  "Confirm" carries its own hook while still resolving `approve`. */
  const makeResolveButton = (
    decision: ApprovalCardDecision,
    actionAttr: string,
    label: string,
    className: string,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute(APPROVAL_CARD_ACTION_ATTR, actionAttr);
    setActionLabel(btn, actionAttr, label);
    btn.disabled = options.disabled === true;
    idleLabels.set(btn, label);
    btn.addEventListener('click', () => {
      if (pending || options.busy === true || btn.disabled) return;
      pending = true;
      setBusy(true, actionAttr);
      errorEl.hidden = true;
      void (async () => {
        try {
          await handlers.onResolve(decision);
        } catch {
          pending = false;
          setDisabled(options.disabled === true);
          setBusy(options.busy === true, options.busyAction);
          errorEl.textContent =
            options.errorMessage ?? 'Could not resolve approval - try again.';
          errorEl.hidden = false;
        }
      })();
    });
    buttons.push(btn);
    return btn;
  };
  /** An arm / cancel toggle — flips host-owned state + triggers a re-render
   *  (which rebuilds this button), so it needs no in-flight guard. */
  const makeToggleButton = (
    actionAttr: string,
    label: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute(APPROVAL_CARD_ACTION_ATTR, actionAttr);
    setActionLabel(btn, actionAttr, label);
    btn.disabled = options.disabled === true;
    idleLabels.set(btn, label);
    btn.addEventListener('click', () => {
      if (pending || options.busy === true || btn.disabled) return;
      onClick();
    });
    buttons.push(btn);
    return btn;
  };

  if (usesDestructiveConfirm && armed) {
    // Armed: a caution line + Cancel + a danger-styled Confirm (resolves
    // approve). This is the REAL confirm that replaces the old hollow
    // Review-then-route for destructive gates.
    const caution = doc.createElement('div');
    caution.className = 'rx-approval-card-caution';
    caution.setAttribute(APPROVAL_CARD_CAUTION_ATTR, model.approval_id);
    caution.textContent =
      'This cannot be undone. Say yes to go ahead.';
    card.appendChild(caution);
    actions.appendChild(
      makeToggleButton(
        'cancel',
        'Cancel',
        'rx-approval-card-btn rx-approval-card-btn--reject',
        () => handlers.onDisarm?.(),
      ),
    );
    actions.appendChild(
      makeResolveButton(
        'approve',
        'confirm',
        'Confirm',
        'rx-approval-card-btn rx-approval-card-btn--confirm',
      ),
    );
  } else if (usesDestructiveConfirm) {
    // Unarmed destructive: Reject resolves immediately; Approve ARMS.
    actions.appendChild(
      makeResolveButton(
        'reject',
        'reject',
        'Reject',
        'rx-approval-card-btn rx-approval-card-btn--reject',
      ),
    );
    actions.appendChild(
      makeToggleButton(
        'arm',
        'Approve',
        'rx-approval-card-btn rx-approval-card-btn--approve',
        () => handlers.onArm?.(),
      ),
    );
  } else {
    // Non-destructive (or no arm handler): Reject + immediate Approve.
    actions.appendChild(
      makeResolveButton(
        'reject',
        'reject',
        'Reject',
        'rx-approval-card-btn rx-approval-card-btn--reject',
      ),
    );
    actions.appendChild(
      makeResolveButton(
        'approve',
        'approve',
        'Approve',
        'rx-approval-card-btn rx-approval-card-btn--approve',
      ),
    );
  }

  card.appendChild(actions);
  card.appendChild(statusEl);
  card.appendChild(errorEl);
  setBusy(options.busy === true, options.busyAction);
  return card;
};

// ════════════════════════════════════════════════════════════════
// Chat plan-approval card (R20) — a D-137 write-plan pulled into #approvals
// ════════════════════════════════════════════════════════════════

/** Renderable subset of a pending chat write-plan (D-137). Structural so the
 *  webclient's `PendingChatPlan` satisfies it without importing chat types. */
export interface ChatPlanCardModel {
  plan_id: string;
  /** Server-stamped lineage for a fresh approval after an uncertain action. */
  retry_of_plan_id?: string;
  tool: string;
  tier: 1 | 2 | 3;
  args: unknown;
  /** False when recovery can identify the pending plan but cannot recover the
   * exact reviewed payload. The card keeps safe rejection available while
   * withholding approval authority. Defaults to true for older consumers. */
  payload_available?: boolean;
}

export type ChatPlanCardDecision = 'approve' | 'reject';

export interface ChatPlanCardHandlers {
  /** Approve → `chat.plan.approve`; Reject → `chat.plan.cancel` (the host maps
   *  the verb — the wire verb is unchanged, only the LABEL is "Reject", R20).
   *  MAY be async: actions stay focusable but guarded while the promise is
   *  pending; a rejection clears the guard + shows the inline error. */
  onResolve: (decision: ChatPlanCardDecision) => void | Promise<void>;
}

export interface ChatPlanCardOptions {
  /** Permanently unavailable card. Transient progress belongs in `busy`. */
  disabled?: boolean;
  /** Host-owned pending state, retained across composed-queue repaints. */
  busy?: boolean;
  /** Exact approve/reject action that owns the pending operation. */
  busyAction?: ChatPlanCardDecision;
  errorMessage?: string | null;
  /** Durable address for reviewing the plan in its originating Chat. */
  chatHref?: string;
}

/** Stable hook on the chat-plan card root (value = plan_id). */
export const CHAT_PLAN_CARD_ATTR = 'data-recued-chat-plan-card';
/** Stable hook on approve/reject buttons (value = the decision). */
export const CHAT_PLAN_CARD_ACTION_ATTR = 'data-recued-chat-plan-action';
/** Stable hook on the inline resolve-error line. */
export const CHAT_PLAN_CARD_ERROR_ATTR = 'data-recued-chat-plan-error';
/** Stable hook on the fresh-review explanation. */
export const CHAT_PLAN_CARD_RETRY_NOTICE_ATTR =
  'data-recued-chat-plan-retry-notice';
/** Stable hook on the non-executable recovered-payload explanation. */
export const CHAT_PLAN_CARD_UNAVAILABLE_NOTICE_ATTR =
  'data-recued-chat-plan-unavailable-notice';
/** Stable hook on the durable route back to the originating Chat message. */
export const CHAT_PLAN_CARD_CHAT_LINK_ATTR =
  'data-recued-chat-plan-chat-link';

const formatPlanArgs = (args: unknown): string => {
  try {
    const text = JSON.stringify(args);
    if (text === undefined || text === '{}' || text === 'null') return 'No arguments';
    return text.length > 320 ? `${text.slice(0, 317)}...` : text;
  } catch {
    return 'Arguments could not be displayed';
  }
};

/** Render one pending chat write-plan as an interactive card. Reuses the
 *  `.rx-approval-card*` visual shell so plans sit consistently in the unified
 *  #approvals list beside gates + asks. */
export const renderChatPlanCard = (
  doc: Document,
  model: ChatPlanCardModel,
  handlers: ChatPlanCardHandlers,
  options: ChatPlanCardOptions = {},
): HTMLElement => {
  const payloadAvailable = model.payload_available !== false;
  const actionSubject = model.tool.trim() || `plan ${model.plan_id}`;
  const card = doc.createElement('div');
  card.className = 'rx-approval-card';
  card.setAttribute(CHAT_PLAN_CARD_ATTR, model.plan_id);
  if (model.retry_of_plan_id !== undefined) {
    card.setAttribute('data-retry-of-plan-id', model.retry_of_plan_id);
  }

  const heading = doc.createElement('div');
  heading.className = 'rx-approval-card-title';
  heading.textContent =
    model.retry_of_plan_id === undefined
      ? `Run ${model.tool}`
      : `Fresh review: ${model.tool}`;
  card.appendChild(heading);

  const meta = doc.createElement('div');
  meta.className = 'rx-approval-card-meta';
  meta.textContent =
    model.retry_of_plan_id === undefined
      ? `chat plan · tier ${model.tier}`
      : `new permission after an uncertain outcome · tier ${model.tier}`;
  card.appendChild(meta);

  if (model.retry_of_plan_id !== undefined) {
    const notice = doc.createElement('p');
    notice.className = 'rx-approval-card-retry-notice';
    notice.setAttribute(CHAT_PLAN_CARD_RETRY_NOTICE_ATTR, '');
    notice.textContent =
      'The earlier permission was already used. Review these details again; '
      + 'approving this card grants new one-time permission but does not run it.';
    card.appendChild(notice);
  }

  if (!payloadAvailable) {
    const notice = doc.createElement('p');
    notice.className =
      'rx-approval-card-retry-notice rx-approval-card-unavailable-notice';
    notice.setAttribute(CHAT_PLAN_CARD_UNAVAILABLE_NOTICE_ATTR, '');
    notice.textContent =
      'The exact reviewed details are unavailable after recovery. '
      + 'This plan cannot be approved, but you can safely reject it.';
    card.appendChild(notice);
  }

  const input = doc.createElement('pre');
  input.className = 'rx-approval-card-input';
  input.textContent = payloadAvailable
    ? formatPlanArgs(model.args)
    : 'Reviewed arguments unavailable.';
  card.appendChild(input);

  if (options.chatHref !== undefined) {
    const links = doc.createElement('div');
    links.className = 'rx-approval-card-links';
    const link = doc.createElement('a');
    link.setAttribute('href', options.chatHref);
    link.setAttribute(CHAT_PLAN_CARD_CHAT_LINK_ATTR, '');
    link.textContent = 'Review in Chat';
    link.setAttribute('aria-label', `Review ${actionSubject} in Chat`);
    links.appendChild(link);
    card.appendChild(links);
  }

  const errorEl = doc.createElement('div');
  errorEl.className = 'rx-approval-card-error';
  errorEl.setAttribute(CHAT_PLAN_CARD_ERROR_ATTR, model.plan_id);
  errorEl.setAttribute('role', 'alert');
  errorEl.textContent = options.errorMessage ?? 'Could not resolve plan - try again.';
  errorEl.hidden = options.errorMessage === undefined || options.errorMessage === null;

  const actions = doc.createElement('div');
  actions.className = 'rx-approval-card-actions';

  const buttons: HTMLButtonElement[] = [];
  let pending = options.busy === true;
  const setActionLabel = (
    button: HTMLButtonElement,
    label: string,
  ): void => {
    button.textContent = label;
    button.setAttribute(
      'aria-label',
      contextualActionLabel(label, actionSubject),
    );
  };
  const setBusy = (
    busy: boolean,
    busyAction?: ChatPlanCardDecision,
  ): void => {
    for (const b of buttons) {
      const action = b.getAttribute(
        CHAT_PLAN_CARD_ACTION_ATTR,
      ) as ChatPlanCardDecision;
      b.disabled = options.disabled === true
        || (
          action === 'approve'
          && !payloadAvailable
        );
      if (busy) {
        b.setAttribute('aria-disabled', 'true');
        if (action === busyAction) {
          b.setAttribute('aria-busy', 'true');
          setActionLabel(
            b,
            action === 'approve' ? 'Approving…' : 'Rejecting…',
          );
        } else {
          b.removeAttribute('aria-busy');
          setActionLabel(b, action === 'approve' ? 'Approve' : 'Reject');
        }
      } else {
        b.removeAttribute('aria-disabled');
        b.removeAttribute('aria-busy');
        setActionLabel(b, action === 'approve' ? 'Approve' : 'Reject');
      }
    }
  };
  const makeButton = (
    decision: ChatPlanCardDecision,
    label: string,
    className: string,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute(CHAT_PLAN_CARD_ACTION_ATTR, decision);
    setActionLabel(btn, label);
    btn.disabled =
      options.disabled === true
      || (decision === 'approve' && !payloadAvailable);
    if (decision === 'approve' && !payloadAvailable) {
      btn.title = 'Recued needs the exact details before you can say yes.';
    }
    btn.addEventListener('click', () => {
      if (
        pending
        || btn.disabled
        || btn.getAttribute('aria-disabled') === 'true'
      ) return;
      pending = true;
      setBusy(true, decision);
      errorEl.hidden = true;
      void (async () => {
        try {
          await handlers.onResolve(decision);
        } catch {
          pending = false;
          setBusy(false);
          errorEl.textContent =
            options.errorMessage ?? 'Could not resolve plan - try again.';
          errorEl.hidden = false;
        }
      })();
    });
    buttons.push(btn);
    return btn;
  };
  actions.appendChild(
    makeButton('reject', 'Reject', 'rx-approval-card-btn rx-approval-card-btn--reject'),
  );
  actions.appendChild(
    makeButton('approve', 'Approve', 'rx-approval-card-btn rx-approval-card-btn--approve'),
  );
  card.appendChild(actions);
  card.appendChild(errorEl);
  setBusy(pending, options.busyAction);
  return card;
};

/** Self-contained CSS for the card. No ancestor selectors — every rule
 *  targets `.rx-ask-card*` directly so the card looks consistent wherever
 *  it is injected (the bridge side panel, the webclient). Colours read the
 *  global CSS custom properties each host shell defines, with neutral
 *  fallbacks so the card is legible even with no theme variables present. */
export const ASK_CARD_STYLES = `
.rx-ask-card {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  margin: 8px 0;
  background: var(--surface);
}
.rx-ask-card-title {
  min-width: 0;
  font-weight: 650;
  font-size: 15px;
  margin-bottom: 6px;
  color: var(--fg);
  overflow-wrap: anywhere;
}
.rx-ask-card-age {
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
  margin-bottom: 6px;
  /* Secondary by default - the age is context for the decision, not the
     decision. It earns emphasis only once genuinely old, which a host can do
     by styling on the data-recued-ask-age value; the card hard-codes no
     staleness threshold, because "old" is preflight.stale_after_days-relative
     and that is owner-configurable.
     NOTE: no backticks in here - this block is inside a template literal. */
  color: var(--muted, var(--fg));
  opacity: 0.75;
}
.rx-ask-card-text {
  min-width: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--fg);
  margin-bottom: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rx-ask-card-consequence {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--danger);
  font-weight: 600;
}
.rx-ask-card-consequence--local {
  color: var(--fg);
}
.rx-ask-card-summary,
.rx-ask-card-details dl {
  display: grid;
  gap: 7px;
  margin: 0;
}
.rx-ask-card-summary { margin-bottom: 10px; }
.rx-ask-card-summary-row,
.rx-ask-card-detail-row {
  display: grid;
  grid-template-columns: minmax(72px, .35fr) minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
.rx-ask-card-summary dt,
.rx-ask-card-detail-row dt {
  min-width: 0;
  color: var(--fg-subtle);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: .035em;
  overflow-wrap: anywhere;
}
.rx-ask-card-summary dd,
.rx-ask-card-detail-row dd {
  min-width: 0;
  margin: 0;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.rx-ask-card-details {
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
}
.rx-ask-card-details summary {
  color: var(--fg-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.rx-ask-card-details[open] summary { margin-bottom: 10px; }
.rx-ask-card-confirm {
  min-width: 0;
  margin-top: 10px;
  padding: 8px 10px;
  border-left: 3px solid var(--danger);
  background: var(--danger-weak, var(--surface-sunk));
  color: var(--fg);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.rx-ask-card-confirm[hidden] { display: none; }
.rx-ask-card-actions {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.rx-ask-card-btn {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  min-height: 44px;
  padding: 9px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  line-height: 1.2;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.rx-ask-card-btn--approve {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.rx-ask-card-btn--reject {
  border-color: var(--danger);
  color: var(--danger);
}
.rx-ask-card-btn--confirming {
  border-color: var(--danger);
  background: var(--danger);
  color: var(--on-danger, #fff);
}
.rx-ask-card-btn:hover:not(:disabled):not([aria-disabled="true"]) { filter: brightness(.96); }
.rx-ask-card-btn:disabled,
.rx-ask-card-btn[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.rx-ask-card-body {
  min-width: 0;
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--surface);
}
.rx-ask-card-body-summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
}
.rx-ask-card-body-text {
  margin: 8px 0 0;
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 13px;
  color: var(--fg);
}
.rx-ask-card-note {
  min-width: 0;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rx-ask-card-note-label {
  font-size: 12px;
  color: var(--muted);
}
.rx-ask-card-note-input {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font: inherit;
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
}
.rx-ask-card-note-error {
  font-size: 12px;
  color: var(--danger);
}
.rx-ask-card-error {
  min-width: 0;
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.rx-ask-card-error[hidden] { display: none; }
/* D-234 § 234.3 — the "read it" affordance. Deliberately a LINK, not a button:
   it must not read as one of the answers. WARN: CSS IS INVISIBLE TO A RENDER
   TEST, so the display rule here is what actually puts it on its own row - the
   DOM assertion passes either way. (No backticks in this block: it lives inside
   a template literal.) */
.rx-ask-card-link {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--accent, #2563eb);
  overflow-wrap: anywhere;
}
`;

export const APPROVAL_CARD_STYLES = `
.rx-approval-card {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  margin: 8px 0;
  background: var(--surface);
}
.rx-approval-card-title {
  min-width: 0;
  font-weight: 650;
  font-size: 13px;
  line-height: 1.35;
  color: var(--fg);
  margin-bottom: 5px;
  overflow-wrap: anywhere;
}
.rx-approval-card-meta {
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--muted);
  margin-bottom: 5px;
  overflow-wrap: anywhere;
}
.rx-approval-card-retry-notice {
  margin: 7px 0;
  padding: 7px 8px;
  border-left: 3px solid var(--accent);
  background: var(--surface-subtle, #f7f8f8);
  color: var(--fg);
  font-size: 12px;
  line-height: 1.4;
}
.rx-approval-card-unavailable-notice {
  border-left-color: var(--danger, var(--fail));
  color: var(--danger, var(--fail));
}
.rx-approval-card-input {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  margin: 8px 0;
  padding: 8px;
  border: 1px solid var(--border-subtle, var(--border));
  border-radius: 4px;
  background: var(--surface-subtle, #f7f8f8);
  color: var(--fg);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rx-approval-card-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 0;
}
.rx-approval-card-links a {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 5px 4px;
  border-radius: 5px;
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
}
.rx-approval-card-links a:hover {
  background: var(--accent-weak, var(--surface-subtle));
}
.rx-approval-card-links a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.rx-approval-card-actions {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rx-approval-card-btn {
  box-sizing: border-box;
  min-height: 36px;
  min-width: 0;
  max-width: 100%;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--surface);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  line-height: 1.2;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.rx-approval-card-btn--approve {
  background: var(--accent);
  color: var(--on-accent);
}
.rx-approval-card-btn--reject {
  border-color: var(--danger, var(--fail));
  color: var(--danger, var(--fail));
}
/* R20 — the destructive-gate confirm: a filled danger button so the second,
   deliberate step reads unmistakably as the irreversible action. */
.rx-approval-card-btn--confirm {
  border-color: var(--danger, var(--fail));
  background: var(--danger, var(--fail));
  color: var(--on-danger, #ffffff);
}
.rx-approval-card-btn:hover:not(:disabled):not([aria-disabled="true"]) { opacity: 0.9; }
.rx-approval-card-btn:disabled,
.rx-approval-card-btn[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.rx-approval-card-caution {
  min-width: 0;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--danger, var(--fail));
  overflow-wrap: anywhere;
}
.rx-approval-card-error,
.rx-approval-card-status {
  min-width: 0;
  margin-top: 6px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.rx-approval-card-error { color: var(--danger, var(--fail)); }
.rx-approval-card-status { color: var(--muted); }
.rx-approval-card-error[hidden],
.rx-approval-card-status[hidden] { display: none; }
`;
