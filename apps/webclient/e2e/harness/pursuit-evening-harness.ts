/** The production Pursuit form (D-342 §3) and its "Ask me in the evening" (D-343 slice 4): what it
 *  would save, read as the Yours editor reads it. */
import type { Asset } from '@recued/contracts';
import { mountPursuitEditor } from '../../src/yours/pursuit-editor.js';

const at = Date.parse('2026-11-07T12:00:00Z');
const pursuit = (name: string, settings: Record<string, unknown>): Asset => ({ id: name, name, class_id: 'pursuit', status: 'active',
  source_id: 'recued.asset', last_seen_at: at, sync_state: 'live', conflict_policy: 'recued_wins', created_at: at, updated_at: at,
  dates: { target_on: null }, readings: { progress: null }, observations: {}, values: [], anchors: [], attributes: {}, settings, rules: [],
  field_sources: {}, retirement: 'part', audience: 'owner', sphere: 'personal' } as Asset);
const host = document.querySelector<HTMLFormElement>('#panel')!;
let editor: ReturnType<typeof mountPursuitEditor> | undefined;
const controls = {
  /** Mount the form for a new pursuit (no `settings`) or to edit one with these settings. */
  mount(settings?: Record<string, unknown>) {
    host.replaceChildren();
    editor = mountPursuitEditor(host, settings ? pursuit('Learn Spanish', settings) : undefined, [], { changed: () => {} });
  },
  read: () => editor!.read(at),
};
declare global { interface Window { __pursuit: typeof controls } }
window.__pursuit = controls;
