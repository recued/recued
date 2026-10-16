import { RpcError,type CustomerRefundPrepareInput,type CustomerRefundHistoryInput,type CustomerRefundCopyInput,type CustomerRefundDraftInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerRefundService } from './customer-refund-service.js';
import type { CustomerRefundCorrectionPrepareInput,CustomerRefundCorrectionHistoryInput } from '@recued/contracts';
type Caller={ instance_id?: string|null }|undefined;
const run=async<T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],body: (service: CustomerRefundService,instance: string)=>T|Promise<T>): Promise<T>=>{
  if (!caller?.instance_id) throw new RpcError('unauthorized','Customer refunds require a paired owner client.',401);
  if (!deps.getCustomerRefundService) throw new RpcError('not_configured','Customer refunds are unavailable.',503);
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!keys.includes(key))) throw new RpcError('customer_refund_invalid','Invalid refund fields.',400);
  try { return await body(deps.getCustomerRefundService(),caller.instance_id); } catch(error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerRefundPrepare=(deps: ReceptionRpcDeps,input: CustomerRefundPrepareInput,caller: Caller)=>run(deps,input,caller,['request_key','signoff_id','expected_snapshot_hash','kind','payment_id','credit_id','amount','date','reason','method','reference'],(s,owner)=>s.prepare(input,owner));
export const handleCustomerRefundHistory=(deps: ReceptionRpcDeps,input: CustomerRefundHistoryInput,caller: Caller)=>run(deps,input,caller,['signoff_id','limit','cursor'],s=>s.history(input));
export const handleCustomerRefundCopy=(deps: ReceptionRpcDeps,input: CustomerRefundCopyInput,caller: Caller)=>run(deps,input,caller,['signoff_id','action_id'],s=>s.copy(input));
export const handleCustomerRefundDraft=(deps: ReceptionRpcDeps,input: CustomerRefundDraftInput,caller: Caller)=>run(deps,input,caller,['signoff_id','action_id','expected_document_hash','sender_mail_instance','recipient_email'],s=>s.draft(input));
export const handleCustomerRefundCorrectionPrepare=(deps: ReceptionRpcDeps,input: CustomerRefundCorrectionPrepareInput,caller: Caller)=>run(deps,input,caller,
  ['request_key','signoff_id','refund_id','expected_snapshot_hash','action','reason','reversed_on','amount','returned_on','replacement_reason','method','reference'],(s,owner)=>s.prepareCorrection(input,owner));
export const handleCustomerRefundCorrectionHistory=(deps: ReceptionRpcDeps,input: CustomerRefundCorrectionHistoryInput,caller: Caller)=>run(deps,input,caller,
  ['signoff_id','limit','cursor'],s=>s.correctionHistory(input));
