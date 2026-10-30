import { outputSectionKeys, type OutputSectionKey, type OutputType } from '@recued/contracts';

export interface OutputSectionField { key: OutputSectionKey; type: 'string' | 'array' | 'object'; required: boolean; description: string }
const fields = {
  type: { type: 'string', description: 'The result block kind from the shared output vocabulary. The consuming channel decides how to present it.' },
  source: { type: 'string', description: 'A completed step result, such as step.result. Choose an existing step; declaring an output does not run it.' },
  label: { type: 'string', description: 'Display label for this result block. Use label rather than title.' },
  entity: { type: 'string', description: 'The local entity kind whose schema supplies field presentation. Required for record_fields; optional for table.' },
  fields: { type: 'array', description: 'Fields to show, in order. A filter names declared variables; entity-bound tables and record_fields name entity fields.' },
  hidden: { type: 'array', description: 'Declared variables carried by a filter without visible controls.' },
  submit: { type: 'string', description: 'The non-empty label for submitting an authored filter.' },
  edit: { type: 'object', description: 'Table editing declaration. Its bindings and write operations still require canonical validation and runtime grants.' },
  select: { type: 'object', description: 'Table row selection declaration. Review its action and binding requirements before use.' },
  group_by: { type: 'string', description: 'The row field whose value groups table rows. This is a table facet, not another output type.' },
} satisfies Record<OutputSectionKey, { type: OutputSectionField['type']; description: string }>;
export const outputSectionFields = (type: unknown): OutputSectionField[] => outputSectionKeys(type).map(key => ({
  key: key as OutputSectionKey, ...fields[key as OutputSectionKey],
  required: key === 'type' || key === 'source' || type === 'filter' && ['fields', 'hidden', 'submit'].includes(key)
    || type === 'record_fields' && key === 'entity',
}));
export const outputTypeHelp: Record<OutputType, string> = {
  checklist: 'A checklist result.',
  table: 'Tabular rows, optionally bound to an entity schema, with editing, selection or grouping facets.',
  summary: 'A curated summary of a step result.',
  ai_analysis: 'An AI analysis result.',
  text: 'Text from a step result.',
  copyable: 'Copyable content from a step result.',
  button: 'A recipe action descriptor; execution still requires the caller to hold its grants.',
  file_artifact: 'Immutable file cards with server-derived metadata.',
  file_preview: 'One bounded file requested for inline display; channels may present a file card instead.',
  link_button: 'Outbound navigation through an absolute HTTPS link.',
  json: 'Structured data from a step result, retained as a result block for the consuming channel.',
  filter: 'An owner invocation form whose visible and hidden inputs come from declared variables.',
  record_fields: 'A schema-bound field list over one Records row.',
};
