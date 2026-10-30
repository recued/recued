import { CSV_INSPECT_ARGUMENTS, CSV_TRANSFORM_ARGUMENTS, CSV_TRANSFORM_ARGUMENT_VARIANTS } from './csv-toolkit-authoring.js';

/** Explicit schemas can establish static constraints; projected defaults remain hints. */
export interface KernelArgumentSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly properties?: Readonly<Record<string, KernelArgumentSchema>>;
  readonly required?: readonly string[];
  readonly items?: KernelArgumentSchema;
  readonly additionalProperties?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

/** Only explicit contracts enter validation. Legacy manifest defaults do not. */
export const typedKernelArguments = (op: string, args: Readonly<Record<string, unknown>> = {}): KernelArgumentSchema | undefined => {
  if (op === 'core.storage.csv.inspect') return CSV_INSPECT_ARGUMENTS;
  if (op !== 'core.storage.csv.transform') return;
  const operation = Object.hasOwn(args, 'operation') ? args.operation : undefined;
  const variant = typeof operation === 'string' && Object.hasOwn(CSV_TRANSFORM_ARGUMENT_VARIANTS, operation)
    ? CSV_TRANSFORM_ARGUMENT_VARIANTS[operation as keyof typeof CSV_TRANSFORM_ARGUMENT_VARIANTS] : undefined;
  // Until a variant is known, its other argument names cannot be checked.
  return variant ? { ...CSV_TRANSFORM_ARGUMENTS, properties: { ...CSV_TRANSFORM_ARGUMENTS.properties, ...variant.properties },
    required: [...CSV_TRANSFORM_ARGUMENTS.required, ...variant.required] } : { ...CSV_TRANSFORM_ARGUMENTS, additionalProperties: true };
};
