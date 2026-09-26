/** D-295 — the webhooks an install dialog has the owner choose.
 *
 *  ⛔ A PACK THAT LISTENS TO WEBHOOKS COULD NOT BE INSTALLED OR UPDATED FROM
 *  SETTINGS → PACKS. The install requires one owner-selected webhook per
 *  declared binding — for the pack and every dependency it will install — and
 *  the dialog never asked, so the server refused every attempt (14 bundled
 *  packs). This builds what the dialog asks: per binding, the owner's webhooks
 *  that fit it and, on an update, the one it uses now.
 *
 *  "Fit" is the install's OWN rule (`webhookIngressUnfit`), so the dialog never
 *  offers a webhook the install then refuses: enabled intake, the right
 *  profile, registration mode and environment, every event the requirement and
 *  the pack's recipes need, and a paired connection where one is required.
 *
 *  Pure over its inputs; the preview handler supplies the pack walk, the
 *  recipes' webhook triggers, the owner's webhooks and the current bindings. */

import {
  webhookProfile,
  type BulkPackManifest,
  type PackWebhookPlanEntry,
  type RecipeWebhookTrigger,
  type WebhookIngressRecord,
} from '@recued/contracts';

import { webhookIngressUnfit } from './storage/webhook-consumer-store.js';

export const planPackWebhookBindings = (input: {
  /** The packs the install will touch, in its walk order. */
  manifests: readonly BulkPackManifest[];
  /** The webhook triggers of a pack's recipes. */
  triggersFor: (packSlug: string) => readonly RecipeWebhookTrigger[];
  /** The owner's webhooks. */
  ingresses: readonly WebhookIngressRecord[];
  /** A pack's current bindings (binding → ingress id); empty when not installed. */
  currentFor: (packSlug: string) => ReadonlyMap<string, string>;
}): PackWebhookPlanEntry[] => {
  const plan: PackWebhookPlanEntry[] = [];
  for (const manifest of input.manifests) {
    const requirements = manifest.webhook_requirements ?? [];
    if (requirements.length === 0) continue;
    const triggers = input.triggersFor(manifest.slug);
    const current = input.currentFor(manifest.slug);
    for (const requirement of requirements) {
      const fits = (ingress: WebhookIngressRecord): boolean =>
        webhookIngressUnfit(ingress, requirement, triggers) === null;
      const candidates = input.ingresses
        .filter(fits)
        .map((ingress) => ({ ingress_id: ingress.ingress_id, display_name: ingress.display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.ingress_id.localeCompare(b.ingress_id));
      const eventTypes = [...new Set([
        ...(requirement.required_event_types ?? []),
        ...triggers
          .filter((trigger) => trigger.binding === requirement.binding)
          .flatMap((trigger) => trigger.event_types),
      ])];
      const currentId = current.get(requirement.binding);
      const currentIngress = currentId === undefined
        ? undefined
        : input.ingresses.find((ingress) => ingress.ingress_id === currentId);
      plan.push({
        pack_slug: manifest.slug,
        pack_name: manifest.name,
        binding: requirement.binding,
        vendor: webhookProfile(requirement.profile_ids[0])?.vendor ?? requirement.profile_ids[0] ?? 'webhook',
        event_types: eventTypes,
        candidates,
        ...(currentId !== undefined
          ? {
            current: {
              ingress_id: currentId,
              display_name: currentIngress?.display_name ?? currentId,
              fits: currentIngress !== undefined && fits(currentIngress),
            },
          }
          : {}),
      });
    }
  }
  return plan;
};
