/** Recovery-key grid primitive.
 *
 *  The 24-slot word-input grid used everywhere a user types a
 *  recovery key: the import-dialog passwording + recover-pairing
 *  stages, the pair-with-server form, the recovery-setup challenge
 *  stage, and the reusable recovery-key entry widget (export/pair).
 *
 *  Pure renderer. Callers pre-split the joined key via
 *  `toRecoveryWords(state)` and pass the 24-slot array in. The
 *  primitive emits the grid + word-count line; the caller wraps with
 *  a panel and appends any error / action-bar / status hints.
 *
 *  Each grid on a page MUST get a unique `fieldName` + `idPrefix`.
 *  The field-event dispatchers in options.ts / sidebar.ts route edits
 *  by `data-{fieldName}` and the DOM ids — collisions would cross
 *  paste a phrase into the wrong grid when two mount together (e.g.
 *  the import dialog above the default pair form).
 */

import { e } from '../template.js';

export interface RecoveryGridProps {
  /** The 24 slot values. Use `toRecoveryWords(key)` from
   *  `options/features/sync/import-dialog` to split a joined string. */
  words: string[];
  /** `data-{fieldName}` attribute name (no `data-` prefix). The
   *  field-event dispatcher routes on this attribute; must be unique
   *  on any page that mounts more than one grid at once. */
  fieldName: string;
  /** Value of the `data-{fieldName}` attribute. Short kind label like
   *  `recovery-word`, `challenge-word`, `entry-word`. */
  fieldValue: string;
  /** Each input becomes id `{idPrefix}-{i}`; its `<label>` points at
   *  the same id. Must be unique on a page. */
  idPrefix: string;
  /** Disable every slot — used while a submit/verify is in-flight. */
  disabled?: boolean;
  /** Grid wrapper class. Default `rx-recovery-words`. Override for
   *  surfaces with legacy styling hooks (e.g. import-dialog
   *  passwording uses `sync-import-words`). */
  wrapperClass?: string;
  /** Per-slot class. Default `rx-recovery-word`. */
  slotClass?: string;
  /** Extra class tokens on the `<p class="field-hint …">` count line.
   *  Default `rx-recovery-word-count`. */
  countClass?: string;
}

export const recoveryGrid = (props: RecoveryGridProps): string => {
  const wrapper = props.wrapperClass ?? 'rx-recovery-words';
  const slot = props.slotClass ?? 'rx-recovery-word';
  const countCls = props.countClass ?? 'rx-recovery-word-count';
  const disabledAttr = props.disabled ? 'disabled' : '';
  const filled = props.words.filter((w) => w.length > 0).length;

  const slots = props.words.map((word, i) => {
    const id = `${props.idPrefix}-${i}`;
    return `
    <div class="${e(slot)}">
      <label for="${e(id)}">${i + 1}</label>
      <input id="${e(id)}"
        type="text"
        data-${e(props.fieldName)}="${e(props.fieldValue)}"
        data-index="${i}"
        value="${e(word)}"
        autocomplete="off"
        spellcheck="false"
        autocapitalize="none"
        ${disabledAttr}
        style="font-family:monospace; text-transform:lowercase" />
    </div>`;
  }).join('');

  return `
    <div class="${e(wrapper)}">${slots}</div>
    <p class="field-hint ${e(countCls)}">
      ${filled} of 24 words entered.
    </p>
  `;
};
