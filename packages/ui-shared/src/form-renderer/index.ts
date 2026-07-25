/** D-145 PA5 — form-renderer barrel.
 *
 *  Pairs with `@recued/contracts/form-renderer` (types + generators +
 *  validators). Spec: D-145 § A.3.
 */

export {
  renderField,
  renderForm,
  type FormRenderOptions,
} from './render.js';

export { readField, readFormValues } from './read.js';

export {
  mountForm,
  type FormMount,
  type MountFormOptions,
} from './mount.js';

export { FORM_RENDERER_STYLES } from './styles.js';
