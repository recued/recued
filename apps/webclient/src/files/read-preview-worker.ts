/** One bounded request to a bundled reader. Closing a preview retires its work
 * and terminates the worker, including a reader that never sends a reply. */
export const readPreviewWorker = <T>(doc: Document, kind: 'docx' | 'xlsx', bytes: Uint8Array, signal: AbortSignal): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) { resolve(undefined); return; }
    const label = kind === 'xlsx' ? 'workbook' : 'document';
    let worker: Worker;
    try { worker = new Worker(new URL(`file-preview/${kind}.worker.js`, doc.baseURI), { type: 'module' }); }
    catch { reject(new Error(`The ${label} reader could not load. Download the file or retry the preview.`)); return; }
    let settled = false;
    const finish = () => { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { if (!settled) { finish(); resolve(undefined); } };
    const timer = setTimeout(() => { if (!settled) { finish(); reject(new Error(`This ${label} preview took too long. Download the file to open it.`)); } }, 5000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ parts?: T; error?: string }>) => {
      if (settled) return;
      finish(); if (event.data.parts) resolve(event.data.parts);
      else reject(new Error(event.data.error ?? `This ${label} could not be read. Download it to open it.`));
    };
    worker.onerror = event => {
      event.preventDefault(); if (settled) return;
      finish(); reject(new Error(`The ${label} reader could not load. Download the file or retry the preview.`));
    };
    try { const input = bytes.slice(); worker.postMessage(input, [input.buffer]); }
    catch { if (!settled) { finish(); reject(new Error(`This ${label} could not be read. Download it to open it.`)); } }
  });
