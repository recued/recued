/** Section primitive.
 *
 *  The options page is a vertical stack of top-level sections (LLM,
 *  Connections, Endpoints, …). Each one opens with a title, sometimes a
 *  hint paragraph, and a body. A *subsection* is the lighter-weight
 *  header used inside a section (e.g. "Slack workspaces" inside the
 *  Cloud panel).
 *
 *  Self-contained CSS: `.rx-section` never reaches into its children,
 *  so nesting is safe — a section can live inside a flash, a flash can
 *  live inside a section, and so on.
 */

import { e } from '../template.js';

export interface SectionProps {
  /** Heading text shown as `<h2>`. */
  title: string;
  /** Optional hint paragraph under the title. */
  hint?: string;
  /** Body HTML (callers assemble it freely). */
  body: string;
  /** Legacy wrapper class kept for layout styles (`.account-section`,
   *  `.clear-data-section`, …). Defaults to `account-section`. */
  wrapperClass?: string;
  /** Optional id (for deep-links / scroll-to). */
  id?: string;
}

export const section = (props: SectionProps): string => {
  const classes = ['rx-section', props.wrapperClass ?? 'account-section']
    .filter(Boolean)
    .join(' ');
  const idAttr = props.id ? ` id="${e(props.id)}"` : '';
  const hintHtml = props.hint
    ? `<p class="rx-section-hint section-hint">${e(props.hint)}</p>`
    : '';
  return `
    <section class="${classes}"${idAttr}>
      <h2 class="rx-section-title section-title">${e(props.title)}</h2>
      ${hintHtml}
      ${props.body}
    </section>
  `;
};

export interface SubsectionProps {
  title: string;
  body: string;
}

export const subsection = (props: SubsectionProps): string => `
  <div class="rx-subsection">
    <h3 class="rx-subsection-title subsection-title">${e(props.title)}</h3>
    ${props.body}
  </div>
`;

export const SECTION_STYLES = `
.rx-section {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}
.rx-section:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
.rx-section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  margin: 0 0 8px;
  letter-spacing: -0.2px;
}
.rx-section-hint {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.5;
}
.rx-subsection { margin-top: 14px; }
.rx-subsection-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  margin: 12px 0 8px;
}
`;
