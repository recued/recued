/** Connections ▸ foundational account lanes — public barrel.
 *
 *  The pure renderer + schema + validation + projection for the
 *  Mail / Calendar / Files lanes (treemap §6, R13–R16). The webclient
 *  mount (`connections/accounts-lane-panel.ts`) consumes these. */

export {
  ACCOUNT_LANES,
  ACCOUNT_SLUG_REGEX,
  ACCOUNTS_PANEL_STYLES,
  canSubmitAccountForm,
  findAccountLane,
  findAccountProvider,
  initialAccountsPanelState,
  isOAuthAccountTransport,
  renderAccountsPanel,
  seedAccountFormValues,
  splitAccountList,
  validateAccountForm,
  type AccountEnrollTransport,
  type AccountField,
  type AccountFieldType,
  type AccountFormValues,
  type AccountLane,
  type AccountLaneId,
  type AccountProvider,
  type AccountRow,
  type AccountsPanelProps,
  type AccountsPanelStage,
  type AccountsPanelState,
} from './page.js';
