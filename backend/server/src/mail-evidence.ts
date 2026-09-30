/** Readable message date and an exact, account-qualified source link. The date
 * is `received_at` as stored: providers take the sender's Date header first,
 * so it is not proof of receipt. Neither establishes chronology within a
 * message or proves a claim is supported. */
export const mailReceivedAtIso = (receivedAt: number | undefined): string | null => {
  if (receivedAt === undefined || !Number.isFinite(receivedAt)) return null;
  const date = new Date(receivedAt);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export const mailEvidenceMetadata = (slug: string, recordId: string, receivedAt: number | undefined) => ({
  // The webclient's exact Data record route. Encode punctuation too so the
  // address can be copied into a Markdown link without ending it early.
  source_url: '#data/mail/record/' + [slug, recordId].map(value =>
    encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()),
  ).join('/'),
  received_at_iso: mailReceivedAtIso(receivedAt),
});
