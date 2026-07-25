/** D-192 CORE #6 seam 10 — the channel-vocabulary consolidation.
 *
 *  Seam 10's whole claim is: **declaring a chat transport is ONE edit** (the slug
 *  in `MESSENGER_VENDOR_SLUGS` + its declaration, both in `messenger-vendors.ts`)
 *  and every downstream vocabulary picks it up for free. Before this, the same
 *  `'slack' | 'telegram'` was hand-spelled in ~8 lists across four packages, so a
 *  new vendor silently missed whichever one you forgot — enrollable over rpc but
 *  with no enroll card, or channel-typed but not sendable.
 *
 *  So every assertion below iterates the LIVE registry rather than naming
 *  slack/telegram. A newly declared vendor (Teams) is covered here the moment it
 *  is declared, with **zero edits to this file** — and if any list were to fall
 *  out of the derivation and get hand-spelled again, exactly one of these fails.
 *
 *  The type level is guarded separately, and more strictly, by the compiler:
 *  `notificationSchemas` is `satisfies Record<NotificationSubtype, …>`, so a
 *  vendor without an enroll card cannot compile at all. */

import { describe, expect, it } from 'vitest';
import {
  MESSENGER_VENDOR_DECLARATIONS,
  MESSENGER_VENDOR_SLUGS,
  NOTIFICATION_CHANNEL_NAMES,
  NOTIFICATION_DELIVERY_CHANNELS,
  NOTIFICATION_SUBTYPES,
  getMessengerVendorDeclaration,
  listMessengerVendors,
} from '@recued/contracts';
import { CONNECTION_SUBTYPE_CHOICES, notificationSchemas } from '@recued/ui-shared';

import { ALL_NOTIFICATION_CHANNELS } from '../notification-handler.js';
import {
  MESSENGER_RECIPIENT_RESOLVERS,
  MESSENGER_TRANSPORT_FACTORIES,
} from '../composition/bin/messenger-transport-leaves.js';
import { MESSENGER_WEBHOOK_DESCRIPTOR_LEAVES } from '../composition/bin/wire-vendor-webhook-port.js';

const slugs = (): readonly string[] => MESSENGER_VENDOR_SLUGS;

describe('D-192 seam 10 — one registry, every channel vocabulary', () => {
  describe('the two halves of the registry cannot drift', () => {
    it('names the same vendors in the slug tuple and the declarations, both ways', () => {
      // The boot check in `messenger-vendors.ts` throws on disagreement; this
      // pins WHY it matters. A declared vendor missing from the tuple would be
      // unroutable (no `ChannelName` ⇒ `createRemoteChannel` rejects it); a slug
      // with no declaration would type as routable but carry no facets.
      expect([...slugs()].sort()).toEqual([...listMessengerVendors()].sort());
      expect([...slugs()].sort()).toEqual(
        MESSENGER_VENDOR_DECLARATIONS.map((d) => d.vendor).sort(),
      );
    });
  });

  describe('every declared chat transport reaches every vocabulary', () => {
    it.each(MESSENGER_VENDOR_SLUGS.map((v) => [v] as const))(
      '%s is a notification channel, a connection subtype, and a delivery channel',
      (vendor) => {
        // The channel list (D-158 block + Settings toggles + the seam-10 guard
        // that `createRemoteChannel` fails loud on).
        expect(NOTIFICATION_CHANNEL_NAMES).toContain(vendor);
        // The enrollment gate (seam 8: an unenrollable subtype can never be probed).
        expect(NOTIFICATION_SUBTYPES).toContain(vendor);
        // The `notification.send` fan-out.
        expect(NOTIFICATION_DELIVERY_CHANNELS).toContain(vendor);
        expect(ALL_NOTIFICATION_CHANNELS).toContain(vendor);
      },
    );

    it.each(MESSENGER_VENDOR_SLUGS.map((v) => [v] as const))(
      '%s has an enroll card, and a picker row labelled from its declaration',
      (vendor) => {
        // The enrollment half — a vendor that is rpc-enrollable but has no card
        // is unusable from the UI. (`satisfies Record<NotificationSubtype, …>`
        // makes this a compile error too; this pins the runtime shape.)
        expect(notificationSchemas[vendor]).toBeDefined();

        const row = CONNECTION_SUBTYPE_CHOICES.notification.find(
          (r) => r.subtype === vendor,
        );
        expect(row).toBeDefined();
        // The label is DERIVED from the declaration, not hand-typed beside it.
        expect(row?.label).toBe(getMessengerVendorDeclaration(vendor)?.display_name);
        expect(row?.description).toBe(notificationSchemas[vendor].description);
      },
    );
  });

  // Seam 11 — the leaf maps are RUNTIME (contracts cannot reference backend
  // code), so a declared vendor missing a leaf cannot be a compile error the way
  // a missing enroll card is. It would instead be SILENTLY skipped: no transport
  // ⇒ no channel, no webhook descriptor ⇒ inbound 404s. Fail-closed, but silent —
  // exactly the class this arc exists to kill. So assert completeness here, and a
  // half-added vendor is a red test rather than a vendor that quietly does nothing.
  describe('every declared chat transport has its runtime leaves', () => {
    it.each(MESSENGER_VENDOR_SLUGS.map((v) => [v] as const))(
      '%s has a transport factory, a recipient resolver, and a webhook descriptor',
      (vendor) => {
        expect(MESSENGER_TRANSPORT_FACTORIES[vendor]).toBeTypeOf('function');
        expect(MESSENGER_RECIPIENT_RESOLVERS[vendor]).toBeTypeOf('function');
        // Only a `webhook` ingress needs a descriptor — a `socket` / `poll` vendor
        // (Discord's Gateway) arrives by another path and is correctly absent here.
        if (getMessengerVendorDeclaration(vendor)?.ingress.mode === 'webhook') {
          expect(MESSENGER_WEBHOOK_DESCRIPTOR_LEAVES[vendor]).toBeTypeOf('function');
        }
      },
    );

    it('declares the inbound id field every webhook vendor dispatches on', () => {
      // Seam 11's normalizer reads the vendor's native id under this declared key
      // (Slack `event_id`, Telegram `update_id`). Absent ⇒ the vendor would get no
      // dispatcher at all, so it is required for a webhook ingress.
      for (const vendor of MESSENGER_VENDOR_SLUGS) {
        const ingress = getMessengerVendorDeclaration(vendor)?.ingress;
        if (ingress?.mode !== 'webhook') continue;
        expect(ingress.id_field).toBeTruthy();
        expect(ingress.secret_field).toBeTruthy();
      }
    });
  });

  describe('the non-transport members stay put', () => {
    it('keeps ui / bridge / email structural on the channel list', () => {
      // These are NOT chat transports (no `Transport`, absent from the messenger
      // registry by construction), so they are named literally and must survive
      // the de-hardcode.
      for (const structural of ['ui', 'bridge', 'email'] as const) {
        expect(NOTIFICATION_CHANNEL_NAMES).toContain(structural);
        expect(slugs()).not.toContain(structural);
      }
    });

    it('keeps the two in-app spellings on their own surfaces', () => {
      // Genuinely different wire spellings on different surfaces — the connection
      // SUBTYPE is `in-app`, the delivery CHANNEL is `in_app`. Seam 10 de-hardcodes
      // the vendor half of each without unifying these (changing either is a
      // breaking wire change), so pin them rather than let a future tidy-up merge
      // them by accident.
      expect(NOTIFICATION_SUBTYPES).toContain('in-app');
      expect(NOTIFICATION_DELIVERY_CHANNELS).toContain('in_app');
      expect(NOTIFICATION_SUBTYPES).not.toContain('in_app');
      expect(NOTIFICATION_DELIVERY_CHANNELS).not.toContain('in-app');
      // `notification.send` cannot be aimed at ui / bridge.
      expect(NOTIFICATION_DELIVERY_CHANNELS).not.toContain('ui');
      expect(NOTIFICATION_DELIVERY_CHANNELS).not.toContain('bridge');
    });
  });
});
