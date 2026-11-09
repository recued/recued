/** The owner's 3b (2026-11-07) — what Recued tells a model about a tab showing a PDF: where it kept the
 *  PDF, and how its text is read. ⚠ Model-facing — see `chat-prompt-optimization-log.md`. The DOM adapter
 *  writes the first two into a read's or an action's answer (D-335 slice AS); the chat's turn swaps the
 *  first for the third when it reads the PDF itself (slice AT, `chat-tab-pdf-read.ts`). */

/** 3b — what a read of a tab showing a PDF says first, and what an action ending on one carries: where
 *  Recued kept the PDF, and how its text is read. */
export const pdfKeptNote = (filename: string, file_ref: string): string =>
  `(This tab shows a PDF, which a page read cannot see into. Recued kept it among the user's files as “${filename}” `
  + `(${file_ref}): read its text with document.read, passing that file_ref.)`;

/** 3b — the same, for a PDF that could not be kept. */
export const PDF_NOT_KEPT_NOTE = '(This tab shows a PDF, which a page read cannot see into: save it by its address, with '
  + 'Download a file from a web address or a download step, then read its text with document.read.)';

/** D-335 slice AT — the first, once the chat has read the PDF for the model in the same round: the read
 *  is a call of its own, right after the one whose answer carries this. */
export const pdfReadForYouNote = (filename: string, file_ref: string): string =>
  `(This tab shows a PDF, which a page read cannot see into. Recued kept it among the user's files as “${filename}” `
  + `(${file_ref}) and read it with document.read: that call and its result come next.)`;
