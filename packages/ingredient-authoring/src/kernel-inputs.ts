import { CSV_INSPECT_ARGUMENTS, CSV_TRANSFORM_ARGUMENTS, CSV_TRANSFORM_ARGUMENT_VARIANTS } from '@recued/contracts';
import { KERNEL_INPUT_DECLARATIONS } from './kernel-inputs.generated.js';
/** Portable argument hints. An absent required list or type means the declaration does not establish it. */
export interface KernelArgumentSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly properties?: Readonly<Record<string, KernelArgumentSchema>>;
  readonly required?: readonly string[];
  readonly items?: KernelArgumentSchema;
}
const declarations: Readonly<Record<string, KernelArgumentSchema>> = KERNEL_INPUT_DECLARATIONS;
export const kernelArguments = (op: string, args: Readonly<Record<string, unknown>> = {}): KernelArgumentSchema | undefined => {
  if (op === 'core.storage.csv.inspect') return CSV_INSPECT_ARGUMENTS;
  if (op === 'core.storage.csv.transform') {
    const key = Object.hasOwn(args, 'operation') ? args.operation : undefined;
    const variant = typeof key === 'string' && Object.hasOwn(CSV_TRANSFORM_ARGUMENT_VARIANTS, key)
      ? CSV_TRANSFORM_ARGUMENT_VARIANTS[key as keyof typeof CSV_TRANSFORM_ARGUMENT_VARIANTS] : undefined;
    return variant ? { ...CSV_TRANSFORM_ARGUMENTS, properties: { ...CSV_TRANSFORM_ARGUMENTS.properties, ...variant.properties }, required: [...CSV_TRANSFORM_ARGUMENTS.required, ...variant.required] } : CSV_TRANSFORM_ARGUMENTS;
  }
  return Object.hasOwn(declarations, op) ? declarations[op] : undefined;
};
