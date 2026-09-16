/** Settings — Server — Connect a device: the mount.
 *
 *  Renders `buildConnectDeviceRows` + `hostedAppNote`. All wording and every
 *  decision about what is safe to offer lives in `connect-device.ts`; this file
 *  only puts it on screen, so the copy stays testable without a DOM.
 *
 *  ⚠ The certificate read is FIRE-AND-FORGET and starts as `null` (= nobody
 *  asked), not `[]` (= asked, none configured). Rendering the unread state as
 *  "you have no certificate" would be asserting a fact this panel had not
 *  fetched — the same mistake as calling an unprobed server unreachable. */

import {
  CERTIFICATE_ROUTES,
  PRO_CERTIFICATE_NOTE,
  buildConnectDevicePlaces,
  hostedAppNote,
  type ConnectDeviceFacts,
  type ConnectDevicePlaceCard,
} from './connect-device.js';

export const CONNECT_DEVICE_PANEL_ATTR = 'data-recued-connect-device-panel';
export const CONNECT_DEVICE_PLACE_ATTR = 'data-recued-connect-device-place';
export const CONNECT_DEVICE_ROUTES_ATTR = 'data-recued-connect-device-routes';
export const CONNECT_DEVICE_STATE_ATTR = 'data-recued-connect-device-state';
export const CONNECT_DEVICE_HOSTED_NOTE_ATTR = 'data-recued-connect-device-hosted';

export interface MountConnectDevicePanelOptions {
  host: HTMLElement;
  document?: Document;
  /** `bootstrap.bind_port` — the LAN listener, always bound. */
  lanPort: number;
  /** `public_port` — the public listener. Defaults to 443. */
  publicPort?: number;
  /** Resolves the hostnames that hold a live certificate. Omit when no caller
   *  is wired — the panel then renders the honest "not read" wording. */
  readCertifiedHostnames?: () => Promise<readonly string[]>;
}

export interface ConnectDevicePanelMount {
  /** Re-render from current facts. Safe to call after dispose (no-ops). */
  refresh: () => void;
  dispose: () => void;
}

export const mountConnectDevicePanel = (
  opts: MountConnectDevicePanelOptions,
): ConnectDevicePanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountConnectDevicePanel: no document available — pass `opts.document`',
    );
  }

  let disposed = false;
  let facts: ConnectDeviceFacts = {
    lan_port: opts.lanPort,
    public_port: opts.publicPort ?? 443,
    certified_hostnames: null,
  };

  const el = (tag: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const renderCard = (card: ConnectDevicePlaceCard): HTMLElement => {
    const section = el('section');
    section.className = 'connect-device-card';
    section.setAttribute(CONNECT_DEVICE_PLACE_ATTR, card.place);
    section.setAttribute(CONNECT_DEVICE_STATE_ATTR, card.state);

    const heading = el('h4', card.title);
    heading.className = 'connect-device-card-title';
    const chip = el('span', card.status);
    chip.className = card.state === 'ready'
      ? 'connect-device-chip connect-device-chip-ok'
      : 'connect-device-chip connect-device-chip-todo';
    heading.appendChild(chip);
    section.appendChild(heading);

    section.appendChild(el('p', card.body));

    // ⛔ A LINK ONLY WHERE ONE WORKS. An address that opens a page and then
    // refuses to start is worse than no address — the whole reason this page
    // exists — so a card that is not ready shows the way to get there instead.
    if (card.url !== undefined) {
      const link = doc.createElement('a');
      link.className = 'connect-device-url';
      link.setAttribute('href', card.url);
      link.setAttribute('rel', 'noreferrer');
      link.textContent = card.url;
      section.appendChild(link);
    }

    const port = el('p', card.portNote);
    port.className = 'connect-device-port-note';
    section.appendChild(port);

    // The ways to get a certificate hang off the FIRST card that needs one, so
    // the reader meets them once, where the need is first stated.
    if (card.state === 'one_step' && card.place === 'at_home') {
      const routes = el('ul');
      routes.className = 'connect-device-routes';
      routes.setAttribute(CONNECT_DEVICE_ROUTES_ATTR, 'true');
      for (const route of CERTIFICATE_ROUTES) {
        const li = el('li');
        const head = el('p');
        head.className = 'connect-device-route-head';
        head.appendChild(el('strong', route.title));
        head.appendChild(el('span', ` — ${route.when}`));
        if (route.coversAway) {
          const badge = el('span', 'Works away from home too');
          badge.className = 'connect-device-route-badge';
          head.appendChild(badge);
        }
        li.appendChild(head);
        li.appendChild(el('p', route.detail));
        // `textContent`, so a command can never become markup.
        if (route.command !== undefined) {
          const pre = el('pre');
          pre.className = 'connect-device-command';
          pre.appendChild(el('code', route.command));
          li.appendChild(pre);
        }
        routes.appendChild(li);
      }
      section.appendChild(routes);
      const pro = el('p', PRO_CERTIFICATE_NOTE);
      pro.className = 'connect-device-pro-note';
      section.appendChild(pro);
    }
    return section;
  };

  const render = (): void => {
    if (disposed) return;
    // ⚠ `innerHTML = ''`, NOT `replaceChildren()` — the same note
    // `server-timezone-panel.ts` carries, and for the same reason: the
    // webclient's test fakes implement exactly the DOM surface the existing
    // panels use, so a panel reaching for a newer method makes every fake in the
    // tree grow one to accommodate it. This panel's own tests are pure (no DOM)
    // and a real-Chrome verify passed, so it was the COMPOSITION-ROOT test that
    // caught it — exactly as that note predicts.
    opts.host.innerHTML = '';
    const panel = el('div');
    panel.className = 'connect-device-panel';
    panel.setAttribute(CONNECT_DEVICE_PANEL_ATTR, 'true');

    const intro = el('p', 'Where you can open Recued, and what each one needs.');
    intro.className = 'connect-device-intro';
    panel.appendChild(intro);

    for (const card of buildConnectDevicePlaces(facts)) panel.appendChild(renderCard(card));

    const hosted = el('p', hostedAppNote(facts));
    hosted.className = 'connect-device-hosted-note';
    hosted.setAttribute(CONNECT_DEVICE_HOSTED_NOTE_ATTR, 'true');
    panel.appendChild(hosted);

    opts.host.appendChild(panel);
  };

  render();

  // Fire-and-forget: the panel is useful before this resolves, and a failed read
  // leaves `null` (not read) rather than `[]` (read, none) on purpose.
  if (opts.readCertifiedHostnames !== undefined) {
    void (async () => {
      try {
        const hostnames = await opts.readCertifiedHostnames!();
        if (disposed) return;
        facts = { ...facts, certified_hostnames: hostnames };
        render();
      } catch {
        /* keep `null` — see the header note */
      }
    })();
  }

  return {
    refresh: render,
    dispose: () => { disposed = true; },
  };
};

/** Scoped to this panel's own attributes, so the rules are inert anywhere the
 *  panel does not mount.
 *
 *  ⚠ Shipped WITH the panel deliberately. `bootstrap-settings-route.ts` records
 *  three panels that landed with no styles and rendered as an unseparated run of
 *  controls; a page whose whole job is to be readable by a beginner is the worst
 *  place to repeat that. */
export const CONNECT_DEVICE_PANEL_STYLES = `
[${CONNECT_DEVICE_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-size: 13px;
  color: var(--fg);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-intro {
  margin: 0;
  color: var(--fg-muted, var(--fg));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-card-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-chip {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border: 1px solid var(--border);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-chip-ok {
  border-color: var(--accent);
  color: var(--on-accent, var(--fg));
  background: var(--accent);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-chip-todo {
  color: var(--fg-muted, var(--fg));
  background: var(--accent-weak, transparent);
}
/* The actual two-column table: label gutter + value. max-content keeps the
   labels tight so the values start on one shared edge, which is what makes the
   two ports comparable at a glance. */
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-card p {
  margin: 0;
  line-height: 1.55;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-port-note {
  font-size: 12px;
  color: var(--fg-muted, var(--fg));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-route-badge {
  margin-left: 8px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--accent);
  font-size: 11px;
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-url {
  display: inline-block;
  padding: 3px 8px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 4px;
  background: var(--surface, var(--bg));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--fg);
  text-decoration: none;
  word-break: break-all;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-url:hover {
  border-color: var(--accent);
}
/* The certificate routes sit inside the port that needs one. Indented under a
   left rule so they read as "how to satisfy the row above", not as a fourth
   table. */
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-routes {
  margin: 2px 0 0;
  padding: 0 0 0 14px;
  border-left: 2px solid var(--accent-weak, var(--border));
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-routes li {
  line-height: 1.5;
  color: var(--fg-muted, var(--fg));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-routes p {
  margin: 0 0 4px;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-route-head strong {
  color: var(--fg);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-command {
  margin: 4px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface, var(--bg));
  overflow-x: auto;
  white-space: pre;
  tab-size: 2;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-command code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--fg);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-pro-note {
  margin: 2px 0 0;
  line-height: 1.5;
  color: var(--fg-muted, var(--fg));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-hosted-note {
  margin: 0;
  line-height: 1.5;
  color: var(--fg-muted, var(--fg));
}
`;
