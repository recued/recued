import { expect, it } from 'vitest';
import { renderCommitmentRelated } from '../work-entity-page/commitment-related.js';

it('keeps linked names, opaque keys, error text and preview fields literal rather than executable markup', () => {
  const attack = '<img src="https://unwanted.test/tracker" onerror="alert(1)">';
  const html = renderCommitmentRelated({ more: false, records: [{ key: 'task:id" data-action="unwanted', kind: 'task',
    label: attack, state: 'ready', expanded: true, previewing: false, can_open: true, message: attack,
    preview: { title: attack, fields: [['Notes', attack]], notice: attack } }] });
  expect(html).toContain('&lt;img src='); expect(html).not.toMatch(/<(?:img|script|iframe|svg|object)\b/i);
  expect(html).not.toContain('data-action="unwanted"'); expect(html).toContain('task:id&quot; data-action=&quot;unwanted');
  expect(html).toContain('role="region"'); expect(html).toContain('Open task &lt;img');
});
