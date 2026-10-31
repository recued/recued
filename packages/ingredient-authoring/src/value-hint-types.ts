import type { ValueHintType } from '@recued/contracts';

/** Suggested authoring vocabulary, never an admission list. Custom type names stay valid. */
const descriptions = {
  text: 'A text input.',
  long_text: 'Multi-line text rendered with a textarea. Custom type names remain valid.',
  number: 'A numeric input. Operation schemas enforce bounds and whole-number requirements.',
  boolean: 'A true or false input.',
  enum: 'A choice from options. Supply at least one non-empty string; the first option is the default.',
  date: 'A calendar day in YYYY-MM-DD form, without a time or time zone.',
  datetime: 'An instant expressed with an explicit time-zone offset, distinct from a calendar day.',
  url: 'A URL input.',
  secret: 'A sensitive setting entered by the owner. Authoring does not choose credentials or grant access.',
  oauth: 'An OAuth setting routed by provider and requested scopes. Authoring does not authorize an account.',
  file_slug: 'The slug of a registered file collection, distinct from one stored file.',
  file_ref: 'One stored data.file record selected from the owner\'s file inventory. accept_mime_types narrows discovery only.',
  'file_ref[]': 'An ordered list of stored file references. Selection order is significant.',
  record_ref: 'One stored record selected by search. Supply entity; entity_filter can narrow discovery. These fields do not grant access.',
  mail_template: 'An owner-side mail template ID. An optional starter brings its definition; authored defaults are refused because installation creates the ID.',
} satisfies Record<ValueHintType | 'long_text', string>;
export const valueHintTypes = () => Object.entries(descriptions).map(([type, description]) => ({ type, description }));
export const valueHintTypeHelp = (type: string): string | undefined => Object.hasOwn(descriptions, type)
  ? descriptions[type as keyof typeof descriptions] : undefined;
