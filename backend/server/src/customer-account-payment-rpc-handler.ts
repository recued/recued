import { RpcError,type CustomerAccountPaymentPrepareInput,type CustomerAccountPaymentHistoryInput,
  type CustomerAccountPaymentReceiptInput,type CustomerAccountPaymentReceiptDraftInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerAccountPaymentService } from './customer-account-payment-service.js';
type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],
  body: (service: CustomerAccountPaymentService,instance: string) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Account payments require a paired owner client.',401);
  if (!deps.getCustomerAccountPaymentService) throw new RpcError('not_configured','Customer account payments are unavailable.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new RpcError('customer_account_payment_invalid','Invalid account payment fields.',400);
  try { return await body(deps.getCustomerAccountPaymentService(),caller.instance_id); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerAccountPaymentPrepare = (deps: ReceptionRpcDeps,input: CustomerAccountPaymentPrepareInput,caller: Caller) =>
  run(deps,input,caller,['request_key','account_id','expected_statement_hash','currency','amount','received_on','method','reference','allocations'],(service,instance) => service.prepare(input,instance));
export const handleCustomerAccountPaymentHistory = (deps: ReceptionRpcDeps,input: CustomerAccountPaymentHistoryInput,caller: Caller) =>
  run(deps,input,caller,['account_id','limit','cursor'],service => service.history(input));
export const handleCustomerAccountPaymentReceipt = (deps: ReceptionRpcDeps,input: CustomerAccountPaymentReceiptInput,caller: Caller) =>
  run(deps,input,caller,['account_payment_id'],service => service.receipt(input));
export const handleCustomerAccountPaymentReceiptDraft = (deps: ReceptionRpcDeps,input: CustomerAccountPaymentReceiptDraftInput,caller: Caller) =>
  run(deps,input,caller,['account_payment_id','expected_receipt_hash','sender_mail_instance','recipient_email'],service => service.draft(input));
