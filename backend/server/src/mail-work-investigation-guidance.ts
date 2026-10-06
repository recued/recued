import { MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE } from '@recued/contracts';
import { buildMailWorkPrompts } from './mail-work-prompt-templates.js';

const prompts = buildMailWorkPrompts(MAIL_WORK_OWNER_NOTES_TIME_GUIDANCE, 16);
/** The same templates are replayed against captured inputs before live adoption. */
export const MAIL_WORK_OUTPUT_SHAPE = prompts.output;
export const MAIL_WORK_INVESTIGATION_GUIDANCE = prompts.investigation;
export const MAIL_WORK_REFINEMENT_GUIDANCE = prompts.refinement;
export const MAIL_WORK_LINKED_REVIEW_PROMPT = prompts.linkedReview;

/** Used only when exact bounded retention cannot cover the closing turn. */
export const MAIL_WORK_BRIEF_GUIDANCE = `For this mail-work carry, keep owner-reported facts explicitly attributed to owner notes and mail facts attached to their exact source_url. Never merge a phone fact into an email citation. Preserve source timestamps, withdrawn status in each historical finding, and the scope of approval and delivery conditions. An empty search is only a bounded not-found observation. Do not copy investigation instructions as owner facts.`;
