import { readDocxParts, DocxPreviewError } from './docx-parts.js';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<Uint8Array>) => void;
  postMessage: (value: unknown) => void;
};
worker.onmessage = event => {
  try { worker.postMessage({ parts: readDocxParts(event.data) }); }
  catch (error) { worker.postMessage({ error: error instanceof DocxPreviewError ? error.message : 'This DOCX file could not be read. Download it to open it.' }); }
};
