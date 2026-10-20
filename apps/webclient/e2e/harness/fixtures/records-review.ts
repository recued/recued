import type { ResourceReview } from '@recued/contracts';

export const RECORDS_REVIEW_FIXTURE: ResourceReview = {
  schema_version: 1, operation: 'fixture.note.batch', input_hash: 'a'.repeat(64), captured_at: 1_700_000_000_000,
  resources: [{
    kind: 'records', key: 'note-1', label: 'Existing note', binding: 'binding', version: 'reviewed-v1',
    precondition: { kind: 'records_revision', value: 0, incarnation: 'original-row' },
    before: { id: 'note-1', title: '<script>window.reviewInjected = true</script>' },
    after: { id: 'note-1', title: 'Recreated final note' },
    changes: [
      { operation_index: 0, action: 'update', before: { title: 'Original' }, after: { title: 'Intermediate edit' } },
      { operation_index: 1, action: 'delete', before: { title: 'Intermediate edit' }, after: null },
      { operation_index: 2, action: 'create', before: null, after: { title: 'Recreated final note' } },
    ],
  }, {
    kind: 'records', key: 'note-2', label: 'New note', binding: 'binding', version: 'reviewed-absence',
    precondition: { kind: 'records_absent', generated_for: 3 }, before: {}, after: { id: 'note-2', title: 'Inserted note' },
    changes: [{ operation_index: 3, action: 'create', before: null, after: { id: 'note-2', title: 'Inserted note' } }],
  }],
};
