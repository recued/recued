import { isFileRefArgumentValue, isRef, normalizeOperationArg, type OperationArgEntry, type OperationArgSpec } from '@recued/contracts';

/** Authoring metadata only: bare keys are required; object entries default to optional. */
export const declaredOperationArguments = (entries: readonly OperationArgEntry[]): OperationArgSpec[] => entries.map(entry => ({
  ...normalizeOperationArg(entry), required: typeof entry === 'string' || entry.required === true,
}));
export interface DeclaredArgumentFinding { key: string; reason: 'missing' | 'type'; expected: string }
/** Conservative literal checks. Dynamic values and undeclared extra inputs remain open. */
export const checkDeclaredOperationArguments = (args: readonly OperationArgSpec[], input: Readonly<Record<string, unknown>>): DeclaredArgumentFinding[] => {
  const findings: DeclaredArgumentFinding[] = [];
  for (const arg of args) {
    const expected = arg.type ?? 'string';
    if (!Object.hasOwn(input, arg.key)) { if (arg.required === true) findings.push({ key: arg.key, reason: 'missing', expected }); continue; }
    const value = input[arg.key]; if (isRef(value)) continue;
    if (expected === 'file_ref' && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).some(isRef)) continue;
    const matches = expected === 'array' ? Array.isArray(value) : expected === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : expected === 'file_ref' ? isFileRefArgumentValue(value)
        : expected === 'file_ref[]' ? Array.isArray(value) && value.every(item => isRef(item) || item !== null && typeof item === 'object' && !Array.isArray(item) && Object.values(item).some(isRef) || isFileRefArgumentValue(item))
          : expected === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === expected;
    if (!matches) findings.push({ key: arg.key, reason: 'type', expected });
  }
  return findings;
};
