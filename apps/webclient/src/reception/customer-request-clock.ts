/** Keep a response's server time advancing without following device clock edits. */
export type CustomerRequestClock = () => number;

export const customerRequestClock = (doc: Document, serverNow?: number): CustomerRequestClock => {
  const elapsed = () => doc.defaultView?.performance?.now() ?? Date.now();
  const started = elapsed();
  const reference = Number.isSafeInteger(serverNow) ? serverNow! : Date.now();
  return () => reference + Math.max(0, elapsed() - started);
};
