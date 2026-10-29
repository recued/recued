import { RpcError, type PromptSchedulePreview, type PromptScheduleTiming } from '@recued/contracts';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

/** A read-only preview; replies never change form fields or save readiness. */
export const mountPromptSchedulePreview = (options: {
  host: HTMLElement;
  readTiming: () => PromptScheduleTiming;
  calculate: (timing: PromptScheduleTiming) => Promise<PromptSchedulePreview>;
  paused: boolean;
  inactiveOneOffAt?: number;
}) => {
  const { host } = options, doc = host.ownerDocument;
  host.className = 'prompt-schedule-preview'; host.dataset.promptSchedulePreview = '';
  host.setAttribute('aria-label', 'Schedule preview');
  let disposed = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string) => {
    const element = doc.createElement(tag); element.textContent = text; return element;
  };
  const failure = (error: unknown, retryable = true) => {
    host.setAttribute('aria-busy', 'false');
    const classified = classifyRpcError(error);
    const unavailable = classified.code === 'unknown_method' || classified.code === 'not_configured';
    const message = node('p', unavailable ? 'Preview unavailable. You can still save this schedule.' : classified.copy);
    message.className = 'prompt-schedule-note';
    if (!retryable || unavailable || classified.code === 'bad_request') { host.replaceChildren(message); return; }
    const retry = node('button', 'Retry preview'); retry.type = 'button';
    retry.addEventListener('click', () => refresh(0)); host.replaceChildren(message, retry);
  };
  const refresh = (delay = 250) => {
    if (disposed) return;
    const request = ++sequence; if (timer) clearTimeout(timer);
    let timing: PromptScheduleTiming;
    try { timing = options.readTiming(); } catch (error) { failure(error, false); return; }
    host.setAttribute('aria-busy', 'true'); host.replaceChildren(node('p', 'Calculating upcoming times…'));
    timer = setTimeout(() => {
      timer = undefined;
      void (async () => {
        try {
          const result = await options.calculate(timing);
          if (disposed || request !== sequence) return;
          const past = result?.mode === 'one_shot' && result.next_runs?.length === 0
            && Number.isFinite(result.past_run_at) && result.past_run_at! <= result.calculated_at;
          if (!result || result.mode !== timing.mode || typeof result.time_zone !== 'string'
            || !Number.isFinite(result.calculated_at) || !Array.isArray(result.next_runs)
            || (!past && result.next_runs.length < 1) || result.next_runs.length > 3
            || result.next_runs.some((at, i) => !Number.isFinite(at) || at <= result.calculated_at
              || i > 0 && at <= result.next_runs[i - 1]!)) {
            throw new Error('Preview unavailable. You can still save this schedule.');
          }
          if (past && options.inactiveOneOffAt !== result.past_run_at) throw new RpcError('bad_request', 'Choose a future date and time.', 400);
          const heading = node('h3', `${past ? 'Saved time' : options.paused ? 'Next runs if resumed' : result.mode === 'one_shot' ? 'Runs once' : 'Next runs'} · ${result.time_zone}`);
          const list = doc.createElement('ol');
          for (const at of past ? [result.past_run_at!] : result.next_runs) {
            const date = new Date(at), seconds = date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0;
            const item = doc.createElement('li'), time = doc.createElement('time'); time.dateTime = date.toISOString();
            time.textContent = date.toLocaleString(undefined, { timeZone: result.time_zone, timeZoneName: 'shortOffset',
              weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              ...(seconds ? { second: '2-digit' } : {}), ...(date.getUTCMilliseconds() ? { fractionalSecondDigits: 3 as const } : {}) });
            item.append(time); list.append(item);
          }
          const note = node('p', past ? 'This one-off has no future runs. Saving keeps them off; use Run now to repeat the saved request.' : result.mode === 'one_shot'
            ? 'Runs once when Recued is available, including after downtime.'
            : `Timing is checked about once a minute. After downtime, missed runs combine into one.${result.next_runs.length < 3 ? ' Showing runs within the next year.' : ''}`);
          note.className = 'prompt-schedule-note'; host.replaceChildren(heading, list, note);
          host.setAttribute('aria-busy', 'false');
        } catch (error) { if (!disposed && request === sequence) failure(error); }
      })();
    }, delay);
  };
  return { refresh, dispose() { disposed = true; ++sequence; if (timer) clearTimeout(timer); } };
};
