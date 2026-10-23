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
  let disposed = false; let busy = false; let reading = false; let generation = 0;
  let status: YoursLearningStatus | undefined;
  let stateWords = '';
  let readFailed = false;
  let confirming: 'on' | 'off' | undefined;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = root) => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; parent.appendChild(value); return value;
  };
  node('h4', 'Last time');
  node('p', 'Offers in your overview what you did around this date before, such as flowers before a yearly trip, and suggests yearly occasions and habits from what you did among your proposals in Yours. It reads only your own records.');
  node('p', 'A kind of offer reaches your overview only once it has proved useful often enough, at a rate you accept in Yours → Episodes.');
  const state = node('p'); state.setAttribute('data-last-time-state', '');
  const choose = (label: string, choice: 'on' | 'off') => {
    const button = node('button', label); button.type = 'button'; button.dataset.lastTimeChoice = choice;
    button.addEventListener('click', () => { void write(choice, button); });
    return button;
  };
  const allow = choose('Allow last time', 'on');
  const turnOff = choose('Turn last time off', 'off');
  const choices = [allow, turnOff];
  const exclusions = node('a', 'People, places and dates it never brings up'); exclusions.href = '#yours/episodes';
  const message = node('p'); message.setAttribute('data-last-time-message', '');
  message.setAttribute('role', 'status'); message.setAttribute('tabindex', '-1'); message.setAttribute('aria-atomic', 'true');
  const retry = node('button', 'Retry Last time settings'); retry.type = 'button';
  retry.setAttribute('data-last-time-retry', ''); retry.hidden = true;
  const say = (text: string, error = false) => {
    message.textContent = text; message.setAttribute('role', error ? 'alert' : 'status');
  };
  const focusChoice = () => (choices.find(button => !button.hidden && !button.disabled)
    ?? (!retry.hidden && !retry.disabled ? retry : message)).focus({ preventScroll: true });
  const paint = () => {
    if (disposed) return;
    const owner = choices.find(button => doc.activeElement === button);
    state.textContent = status ? `${busy || readFailed ? 'Last confirmed: ' : ''}${stateWords}`
      : reading ? 'Checking current setting…' : 'Current setting unavailable.';
    allow.hidden = !status || status.last_time === 'on';
    turnOff.hidden = !status || status.last_time === 'off';
    turnOff.textContent = status?.last_time === 'unasked' ? 'Keep it off' : 'Turn last time off';
    for (const button of choices) button.disabled = busy || readFailed || !status;
    retry.disabled = busy || reading;
    if (owner && (owner.hidden || owner.disabled) && root.isConnected) focusChoice();
  };
  const accept = (next: YoursLearningStatus, otherwise: string) => {
    // Derive the words before replacing the last good status, so an unreadable
    // reply cannot leave a broken snapshot for the error render.
    if (!next || !['on', 'off', 'unasked'].includes(next.last_time) || !Array.isArray(next.classes)) {
      throw new Error('Recued could not read the Last time setting. Try again.');
    }
    const words = lastTimeStateText(next);
    status = next; stateWords = words; readFailed = false;
    if (confirming && next.last_time !== confirming) {
      say('The change could not be confirmed. The current setting is shown above. Try checking again.', true);
      retry.hidden = false;
    } else {
      say(confirming ? `Last time is ${confirming}.` : otherwise);
      confirming = undefined; retry.hidden = true;
    }
    paint();
  };
  const write = async (choice: 'on' | 'off', button: HTMLButtonElement) => {
    if (disposed || busy || !status || readFailed) return;
    const ownGeneration = ++generation;
    const owned = doc.activeElement === button;
    busy = true; reading = false; confirming = choice;
    say('Saving…');
    if (owned) message.focus({ preventScroll: true });
    retry.hidden = true; paint();
    try {
      await opts.save(choice);
      if (disposed || ownGeneration !== generation) return;
      say('Checking the Last time setting…');
      const next = await opts.read();
      if (disposed || ownGeneration !== generation) return;
      accept(next, '');
    } catch (error) {
      if (disposed || ownGeneration !== generation) return;
      // A lost write acknowledgement may still have applied the choice. Check
      // the current setting before offering another write.
      readFailed = true; retry.hidden = false;
      say(classifyRpcError(error).copy, true);
    } finally {
      busy = false;
      if (!disposed && ownGeneration === generation) {
        paint();
        if (owned && doc.activeElement === message) focusChoice();
      }
    }
  };
  const refresh = async () => {
    if (disposed || busy) return;
    const ownGeneration = ++generation;
    const owned = doc.activeElement === retry;
    const hadStatus = status !== undefined;
    reading = true; say('Checking Last time settings…');
    if (owned) message.focus({ preventScroll: true });
    retry.hidden = true; paint();
    try {
      const next = await opts.read();
      if (disposed || ownGeneration !== generation) return;
      accept(next, hadStatus ? 'Last time settings updated.' : '');
    }
    catch (error) {
      if (disposed || ownGeneration !== generation) return;
      // A server without the read predates this panel: leave it out, as Yours does.
      if (!status && classifyRpcError(error).code === 'unknown_method') { disposed = true; root.remove(); return; }
      readFailed = true; retry.hidden = false;
      say(classifyRpcError(error).copy, true);
    } finally {
      if (!disposed && ownGeneration === generation) {
        reading = false; paint();
        if (owned && doc.activeElement === message) focusChoice();
      }
    }
  };
  retry.addEventListener('click', () => { if (!reading && !busy) void refresh(); });
  void refresh();
  return { refresh, dispose() { disposed = true; generation += 1; root.remove(); } };
};
