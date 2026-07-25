/** D-196 S3 — reusable Reception outbound-link element.
 *
 * A link button is navigation only: label + absolute HTTPS URL + optional
 * description. It never submits a form, embeds the destination, or carries a
 * bearer. Host configs decide placement and cardinality; this module owns the
 * closed row shape so every Reception form/page can reuse the same contract. */

export const RECEPTION_LINK_BUTTON_LABEL_MAX = 60;
export const RECEPTION_LINK_BUTTON_URL_MAX = 512;
export const RECEPTION_LINK_BUTTON_DESCRIPTION_MAX = 400;

export interface ReceptionLinkButton {
  readonly label: string;
  readonly url: string;
  readonly description?: string;
}

export type ReceptionLinkButtonValidationCode =
  | 'shape_invalid'
  | 'unknown_key'
  | 'label_invalid'
  | 'label_too_long'
  | 'url_invalid'
  | 'url_too_long'
  | 'description_invalid'
  | 'description_too_long';

export interface ReceptionLinkButtonValidationFailure {
  readonly code: ReceptionLinkButtonValidationCode;
  readonly detail: string;
}

const LINK_BUTTON_KEYS: ReadonlySet<string> = new Set([
  'label',
  'url',
  'description',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** True only for an absolute HTTPS URL. Relative URLs and every other scheme
 * are rejected so the element cannot become an implicit form action or embed. */
export const isReceptionLinkButtonUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > RECEPTION_LINK_BUTTON_URL_MAX) return false;
  // `new URL` normalizes leading whitespace and shorthand such as
  // `https:example.com`. Require the authored absolute form before parsing so
  // validation and the literal href emitted by Reception agree exactly.
  if (!/^https:\/\/\S+$/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
};

/** Unknown-safe closed-shape validator for one reusable link-button row. */
export const validateReceptionLinkButton = (
  value: unknown,
): ReadonlyArray<ReceptionLinkButtonValidationFailure> => {
  if (!isRecord(value)) {
    return [{ code: 'shape_invalid', detail: 'link_button must be an object' }];
  }

  const failures: ReceptionLinkButtonValidationFailure[] = [];
  for (const key of Object.keys(value)) {
    if (!LINK_BUTTON_KEYS.has(key)) {
      failures.push({
        code: 'unknown_key',
        detail: `link_button.${key} is not in the closed shape`,
      });
    }
  }

  if (typeof value.label !== 'string' || value.label.trim().length === 0) {
    failures.push({ code: 'label_invalid', detail: 'link_button.label must be non-empty' });
  } else if (value.label.length > RECEPTION_LINK_BUTTON_LABEL_MAX) {
    failures.push({
      code: 'label_too_long',
      detail: `link_button.label must be at most ${RECEPTION_LINK_BUTTON_LABEL_MAX} characters`,
    });
  }

  if (typeof value.url === 'string' && value.url.length > RECEPTION_LINK_BUTTON_URL_MAX) {
    failures.push({
      code: 'url_too_long',
      detail: `link_button.url must be at most ${RECEPTION_LINK_BUTTON_URL_MAX} characters`,
    });
  } else if (!isReceptionLinkButtonUrl(value.url)) {
    failures.push({
      code: 'url_invalid',
      detail: 'link_button.url must be an absolute HTTPS URL',
    });
  }

  if (value.description !== undefined && typeof value.description !== 'string') {
    failures.push({
      code: 'description_invalid',
      detail: 'link_button.description must be a string when present',
    });
  } else if (
    typeof value.description === 'string'
    && value.description.length > RECEPTION_LINK_BUTTON_DESCRIPTION_MAX
  ) {
    failures.push({
      code: 'description_too_long',
      detail: `link_button.description must be at most ${RECEPTION_LINK_BUTTON_DESCRIPTION_MAX} characters`,
    });
  }

  return failures;
};

/** Keep only the rows that pass the closed-shape validator; drop the rest.
 *
 *  ⛔ THE FENCE AND THE HTML THAT TRUSTS IT MUST TRAVEL TOGETHER. Every
 *  renderer of this block calls THIS — never its own filter, never none. The
 *  href is the reason: HTML-escaping a `javascript:` URL yields a working
 *  `javascript:` URL, so escaping is not a substitute for the scheme check in
 *  `isReceptionLinkButtonUrl`. A caller that renders the raw rows because it
 *  forgot to filter is the caller that emits the non-HTTPS navigation target.
 *
 *  DROP, never throw: these rows reach visitor-facing pages from registry
 *  metadata and — D-207 slice 2 — from a recipe run, neither of which is inside
 *  the D-145 redacted packet's strict-pick. One bad row must not 500 a public
 *  page, and must not render either. */
export const selectValidReceptionLinkButtons = (
  value: unknown,
): ReadonlyArray<ReceptionLinkButton> => {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter(
    (row): row is ReceptionLinkButton => validateReceptionLinkButton(row).length === 0,
  );
};
