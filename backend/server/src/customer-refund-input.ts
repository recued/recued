import { QuoteSignoffError } from './quote-signoff-service.js';
import { refundDecimal as decimal } from './customer-refund-ledger.js';
export const invalid=(message: string): never=>{ throw new QuoteSignoffError('customer_refund_invalid',message,400); };
export const stale=(): never=>{ throw new QuoteSignoffError('customer_refund_stale','The invoice, payment, credit or refund changed. Refresh payment history and preview again.'); };
export const uuid=(value: unknown): string=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ? value : invalid('Choose a saved customer invoice and preview again.');
export const text=(value: unknown,max: number,optional=false): string | undefined=>{
  if (optional && (value===undefined || value==='')) return;
  if (typeof value!=='string' || !value.trim() || value.trim().length>max || /[\u0000\r]/.test(value)) return invalid('Enter a valid refund reason or reference.');return value.trim();
};
export const money=(value: unknown): string=>{
  if (typeof value!=='string' || value.length>24 || !/^\d+(?:\.\d{1,4})?$/.test(value)) return invalid('Enter a positive amount with up to four decimal places.');
  const [whole,part='']=value.split('.');const n=BigInt(whole!)*10_000n+BigInt(part.padEnd(4,'0'));
  if (n<=0n || n>9_223_372_036_854_775_807n) return invalid('The refund amount is outside Invoice Book’s exact range.');return decimal(n);
};
export const day=(value: unknown): string=>{
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z')) || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value) return invalid('Choose a valid date.');return value;
};
