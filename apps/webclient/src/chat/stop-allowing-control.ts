/** D-402 slice F5 (§7.9) — "Stop allowing", on the line of a chat call that a standing permission of
 *  the owner's chats ran without asking (`ChatToolCall.stop_allowing_recipe_id`): an "Always", a site
 *  pass, a grant or a rule for that recipe.
 *
 *  It asks once more, as the run's page and Contracts do, then ends everything the owner's chats may do
 *  with the recipe without asking (`collection.contract.stopAllowing`, ruling 12), and says what it
 *  ended in the same words: "Ended 1 standing approval. It asks again from now on." The model could
 *  already do it when asked (`recipe.stop_allowing`); this is the owner's own button.
 *
 *  One control per recipe, kept across the chat's repaints by its host, so a confirmation half-way
 *  or a result already said is not lost when the answer redraws. */

import { stopAllowingSummary, type PreapprovalCaller, type StopAllowingResult } from '@recued/contracts';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export type ChatStopAllowingCaller = (args: { caller: PreapprovalCaller; recipe_id: string }) => Promise<{ ended: StopAllowingResult }>;

export const CHAT_STOP_ALLOWING_ATTR = 'data-recued-chat-stop-allowing';
export const CHAT_STOP_ALLOWING_BUTTON_ATTR = 'data-recued-chat-stop-allowing-button';
export const CHAT_STOP_ALLOWING_CONFIRM_ATTR = 'data-recued-chat-stop-allowing-confirm';
export const CHAT_STOP_ALLOWING_CANCEL_ATTR = 'data-recued-chat-stop-allowing-cancel';
export const CHAT_STOP_ALLOWING_NOTE_ATTR = 'data-recued-chat-stop-allowing-note';

/** The owner's chats, as a standing permission names them. */
const OWNER_CHATS: PreapprovalCaller = { kind: 'owner_chat' };

/** The server's words, without the method name its refusals start with. */
const ownerWords = (error: unknown): string => humanizeRpcError(error).replace(/^collection\.contract\.\w+: /u, '');

export const chatStopAllowingControl = (doc: Document, stopAllowing: ChatStopAllowingCaller, recipeId: string): HTMLElement => {
  const host = doc.createElement('div');
  host.setAttribute(CHAT_STOP_ALLOWING_ATTR, recipeId);
  host.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;max-width:100%;min-width:0;overflow-wrap:anywhere';
  let phase: 'idle' | 'confirm' | 'busy' | 'done' = 'idle';
  let said = '';
  let failed = '';

  const button = (label: string, attr: string, onClick: () => void): HTMLButtonElement => {
    const node = doc.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.setAttribute(attr, '');
    node.style.cssText = 'padding:6px 10px;font:inherit;min-height:32px';
    node.addEventListener('click', onClick);
    return node;
  };
  const text = (value: string, role?: 'status' | 'alert'): HTMLElement => {
    const node = doc.createElement('span');
    node.textContent = value;
    if (role !== undefined) node.setAttribute('role', role);
    return node;
  };
  const focus = (attr: string): void => {
    (host.querySelector?.(`[${attr}]`) as HTMLElement | null)?.focus?.();
  };

  const end = async (): Promise<void> => {
    if (phase !== 'confirm') return;
    phase = 'busy';
    failed = '';
    paint();
    try {
      const { ended } = await stopAllowing({ caller: OWNER_CHATS, recipe_id: recipeId });
      const summary = stopAllowingSummary(ended);
      said = summary !== '' ? `Ended ${summary}. It asks again from now on.` : 'Nothing was left to end.';
      phase = 'done';
      paint();
      focus(CHAT_STOP_ALLOWING_NOTE_ATTR);
    } catch (error) {
      failed = `Recued could not end it: ${ownerWords(error)}`;
      phase = 'confirm';
      paint();
      focus(CHAT_STOP_ALLOWING_CONFIRM_ATTR);
    }
  };

  const paint = (): void => {
    while (host.firstChild !== null) host.removeChild(host.firstChild);
    if (phase === 'done') {
      const note = text(said, 'status');
      note.setAttribute(CHAT_STOP_ALLOWING_NOTE_ATTR, '');
      note.tabIndex = -1;
      host.append(note);
      return;
    }
    if (phase === 'idle') {
      host.append(text('Ran without asking, as you allowed. It stays on until you end it.'),
        button('Stop allowing', CHAT_STOP_ALLOWING_BUTTON_ATTR, () => {
          phase = 'confirm';
          paint();
          focus(CHAT_STOP_ALLOWING_CONFIRM_ATTR);
        }));
      return;
    }
    // Asked once more. While it runs, both buttons say they are unavailable and keep focus.
    const busy = phase === 'busy';
    const confirm = button(busy ? 'Working…' : 'Stop allowing', CHAT_STOP_ALLOWING_CONFIRM_ATTR, () => { void end(); });
    const cancel = button('Cancel', CHAT_STOP_ALLOWING_CANCEL_ATTR, () => {
      if (phase !== 'confirm') return;
      phase = 'idle';
      failed = '';
      paint();
      focus(CHAT_STOP_ALLOWING_BUTTON_ATTR);
    });
    if (busy) {
      confirm.setAttribute('aria-busy', 'true');
      confirm.setAttribute('aria-disabled', 'true');
      cancel.setAttribute('aria-disabled', 'true');
    }
    host.append(text('It asks again from now on.'), confirm, cancel);
    if (failed !== '') host.append(text(failed, 'alert'));
  };

  paint();
  return host;
};
