/** Shared resumable-upload engine + widget — barrel.
 *
 *  The CLIENT half of D-172 webclient uploads: a framework-agnostic state
 *  machine over the shipped binary `/ws/upload` transport + `upload.*` rpc
 *  control plane, plus a vanilla-DOM progress widget. See `types.ts` for the
 *  layering. The wire format itself lives in `@recued/contracts`.
 */

export type {
  UploadCallers,
  UploadAckMessage,
  UploadSocket,
  UploadConnectFactory,
  UploadDigest,
  UploadFile,
  UploadFileSlice,
  UploadResumeStore,
  UploadPhase,
  UploadProgress,
  UploadProgressListener,
  UploadEngine,
  UploadEngineOptions,
  UploadWidgetConfig,
  WireUploadWidgetOptions,
  UploadHandle,
  // Transport seam (data plane)
  UploadTransport,
  UploadChunkSend,
  UploadChunkOutcome,
  WsUploadTransportOptions,
  HttpUploadTransportOptions,
  UploadFetch,
  UploadFetchResponse,
  UploadFetchInit,
} from './types.js';

export { UploadTransportFault } from './types.js';

export { createUploadEngine } from './engine.js';
export { createWsUploadTransport } from './ws-transport.js';
export { createHttpUploadTransport } from './http-transport.js';

export {
  renderUploadWidget,
  renderUploadProgress,
  uploadShellAttr,
  UPLOAD_SHELL_ATTR,
  UPLOAD_INPUT_ATTR,
  UPLOAD_DROPZONE_ATTR,
  UPLOAD_PROGRESS_ATTR,
  UPLOAD_CANCEL_ATTR,
} from './render.js';

export { wireUploadWidget } from './wire.js';

export { UPLOAD_STYLES } from './styles.js';
