/** D-156 P1 — account-level shared primitives (recovery key setup +
 *  entry + storage + crypto helpers). Consumed by the webclient (P3+)
 *  + bridge (P6) when they wire pair / re-pair flows. */

export {
  // setup state
  type RecoverySetupStage,
  type RecoverySetupSlice,
  initialRecoverySetupSlice,
  keyGenerated,
  ackWritten,
  challengeEntryChanged,
  pairServerUrlChanged,
  pairServerCodeChanged,
  challengeFailed,
  wrappingStarted,
  finalizingStarted,
  setupCompleted,
  setupReset,
  // setup crypto seam
  type RecoveryCrypto,
  defaultRecoveryCrypto,
  // setup handlers
  type RecoverySetupHandlerDeps,
  type RecoverySetupHandlers,
  createRecoverySetupHandlers,
  // setup renderer
  type RecoverySetupRenderOptions,
  renderRecoverySetup,
} from './recovery-setup.js';

export {
  // entry state
  type RecoveryKeyEntryStage,
  type RecoveryKeyEntrySlice,
  initialRecoveryKeyEntrySlice,
  entryStarted,
  entryChanged,
  verifyingStarted,
  submittingStarted,
  entryFailed,
  entryDone,
  entryReset,
  // entry crypto seam
  type RecoveryEntryCrypto,
  defaultRecoveryEntryCrypto,
  // entry handlers
  type RecoveryKeyEntryDeps,
  type RecoveryKeyEntryHandlers,
  createRecoveryKeyEntryHandlers,
  // entry renderer
  type RecoveryKeyEntryRenderProps,
  renderRecoveryKeyEntry,
} from './recovery-key-entry.js';

export {
  type RecoveryCheckStorage,
  RECOVERY_CHECK_KEY,
  readRecoveryCheck,
  hasRecoveryCheck,
  writeRecoveryCheck,
  clearRecoveryCheck,
  createInMemoryRecoveryStorage,
} from './recovery-check-store.js';

export {
  deriveKekFromRecoveryKey,
  buildRecoveryKeyCheck,
  verifyRecoveryKeyCheck,
} from './recovery-check-crypto.js';

export {
  type PairListEntryKind,
  type DevicesPageRow,
  type DevicesPageState,
  renderDevicesPage,
} from './devices-page.js';
