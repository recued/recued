import { describe, expect, it } from 'vitest';
import { renderFileArtifactBlock } from '../index.js';

describe('renderFileArtifactBlock', () => {
  it('renders exact metadata and keeps host-only decision interactions inert', () => {
    const html = renderFileArtifactBlock({
      title: 'Paid document for response response-1',
      record_id: 'file:abcdef',
      filename: 'document.pdf',
      mime_type: 'application/pdf',
      size_bytes: 7_197,
      sha256: 'a'.repeat(64),
      generated_at: Date.UTC(2026, 6, 11, 12, 0, 0),
      generation_mode: 'static',
      origin: { submission_id: 'response-1', task_id: 'task-1' },
      payment: { status: 'paid' },
      template: { filename: 'template.md' },
      approval_action: {
        kind: 'recipe.run',
        label: 'Approve and send exact PDF',
        recipe_id: 'approve-deliver-paid-document',
      },
      decision_actions: [{
        kind: 'recipe.run',
        label: 'Regenerate exact PDF',
        recipe_id: 'generate-paid-document',
      }, {
        kind: 'recipe.run',
        label: 'Cancel fulfillment',
        recipe_id: 'regenerate-reject-paid-document',
      }],
    });

    expect(html).toContain('file-artifact-card');
    expect(html).toContain('document.pdf');
    expect(html).toContain('7,197 bytes');
    expect(html).toContain('response-1');
    expect(html).toContain('template.md');
    expect(html).toContain('Approve and send exact PDF');
    expect(html).toContain('Regenerate exact PDF');
    expect(html).toContain('Cancel fulfillment');
    expect(html).toContain('Authenticated preview/download is available');
    expect(html).not.toContain('<button');
  });

  it('escapes metadata and rejects incomplete descriptors', () => {
    const escaped = renderFileArtifactBlock({
      record_id: 'file:<bad>',
      filename: '<img src=x>',
      mime_type: 'application/pdf',
      sha256: 'a'.repeat(64),
    });
    expect(escaped).toContain('&lt;img src=x&gt;');
    expect(escaped).not.toContain('<img src=x>');

    expect(renderFileArtifactBlock({ filename: 'document.pdf' }))
      .toContain('invalid exact-file descriptor');

    expect(renderFileArtifactBlock({
      record_id: 'file:abc',
      filename: 'document.pdf',
      mime_type: 'application/pdf',
      sha256: 'a'.repeat(64),
      generated_at: Number.MAX_VALUE,
    })).toContain('Unknown time');
  });
});
