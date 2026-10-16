import { RpcError,type CustomerAccountPaymentCorrectionPrepareInput,type CustomerAccountPaymentCorrectionHistoryInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerAccountPaymentCorrectionService } from './customer-account-payment-correction-service.js';
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: { instance_id?: string | null } | undefined,keys: string[],
  body: (service: CustomerAccountPaymentCorrectionService,instance: string) => Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Account payment corrections require a paired owner client.',401);
  if (!deps.getCustomerAccountPaymentCorrectionService) throw new RpcError('not_configured','Account payment corrections are unavailable.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new RpcError('customer_account_correction_invalid','Invalid account payment correction fields.',400);
  try { return await body(deps.getCustomerAccountPaymentCorrectionService(),caller.instance_id); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerAccountPaymentCorrectionPrepare = (deps: ReceptionRpcDeps,input: CustomerAccountPaymentCorrectionPrepareInput,caller: { instance_id?: string | null } | undefined) =>
  run(deps,input,caller,['request_key','account_payment_id','expected_receipt_hash','action','reason','amount','received_on','method','reference','allocations'],(s,instance) => s.prepare(input,instance));
export const handleCustomerAccountPaymentCorrectionHistory = (deps: ReceptionRpcDeps,input: CustomerAccountPaymentCorrectionHistoryInput,caller: { instance_id?: string | null } | undefined) =>
  run(deps,input,caller,['account_payment_id','limit','cursor'],s => s.history(input));
