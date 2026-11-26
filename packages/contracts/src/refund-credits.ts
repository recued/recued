import { COMMITMENT_AMOUNT_REGEX, type Commitment, type MonetaryValue } from './work-entities.js';

export const REFUND_WATCH_RECIPE = 'track-refund-from-cancelled-order';
export const REFUND_STATEMENT_OWNER = { publisher: 'recued-core', pack_slug: 'statement-import' } as const;
export const REFUND_STATEMENT_KIND = 'statement_line';
export const REFUND_CREDIT_LIMIT = 50;

export const refundWatchOrder = (commitment: Commitment): { merchant: string; order_id: string } | null => {
  const data = commitment.source_extension_blob;
  if (commitment.direction !== 'inbound' || data?.authored_by_recipe_id !== REFUND_WATCH_RECIPE
    || typeof data.merchant !== 'string' || !data.merchant.trim()
    || typeof data.order_id !== 'string' || !data.order_id.trim()) return null;
  return { merchant: data.merchant, order_id: data.order_id };
};

/** The same two-decimal precision used by saved commitment amounts. */
export const refundCents = (amount: string): bigint | null => {
  if (amount.length > 24 || !COMMITMENT_AMOUNT_REGEX.test(amount) || amount.startsWith('-')) return null;
  const [whole, fraction = ''] = amount.split('.');
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? cents : null;
};

export const formatRefundCents = (cents: bigint): string => {
  const digits = cents.toString().padStart(3, '0');
  return digits.slice(0, -2) + '.' + digits.slice(-2);
};

export interface RefundCreditCaseRef {
  commitment_id: string;
  created_at: number;
}

export interface RefundCreditsRead extends RefundCreditCaseRef {
  account_label?: string;
  cursor?: string;
}

export interface RefundCreditLineRef {
  id: string;
  /** Opaque proof for the exact imported line the owner reviewed. */
  stamp: string;
}

export interface RefundStatementCredit {
  line: RefundCreditLineRef;
  account_label: string;
  posted_on: string;
  description: string;
  amount: string;
}

export interface RefundCreditMatch {
  line: RefundCreditLineRef;
  confirmed_at: number;
  credit: RefundStatementCredit | null;
}

export interface RefundCreditsView {
  review_token: string;
  expected: MonetaryValue | null;
  credited: string;
  outstanding: string | null;
  exceeds_expected: boolean;
  statement_available: boolean;
  account_label?: string;
  matches: RefundCreditMatch[];
  candidates: RefundStatementCredit[];
  next_cursor?: string;
}

export type RefundCreditsChange = RefundCreditCaseRef & { review_token: string } & (
  | { action: 'confirm'; account_label: string; lines: RefundCreditLineRef[] }
  | { action: 'remove'; line_id: string }
);
