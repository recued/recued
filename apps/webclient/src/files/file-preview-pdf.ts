import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import pdfjsPackage from 'pdfjs-dist/package.json';
import { buildPdfText, createPdfSearch, type PdfSearchState, type PdfTextRun } from './pdf-search.js';

type TextItem = Extract<Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number], { str: string }>;

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
  let task: PDFDocumentLoadingTask | undefined, drawing: RenderTask | undefined, textLayer: TextLayer | undefined;
  let search: ReturnType<typeof createPdfSearch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0, pageNumber = 1, zoom = 1, navigation = 0;
  const stop = () => {
    sequence++; clearTimeout(timer); search?.dispose(); drawing?.cancel(); textLayer?.cancel();
    void task?.destroy().catch(() => {}).finally(() => pdfjs.TextLayer.cleanup());
  };
  signal.addEventListener('abort', stop, { once: true });
  task = pdfjs.getDocument({ data: bytes.slice(), ownerDocument: doc,
    cMapUrl: new URL('cmaps/', assets).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assets).href, wasmUrl: new URL('wasm/', assets).href,
    iccUrl: new URL('iccs/', assets).href, enableXfa: false, disableFontFace: true, useWasm: false,
    maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32_000_000,
  });
  const pdf = await task.promise;
  if (signal.aborted) return;
  const root = doc.createElement('section'); root.className = 'pdf-preview';
  const style = doc.createElement('style'); style.textContent = PDF_PREVIEW_STYLES;
  const toolbar = doc.createElement('div'); toolbar.className = 'file-preview-controls pdf-page-controls';
  const pageLabel = doc.createElement('span'); pageLabel.setAttribute('role', 'status');
  const surface = doc.createElement('div'); surface.className = 'file-preview-pdf-page';
  const text = doc.createElement('pre'); text.hidden = true; text.setAttribute('aria-label', 'PDF page text');
  const button = (parent: HTMLElement, label: string, action: () => void) => {
    const item = doc.createElement('button'); item.type = 'button'; item.textContent = label;
    item.addEventListener('click', action, { signal }); parent.append(item); return item;
  };
  const redraw = () => {
    const pending = render(), own = sequence;
    void pending.catch(error => { if (!signal.aborted && own === sequence) fail(error); });
  };
  const goTo = (number: number, manual = true) => {
    if (signal.aborted) return;
    if (manual) { navigation++; automatic = null; scrollMatch = false; }
    pageNumber = number; pageInput.value = String(number); pageError.hidden = true; pageInput.removeAttribute('aria-invalid');
    if (displayed?.page === number) paintMatches(); else redraw();
  };
  const previous = button(toolbar, 'Previous page', () => goTo(Math.max(1, pageNumber - 1)));
  toolbar.append(pageLabel);
  const next = button(toolbar, 'Next page', () => goTo(Math.min(pdf.numPages, pageNumber + 1)));
  const pageField = doc.createElement('label'); pageField.textContent = 'Go to page ';
  const pageInput = doc.createElement('input'); pageInput.type = 'number'; pageInput.min = '1'; pageInput.max = String(pdf.numPages);
  pageInput.step = '1'; pageInput.value = '1'; pageInput.inputMode = 'numeric'; pageInput.setAttribute('aria-label', 'Page number');
  pageField.append(pageInput); toolbar.append(pageField);
  const pageError = doc.createElement('p'); pageError.setAttribute('role', 'alert'); pageError.hidden = true;
  const jump = () => {
    const number = Number(pageInput.value);
    if (!pageInput.value.trim() || !Number.isSafeInteger(number) || number < 1 || number > pdf.numPages) {
      pageInput.setAttribute('aria-invalid', 'true'); pageError.textContent = `Enter a whole page number from 1 to ${pdf.numPages}.`; pageError.hidden = false; return;
    }
    goTo(number);
  };
  button(toolbar, 'Go to page', jump);
  pageInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } }, { signal });
  const smaller = button(toolbar, 'Zoom out', () => { navigation++; automatic = null; zoom = Math.max(.5, zoom - .25); redraw(); });
  const larger = button(toolbar, 'Zoom in', () => { navigation++; automatic = null; zoom = Math.min(2, zoom + .25); redraw(); });
  const showText = button(toolbar, 'Show page text', () => {
    text.hidden = !text.hidden; showText.textContent = text.hidden ? 'Show page text' : 'Hide page text';
    showText.setAttribute('aria-pressed', String(!text.hidden));
  });
  showText.setAttribute('aria-pressed', 'false');

  const findBar = doc.createElement('div'); findBar.className = 'file-preview-controls pdf-find';
  const findLabel = doc.createElement('label'); findLabel.textContent = 'Find in PDF ';
  const findInput = doc.createElement('input'); findInput.type = 'search'; findInput.maxLength = 512;
  findInput.autocomplete = 'off'; findInput.setAttribute('aria-label', 'Find in PDF'); findLabel.append(findInput); findBar.append(findLabel);
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('data-pdf-find-status', '');
  let automatic: { owner: Element | null; navigation: number } | null = null, scrollMatch = false;
  let paintedKey = '';
  let displayed: { page: number; model: ReturnType<typeof buildPdfText<TextItem>>; layer: TextLayer } | undefined;
  const runSearch = () => {
    clearTimeout(timer); automatic = { owner: doc.activeElement, navigation }; void search?.start();
  };
  button(findBar, 'Find', runSearch);
  const previousMatch = button(findBar, 'Previous match', () => { automatic = null; search?.previous(); });
  const nextMatch = button(findBar, 'Next match', () => { automatic = null; search?.next(); });
  const cancelSearch = button(findBar, 'Stop search', () => { automatic = null; clearTimeout(timer); search?.stop(); findInput.focus({ preventScroll: true }); });

  const appendMatches = (element: HTMLElement, value: string, offset: number, ranges: readonly (PdfTextRun & { index: number })[]) => {
    element.replaceChildren(); let cursor = 0;
    for (const range of ranges) {
      const from = Math.max(0, range.start - offset), to = Math.min(value.length, range.end - offset);
      if (from >= to || to <= cursor) continue;
      element.append(doc.createTextNode(value.slice(cursor, from)));
      const mark = doc.createElement('mark'); mark.textContent = value.slice(from, to);
      mark.setAttribute('data-pdf-find-match', String(range.index));
      if (search?.state().active === range.index) mark.setAttribute('data-pdf-find-active', '');
      element.append(mark); cursor = to;
    }
    element.append(doc.createTextNode(value.slice(cursor)));
  };
  const paintMatches = () => {
    if (!displayed || signal.aborted) return;
    const current = displayed;
    const ranges = (search?.state().matches ?? []).map((match, index) => ({ ...match, index })).filter(match => match.page === current.page);
    const key = `${current.page}\n${search?.state().query}\n${search?.state().active}\n${ranges.map(range => `${range.start}:${range.end}:${range.index}`).join(',')}`;
    // Background search progress must not rebuild the visible page's text.
    if (key !== paintedKey) {
      for (const [index, run] of current.model.runs.entries()) {
        const span = current.layer.textDivs[index];
        if (span) appendMatches(span, current.model.items[index]!.str, run.start, ranges);
      }
      appendMatches(text, current.model.text, 0, ranges);
      if (current.model.truncated) text.append(doc.createTextNode('\n[Page text shortened. Download the file to read the rest.]'));
      paintedKey = key;
    }
    if (scrollMatch) {
      scrollMatch = false;
      const target = surface.querySelector<HTMLElement>('[data-pdf-find-active]'), ownNavigation = navigation;
      // WebKit reveals the search caret during painting. Reveal the match
      // after that paint, provided the page, selection and user intent survive.
      const reveal = () => {
        if (!signal.aborted && displayed === current && ownNavigation === navigation && target?.isConnected) {
          target.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
      };
      if (doc.defaultView) doc.defaultView.requestAnimationFrame(() => setTimeout(reveal, 0)); else reveal();
    }
  };
  const updateSearch = (state: PdfSearchState) => {
    previousMatch.disabled = nextMatch.disabled = state.matches.length === 0;
    cancelSearch.hidden = state.phase !== 'searching';
    const count = state.matches.length, selected = state.matches[state.active];
    const summary = selected ? `Match ${state.active + 1} of ${count} · page ${selected.page}` : `${count} ${count === 1 ? 'match' : 'matches'}`;
    const partial = state.limited || state.unreadable > 0;
    status.textContent = state.phase === 'idle' ? 'Find words in this PDF.'
      : state.phase === 'searching' ? `Searching page ${Math.min(state.searched + 1, state.total)} of ${state.total}… ${count} matches so far.`
      : state.phase === 'stopped' ? `Search stopped after ${state.searched} of ${state.total} pages. ${summary} found so far.`
      : !partial && state.textPages === 0 ? 'This PDF has no searchable text.'
      : (count ? summary : partial ? 'No matches in the searched text.' : 'No matches found.')
        + (state.limited ? ` Search limits reached after ${state.searched} of ${state.total} pages; some text was not searched.` : '')
        + (state.unreadable ? ` ${state.unreadable} ${state.unreadable === 1 ? 'page could' : 'pages could'} not be searched.` : '');
    paintMatches();
    if (state.phase === 'done' && automatic && count) {
      const intent = automatic; automatic = null;
      if (intent.owner === doc.activeElement && intent.navigation === navigation) search?.select(0);
    }
  };
  search = createPdfSearch({ total: pdf.numPages,
    read: async number => {
      const page = await pdf.getPage(number), content = await page.getTextContent();
      const model = buildPdfText(content.items.filter((item): item is TextItem => 'str' in item));
      return { text: model.text, truncated: model.truncated };
    },
    changed: updateSearch,
    selected: match => { scrollMatch = true; goTo(match.page, false); },
  });
  findInput.addEventListener('input', () => {
    clearTimeout(timer); automatic = null; search!.setQuery(findInput.value);
    if (findInput.value.trim()) timer = setTimeout(runSearch, 180);
  }, { signal });
  findInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); if (search!.state().matches.length) { automatic = null; event.shiftKey ? search!.previous() : search!.next(); } else runSearch(); }
    else if (event.key === 'Escape' && findInput.value) {
      event.preventDefault(); event.stopPropagation(); clearTimeout(timer); automatic = null; findInput.value = ''; search!.setQuery('');
    }
  }, { signal });
  const keyboardOwner = host.closest('[data-file-preview]') ?? host;
  keyboardOwner.addEventListener('keydown', event => {
    if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault(); findInput.focus(); findInput.select();
    }
  }, { signal });

  const render = async () => {
    const own = ++sequence, number = pageNumber, factor = zoom; drawing?.cancel(); textLayer?.cancel(); displayed = undefined; paintedKey = '';
    previous.disabled = number <= 1; next.disabled = number >= pdf.numPages;
    smaller.disabled = factor <= .5; larger.disabled = factor >= 2;
    pageLabel.textContent = `Page ${number} of ${pdf.numPages}`; text.replaceChildren();
    const page = await pdf.getPage(number);
    if (signal.aborted || own !== sequence) return;
    const natural = page.getViewport({ scale: 1 }), ratio = Math.min(2, doc.defaultView?.devicePixelRatio ?? 1);
    const width = Math.max(200, host.clientWidth - 24);
    const scale = Math.min(width / natural.width * factor * ratio,
      8192 / natural.width, 8192 / natural.height, Math.sqrt(8_000_000 / (natural.width * natural.height)));
    const viewport = page.getViewport({ scale }), cssViewport = page.getViewport({ scale: scale / ratio });
    const canvas = doc.createElement('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `PDF page ${number} of ${pdf.numPages}`);
    canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.style.width = `${canvas.width / ratio}px`; canvas.style.height = `${canvas.height / ratio}px`;
    const pageBox = doc.createElement('div'); pageBox.className = 'pdf-page-box';
    pageBox.style.width = canvas.style.width; pageBox.style.height = canvas.style.height;
    pageBox.append(canvas); surface.replaceChildren(pageBox);
    drawing = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE });
    try { await drawing.promise; } catch (error) { if (signal.aborted || own !== sequence) return; throw error; }
    const content = await page.getTextContent();
    if (signal.aborted || own !== sequence) return;
    const model = buildPdfText(content.items.filter((item): item is TextItem => 'str' in item));
    const layerHost = doc.createElement('div'); layerHost.className = 'pdf-text-layer'; layerHost.setAttribute('aria-hidden', 'true');
    const totalScale = cssViewport.scale * page.userUnit;
    layerHost.style.setProperty('--total-scale-factor', String(totalScale));
    pageBox.append(layerHost);
    const layer = new pdfjs.TextLayer({ textContentSource: { ...content, items: model.items }, container: layerHost, viewport: cssViewport });
    textLayer = layer;
    const unrotated = page.getViewport({ scale: scale / ratio, rotation: 0 });
    layerHost.style.width = `${unrotated.width}px`;
    layerHost.style.height = `${unrotated.height}px`;
    await layer.render();
    if (signal.aborted || own !== sequence) return;
    displayed = { page: number, model, layer }; paintMatches();
    canvas.setAttribute('data-file-preview-rendered', ''); page.cleanup();
  };
  updateSearch(search.state());
  root.append(style, toolbar, pageError, findBar, status, surface, text); host.replaceChildren(root);
  await render();
};

const PDF_PREVIEW_STYLES = `
.pdf-preview .pdf-page-controls input { width:5em; }
.pdf-preview input { min-height:44px; padding:6px 8px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:6px; }
.pdf-preview label { display:flex; align-items:center; gap:6px; white-space:nowrap; }
.pdf-preview .file-preview-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:10px 0; }
.pdf-preview [hidden] { display:none !important; }
.pdf-preview .file-preview-pdf-page { overflow:auto; max-width:100%; }
.pdf-find label { flex:1 1 200px; }
.pdf-find input { width:100%; min-width:0; }
.pdf-preview button { min-height:44px; font:inherit; }
.pdf-preview [data-pdf-find-status] { font-size:13px; color:var(--fg-muted); }
.pdf-page-box { position:relative; }
.pdf-text-layer { position:absolute; inset:0; overflow:clip; line-height:1; text-size-adjust:none; transform-origin:0 0; pointer-events:none;
  --text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size)); --min-font-size-inv:calc(1 / var(--min-font-size)); }
.pdf-text-layer > span { position:absolute; white-space:pre; color:transparent; transform-origin:0 0; font-size:calc(var(--text-scale-factor) * var(--font-height));
  transform:rotate(var(--rotate,0deg)) scaleX(var(--scale-x,1)) scale(var(--min-font-size-inv)); }
.pdf-text-layer br { display:none; }
.pdf-text-layer[data-main-rotation="90"] { transform:rotate(90deg) translateY(-100%); }
.pdf-text-layer[data-main-rotation="180"] { transform:rotate(180deg) translate(-100%,-100%); }
.pdf-text-layer[data-main-rotation="270"] { transform:rotate(270deg) translateX(-100%); }
.pdf-text-layer mark { color:transparent; background:rgb(255 220 0 / .45); font:inherit; padding:0; }
.pdf-preview [data-pdf-find-active] { background:rgb(255 140 0 / .6); outline:1px solid #b35b00; }
.pdf-preview pre mark { color:var(--fg); background:color-mix(in srgb,var(--accent) 22%,var(--surface)); }
.pdf-preview :is(input,button):focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
`;
