/** AI analysis block — arbitrary object from an AI ingredient.
 *
 *  The renderer cherry-picks common fields produced by contracted
 *  AI functions (`summary`, `category`, `score`, `confidence`,
 *  `sentiment`, `reasoning`, `key_points`) and falls back to a
 *  pretty-printed JSON view when the shape isn't recognised. Strings
 *  render as plain text; primitives coerce via `String`. */

import { e } from './escape.js';
import { renderBlockEmpty } from './block-error.js';
import { renderBlockLabel } from './label.js';

export const renderAiAnalysisBlock = (data: unknown, label?: string): string => {
  if (data === null || data === undefined) return renderBlockEmpty('ai_analysis');
  if (typeof data === 'string') {
    return `
      <div class="block ai-block">
        ${renderBlockLabel(label)}
        <p class="ai-text">${e(data)}</p>
      </div>
    `;
  }
  if (typeof data !== 'object') {
    return `
      <div class="block ai-block">
        ${renderBlockLabel(label)}
        <p class="ai-text">${e(String(data))}</p>
      </div>
    `;
  }

  const d = data as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof d.summary === 'string') {
    parts.push(`<p class="ai-summary">${e(d.summary)}</p>`);
  }
  if (typeof d.category === 'string') {
    parts.push(
      `<div class="ai-row"><span class="ai-label">Category</span><span>${e(d.category)}</span></div>`,
    );
  }
  if (typeof d.score === 'number') {
    parts.push(
      `<div class="ai-row"><span class="ai-label">Score</span><span>${e(String(d.score))}</span></div>`,
    );
  }
  if (typeof d.confidence === 'number') {
    parts.push(
      `<div class="ai-row"><span class="ai-label">Confidence</span><span>${e(String(Math.round(d.confidence * 100)))}%</span></div>`,
    );
  }
  if (typeof d.sentiment === 'string') {
    parts.push(
      `<div class="ai-row"><span class="ai-label">Sentiment</span><span>${e(d.sentiment)}</span></div>`,
    );
  }
  if (typeof d.reasoning === 'string') {
    parts.push(`<p class="ai-reasoning">${e(d.reasoning)}</p>`);
  }
  if (Array.isArray(d.key_points)) {
    parts.push(
      `<ul class="ai-points">${d.key_points
        .map((p) => `<li>${e(String(p))}</li>`)
        .join('')}</ul>`,
    );
  }

  if (parts.length === 0) {
    parts.push(`<pre class="ai-json">${e(JSON.stringify(d, null, 2))}</pre>`);
  }

  return `<div class="block ai-block">${renderBlockLabel(label)}${parts.join('')}</div>`;
};
