import { RpcError,type CustomerPaymentHistoryInput,type CustomerPaymentReceiptInput,type CustomerPaymentReceiptDraftInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerPaymentReceiptService } from './customer-payment-receipt-service.js';
type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],body: (service: CustomerPaymentReceiptService) => T | Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Payment history and receipts require a paired owner client.',401);
  if (!deps.getCustomerPaymentReceiptService) throw new RpcError('not_configured','Customer payment receipts are unavailable on this server.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('customer_payment_invalid','Invalid customer payment input.',400);
  }
  try { return await body(deps.getCustomerPaymentReceiptService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerPaymentHistory = (deps: ReceptionRpcDeps,input: CustomerPaymentHistoryInput,caller: Caller) =>
  run(deps,input,caller,['signoff_id','limit','cursor'],service => service.history(input));
export const handleCustomerPaymentReceipt = (deps: ReceptionRpcDeps,input: CustomerPaymentReceiptInput,caller: Caller) =>
  run(deps,input,caller,['signoff_id','payment_id','expected_snapshot_hash'],service => service.receipt(input));
export const handleCustomerPaymentReceiptDraft = (deps: ReceptionRpcDeps,input: CustomerPaymentReceiptDraftInput,caller: Caller) =>
  run(deps,input,caller,['signoff_id','payment_id','expected_receipt_hash','sender_mail_instance','recipient_email'],service => service.draft(input));
