/** D-125 P7.1 — Settings → Connections page barrel.
 *
 *  Public surface for the new D-125 Connections UI. Schemas live one
 *  level up under `connection-schemas/` so recipe-install pre-fill
 *  paths can pick them up without dragging in the page renderer. */

export {
  renderConnectionsPage,
  validateConnectionForm,
  CONNECTIONS_PAGE_STYLES,
  type ConnectionsPageProps,
} from './page.js';
export {
  initialConnectionsPageState,
  initialConnectionsDialogState,
  connectionRowKey,
  type ConnectionsPageState,
  type ConnectionsDialogState,
  type ConnectionsDialogStage,
  type ConnectionsDeleteConfirmState,
} from './state.js';
export {
  projectConnectionPayload,
  shouldPatchConnectionAuth,
  flattenConnectionViewIntoValues,
  resolveConnectionViewVendor,
  buildConnectionEditDialogPatch,
  type ConnectionPayload,
  type ConnectionEditDialogPatch,
} from './payload.js';
export {
  renderEngagementHealthPanel,
  ENGAGEMENT_HEALTH_PANEL_STYLES,
  type EngagementHealthPanelProps,
} from './engagement-health.js';
