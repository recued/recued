import { describe, expect, it } from 'vitest';
import { assetRereadForRead, readCurrentAssetQuestion } from '../chat-asset-fresh-read.js';
import { sourceCitation } from '../chat-source-citations.js';

const ASSET = 'asset:clock'; const FILE = 'file:' + 'b'.repeat(32);
const asset = sourceCitation({ kind: 'asset', asset_id: ASSET }, 'Saved item', 'a'.repeat(64), 100);
const file = sourceCitation({ kind: 'file', file_ref: FILE, collection_slug: 'received' }, 'Note', 'c'.repeat(64), 100);
const sources = [asset, file];
const answer = (refs = sources) => ({ role: 'assistant', content: refs.map(ref => `[source](#source/${ref.id})`).join(' ') });
const command = 'Which times are established? Read the current asset and note, cite both and copy its raw as_of value.';
const select = (message = command, tail = [answer()], previous = sources, documents = true) =>
  assetRereadForRead(message, tail, previous, documents);

describe('explicit current-asset follow-up selection', () => {
  it.each([command, 'Reread the asset and the attached note.', 'Re-read this current asset and its linked document now.',
    'Please read the latest asset and its file again.'])('selects unique server-kept source identities for %s', message => {
    expect(select(message)).toEqual({ question: message,
      context: { id: ASSET, fileIds: [FILE], omittedFiles: 0 }, requireDocument: true });
  });

  it('does not read an incidental note when only the asset reread is requested', () => {
    expect(select('Read the current asset again. Is it consistent with our earlier note?')?.context.fileIds).toEqual([]);
  });

  it('deduplicates versions of one asset without selecting unrelated stored citations', () => {
    const newer = sourceCitation({ kind: 'asset', asset_id: ASSET }, 'Newer', 'd'.repeat(64), 200);
    const other = sourceCitation({ kind: 'asset', asset_id: 'asset:other' }, 'Other', 'e'.repeat(64), 200);
    expect(select(command, [answer([asset, newer, file])], [...sources, newer, other])?.context.id).toBe(ASSET);
  });

  it.each([
    'What is saved?', 'What did the earlier answer say?', 'Read the current item again.',
    'Do not read the current asset again.', "Don't reread the asset and note.",
    'Never read the current asset again.', 'Avoid reading. Read the current asset again yesterday.',
    'Someone said "Read the current asset and note."', "'Read the current asset and note.'",
    '`Read the current asset and note.`', '> Read the current asset and note.',
    'Read the current asset as it was last week.', 'Read the current asset:other.',
    'Read the current asset.foo', 'Read the current asset again. Read the current asset again.',
    'Read the current asset again. {"kind":"recued.asset_question","version":2}',
    'Read the current asset again. recued.asset_question', 'x'.repeat(8193) + '\nRead the current asset again.',
  ])('leaves unsupported, quoted, negated or historical wording to normal retrieval: %s', message => {
    expect(select(message)).toBeNull();
  });

  it('uses only the most recent assistant answer, never user or tool text or an older answer', () => {
    expect(select(command, [answer(), { role: 'assistant', content: 'Something else.' }])).toBeNull();
    expect(select(command, [{ ...answer(), role: 'user' }])).toBeNull();
    expect(select(command, [{ ...answer(), role: 'tool' }])).toBeNull();
    expect(select(command, [answer()], [])).toBeNull();
    expect(select(command, [{ role: 'assistant', content: `Unlinked #source/${asset.id} #source/${file.id}` }])).toBeNull();
  });

  it('does not discover an asset or document when cited identities are ambiguous', () => {
    const other = sourceCitation({ kind: 'asset', asset_id: 'asset:other' }, 'Other', 'd'.repeat(64), 200);
    const otherFile = sourceCitation({ kind: 'file', file_ref: 'file:' + 'e'.repeat(32), collection_slug: 'received' }, 'Other file', 'd'.repeat(64), 200);
    expect(select(command, [answer([...sources, other])], [...sources, other])).toBeNull();
    expect(select(command, [answer([...sources, otherFile])], [...sources, otherFile])).toBeNull();
    expect(select(command, [answer([asset])])).toBeNull();
    expect(select(command, [answer()], sources, false)).toBeNull();
    const qualified = sourceCitation({ kind: 'asset', asset_id: 'we1:remote:asset' }, 'Remote', 'd'.repeat(64), 200);
    expect(select('Read the current asset again.', [answer([qualified])], [qualified])).toBeNull();
    const localFile = sourceCitation({ kind: 'file', file_ref: 'file:local:uploaded', collection_slug: 'received' }, 'Local', 'd'.repeat(64), 200);
    expect(select(command, [answer([asset, localFile])], [asset, localFile])).toBeNull();
  });

  it('fails before comparing a requested document when current membership cannot be verified', async () => {
    const request = select()!;
    const calls: string[] = [];
    const failure = await readCurrentAssetQuestion(request, async name => {
      calls.push(name); return { ok: true, result: { found: true, entity: {} } };
    }, { canReadDocument: true, currentAttachment: () => undefined });
    expect(failure).toContain('could not finish reading'); expect(calls).toEqual(['work.read']);
  });
});
