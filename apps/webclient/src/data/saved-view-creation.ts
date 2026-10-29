import {
  parseSavedDataViewDefinition, type SavedDataView, type SavedDataViewCreateRequest,
  type SavedDataViewCreateOnceRequest, type SavedDataViewCreation, type SavedDataViewDefinition,
} from '@recued/contracts';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface SavedViewCreationClient {
  create(args: SavedDataViewCreateRequest): Promise<{ view: SavedDataView }>;
  createOnce?(args: SavedDataViewCreateOnceRequest): Promise<SavedDataViewCreation>;
  getCreation?(args: SavedDataViewCreateOnceRequest): Promise<{ creation: SavedDataViewCreation | null }>;
}
export interface SavedViewCreateAttempt {
  request: SavedDataViewCreateOnceRequest;
  safe: boolean;
}
export type SavedViewCreateResult =
  | { kind: 'saved'; view: SavedDataView }
  | { kind: 'removed'; view_id: string }
  | { kind: 'retryable' | 'uncertain' | 'rejected'; message: string };

export const newSavedViewCreateAttempt = (name: string, definition: SavedDataViewDefinition, safe: boolean): SavedViewCreateAttempt => ({
  safe, request: { request_id: crypto.randomUUID(), name: name.trim(), definition: structuredClone(definition) },
});
const viewId = (id: unknown): id is string => typeof id === 'string' && /^view_[a-f0-9-]{36}$/.test(id);
const validView = (view: SavedDataView): boolean => view !== null && typeof view === 'object'
  && viewId(view.id) && typeof view.name === 'string' && view.name.trim().length > 0
  && Number.isSafeInteger(view.revision) && view.revision > 0 && parseSavedDataViewDefinition(view.definition) !== null;
const receiptResult = (attempt: SavedViewCreateAttempt, receipt: SavedDataViewCreation): SavedViewCreateResult => {
  if (!receipt || receipt.request_id !== attempt.request.request_id || !viewId(receipt.view_id)
    || receipt.view !== null && (!validView(receipt.view) || receipt.view.id !== receipt.view_id)) {
    throw new Error('The server did not confirm this saved view. Check the save before trying again.');
  }
  return receipt.view === null ? { kind: 'removed', view_id: receipt.view_id } : { kind: 'saved', view: receipt.view };
};

/** Reads only. A missing receipt permits a retry of the SAME immutable request;
 * it never authorizes a fresh creation identity or changes the captured filters. */
export const checkSavedViewCreation = async (
  client: SavedViewCreationClient, attempt: SavedViewCreateAttempt,
): Promise<SavedViewCreateResult> => {
  if (!attempt.safe || !client.getCreation) return { kind: 'uncertain',
    message: 'This save could not be confirmed. Open Saved views to inspect it before starting another save.' };
  try {
    const result = await client.getCreation(attempt.request);
    return result.creation === null ? { kind: 'retryable',
      message: 'This save has not been confirmed. Try saving again to continue the same request, or check again.' }
      : receiptResult(attempt, result.creation);
  } catch (error) {
    // A refusal of this read says nothing about whether the earlier write
    // committed. Keep its identity until a receipt confirms the outcome.
    return { kind: 'uncertain', message: `Could not check this save: ${humanizeRpcError(error)} Check the saved view before trying again.` };
  }
};

export const submitSavedViewCreation = async (
  client: SavedViewCreationClient, attempt: SavedViewCreateAttempt, retrying = false,
): Promise<SavedViewCreateResult> => {
  try {
    if (attempt.safe) {
      if (!client.createOnce) return retrying ? checkSavedViewCreation(client, attempt)
        : { kind: 'rejected', message: 'Update this server to save views with recovery.' };
      const receipt = await client.createOnce(attempt.request);
      const result = receiptResult(attempt, receipt);
      if (result.kind === 'removed') return result;
      const checked = await checkSavedViewCreation(client, attempt);
      return checked.kind === 'retryable' ? { kind: 'uncertain', message: 'The save was accepted, but its current record could not be confirmed. Check the saved view.' } : checked;
    }
    const { name, definition } = attempt.request;
    const { view } = await client.create({ name, definition });
    if (!validView(view)) throw new Error('The server did not confirm the saved view.');
    return { kind: 'saved', view };
  } catch (error) {
    const failure = classifyRpcError(error);
    // An initial refusal is definitive. Refusing a retry does not settle the
    // earlier unknown write, which may have committed in the meantime.
    if (!retrying && ['bad_request', 'conflict', 'unauthorized', 'forbidden', 'not_implemented', 'unknown_method'].includes(failure.code ?? '')) {
      return { kind: 'rejected', message: failure.code === 'unknown_method' || failure.code === 'not_implemented'
        ? 'Update this server to save views with recovery.' : humanizeRpcError(error) };
    }
    return checkSavedViewCreation(client, attempt);
  }
};
