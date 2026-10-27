/** View-local reading state. Message identity survives a differently sized window. */
export interface TranscriptPosition {
  atLatest: boolean;
  messageId?: string;
  offset: number;
  scrollTop: number;
}

export const transcriptAtBottom = (scroller: HTMLElement): boolean =>
  scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 24;

export const captureTranscriptPosition = (scroller: HTMLElement, hasLater: boolean): TranscriptPosition => {
  const position: TranscriptPosition = { atLatest: !hasLater && transcriptAtBottom(scroller), offset: 0, scrollTop: scroller.scrollTop };
  if (typeof scroller.getBoundingClientRect !== 'function') return position;
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-recued-chat-route-message]')) {
    const box = row.getBoundingClientRect();
    if (box.bottom > top + 1) {
      position.messageId = row.getAttribute('data-recued-chat-route-message') ?? undefined;
      position.offset = box.top - top;
      break;
    }
  }
  return position;
};

export const restoreTranscriptPosition = (scroller: HTMLElement, position: TranscriptPosition): void => {
  if (position.atLatest) {
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return;
  }
  const row = Array.from(scroller.querySelectorAll<HTMLElement>('[data-recued-chat-route-message]'))
    .find(node => node.getAttribute('data-recued-chat-route-message') === position.messageId);
  if (row && typeof row.getBoundingClientRect === 'function' && typeof scroller.getBoundingClientRect === 'function') {
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offset;
  } else scroller.scrollTop = Math.min(position.scrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
};
