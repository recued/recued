/** D-116 follow-up — server `/status` mirror.
 *
 *  Self-host equivalent of the extension's options-page auto-disabled
 *  section. The extension consumes the same `summarizeAutoDisabled`
 *  projection from `@recued/scheduler`; this module wraps it for two
 *  surfaces:
 *
 *    GET /status        — small HTML page (default: text/html). Self-
 *                         hosters proxy or hit it directly.
 *    GET /status.json   — same payload as JSON. Used by the CLI's
 *                         `recued-server status` command when the
 *                         daemon is running.
 *
 *  Both routes require Bearer-token auth against the realm token —
 *  recipe IDs leak active integrations (mail / calendar / etc.) which
 *  is light fingerprinting if exposed open.
 *
 *  CLI status reads SQLite directly when the server is stopped (see
 *  `cli-status-extras.ts`). The HTTP path here is the live-roster
 *  surface — process_id + last_finished_at reflect in-memory state.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutoDisabledSummary } from '@recued/scheduler';
import type { LaneStatus } from '@recued/contracts';

export interface StatusPageDeps {
  /** Build the live auto-disabled summary. The closure captures the
   *  server's auto-run handle, recipe store, and circuit-breaker store
   *  so the request handler doesn't have to know about any of them. */
  buildSummary: () => AutoDisabledSummary[];
  /** Realm token — Bearer credential required to view either route.
   *  Empty string disables auth (test compositions). */
  realmToken: string;
  /** Server-id surfaced in the page header. Optional. */
  serverId?: string;
  /** D-181 §12 — live per-lane long-op governor occupancy for the status
   *  page's lanes line. Read at request time off the in-flight registry
   *  (`registry.laneStatus()`). Absent (dbless / unwired registry) ⇒ the
   *  lanes section is omitted. Best-effort: a throw is swallowed. */
  laneStatus?: () => LaneStatus[];
  /** Clock for the "generated at" timestamp. */
  now?: () => number;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtTime = (epoch: number | null): string => {
  if (epoch === null) return '—';
  try { return new Date(epoch).toISOString(); }
  catch { return '—'; }
};

/** Compact human duration for the lanes line's `oldest_wait_ms`. 0 → "—". */
const fmtWait = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
};

/** Render the HTML page. Self-contained (inline CSS) so it works
 *  through a reverse-proxy without extra static assets. */
/** D-181 §12 — the long-op lanes section: one row per typed lane with its
 *  auto-detected capacity, in-use / queued counts, and the oldest waiter's
 *  age. Omitted entirely when no lane status is available (unwired registry). */
const renderLanesHtml = (lanes: readonly LaneStatus[]): string => {
  if (lanes.length === 0) return '';
  return `
    <h1 style="margin-top:24px">long-op lanes</h1>
    <table>
      <thead>
        <tr>
          <th>Lane</th>
          <th>In use</th>
          <th>Queued</th>
          <th>Oldest wait</th>
        </tr>
      </thead>
      <tbody>
        ${lanes.map((l) => `
          <tr>
            <td><code>${escapeHtml(l.lane)}</code></td>
            <td>${l.in_use} / ${l.capacity}</td>
            <td>${l.queued}</td>
            <td><small>${escapeHtml(fmtWait(l.oldest_wait_ms))}</small></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
};

export const renderStatusHtml = (
  summary: readonly AutoDisabledSummary[],
  meta: { serverId?: string; generatedAt: number; lanes?: readonly LaneStatus[] },
): string => {
  const rowsHtml = summary.length === 0
    ? `<p class="empty">No reactive recipes are currently auto-disabled. ✓</p>`
    : `
      <table>
        <thead>
          <tr>
            <th>Recipe</th>
            <th>Publisher</th>
            <th>Failures</th>
            <th>Last fired</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          ${summary.map((s) => `
            <tr>
              <td><code>${escapeHtml(s.recipe_id)}</code><br><small>${escapeHtml(s.name)}</small></td>
              <td>${escapeHtml(s.publisher_id)}</td>
              <td>${s.consecutive_failures}</td>
              <td><small>${escapeHtml(fmtTime(s.last_finished_at))}</small></td>
              <td><small>${s.last_failure_reason ? escapeHtml(s.last_failure_reason) : '—'}</small></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>recued — status</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .meta { color: #888; font-size: 12px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
    th { background: #f7f7f7; font-weight: 600; }
    code { background: #f1f1f1; padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, monospace; }
    small { color: #888; }
    .empty { color: #444; padding: 12px 14px; background: #f7f7f7; border-radius: 4px; }
    .help { color: #888; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>recued — auto-disabled recipes</h1>
  <div class="meta">
    ${meta.serverId ? `Instance: <code>${escapeHtml(meta.serverId)}</code> · ` : ''}
    Generated: ${escapeHtml(fmtTime(meta.generatedAt))}
  </div>
  ${rowsHtml}
  ${renderLanesHtml(meta.lanes ?? [])}
  <p class="help">
    Reset a disabled recipe via the paired extension's Options page,
    or run <code>recued status</code> on the server host.
  </p>
</body>
</html>`;
};

export interface StatusJsonPayload {
  generated_at: number;
  server_id?: string;
  auto_disabled: AutoDisabledSummary[];
  /** D-181 §12 — per-lane long-op governor occupancy. Omitted when no lane
   *  status is available (unwired registry). */
  lanes?: LaneStatus[];
}

export const renderStatusJson = (
  summary: readonly AutoDisabledSummary[],
  meta: { serverId?: string; generatedAt: number; lanes?: readonly LaneStatus[] },
): StatusJsonPayload => ({
  generated_at: meta.generatedAt,
  ...(meta.serverId ? { server_id: meta.serverId } : {}),
  auto_disabled: [...summary],
  ...(meta.lanes && meta.lanes.length > 0 ? { lanes: [...meta.lanes] } : {}),
});

const extractBearer = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1].trim() || null) : null;
};

/** Handle either `/status` or `/status.json`. The route dispatcher
 *  in `server.ts` picks the format based on the URL suffix. */
export const handleStatusRequest = (
  deps: StatusPageDeps,
  req: IncomingMessage,
  res: ServerResponse,
  format: 'html' | 'json',
): void => {
  if (deps.realmToken.length > 0) {
    const provided = extractBearer(req);
    if (provided !== deps.realmToken) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        error: { code: 'unauthorized', message: 'Bearer realm token required.' },
      }));
      return;
    }
  }
  let summary: AutoDisabledSummary[];
  try { summary = deps.buildSummary(); }
  catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: {
        code: 'status_unavailable',
        message: e instanceof Error ? e.message : String(e),
      },
    }));
    return;
  }
  const generatedAt = (deps.now ?? Date.now)();
  // D-181 §12 — best-effort live lane occupancy; a throw never fails /status.
  let lanes: LaneStatus[] = [];
  if (deps.laneStatus) {
    try { lanes = deps.laneStatus(); }
    catch { lanes = []; }
  }
  const meta = {
    generatedAt,
    ...(deps.serverId ? { serverId: deps.serverId } : {}),
    ...(lanes.length > 0 ? { lanes } : {}),
  };
  if (format === 'json') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(renderStatusJson(summary, meta)));
  } else {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderStatusHtml(summary, meta));
  }
};
