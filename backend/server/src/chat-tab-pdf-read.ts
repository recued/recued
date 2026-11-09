/** D-335 slice AT (2026-11-07) — a tab showing a PDF, read in the round that reached it. The owner: "go
 *  ahead with #1, then #2", #2 being: when a sequence lands on a PDF and keeps it, put the PDF's text in
 *  that same round, saving the separate `document.read` one. Task K's runs clicked the PDF's link, the
 *  answer carrying the kept PDF (slice AS), and then spent a round (5.7 to 14.6 s) writing that call.
 *
 *  The turn makes the read itself (`chat-turn-executor.ts`), as the model would next: `document.read` on
 *  the kept PDF, the same tool under the turn's own caller, a call of its own right after the one whose
 *  answer kept it, as mail a search found is read in the search's round. These find the PDFs an answer
 *  kept, by AS's own note, and swap that note, which told the model to read it, for one saying the read
 *  comes next. */
import type { ChatDispatchResult } from '@recued/contracts';
import { pdfKeptNote, pdfReadForYouNote } from './bridges/pdf-tab-notes.js';

/** A PDF a tab showed, kept among the owner's files. */
export interface KeptTabPdf {
  readonly file_ref: string;
  readonly filename: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** How deep an answer is searched: a sequence's tabs are about six levels down. */
const MAX_DEPTH = 16;

/** The PDFs a call's answer kept from the tab it read or ended on, each once, in the order found. Only a
 *  `pdf` that AS wrote, carrying AS's note for that very file, counts: any other `pdf` is left alone. */
export const keptTabPdfs = (result: ChatDispatchResult): KeptTabPdf[] => {
  if (!result.ok) return [];
  const found = new Map<string, KeptTabPdf>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const pdf = (value as Record<string, unknown>).pdf;
    if (isRecord(pdf) && typeof pdf.file_ref === 'string' && typeof pdf.filename === 'string'
      && pdf.mime_type === 'application/pdf' && pdf.note === pdfKeptNote(pdf.filename, pdf.file_ref)
      && !found.has(pdf.file_ref)) {
      found.set(pdf.file_ref, { file_ref: pdf.file_ref, filename: pdf.filename });
    }
    for (const inner of Object.values(value)) walk(inner, depth + 1);
  };
  walk(result.result, 0);
  return [...found.values()];
};

/** The answer with AS's note for `pdf`, wherever it carries it (the PDF's own `note`, the head of a read's
 *  text or outline), saying the PDF was read and the read comes next. */
export const withTabPdfReadNote = (result: ChatDispatchResult, pdf: KeptTabPdf): ChatDispatchResult => {
  if (!result.ok) return result;
  const before = pdfKeptNote(pdf.filename, pdf.file_ref);
  const after = pdfReadForYouNote(pdf.filename, pdf.file_ref);
  const swap = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return value.includes(before) ? value.split(before).join(after) : value;
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => swap(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swap(inner, depth + 1)]));
  };
  return { ...result, result: swap(result.result, 0) };
};
