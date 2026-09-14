import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import pdfjsPackage from 'pdfjs-dist/package.json';
import { FILE_PREVIEW_TEXT_CHARACTERS } from '@recued/contracts';

/** PDF.js renders pixels and text only. Its packaged worker/assets stay on the
 * app's origin; document scripts, forms and link actions are never mounted. */
export const renderPdfPreview = async (
  doc: Document, host: HTMLElement, bytes: Uint8Array, signal: AbortSignal,
  fail: (error: unknown) => void,
): Promise<void> => {
  const assets = new URL(`file-preview/${pdfjsPackage.version}/`, doc.baseURI);
  const pdfjs = await import(new URL('pdf.mjs', assets).href) as typeof import('pdfjs-dist');
  if (signal.aborted) return;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', assets).href;
  let task: PDFDocumentLoadingTask | undefined;
  let drawing: RenderTask | undefined;
  let sequence = 0;
  const stop = () => { sequence++; drawing?.cancel(); void task?.destroy().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  task = pdfjs.getDocument({ data: bytes.slice(), ownerDocument: doc,
    cMapUrl: new URL('cmaps/', assets).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assets).href, wasmUrl: new URL('wasm/', assets).href,
    // Packaged JS codecs and canvas font paths respect the app's no-eval CSP.
    iccUrl: new URL('iccs/', assets).href, enableXfa: false, disableFontFace: true, useWasm: false,
    maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32_000_000,
  });
  const pdf = await task.promise;
  if (signal.aborted) return;
  const toolbar = doc.createElement('div'); toolbar.className = 'file-preview-controls';
  const pageLabel = doc.createElement('span'); pageLabel.setAttribute('role', 'status');
  const surface = doc.createElement('div'); surface.className = 'file-preview-pdf-page';
  const text = doc.createElement('pre'); text.hidden = true; text.setAttribute('aria-label', 'PDF page text');
  let pageNumber = 1; let zoom = 1;
  const button = (label: string, action: () => void) => {
    const item = doc.createElement('button'); item.type = 'button'; item.textContent = label;
    item.addEventListener('click', action); toolbar.append(item); return item;
  };
  const previous = button('Previous page', () => { pageNumber--; void render().catch(fail); });
  toolbar.append(pageLabel);
  const next = button('Next page', () => { pageNumber++; void render().catch(fail); });
  const smaller = button('Zoom out', () => { zoom = Math.max(.5, zoom - .25); void render().catch(fail); });
  const larger = button('Zoom in', () => { zoom = Math.min(2, zoom + .25); void render().catch(fail); });
  const showText = button('Show page text', () => {
    text.hidden = !text.hidden; showText.textContent = text.hidden ? 'Show page text' : 'Hide page text';
    showText.setAttribute('aria-pressed', String(!text.hidden));
  });
  showText.setAttribute('aria-pressed', 'false');
  const render = async () => {
    const own = ++sequence; drawing?.cancel();
    previous.disabled = pageNumber <= 1; next.disabled = pageNumber >= pdf.numPages;
    smaller.disabled = zoom <= .5; larger.disabled = zoom >= 2;
    pageLabel.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
    text.textContent = '';
    const page = await pdf.getPage(pageNumber);
    if (signal.aborted || own !== sequence) return;
    const natural = page.getViewport({ scale: 1 });
    const ratio = Math.min(2, doc.defaultView?.devicePixelRatio ?? 1);
    const width = Math.max(200, host.clientWidth - 24);
    const scale = Math.min(width / natural.width * zoom * ratio,
      8192 / natural.width, 8192 / natural.height, Math.sqrt(8_000_000 / (natural.width * natural.height)));
    const viewport = page.getViewport({ scale });
    const canvas = doc.createElement('canvas'); canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `PDF page ${pageNumber} of ${pdf.numPages}`);
    canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.style.width = `${canvas.width / ratio}px`; canvas.style.height = `${canvas.height / ratio}px`;
    surface.replaceChildren(canvas);
    drawing = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE });
    try { await drawing.promise; }
    catch (error) { if (signal.aborted || own !== sequence) return; throw error; }
    const content = await page.getTextContent();
    if (signal.aborted || own !== sequence) return;
    let pageText = '';
    for (const item of content.items) {
      if ('str' in item) pageText += item.str + (item.hasEOL ? '\n' : ' ');
      if (pageText.length > FILE_PREVIEW_TEXT_CHARACTERS) break;
    }
    if (pageText.length > FILE_PREVIEW_TEXT_CHARACTERS) {
      pageText = pageText.slice(0, FILE_PREVIEW_TEXT_CHARACTERS).replace(/[\uD800-\uDBFF]$/, '') + '\n[Page text shortened. Download the file to read the rest.]';
    }
    text.textContent = pageText;
    canvas.setAttribute('data-file-preview-rendered', '');
    page.cleanup();
  };
  host.replaceChildren(toolbar, surface, text);
  await render();
};
