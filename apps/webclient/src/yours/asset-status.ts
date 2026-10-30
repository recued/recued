import type { Asset } from '@recued/contracts';

export const ASSET_STATUS_WORDS: Readonly<Record<Asset['status'], string>> = {
  active: 'Active', lent: 'Lent', sold: 'Sold', lost: 'Lost', retired: 'Retired',
};
