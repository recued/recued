import { typedKernelArguments, type KernelArgumentSchema } from '@recued/contracts';
import { KERNEL_INPUT_DECLARATIONS } from './kernel-inputs.generated.js';
export type { KernelArgumentSchema } from '@recued/contracts';
const declarations: Readonly<Record<string, KernelArgumentSchema>> = KERNEL_INPUT_DECLARATIONS;
export const kernelArguments = (op: string, args: Readonly<Record<string, unknown>> = {}): KernelArgumentSchema | undefined => {
  const typed = typedKernelArguments(op, args); if (typed) return typed;
  return Object.hasOwn(declarations, op) ? declarations[op] : undefined;
};
