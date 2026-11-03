import { FILE_PREVIEW_TEXT_CHARACTERS } from '@recued/contracts';
import type { DocxParts } from './docx-parts.js';

const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const typesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';

/** Inert, simplified document content. No HTML from the document, relationship
 * targets, embedded objects, external resources or Word field instructions. */
export const drawDocxContent = (doc: Document, body: HTMLElement, parts: DocxParts): boolean => {
  const parser = new doc.defaultView!.DOMParser();
  const parse = (text: string) => {
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) throw new Error('Unsupported DOCX XML declarations.');
    const xml = parser.parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('This DOCX document could not be read.');
    return xml;
  };
  const types = parse(parts.types);
  if (!Array.from(types.getElementsByTagNameNS(typesNamespace, 'Override')).some(element =>
    element.getAttribute('PartName') === '/word/document.xml'
    && element.getAttribute('ContentType') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) {
    throw new Error('This file is not a supported DOCX document.');
  }
  const xml = parse(parts.document), root = xml.documentElement;
  if (root.localName !== 'document' || !wordNamespaces.has(root.namespaceURI ?? '')) throw new Error('This file is not a supported DOCX document.');
  const ns = root.namespaceURI!, content = Array.from(root.children).find(child => child.namespaceURI === ns && child.localName === 'body');
  if (!content) throw new Error('This DOCX document has no readable body.');
  const article = doc.createElement('article'); article.setAttribute('aria-label', 'Document text'); article.className = 'file-preview-document';
  let nodes = 0, characters = 0, truncated = false, readable = false;
  const appendText = (host: HTMLElement, text: string): void => {
    const visible = text.slice(0, FILE_PREVIEW_TEXT_CHARACTERS - characters).replace(/[\uD800-\uDBFF]$/, '');
    host.append(doc.createTextNode(visible)); characters += visible.length;
    truncated ||= visible.length < text.length;
  };
  const attribute = (element: Element, name: string) => element.getAttributeNS(ns, name);
  const child = (element: Element, name: string) => Array.from(element.children).find(item => item.namespaceURI === ns && item.localName === name);
  const visit = (element: Element, host: HTMLElement, depth: number): void => {
    if (truncated || element.namespaceURI !== ns) return;
    if (++nodes > 20_000 || depth > 64) throw new Error('This document is too complex to preview. Download it to open it.');
    const name = element.localName;
    if (['drawing', 'pict', 'object', 'altChunk', 'del', 'instrText', 'txbxContent', 'sectPr', 'pPr', 'rPr', 'tblPr', 'tcPr'].includes(name)) return;
    if (name === 't') {
      const text = element.textContent ?? ''; readable ||= /\S/u.test(text);
      appendText(host, text); return;
    }
    if (['br', 'cr', 'tab'].includes(name)) {
      if (name === 'tab') appendText(host, '\t');
      else if (characters < FILE_PREVIEW_TEXT_CHARACTERS) { host.append(doc.createElement('br')); characters++; }
      else truncated = true;
      return;
    }
    let target = host;
    if (name === 'p') {
      const properties = child(element, 'pPr');
      const heading = properties && child(properties, 'pStyle');
      const match = heading && /^heading([1-6])$/i.exec(attribute(heading, 'val') ?? '');
      target = doc.createElement(match ? `h${match[1]}` : 'p'); host.append(target);
      if (properties && child(properties, 'numPr')) appendText(target, '• ');
    } else if (name === 'tbl' || name === 'tr' || name === 'tc') {
      target = doc.createElement(name === 'tbl' ? 'table' : name === 'tr' ? 'tr' : 'td'); host.append(target);
      if (name === 'tbl') target.setAttribute('aria-label', 'Document table');
    } else if (name === 'r') {
      const properties = child(element, 'rPr');
      if (properties) for (const [property, tag] of [['b', 'strong'], ['i', 'em'], ['u', 'u']] as const) {
        const setting = child(properties, property);
        if (setting && !['0', 'false', 'off', 'none'].includes(attribute(setting, 'val') ?? '')) {
          const wrapper = doc.createElement(tag); target.append(wrapper); target = wrapper;
        }
      }
    }
    for (const item of element.children) visit(item, target, depth + 1);
  };
  for (const item of content.children) visit(item, article, 0);
  if (!readable) {
    const notice = doc.createElement('p'); notice.textContent = 'This document has no text to preview. Download it to view the complete document.';
    article.replaceChildren(notice);
  }
  const style = doc.createElement('style');
  style.textContent = `.file-preview-document { max-width:760px; margin:0 auto; overflow-wrap:anywhere; white-space:pre-wrap; }
    .file-preview-document table { border-collapse:collapse; width:100%; display:block; overflow:auto; }
    .file-preview-document td { border:1px solid var(--border,#bbb); padding:6px 10px; min-width:80px; }
    .file-preview-document td p { margin:2px 0; }`;
  body.append(style, article); return truncated;
};

export const renderDocxPreview = async (doc: Document, host: HTMLElement, bytes: Uint8Array, signal: AbortSignal): Promise<boolean> => {
  const parts = await new Promise<DocxParts | undefined>((resolve, reject) => {
    if (signal.aborted) { resolve(undefined); return; }
    const worker = new Worker(new URL('file-preview/docx.worker.js', doc.baseURI), { type: 'module' });
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { finish(); resolve(undefined); };
    const timer = setTimeout(() => { finish(); reject(new Error('This DOCX preview took too long. Download the file to open it.')); }, 5000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ parts?: DocxParts; error?: string }>) => {
      finish(); if (event.data.parts) resolve(event.data.parts); else reject(new Error(event.data.error ?? 'This DOCX file could not be read.'));
    };
    worker.onerror = event => { event.preventDefault(); finish(); reject(new Error('The document reader could not load. Download the file or retry the preview.')); };
    try { const input = bytes.slice(); worker.postMessage(input, [input.buffer]); }
    catch (error) { finish(); reject(error); }
  });
  return parts && !signal.aborted ? drawDocxContent(doc, host, parts) : false;
};
