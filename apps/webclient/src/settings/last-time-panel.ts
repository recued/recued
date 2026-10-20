import type { YoursLearningStatus } from '@recued/contracts';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { lastTimeStateText } from '../yours/last-time-words.js';

/** D-325 §15.7 — Settings → Privacy → Learning: "last time" on or off (P21), and the
 * one list of people, places and dates it never brings up, which sits at the top of
 * Yours → Episodes (P17). The once-only question that turns it on waits in the bell. */
export interface LastTimePanelOptions {
  host: HTMLElement; document?: Document;
  read: () => Promise<YoursLearningStatus>;
  save: (choice: 'on' | 'off') => Promise<unknown>;
}

export const mountLastTimePanel = (opts: LastTimePanelOptions) => {
  const doc = opts.document ?? document; const root = doc.createElement('section'); root.setAttribute('data-last-time', ''); opts.host.appendChild(root);
  let disposed = false; let busy = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = root) => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; parent.appendChild(value); return value;
  };
  const say = (text: string, error = false) => {
    const message = root.querySelector<HTMLElement>('[data-last-time-message]');
    if (message) { message.textContent = text; message.setAttribute('role', error ? 'alert' : 'status'); }
  };
  const paint = (status: YoursLearningStatus) => {
    root.textContent = '';
    node('h4', 'Last time');
    node('p', 'Offers in your overview what you did around this date before, such as flowers before a yearly trip, and suggests yearly occasions and habits from what you did among your proposals in Yours. It reads only your own records.');
    node('p', 'A kind of offer reaches your overview only once it has proved useful often enough, at a rate you accept in Yours → Episodes.');
    node('p', lastTimeStateText(status)).setAttribute('data-last-time-state', '');
    const choose = (label: string, choice: 'on' | 'off') => {
      const button = node('button', label); button.type = 'button'; button.dataset.lastTimeChoice = choice;
      button.addEventListener('click', async () => {
        if (busy) return; busy = true; for (const item of root.querySelectorAll('button')) item.disabled = true; say('Saving…');
        try { await opts.save(choice); if (disposed) return; paint(await opts.read()); say(choice === 'on' ? 'Last time is on.' : 'Last time is off.');
          root.querySelector<HTMLElement>('[data-last-time-choice]')?.focus(); }
        catch (error) { if (!disposed) { for (const item of root.querySelectorAll('button')) item.disabled = false; say(error instanceof Error ? error.message : String(error), true); } }
        finally { busy = false; }
      });
    };
    if (status.last_time !== 'on') choose('Allow last time', 'on');
    if (status.last_time !== 'off') choose(status.last_time === 'on' ? 'Turn last time off' : 'Keep it off', 'off');
    const exclusions = node('a', 'People, places and dates it never brings up'); exclusions.href = '#yours/episodes';
    node('p').setAttribute('data-last-time-message', '');
  };
  const refresh = async () => {
    if (disposed || busy) return;
    try { const status = await opts.read(); if (!disposed) paint(status); }
    catch (error) {
      if (disposed) return;
      // A server without the read predates this panel: leave it out, as Yours does.
      if (classifyRpcError(error).code === 'unknown_method') { root.remove(); return; }
      root.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  void refresh();
  return { refresh, dispose() { disposed = true; root.remove(); } };
};
