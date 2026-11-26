import {
  DEFAULT_MISSED_SCHEDULE_POLICY, FOCUS_BLOCK_PACK, FOCUS_BLOCK_RECIPE_ID, focusBlockStarterSettings,
  isInstalledFocusBlockStarter, isReadableFocusBlockStarter,
  type CollectionInstanceRow, type Dish, type FocusBlocksPreviewRequest, type ServerExecuteResponse,
  type ServerRecipeFullEntry, type ServerRpcRegistry,
} from '@recued/contracts';
import { e, type RunModal } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../shell/route.js';
import { wireRunModal } from '../shell/run-modal.js';

type ScheduleRequest = ServerRpcRegistry['schedules.create']['request'];
type DishRequest = ServerRpcRegistry['dishes.create']['request'];

export interface FocusBlockSetupCallers {
  recipe: () => Promise<{ recipe: ServerRecipeFullEntry | null }>;
  calendars: () => Promise<{ instances: CollectionInstanceRow[] }>;
  preview: (request: FocusBlocksPreviewRequest) => Promise<ServerExecuteResponse>;
  dishes: () => Promise<{ dishes: Dish[] }>;
  createDish: (request: DishRequest) => Promise<{ dish: Dish }>;
  schedules: RunModal.RunModalSchedulesListCaller;
  createSchedule: (request: ScheduleRequest) => Promise<{ schedule: import('@recued/contracts').ServerSchedule }>;
  timeZone: () => string | undefined;
}

interface Block {
  start: string;
  end: string;
  minutes: number;
}

interface FocusResult {
  day: string;
  verdict: string;
  blocks: Block[];
  runId?: string;
}

const blockList = (blocks: Block[]): string => '<ul>' + blocks.map(block =>
  `<li>${e(block.start)}–${e(block.end)} · ${e(String(block.minutes))} minutes</li>`).join('') + '</ul>';

// The same four one-hour meetings used to drive the recipe on the owner's clock.
const EXAMPLE: Block[] = [
  { start: '11:00', end: '14:00', minutes: 180 },
  { start: '15:00', end: '16:00', minutes: 60 },
  { start: '17:00', end: '18:00', minutes: 60 },
];

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const resultOf = (response: ServerExecuteResponse): FocusResult => {
  if (!response.success || response.awaiting_approval || response.recipe_id !== FOCUS_BLOCK_RECIPE_ID) {
    throw new Error('Recued could not finish the calendar preview. Check the connection and try again.');
  }
  const summary = object(response.output.render.find(section => section.type === 'summary')?.data);
  const fields = Array.isArray(summary.fields) ? summary.fields.map(object) : [];
  const day = fields.find(field => field.label === 'Day')?.value;
  const verdict = fields.find(field => field.label === 'Verdict')?.value;
  const proposed = response.output.render.find(section => section.type === 'json')?.data;
  const table = object(response.output.render.find(section => section.type === 'table')?.data);
  if (typeof day !== 'string' || typeof verdict !== 'string' || !Array.isArray(proposed) || !Array.isArray(table.rows)) {
    throw new Error('Recued could not read the preview result. Try running it again.');
  }
  // The JSON section is the recipe's actual suggestion list. Its table can
  // also describe gaps on a day below the meeting threshold.
  const blocks = proposed.length === 0 ? [] : table.rows.map((value: unknown) => {
    const row = object(value);
    if (typeof row.gap_start_text !== 'string' || typeof row.gap_end_text !== 'string'
      || typeof row.gap_minutes !== 'number' || !Number.isFinite(row.gap_minutes)) {
      throw new Error('Recued could not read the suggested blocks. Try running the preview again.');
    }
    return { start: row.gap_start_text, end: row.gap_end_text, minutes: row.gap_minutes };
  });
  if (blocks.length !== proposed.length) throw new Error('The preview result is incomplete. Try running it again.');
  return { day, verdict, blocks, runId: response.run_id };
};

const usableCalendars = (instances: CollectionInstanceRow[]) => instances.filter(calendar =>
  calendar.platform === 'calendar' && calendar.auth_state === 'healthy' && 'read' in calendar.caps
    && calendar.caps.read === 'yes' && calendar.slug.trim().length > 0);

const matchesSettings = (dish: Dish, settings: ReturnType<typeof focusBlockStarterSettings>): boolean =>
  dish.recipe_id === FOCUS_BLOCK_RECIPE_ID && dish.enabled
    && Object.entries(settings).every(([key, value]) => dish.config_overlay[key] === value);

export const FOCUS_BLOCK_SETUP_STYLES = `
.focus-block-setup { display:grid; gap:8px; border:1px solid var(--border); border-radius:.5rem; background:var(--surface); padding:12px; }
.focus-block-setup h2, .focus-block-setup h3, .focus-block-setup p, .focus-block-setup ul { margin:0; }
.focus-block-setup h2 { font-size:16px; }
.focus-block-setup details > p, .focus-block-setup details > ul { margin-top:6px; }
.focus-block-setup ul { padding-inline-start:20px; }
.focus-block-setup [data-focus-stage], .focus-block-setup form { display:grid; justify-items:start; gap:8px; min-width:0; }
.focus-block-setup label { display:grid; gap:4px; width:min(100%,22rem); }
.focus-block-setup button, .focus-block-setup select { font:inherit; min-height:44px; max-width:100%; padding:6px 10px; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:6px; }
.focus-block-setup button:disabled { opacity:.6; }
.focus-block-setup .focus-block-result { display:grid; gap:6px; min-width:0; overflow-wrap:anywhere; }
`;

export const mountFocusBlockSetup = (doc: Document, callers: FocusBlockSetupCallers) => {
  const element = doc.createElement('section');
  element.className = 'focus-block-setup';
  element.setAttribute('aria-labelledby', 'setup-focus-blocks');
  element.innerHTML = '<h2 id="setup-focus-blocks">Try Focus block proposer</h2>'
    + '<p>Find time for focused work on a meeting-heavy day.</p><details><summary>See a worked example</summary>'
    + '<p>Four hour-long meetings start at 09:00, 10:00, 14:00 and 16:00. The workflow looks for gaps of at least an hour before 18:00.</p>'
    + blockList(EXAMPLE) + '</details>';
  const stage = doc.createElement('div');
  stage.setAttribute('data-focus-stage', '');
  element.appendChild(stage);

  let disposed = false, started = false, busy = false, loaded = false;
  let entry: ServerRecipeFullEntry | null = null;
  let calendars: CollectionInstanceRow[] = [];
  let slug = '';
  let result: FocusResult | null = null;
  let error = '', notice = '';
  let needsSettings = false;
  let modal: RunModal.RunModalHandle | null = null;

  const paint = (focus?: string) => {
    if (disposed) return;
    const resultHtml = result ? `<section class="focus-block-result" aria-label="Focus block preview">
      <h3 tabindex="-1" data-focus-result>Focus blocks for ${e(result.day)}</h3>
      <p>${e(slug)} · ${e(result.verdict)}</p>
      ${result.blocks.length ? blockList(result.blocks) : '<p>No focus blocks proposed.</p>'}
      ${needsSettings
        ? `<p>Save run settings for ${e(slug)} before choosing a schedule.</p>
           <button type="button" data-focus-action="save-settings"${busy ? ' disabled' : ''}>Save these run settings</button>`
        : `<button type="button" data-focus-action="schedule"${busy ? ' disabled' : ''}>Set up a recurring run</button>`}
      ${result.runId ? `<a href="${e(serializeShellRoute('logs', result.runId))}">View this run</a>` : ''}
    </section>` : '';
    const options = calendars.map(calendar =>
      `<option value="${e(calendar.slug)}"${calendar.slug === slug ? ' selected' : ''}>${e(calendar.slug)}</option>`).join('');
    let content = '<button type="button" data-focus-action="load">Use my calendar</button>';
    if (started) {
      if (!loaded) {
        content = busy ? '<p role="status">Checking the workflow and calendars…</p>'
          : '<button type="button" data-focus-action="load">Check again</button>';
      } else if (!entry || !isInstalledFocusBlockStarter(entry)) {
        content = `<p>Install Daily Ops to use your calendar.</p><a href="${serializeShellRoute('packs', FOCUS_BLOCK_PACK)}">Open Daily Ops</a>`;
      } else if (!isReadableFocusBlockStarter(entry)) {
        content = `<p>This installed version cannot be used for the read-only preview.</p><a href="${serializeShellRoute('packs', FOCUS_BLOCK_PACK)}">Open Daily Ops</a>`;
      } else if (!calendars.length) {
        content = `<p>Connect a calendar to run the preview.</p><a href="${serializeShellRoute('connections', 'calendar')}">Connect a calendar</a>`;
      } else {
        content = `<form><label>Calendar<select name="calendar"${busy ? ' disabled' : ''}>
          <option value="">Choose a calendar</option>${options}</select></label>
          <p>Preview tomorrow using the selected calendar’s synced events and the server’s time zone.</p>
          <button type="submit"${busy || !slug ? ' disabled' : ''}>Preview focus blocks</button></form>${resultHtml}`;
      }
      if (loaded && !busy) content += '<button type="button" data-focus-action="load">Refresh setup</button>';
    }
    stage.innerHTML = content + (busy && loaded ? '<p role="status">Working…</p>' : '')
      + (error ? `<p role="alert">${e(error)}</p>` : '') + (notice ? `<p role="status">${e(notice)}</p>` : '');
    if (focus) (stage.querySelector<HTMLElement>(focus) ?? stage.querySelector<HTMLElement>('button, a'))?.focus();
  };

  const load = async () => {
    started = true; loaded = false; busy = true; result = null; needsSettings = false; error = ''; notice = '';
    paint();
    try {
      entry = (await callers.recipe()).recipe;
      if (disposed) return;
      if (entry && isReadableFocusBlockStarter(entry)) {
        calendars = usableCalendars((await callers.calendars()).instances);
        if (!calendars.some(calendar => calendar.slug === slug)) slug = '';
      }
      loaded = true;
    } catch (err) { error = humanizeRpcError(err); }
    finally { busy = false; paint('select'); }
  };

  const preview = async () => {
    if (!entry || !isReadableFocusBlockStarter(entry) || !calendars.some(calendar => calendar.slug === slug)) return;
    busy = true; result = null; needsSettings = false; error = ''; notice = ''; paint();
    try { result = resultOf(await callers.preview({ calendar_slug: slug, recipe_hash: entry.recipe_hash })); }
    catch (err) { error = humanizeRpcError(err); }
    finally { busy = false; paint(result ? '[data-focus-result]' : 'button[type="submit"]'); }
  };

  const openSchedule = async (saveSettings = false) => {
    if (!entry || !result || modal) return;
    const snapshot = entry;
    const settings = focusBlockStarterSettings(slug);
    const checkSelection = async () => {
      const { recipe } = await callers.recipe();
      if (disposed) throw new Error('Set up closed. Open it again to continue.');
      if (!recipe || recipe.recipe_hash !== snapshot.recipe_hash || !isReadableFocusBlockStarter(recipe)) {
        throw new Error('The installed workflow changed. Refresh setup and preview it again.');
      }
      if (!usableCalendars((await callers.calendars()).instances).some(calendar => calendar.slug === settings.calendar_slug)) {
        throw new Error('The selected calendar is unavailable. Refresh setup and choose a calendar.');
      }
      if (disposed) throw new Error('Set up closed. Open it again to continue.');
    };
    busy = true; error = ''; notice = ''; paint();
    const onClose = () => {
      modal = null;
      paint('[data-focus-action="schedule"]');
    };
    try {
      await checkSelection();
      const { dishes } = await callers.dishes();
      if (disposed) return;
      let matching = dishes.find(dish => matchesSettings(dish, settings));
      if (!matching && dishes.length > 0) {
        if (!saveSettings) { needsSettings = true; return; }
        matching = (await callers.createDish({
          recipe_id: snapshot.recipe_id, publisher_id: snapshot.publisher_id,
          name: 'Focus blocks on ' + settings.calendar_slug, config_overlay: settings,
        })).dish;
        notice = 'Run settings saved for ' + settings.calendar_slug + '.';
        if (disposed) return;
      }
      needsSettings = false;
      let scheduleDishId = matching?.dish_id;
      const createSchedule = async (request: ScheduleRequest) => {
        await checkSelection();
        const latest = (await callers.dishes()).dishes.find(dish =>
          matchesSettings(dish, settings) && (scheduleDishId === undefined || dish.dish_id === scheduleDishId));
        if (scheduleDishId && !latest) throw new Error('The saved run settings changed. Close this form and try again.');
        const existing = latest && (await callers.schedules()).schedules.find(schedule =>
          schedule.dish_id === latest.dish_id && schedule.enabled && (request.mode === 'one_shot'
            ? schedule.run_at === request.run_at
            : schedule.mode !== 'one_shot' && schedule.cron_expression === request.cron_expression
              && (schedule.missed_policy ?? DEFAULT_MISSED_SCHEDULE_POLICY) === (request.missed_policy ?? DEFAULT_MISSED_SCHEDULE_POLICY)));
        if (disposed) throw new Error('Set up closed. Open it again to continue.');
        const saved = existing ? { schedule: existing } : await callers.createSchedule({
          ...request, ...(latest ? { dish_id: latest.dish_id } : { config_overlay: settings }),
        });
        scheduleDishId = saved.schedule.dish_id;
        notice = 'Schedule saved for ' + settings.calendar_slug + '.';
        return saved;
      };
      const handle = wireRunModal({
        document: doc, recipe: snapshot, initialTab: 'schedule', serverTimeZone: callers.timeZone,
        ...(matching ? { dishes: [matching], dish_id: matching.dish_id } : {}),
        schedulesList: async () => ({ schedules: (await callers.schedules()).schedules
          .filter(schedule => scheduleDishId && schedule.dish_id === scheduleDishId) }),
        schedulesCreate: createSchedule,
        onClose: () => { handle.destroy(); onClose(); },
      });
      modal = handle;
      doc.body.appendChild(handle.element);
    } catch (err) { error = humanizeRpcError(err); }
    finally {
      busy = false;
      paint(modal ? undefined : needsSettings ? '[data-focus-action="save-settings"]' : '[data-focus-action="schedule"]');
    }
  };

  stage.addEventListener('change', event => {
    const select = (event.target as HTMLElement).closest<HTMLSelectElement>('select[name="calendar"]');
    if (!select || busy) return;
    slug = select.value; result = null; needsSettings = false; error = ''; notice = ''; paint('select');
  });
  stage.addEventListener('submit', event => { event.preventDefault(); if (!busy) void preview(); });
  stage.addEventListener('click', event => {
    if (busy) return;
    const action = (event.target as HTMLElement).closest('button')?.getAttribute('data-focus-action');
    if (action === 'load') void load();
    if (action === 'schedule' || action === 'save-settings') void openSchedule(action === 'save-settings');
  });
  paint();
  return {
    element,
    dispose: () => { disposed = true; modal?.destroy(); element.remove(); },
  };
};
