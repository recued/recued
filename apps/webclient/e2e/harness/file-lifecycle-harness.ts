import { bootstrapDataRoute } from '../../src/data/bootstrap-data-route.js';

const rpc = async <T>(method: string, args: unknown = {}): Promise<T> => {
  const response = await fetch('/file-lifecycle-rpc', { method: 'POST', body: JSON.stringify({ method, args }) });
  const envelope = await response.json(); if (envelope.error) throw new Error(envelope.error); return envelope.result;
};
const file = new URL(location.href).searchParams.get('file');
const route = bootstrapDataRoute({ root: document.getElementById('app')!, initialTab: 'files', initialCollectionSlug: 'received',
  ...(file ? { initialEntityId: file } : {}),
  collectionListInstancesCaller: () => rpc('collection.listInstances'),
  collectionListCaller: args => rpc('collection.list', args),
  collectionGetCaller: args => rpc('collection.get', args),
  fileReadCaller: args => rpc('data.file.read', args),
  fileUsageCaller: args => rpc('data.file.usage', args),
  fileMutateCaller: args => rpc('data.file.mutate', args),
});
void route.whenLoaded().then(() => document.body.setAttribute('data-ready', 'true'));
