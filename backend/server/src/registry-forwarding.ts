import type { InternalToolRegistry } from '@recued/contracts';

/** D-329 — what a chat registry wrapper forwards beside its own methods: the hooks a held
 *  write is asked about with. That is its own check, asked before the owner is
 *  (`checkBeforeAsking`), and the names of the records it points at (`askValueLabels`). No
 *  wrapper adds a write, so each passes its inner registry's hooks through unchanged.
 *
 *  ⛔ Found live (2026-10-25): every wrapper built its registry from the five methods it
 *  knew, so the chat's registry had no check at all. A write its own arguments refused was
 *  put to the owner anyway, while every test of a bare registry passed. Spread this into a
 *  wrapper's registry: `{ ...forwardedRegistryHooks(inner), list, … }`. */
export const forwardedRegistryHooks = (inner: InternalToolRegistry): Pick<InternalToolRegistry, 'checkBeforeAsking' | 'askValueLabels'> => ({
  ...(inner.checkBeforeAsking === undefined ? {} : { checkBeforeAsking: (name, args, ctx) => inner.checkBeforeAsking!(name, args, ctx) }),
  ...(inner.askValueLabels === undefined ? {} : { askValueLabels: (name, args, ctx) => inner.askValueLabels!(name, args, ctx) }),
});
