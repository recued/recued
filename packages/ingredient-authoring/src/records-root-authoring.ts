import { RECORDS_ROOT_MAX_HOPS, type RecordsRootProjection, type RecordsRootHop } from '@recued/contracts';

interface Field { type: 'string' | 'array' | 'object'; required?: boolean; description: string }
const fields: Record<keyof RecordsRootProjection, Field> = {
  root: { type: 'string', required: true, description: 'The declared identity root. Choose from the bundled root kinds; completion does not create a new root type.' },
  via: { type: 'array', required: true, description: `The explicit ref hops from this base entity toward the contact-key entity. Empty means this entity itself. At most ${RECORDS_ROOT_MAX_HOPS} hops; no target is inferred from stored rows.` },
  key_field: { type: 'string', required: true, description: 'A string-slot field on the FINAL entity of the declared route, holding the contact canonical email. Field identity alone does not verify runtime email values.' },
  select: { type: 'object', required: true, description: 'The declared rollup shape over this BASE entity, independently of the final contact-key entity. Functions and fields use the canonical aggregate rules.' },
  where: { type: 'object', description: 'Fixed field predicates over this BASE entity. Key suggestions preserve assigned predicates. Static checks establish field names; runtime predicate values and operators still need validation.' },
  group_by: { type: 'string', description: 'Group this BASE entity by an eligible string, date, boolean or reference field. Grouping is explicit; selecting a contact-key route does not change the grouping entity.' },
  label: { type: 'string', description: 'Display label for this contact rollup.' },
  name: { type: 'string', description: 'Recipe path segment for this rollup. Multiple projections in one pack need distinct names. Naming a previously unnamed projection changes its recipe output path; no name or caller rewrite is inserted automatically.' },
};
const hop: Record<keyof RecordsRootHop, Field> = {
  field: { type: 'string', required: true, description: 'A reference-slot field on the entity reached by the preceding hops. The first hop starts from the base entity.' },
  entity: { type: 'string', required: true, description: 'The exact local entity this authored hop targets. Both field and entity are explicit; completion does not infer a route from field metadata.' },
};
export const recordsRootFields = () => Object.entries(fields).map(([key, value]) => ({key, ...value}));
export const recordsRootHopFields = () => Object.entries(hop).map(([key, value]) => ({key, ...value}));
