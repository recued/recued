import { readXlsxParts } from './xlsx-parts.js';
import { XlsxPreviewError } from './xlsx-model.js';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<Uint8Array>) => void;
  postMessage: (value: unknown) => void;
};
worker.onmessage = event => {
  try { worker.postMessage({ parts: readXlsxParts(event.data) }); }
  catch (error) { worker.postMessage({ error: error instanceof XlsxPreviewError ? error.message
    : 'This workbook could not be read. Download it to open it.' }); }
};
