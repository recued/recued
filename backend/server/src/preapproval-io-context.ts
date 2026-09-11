/** Private ambient transport context. It is installed only while a claimed
 * invocation runs and is absent from every public request/recipe schema. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MailSendInput } from './collections/mail/mail-collection.js';
import type { FileReadDeps, FileReadResponse } from './collections/file/file-read-handler.js';
import type { PreapprovalBindingFamily } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';
import type { CliInvocationCall } from '@recued/engine';
import type { LLMProviderInvocation, PinnedSlot } from '@recued/llm';
import type { DispatchRequest, ReviewedBridgeDispatch } from './bridges/dispatcher.js';

export interface PreapprovalIoContext {
  prepareDomCommand(call: ResolvedCall, request: DispatchRequest, index: number): Promise<ReviewedBridgeDispatch>;
  aiSlot(): PinnedSlot;
  coversAiFileAsk(input: Record<string, unknown>, recordId: string): boolean;
  readAiFile(recordId: string): Promise<FileReadResponse>;
  readHttpFile(recordId: string): Promise<FileReadResponse>;
  beforeAiProvider(call: ResolvedCall, request: LLMProviderInvocation): Promise<void>;
  beforeCliProvider(call: CliInvocationCall): Promise<void>;
  validateProvider(family: PreapprovalBindingFamily, call: ResolvedCall,
    target?: { expected: string; actual: string }): Promise<void>;
  beforeProvider(family: PreapprovalBindingFamily, call: ResolvedCall,
    target?: { expected: string; actual: string }): Promise<void>;
  coversMailAttachmentAsks(input: Record<string, unknown>): boolean;
  validateMail(instance: string, input: MailSendInput): void;
  readMailAttachment(recordId: string, index: number, deps: FileReadDeps): Promise<FileReadResponse>;
  fileAccess(recordId: string): object;
  beforeMailProvider(instance: string, input: MailSendInput): Promise<void>;
}
const scopes = new AsyncLocalStorage<PreapprovalIoContext | undefined>();
export const currentPreapprovalIo = (): PreapprovalIoContext | undefined => scopes.getStore();
export const withPreapprovalIo = <T>(scope: PreapprovalIoContext | undefined, run: () => T): T => scopes.run(scope, run);

/** An uncovered call retains the enclosing run's cancellation/deadline fence.
 * This callback can only refuse execution; it supplies no approval proof. */
const ordinaryGuards = new AsyncLocalStorage<(() => void) | undefined>();
export const withPreapprovalOrdinaryGuard = <T>(guard: (() => void) | undefined, run: () => T): T => ordinaryGuards.run(guard, run);
export const assertPreapprovalOrdinaryRun = (): void => { ordinaryGuards.getStore()?.(); };
