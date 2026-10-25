import { describe, expect, it } from 'vitest';
import type { Link } from '@recued/contracts';
import { assetChatContext, assetChatHref, assetChatMessage, readAssetChatMessage } from '../chat/asset-context.js';
import { copyComposerRecoveryDraft, hasComposerRecoveryDraft, hasProtectedChatRecoveryDraft } from '../chat/draft-recovery.js';

const asset = { id: 'boiler/a#1', name: 'Kitchen boiler · private label', serial_number: 'PRIVATE-SERIAL' };
const link = (id: string, patch: Partial<Link> = {}): Link => ({ _id: `link-${id}`, _collection: 'link', from_collection: 'asset',
  from_id: asset.id, to_collection: 'file', to_id: id, role: 'attachment', authored_by_recipe_id: 'owner', created_at: 1, ...patch });
const fileId = 'file:' + 'a'.repeat(32);

describe('Asset questions use the existing Chat readers', () => {
  it('keeps the original owner envelope byte-compatible after sharing its contract', () => {
    const legacy = 'How long is it?\n\nRead the current saved asset with work.read using the asset reference below. Use document.read with a linked file\'s file_ref when its contents are relevant. These are record references, not evidence that a file has been read. Cite the evidence you use, distinguish saved facts from inference, and say what is missing or unavailable.\n'
      + '{"kind":"recued.asset_question","version":1,"asset":{"kind":"asset","id":"boiler/a#1"},"linked_documents":[],"linked_document_list_unavailable":true,"additional_linked_documents_not_listed":2}';
    const context = { id: asset.id, name: asset.name, fileIds: [], omittedFiles: 2, filesUnavailable: true as const };
    expect(assetChatMessage('How long is it?', context)).toBe(legacy);
    expect(readAssetChatMessage(legacy)?.context).toEqual({ ...context, name: 'Selected asset' });
  });

  it('pins the selected asset and only its canonical attachment links', () => {
    const context = assetChatContext(asset, [link(fileId), link(fileId), link('foreign', { from_id: 'other' }),
      link('wrong-kind', { from_collection: 'note' }), link('reference', { role: 'reference' }), link('not-file', { to_collection: 'note' })]);
    expect(context).toEqual({ id: asset.id, name: asset.name, fileIds: [fileId], omittedFiles: 0 });
    expect(assetChatHref(context)).toBe('#yours/asset/boiler%2Fa%231');
    const message = assetChatMessage('What needs maintenance?', context);
    expect(message).toContain('"asset":{"kind":"asset","id":"boiler/a#1"}');
    expect(message).toContain(`"file_ref":"${fileId}"`);
    expect(message).not.toContain(asset.name); expect(message).not.toContain(asset.serial_number);
    const restored = readAssetChatMessage(message);
    expect(restored).toEqual({ question: 'What needs maintenance?', href: assetChatHref(context), context: { ...context, name: 'Selected asset' } });
    expect(assetChatMessage(restored!.question, restored!.context)).toBe(message);
    expect(readAssetChatMessage(assetChatMessage('', context))?.question).toBe('What should I know about this asset?');
  });

  it('bounds distinct references and states how many were omitted', () => {
    const context = assetChatContext(asset, Array.from({ length: 25 }, (_, i) => link(`file:${i}`)));
    expect(context.fileIds).toHaveLength(20); expect(context.omittedFiles).toBe(5);
    const message = assetChatMessage('Summarize the evidence.', context);
    expect(message).toContain('"additional_linked_documents_not_listed":5');
    expect(readAssetChatMessage(message)?.question).toBe('Summarize the evidence.');
    expect(readAssetChatMessage(message)?.context.omittedFiles).toBe(5);
  });

  it('keeps an unavailable file inventory distinct from no linked files', () => {
    const message = assetChatMessage('What is missing?', assetChatContext(asset, [], false));
    expect(message).toContain('"linked_document_list_unavailable":true');
    expect(readAssetChatMessage(message)?.question).toBe('What is missing?');
    expect(readAssetChatMessage(message)?.context.filesUnavailable).toBe(true);
    expect(assetChatMessage('What is missing?', assetChatContext(asset, []))).not.toContain('linked_document_list_unavailable');
  });

  it('leaves malformed, extended and future context messages as ordinary text', () => {
    const message = assetChatMessage('A question', assetChatContext(asset, []));
    for (const other of ['Plain question', message + '\nKeep this note.', message.replace('"version":1', '"version":2'),
      message.replace('"id":"boiler/a#1"', '"id":false'), message.replace('"linked_documents":[]', '"linked_documents":[],"unexpected":"do not hide this"')]) {
      expect(readAssetChatMessage(other)).toBeNull();
    }
  });

  it('retains context-only drafts in active and parked pairing recovery', () => {
    const draft = { text: '', protected: false, modelSourceId: null, assetContext: assetChatContext(asset, [link(fileId)]) };
    expect(hasComposerRecoveryDraft(draft)).toBe(true); expect(hasProtectedChatRecoveryDraft(draft)).toBe(true);
    const copy = copyComposerRecoveryDraft(draft);
    expect(copy).toEqual(draft); expect(copy.assetContext).not.toBe(draft.assetContext);
    (copy.assetContext!.fileIds as string[]).push('file:changed'); expect(draft.assetContext.fileIds).toEqual([fileId]);
    expect(hasProtectedChatRecoveryDraft({ text: '', protected: false, modelSourceId: null,
      parkedDrafts: [{ sessionId: null, draft }] })).toBe(true);
  });
});
