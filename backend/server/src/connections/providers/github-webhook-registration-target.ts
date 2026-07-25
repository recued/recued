/** D-201 Slices 8D + 9AE — GitHub registration-target compatibility surface.
 *
 * GitHub's repository/organization labels now live in trusted profile preset
 * data. The exact account/resource grammar and lowercase canonicalization are
 * owned by the neutral closed engine; this export remains for callers that
 * still use the original provider helper name.
 */

import type { WebhookRegistrationTarget } from '@recued/contracts';
import {
  createWebhookAccountResourceRegistrationTargetNormalizer,
} from '../../webhook-account-resource-registration-target-normalizer.js';
import {
  webhookRegistrationTargetProfilePreset,
} from '../../webhook-registration-target-profile-presets.js';

const profilePreset = webhookRegistrationTargetProfilePreset('github.webhook.v1');
if (profilePreset === null) {
  throw new Error('GitHub registration-target profile preset is unavailable');
}
const normalizer = createWebhookAccountResourceRegistrationTargetNormalizer(
  profilePreset.normalizer,
);

/** Return the only canonical target forms admitted by the GitHub.com adapter
 * family. Existence and authorization remain provider read-back concerns. */
export const canonicalGitHubWebhookRegistrationTarget = (
  value: unknown,
): WebhookRegistrationTarget | null => normalizer.normalize(value);
