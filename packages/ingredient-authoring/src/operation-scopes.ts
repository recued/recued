import type { PackOperationRow } from '@recued/contracts';
export const OPERATION_SCOPES_KEY = 'required_scopes' satisfies keyof PackOperationRow;
export const OPERATION_SCOPES_HELP = 'Optional array of non-empty provider OAuth scope strings required by this operation. Names are authored, not a closed editor vocabulary. Reusing a name does not verify vendor support, installed connection scopes or granted permissions. Shared validation still checks any authored surface scope universe. Plain 1x1 ingredient lowering drops operation metadata; use a catalog-shaped composition to retain it.';
