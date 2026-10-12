import type { QuoteSignoffSummary, ServerRecipeListEntry } from '@recued/contracts';
import { RunModal } from '@recued/ui-shared';

export interface QuoteSignoffPaymentOptions {
  listRecipes: () => Promise<{ recipes: readonly ServerRecipeListEntry[] }>;
  execute: RunModal.RunModalExecuteCaller;
  serverTimeZone?: () => string | undefined;
}

export const canRecordSignoffPayment = (offer: QuoteSignoffSummary): boolean =>
  offer.state === 'released' && !!offer.invoice_id
  && offer.follow_up?.invoice.availability === 'current'
  && offer.follow_up.invoice.status === 'open';

/** Launch the installed workflow; only the owner's Run press can write.
 * Re-read the linked invoice before opening and again before dispatching. */
export const createQuoteSignoffPayment = (opts: QuoteSignoffPaymentOptions & {
  document: Document;
  host: HTMLElement;
  readOffer: (id: string) => Promise<QuoteSignoffSummary | undefined>;
  onChanged: () => void;
  onMessage: (message: string) => void;
}) => {
  let disposed = false;
  let opening = false;
  let modal: RunModal.RunModalHandle | null = null;

  const open = async (offer: QuoteSignoffSummary): Promise<void> => {
    if (disposed || opening || modal !== null) return;
    const target = {
      signoff_id: offer.signoff_id, invoice_id: offer.invoice_id,
      invoice_ref: offer.invoice_ref, currency: offer.currency, amount: offer.amount,
    };
    const readCurrent = async (): Promise<void> => {
      const fresh = await opts.readOffer(target.signoff_id);
      if (disposed) throw new Error('This payment view has closed.');
      if (!fresh || !canRecordSignoffPayment(fresh)
        || fresh.invoice_id !== target.invoice_id || fresh.invoice_ref !== target.invoice_ref
        || fresh.currency !== target.currency || fresh.amount !== target.amount) {
        throw new Error('This invoice has changed or is no longer open. Refresh the request and review it in Records.');
      }
    };
    opening = true;
    let submitted = false;
    let handle: RunModal.RunModalHandle | null = null;
    try {
      if (!canRecordSignoffPayment(offer)) throw new Error('This request has no open invoice to pay.');
      const inventory = await opts.listRecipes();
      if (disposed) return;
      const matches = inventory.recipes.filter(entry => entry.recipe_id === 'record-payment'
        && entry.recipe.recipe_id === 'record-payment'
        && entry.version >= 6 && entry.recipe.version === entry.version
        && entry.recipe.metadata?.recipe_bundle === 'recued-core/invoice-book');
      if (matches.length !== 1) throw new Error('Install or update Invoice Book from Packs, then try Record payment again.');
      const entry = matches[0]!;
      await readCurrent();
      if (disposed) return;
      handle = RunModal.wireRunModal({
        recipe: { ...entry, recipe: { ...entry.recipe,
          metadata: { ...entry.recipe.metadata, name: `Record payment — ${target.invoice_ref}` },
          variables: { ...entry.recipe.variables, invoice_id: {
            label: 'Invoice', type: 'text',
            help: `Linked invoice ${target.invoice_ref}. Open another request to record payment against a different invoice.`,
          } },
        } },
        document: opts.document,
        initialTab: 'run',
        ...(opts.serverTimeZone ? { serverTimeZone: opts.serverTimeZone } : {}),
        execute: async args => {
          if (submitted) throw new Error('This payment was already submitted. Close this window before recording another payment.');
          if (disposed || args.recipe_id !== 'record-payment' || args.config?.invoice_id !== target.invoice_id) {
            throw new Error(`This payment run belongs to invoice ${target.invoice_ref}. Keep its linked invoice selected.`);
          }
          const amount = args.config?.amount;
          if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0
            || !/^\d+(?:\.\d{1,4})?$/.test(String(amount))) {
            throw new Error('Enter an amount above zero with up to four decimal places.');
          }
          await readCurrent();
          if (disposed) throw new Error('This payment view has closed.');
          const result = await opts.execute(args);
          submitted = result.awaiting_approval === true
            || result.success && result.run_terminated === undefined;
          return result;
        },
        onRan: () => { if (!disposed) opts.onChanged(); },
        onClose: () => {
          if (modal === handle) modal = null;
          handle?.destroy();
          if (!disposed) opts.onChanged();
        },
      });
      // Do not presume the whole balance arrived: the owner fills the amount.
      handle.setConfigText(JSON.stringify({ invoice_id: target.invoice_id }, null, 2));
      modal = handle;
      (opts.document.body ?? opts.host).appendChild(handle.element);
      opts.onMessage(`Record money received for invoice ${target.invoice_ref}. Check the amount and date, then choose Run.`);
    } catch (error: unknown) {
      handle?.destroy();
      if (modal === handle) modal = null;
      if (!disposed) opts.onMessage(error instanceof Error ? error.message : 'The payment workflow could not open. Try again.');
    } finally {
      opening = false;
    }
  };

  return {
    open,
    hasInFlightWork: () => !disposed && (opening || modal?.hasInFlightWork() === true),
    dispose: () => { disposed = true; modal?.destroy(); modal = null; },
  };
};
