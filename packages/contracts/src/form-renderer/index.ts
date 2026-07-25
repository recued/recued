/** D-145 PA5 — form renderer substrate, contract surface barrel.
 *
 *  Pairs with `packages/ui-shared/src/form-renderer/` (rendering layer).
 *
 *  Spec: D-145 § A.3.
 */

export type {
  DiscriminatedUnionVariant,
  FieldValidationError,
  FieldValidator,
  FormCompositionFieldType,
  FormDefinition,
  FormField,
  FormFieldOrigin,
  FormFieldType,
  ShowIfCondition,
  SourceExtensionField,
  SourceExtensionSchema,
  ValidationHooks,
} from './types.js';

export { FORM_FIELD_TYPES, isFormFieldType } from './types.js';

export {
  fieldTypesInRegistry,
  formFromCanonicalSchema,
  formFromCanonicalSchemaWithExtension,
  humanizeName,
} from './generator.js';

export {
  BUILTIN_VALIDATORS,
  evaluateShowIf,
  resolveDiscriminatedVariant,
  validateField,
  validateForm,
} from './validators.js';
