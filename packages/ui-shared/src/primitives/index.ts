/** Primitive element barrel.
 *
 *  Feature renderers should import from here rather than reaching into
 *  individual primitive modules so call sites stay uniform. Each
 *  primitive exports (a) a pure function returning an HTML string and
 *  (b) a self-contained CSS string — combined via `PRIMITIVE_STYLES`.
 */

export {
  button,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
  BUTTON_STYLES,
} from './button.js';

export {
  section,
  subsection,
  type SectionProps,
  type SubsectionProps,
  SECTION_STYLES,
} from './section.js';

export {
  flash,
  flashOk,
  flashError,
  flashWarn,
  type FlashProps,
  type FlashTone,
  FLASH_STYLES,
} from './flash.js';

export {
  formRow,
  textInput,
  select,
  checkbox,
  fieldHint,
  type FormRowProps,
  type TextInputProps,
  type SelectProps,
  type SelectOption,
  type CheckboxProps,
  FIELD_STYLES,
} from './field.js';

export {
  statusDot,
  badge,
  type StatusTone,
  type BadgeProps,
  type BadgeTone,
  STATUS_STYLES,
} from './status.js';

export {
  code,
  codeBlock,
  CODE_STYLES,
} from './code.js';

export {
  dataTable,
  type DataTableProps,
  type TableColumn,
  TABLE_STYLES,
} from './table.js';

export {
  actionBar,
  type ActionBarProps,
  type ActionBarAlign,
  ACTION_BAR_STYLES,
} from './action-bar.js';

export {
  inlineMessage,
  inlineError,
  inlineWarn,
  inlineOk,
  inlineHint,
  type InlineMessageProps,
  type MessageTone,
  MESSAGE_STYLES,
} from './message.js';

export {
  panel,
  type PanelProps,
  type PanelTone,
  PANEL_STYLES,
} from './panel.js';

export {
  emptyHint,
  type EmptyHintProps,
  EMPTY_HINT_STYLES,
} from './empty-hint.js';

export {
  recoveryGrid,
  type RecoveryGridProps,
} from './recovery-grid.js';

export {
  typedField,
  type TypedFieldProps,
  type TypedFieldType,
} from './typed-field.js';

export { PRIMITIVE_STYLES } from './styles.js';
