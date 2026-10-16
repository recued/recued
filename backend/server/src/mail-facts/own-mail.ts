/** D-318 audit — the mail Recued sent itself, which the mail facts leave out
 *  (D-315: a receipt Recued sent a customer is not a purchase of the owner's).
 *
 *  ⛔ KNOWN BY RECUED'S OWN RECORD, NEVER BY THE HEADER. Every send that carries
 *  a reconciliation id records a claim before it goes (D-207,
 *  `mail-send-claim-store.ts`), and only that record says Recued sent it. The
 *  `X-Recued-Reconciliation-ID` header is anyone's to write, and alone it kept a
 *  stranger's email out of every mail fact — a security notice, a bill.
 *  Without `isOwnSend`, no message is Recued's own. */

import { isMailReconciliationId } from '@recued/contracts';

export const sentByRecued = (
  reconciliation_id: unknown,
  isOwnSend: ((reconciliation_id: string) => boolean) | undefined,
): boolean => isMailReconciliationId(reconciliation_id) && isOwnSend?.(reconciliation_id) === true;
