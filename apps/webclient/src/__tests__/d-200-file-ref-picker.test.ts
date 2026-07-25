import { describe, expect, it } from 'vitest';
import {
  fileRefOptionsFromMirrorResults,
  mirrorFileEntityIdToFileRef,
} from '../recipes/file-ref-picker.js';

describe('D-200 file_ref picker projection', () => {
  it('strips exactly the Data collection prefix from CAS and remote file ids', () => {
    expect(mirrorFileEntityIdToFileRef('file:file:cas-1')).toBe('file:cas-1');
    expect(mirrorFileEntityIdToFileRef('file:file:remote:dropbox:1')).toBe(
      'file:remote:dropbox:1',
    );
    expect(mirrorFileEntityIdToFileRef('mail:message-1')).toBeNull();
    expect(mirrorFileEntityIdToFileRef('file:')).toBeNull();
    expect(mirrorFileEntityIdToFileRef(42)).toBeNull();
  });

  it('keeps labels/sublabels and drops malformed non-file search rows', () => {
    expect(fileRefOptionsFromMirrorResults([
      {
        entity_id: 'file:file:template-1',
        label: 'template.md',
        sublabel: 'Received files',
      },
      {
        entity_id: 'file:file:remote:drive:template-2',
        label: 'template-2.md',
      },
      {
        entity_id: 'mail:wrong-kind',
        label: 'not a file',
      },
      { entity_id: 'file:file:bad-label', label: 42 },
      null,
    ])).toEqual([
      {
        id: 'file:template-1',
        label: 'template.md',
        sublabel: 'Received files',
      },
      {
        id: 'file:remote:drive:template-2',
        label: 'template-2.md',
      },
    ]);
  });
});
