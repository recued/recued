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
  CERTIFICATE_ROUTES_HEADING,
  CHECK_FROM_OUTSIDE_AGAIN_LABEL,
  CONNECT_DEVICE_INTRO,
  CHECK_FROM_OUTSIDE_ERROR,
  CHECK_FROM_OUTSIDE_LABEL,
  CHECK_FROM_OUTSIDE_RUNNING_LABEL,
  CHECK_EXPOSURE_LABEL,
  CHECK_EXPOSURE_AGAIN_LABEL,
  CHECK_EXPOSURE_RUNNING_LABEL,
  CHECK_HERE_LABEL,
  CHECK_HERE_AGAIN_LABEL,
  CHECK_HERE_RUNNING_LABEL,
  CHECK_CONNECTION_LABEL,
  CHECK_CONNECTION_NOTE,
  PAIRING_HEADING,
  PAIRING_STEPS,
  PAIRING_FIRST_DEVICE_NOTE,
  PRO_CERTIFICATE_NOTE,
  buildConnectDevicePlaces,
  hostedAppNote,
  type ConnectDeviceFacts,
  type ConnectDevicePlaceCard,
} from './connect-device.js';

export const CONNECT_DEVICE_PANEL_ATTR = 'data-recued-connect-device-panel';
export const CONNECT_DEVICE_PLACE_ATTR = 'data-recued-connect-device-place';
export const CONNECT_DEVICE_ROUTES_ATTR = 'data-recued-connect-device-routes';
export const CONNECT_DEVICE_STEPS_ATTR = 'data-recued-connect-device-steps';
export const CONNECT_DEVICE_STEP_DONE_ATTR = 'data-recued-connect-device-step-done';
export const CONNECT_DEVICE_STEP_KEY_ATTR = 'data-recued-connect-device-step-key';
export const CONNECT_DEVICE_CHECK_BTN_ATTR = 'data-recued-connect-device-check';
export const CONNECT_DEVICE_CHECK_ERROR_ATTR = 'data-recued-connect-device-check-error';
export const CONNECT_DEVICE_STATE_ATTR = 'data-recued-connect-device-state';
export const CONNECT_DEVICE_NOTE_ATTR = 'data-recued-connect-device-note';
export const CONNECT_DEVICE_EXPOSURE_CHECK_BTN_ATTR =
  'data-recued-connect-device-exposure-check';
export const CONNECT_DEVICE_EXPOSURE_CHECK_ERROR_ATTR =
  'data-recued-connect-device-exposure-check-error';
export const CONNECT_DEVICE_HERE_CHECK_BTN_ATTR =
  'data-recued-connect-device-here-check';
export const CONNECT_DEVICE_PAIRING_ATTR = 'data-recued-connect-device-pairing';
export const CONNECT_DEVICE_PROBE_DETAIL_ATTR =
  'data-recued-connect-device-probe-detail';
export const CONNECT_DEVICE_HOSTED_NOTE_ATTR = 'data-recued-connect-device-hosted';
/** D-273 — the port-mapping control on the router step. */
export const CONNECT_DEVICE_STEP_ACTION_ATTR =
  'data-recued-connect-device-step-action';
export const CONNECT_DEVICE_STEP_ACTION_ERROR_ATTR =
  'data-recued-connect-device-step-action-error';

/** D-272 — how long a from-this-device reachability verdict stays true.
 *
 *  🔑 IT IS AN ANSWER ABOUT A NETWORK, AND THE DEVICE CAN LEAVE THAT NETWORK
 *  WITHOUT TELLING US. A reader checks at home, closes the laptop, opens it in a
 *  cafe — the page is still mounted and the ✓ is still on screen, now describing
 *  somewhere else. Discarding the verdict on an address change (see
 *  `forgetAddressVerdict`) does not cover this: the address never moved, the
 *  DEVICE did.
 *
 *  ⚠ FIVE MINUTES, AND THE TRADE IS EXPLICIT. Long enough to read the line and
 *  act on it; short enough that a page left open overnight never reports last
 *  night's network. Expiring costs the reader nothing they needed — the copy
 *  falls back to the unchecked wording, which still explains the situation, with
 *  the button right there. Reporting a stale ✓ costs them a wrong belief about
 *  whether their phone will work. */
export const ADDRESS_VERDICT_TTL_MS = 5 * 60_000;

export interface MountConnectDevicePanelOptions {
  host: HTMLElement;
  document?: Document;
  /** Clock seam. Defaults to `Date.now`; tests drive it to make expiry
   *  deterministic rather than sleeping. */
  now?: () => number;
  /** Opening guess at `bootstrap.bind_port`, used until `readPorts` answers.
   *  ⚠ A FALLBACK, NOT A FACT — see `readPorts`. */
  lanPort: number;
  /** Opening guess at `public_port`. ⚠ Same: a fallback, not a fact. */
  publicPort?: number;
  /** Reads the server's REAL ports. Fire-and-forget at mount, exactly like
   *  `readCertifiedHostnames`, and for the same reason: the panel is useful
   *  before it resolves.
   *
   *  ⛔⛔ BOTH PORTS ARE USER-CONFIGURABLE, SO NEITHER MAY BE A CONSTANT HERE.
   *  `bind_port` takes `--port` / `$PORT` / `config.toml`; `public_port` is a
   *  runtime config key the owner can change in Settings. This panel does not
   *  merely PRINT those numbers — `publicOrigin` builds the address it hands
   *  over out of the public one, so a wrong guess offers an address that does
   *  not serve. That is the "opens then stops" failure this whole page exists
   *  to prevent, produced by the page itself.
   *
   *  ⚠ EITHER FIELD MAY COME BACK UNDEFINED and that is not an error: a server
   *  older than this client does not send them (self-hosted, no deploy order).
   *  Absent leaves the opening guess in place. */
  readPorts?: () => Promise<{
    lan_port?: number;
    public_port?: number;
    /** D-273 — present ONLY when a live `public_port` change failed to bind, so
     *  the server is still on the old port. Absent is the normal case; forwarded
     *  verbatim and never derived. */
    public_port_requested?: number;
    /** D-272 — the LAN listener's bind posture. ⚠ Absent = the server did not
     *  say, which is NOT "not exposed"; it renders no note either way. */
    lan_exposure?: {
      publicly_routable: boolean;
      wildcard: boolean;
      public_addresses: readonly string[];
    };
  }>;
  /** Resolves the hostnames that hold a live certificate. Omit when no caller
   *  is wired — the panel then renders the honest "not read" wording. */
  readCertifiedHostnames?: () => Promise<readonly string[]>;
  /** The standing answer to "did a check from outside get in on the public
   *  port", read at every render so a check run on ANOTHER page lands here too.
   *
   *  ⚠ SYNCHRONOUS AND PULLED, not pushed. The caller holds the last probe; this
   *  panel holds no copy of it, so there is no second place for the verdict to go
   *  stale. Omit it and the router step stays unknown — which is what it was. */
  readPublicPortReachable?: (publicPort: number) => boolean | null;
  /** Runs a fresh check from outside and returns the verdict for the public port.
   *  Wired → the router step carries a button. Omitted → it points the reader at
   *  their router instead, because sending them to a check they cannot run is
   *  worse than telling them where to look. */
  /** D-272 — run the checks that ask from OUTSIDE, in one request.
   *
   *  🔑 ONE ACTION, SEVERAL ANSWERS. This page briefly had THREE check buttons —
   *  router, exposure, and from-this-device — each defensible alone and
   *  collectively unreadable: three mechanisms, three subjects, and no way for a
   *  reader to tell which one answers their question. D-272's own words about
   *  the Reachability tab apply one level down: *sending someone to press a
   *  button and interpret a diagnostic is the friction this page exists to
   *  remove*.
   *
   *  ⚠ THE VERDICTS COME BACK BY PULL, NOT FROM THIS PROMISE. The composition
   *  root holds the last probe and `readPublicPortReachable` /
   *  `readLanPortReachable` read it at every render — so a check run anywhere
   *  settles these rows, and there is no second copy to go stale.
   *
   *  ⚠ The caller decides which ports the request may carry; the panel only
   *  reports what it has. */
  runOutsideChecks?: (args: {
    publicPort: number;
    lanPort: number;
    lanExposed: boolean;
  }) => Promise<void>;
  /** Whether the probe may be asked about the LAN port, through `extra_port`.
   *  ⚠ A DIFFERENT PREDICATE FROM `canCheckPort` — that one is the closed list,
   *  this one is the single bounded door past it. */
  canCheckExtraPort?: (lanPort: number) => boolean;
  /** D-273 — reads `network.port_mapping`. Fire-and-forget at mount, like the
   *  ports and the certificate: the panel is useful before it resolves, and a
   *  failed read leaves the step with the wording it had rather than asserting
   *  anything about a router nobody reached. */
  readPortMapping?: () => Promise<ConnectDeviceFacts['port_mapping']>;
  /** D-273 audit P2-5 — is `/webclient/` served to the internet?
   *  ⚠ Absent, or a throw, leaves the fact UNREAD — no step, no claim. */
  readWebclientPublicExposed?: () => Promise<boolean | undefined>;
  /** D-273 — flip `network.auto_port_mapping`, through `server.setConfigField`.
   *
   *  ⛔ THE CONTROL IS GATED ON THIS, NOT ON THE FACTS. `portMappingAction`
   *  decides whether flipping it is a sensible thing to OFFER; this decides
   *  whether the panel can flip it AT ALL. A server whose config file is
   *  read-only (the shipped docker-compose bind-mounts it that way) will reject
   *  the write, and that is a failure to SHOW, not to hide — so the caller is
   *  forwarded whenever the rpc exists and the error surfaces in the row.
   *
   *  ⚠ It resolves when the FLAG is written, which is NOT when the router has
   *  answered. The supervisor reconciles off the config change on its own clock
   *  and coalesces concurrent runs, so awaiting a reconcile here could resolve
   *  against the PREVIOUS intent. The panel re-reads instead — see `flipPortMapping`. */
  setPortMappingEnabled?: (enabled: boolean) => Promise<void>;
  /** D-272 — the raw per-check rows from the last probe, for the reader who
   *  wants to see what was actually asked.
   *
   *  ⛔ THIS IS THE REACHABILITY TAB, FOLDED IN. That tab was a DESTINATION for a
   *  diagnostic, which D-272 already argued against one level up: "sending a
   *  beginner to an operator tab to press a button and interpret a diagnostic
   *  table is the friction this page exists to remove". It also only ever
   *  mounted for probe-havers — free self-hosters never saw it — and half its
   *  content (the recommendations engine) had no producer at all.
   *
   *  ⚠ PULLED, like every other verdict here. Absent ⇒ no detail block, which is
   *  the honest state before anything has been checked. */
  readProbeDetail?: () => ReadonlyArray<{
    kind: string;
    status: string;
    detail: string;
  }>;
  /** D-272 — asks whether THIS browser can reach `url` right now. The only
   *  instrument on this page that sits on the reader's side of the router, so
   *  the only one that can see NAT hairpin. `true` = it answered with a valid
   *  certificate; `false` = it did not, cause unknown and unnameable. */
  checkAddressFromHere?: (url: string) => Promise<boolean>;
  /** D-272 — the standing answer to "did a check from outside reach the LAN
   *  port". Read at every render, exactly like `readPublicPortReachable`, and
   *  for the same reason: the verdict lives in the composition root so a check
   *  run anywhere counts here. ⛔ `true` is the BAD answer for this one. */
  readLanPortReachable?: (lanPort: number) => boolean | null;
  /** Whether the check can answer about THIS port. Defaults to yes.
   *
   *  ⛔ TWO SEPARATE REASONS A CHECK IS UNAVAILABLE, AND ONLY ONE OF THEM IS
   *  KNOWN AT MOUNT. `checkFromOutside` being absent says this install has no
   *  probe at all; this predicate says the probe exists and is not allowed to be
   *  asked about the port this card resolved to. The second answer arrives with
   *  `readPorts`, i.e. AFTER the first render — so it cannot be folded into the
   *  presence of the caller, and a button placed on the caller alone would
   *  survive the port resolving to one nothing can answer.
   *
   *  ⚠ Both land on the same copy, which is the right copy for both: the reader
   *  is pointed at their router, because that is where the answer is. */
  canCheckPort?: (publicPort: number) => boolean;
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
  let checking = false;
  /** Set only when the CHECK failed — never when it answered. A failed check
   *  leaves the router step unknown, which is the truth. */
  let checkError: string | null = null;
  /** ⚠ THE EXPOSURE CHECK'S OWN IN-FLIGHT + ERROR STATE. Sharing `checking` with
   *  the router check would disable both buttons whenever either ran, which says
   *  "this is one operation" about two independent requests on two cards. */
  let checkingExposure = false;
  let exposureCheckError: string | null = null;
  /** ⚠ Its own pair again, for the third check. Three independent requests, so
   *  three in-flight flags — one shared flag would grey out two controls the
   *  reader can still press. */
  let checkingHere = false;
  let addressReachableHere: boolean | null = null;
  let addressVerdictAt: number | null = null;
  let verdictExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  const clock = (): number => (opts.now ?? Date.now)();

  /** ⛔⛔ A VERDICT BELONGS TO THE ADDRESS IT WAS EARNED AGAINST. Both inputs to
   *  that address arrive ASYNCHRONOUSLY and independently — `readCertifiedHostnames`
   *  and `readPorts` — so the reader can press the button while one of them is
   *  still the opening fallback. Measured: certs-first, ports-late, click in
   *  between ⇒ the check asked `https://host/webclient/` (443) and the card then
   *  rendered `https://host:8446/webclient/` still claiming it was reached.
   *
   *  That is the same failure the port READS were fixed for earlier in D-272 —
   *  "reports another port's answer under this one's label" — reintroduced by a
   *  verdict that outlived its subject. ⇒ Any change to what the address is built
   *  from DISCARDS the verdict, back to `null` (nobody checked), which is true. */
  const forgetAddressVerdict = (): void => {
    addressReachableHere = null;
    addressVerdictAt = null;
    if (verdictExpiryTimer !== null) {
      clearTimeout(verdictExpiryTimer);
      verdictExpiryTimer = null;
    }
  };

  /** ⛔ EVALUATED AT READ TIME, NOT ONLY ON A TIMER. A background tab throttles
   *  `setTimeout` to minutes, so a timer alone would leave an expired verdict on
   *  screen for exactly the reader who left the page open — the case this
   *  exists for. The timer below is what makes the screen redraw ON TIME; this
   *  is what makes it CORRECT whenever it draws. */
  const liveAddressVerdict = (): boolean | null => {
    if (addressReachableHere === null || addressVerdictAt === null) return null;
    return clock() - addressVerdictAt < ADDRESS_VERDICT_TTL_MS
      ? addressReachableHere
      : null;
  };
  let certifiedHostnames: readonly string[] | null = null;
  // ⚠ The ports the SERVER reported, once it has. `undefined` means not yet (or
  // a server too old to say), and the opening guess stands.
  let lanPort: number | undefined;
  let publicPort: number | undefined;
  /** D-273 — the port the owner asked for, when the server is not on it.
   *  ⛔ NO FALLBACK AND NO OPENING GUESS, unlike the two above. There is nothing
   *  sensible to assume before the server answers: guessing a divergence would
   *  tell every reader their port change failed until the rpc said otherwise. */
  let requestedPublicPort: number | undefined;
  /** ⚠ STILL READ, THOUGH THE WARNING MOVED TO EXPOSURE. The check action needs
   *  to know whether the LAN port is worth asking the probe about; the FINDING
   *  is Exposure's to display. Reading a fact and rendering it are separate
   *  jobs, and only the second one moved. */
  let lanExposure: { publicly_routable: boolean } | undefined;
  let portMapping: ConnectDeviceFacts['port_mapping'];
  let webclientPublicExposed: boolean | undefined;
  /** ⚠ Its own in-flight flag, like each check above it. This one is a WRITE
   *  and the others are reads, which is all the more reason not to share. */
  let flippingPortMapping = false;
  /** Set only when the WRITE failed. A refused write leaves the toggle where it
   *  was, and the row must say so rather than redraw as if it took. */
  let portMappingError: string | null = null;

  const effectiveLanPort = (): number => lanPort ?? opts.lanPort;
  const effectivePublicPort = (): number => publicPort ?? opts.publicPort ?? 443;

  /** 🔑 ONE EXPRESSION, READ BY BOTH THE COPY AND THE BUTTON. The hint and the
   *  control are two renderings of one fact; deriving them separately is how a
   *  panel comes to say "your router settings screen shows this" beside a button
   *  offering to look for the reader. D-272 already caught that shape once, with
   *  a ✓ row next to "Check this now", and only a real browser showed it. */
  const canCheckFromOutside = (): boolean =>
    opts.runOutsideChecks !== undefined
    && (opts.canCheckPort?.(effectivePublicPort()) ?? true);

  /** ⛔ THE SAME SHAPE AS ABOVE, ASKED OF THE OTHER PORT — and deliberately not
   *  derived from it. Two ports, two allowlist rules; a server can be able to
   *  answer one and not the other, in either direction. */
  /** Has the exposure been checked at all? ⛔ EITHER VERDICT COUNTS — unlike the
   *  router step, whose label flips only on `true`. Here `false` means a check
   *  ran and was refused entry, which is a check that HAPPENED; offering "Check
   *  from the internet" again would ask the reader to do something they just
   *  did. The verdict is a MOMENT, not a property, so the control stays — it
   *  just stops pretending nothing has looked. */
  /** Has ANY of the three answered? Drives the label, so a reader who has
   *  checked once is offered a re-check rather than the first-time wording. */
  const anythingChecked = (): boolean =>
    (opts.readPublicPortReachable?.(effectivePublicPort()) ?? null) !== null
    || (opts.readLanPortReachable?.(effectiveLanPort()) ?? null) !== null
    || liveAddressVerdict() !== null;

  const exposureChecked = (): boolean =>
    (opts.readLanPortReachable?.(effectiveLanPort()) ?? null) !== null;

  /** The certified address this page offers, or null when there is none to try.
   *  ⚠ Taken from the card that BUILT it rather than re-derived — checking a
   *  different address would report another one's answer under this label. */
  const addressToCheck = (): string | null =>
    buildConnectDevicePlaces(currentFacts())
      .find((c) => c.place === 'other_devices')?.url ?? null;

  /** ⚠ Offered when ANY of the three can run. A single control that sometimes
   *  answers two questions and sometimes one is still one decision for the
   *  reader; three controls that each answer one is three. */
  const canCheckAnything = (): boolean =>
    (opts.runOutsideChecks !== undefined
      && (canCheckFromOutside() || canCheckLanExposure()))
    || (opts.checkAddressFromHere !== undefined && addressToCheck() !== null);

  const canCheckLanExposure = (): boolean =>
    opts.runOutsideChecks !== undefined
    && lanExposure?.publicly_routable === true
    && (opts.canCheckExtraPort?.(effectiveLanPort()) ?? true);

  const currentFacts = (): ConnectDeviceFacts => ({
    lan_port: effectiveLanPort(),
    public_port: effectivePublicPort(),
    ...(requestedPublicPort !== undefined
      ? { public_port_requested: requestedPublicPort }
      : {}),
    certified_hostnames: certifiedHostnames,
    // ⛔ ASKED ABOUT THE PORT THIS CARD IS ACTUALLY TALKING ABOUT. Reading a
    // verdict for 443 while the card names 8446 would report another port's
    // answer under this one's label.
    public_port_reachable:
      opts.readPublicPortReachable?.(effectivePublicPort()) ?? null,
    can_check_from_outside: canCheckFromOutside(),
    can_check_address_here: opts.checkAddressFromHere !== undefined,
    ...(portMapping !== undefined ? { port_mapping: portMapping } : {}),
    ...(webclientPublicExposed !== undefined
      ? { webclient_public_exposed: webclientPublicExposed }
      : {}),
    address_reachable_here: liveAddressVerdict(),
  });

  const el = (tag: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** Re-read `network.port_mapping`. Used at mount and again after a flip.
   *
   *  ⚠ ASSIGNED ONLY WHEN THE SERVER ACTUALLY ANSWERED. A server too old to know
   *  this rpc leaves the field absent, which the copy reads as "nobody asked"
   *  rather than as a verdict about a router. A throw keeps whatever we had —
   *  the same rule, one level up. */
  const refreshPortMapping = async (): Promise<void> => {
    if (opts.readPortMapping === undefined) return;
    try {
      const result = await opts.readPortMapping();
      if (disposed) return;
      if (result !== undefined) portMapping = result;
      render();
    } catch {
      /* keep the wording the step had — see the option's note */
    }
  };

  /** D-273 — flip the toggle, then go and look.
   *
   *  ⛔⛔ THE WRITE AND THE OUTCOME ARE TWO DIFFERENT FACTS, AND THIS WAITS FOR
   *  THE FIRST ONLY. `server.setConfigField` resolves when the key is validated
   *  and persisted; the supervisor then reconciles on its own clock. It also
   *  COALESCES — `reconcile()` called during an in-flight run returns THAT run's
   *  promise — so a server-side await would have been able to resolve against
   *  the intent this flip replaced. ⇒ We re-read instead, which reports whatever
   *  is true when it is asked, and is honest at every point in between: before
   *  the reconcile the row shows `enabled` with the previous outcome, which is
   *  exactly the state the server is in.
   *
   *  ⚠ THE RE-READ IS NOT RETRIED. One look, and the reader has the check button
   *  and the page for the rest. A poll would be a loop with no completion
   *  criterion — there is no answer that means "done", since a router can refuse
   *  on the fourth renewal as easily as the first. */
  const flipPortMapping = (enable: boolean): void => {
    if (opts.setPortMappingEnabled === undefined || flippingPortMapping) return;
    flippingPortMapping = true;
    portMappingError = null;
    render();
    void (async () => {
      try {
        await opts.setPortMappingEnabled!(enable);
        if (disposed) return;
        await refreshPortMapping();
      } catch (err) {
        if (disposed) return;
        // ⛔ NAMED, NOT SWALLOWED. The write is the one thing on this page that
        // CHANGES the server, and the shipped docker-compose bind-mounts
        // `config.toml` read-only — so "it did not take" is a real outcome a
        // reader must be told about rather than left to infer from a switch
        // that sprang back.
        portMappingError = err instanceof Error && err.message.length > 0
          ? err.message
          : 'The server did not accept that change.';
      } finally {
        if (!disposed) {
          flippingPortMapping = false;
          render();
        }
      }
    })();
  };

  /** The one action. ⛔ Runs every applicable check CONCURRENTLY and settles
   *  them independently: a cloud probe that fails must not discard the answer
   *  the browser already got, and vice versa. `allSettled`, never `all`. */
  const runChecks = (): void => {
    if (!canCheckAnything() || checking) return;
    checking = true;
    checkError = null;
    render();
    void (async () => {
      const address = addressToCheck();
      // ⛔⛔ THE VERDICT BELONGS TO THE ADDRESS IT WAS ASKED ABOUT, and a pending
      // check cannot be un-fired. `forgetAddressVerdict` clears a SETTLED verdict
      // when the address moves, but a check already in flight settled afterwards
      // and was committed against whatever the card had become: a check started
      // against `https://host/webclient/` at the fallback 443, a late
      // `readPorts` supplying 8446, and the card then showed the 8446 link over
      // "this device reached that address just now".
      // ⇒ Captured here and compared at commit time. Same rule as the stored
      // verdict, applied to the one window that rule could not see.
      const askedAbout = address;
      const results = await Promise.allSettled([
        opts.runOutsideChecks === undefined
          ? Promise.resolve()
          : opts.runOutsideChecks({
              publicPort: effectivePublicPort(),
              lanPort: effectiveLanPort(),
              lanExposed: lanExposure?.publicly_routable === true,
            }),
        opts.checkAddressFromHere === undefined || address === null
          ? Promise.resolve(null)
          : opts.checkAddressFromHere(address),
      ]);
      // ⛔ THE ROUTER ROW IS PART OF WHAT THIS BUTTON ANSWERS. The panel read
      // `network.port_mapping` once at mount and never again, so pressing Check
      // connection left a stale `idle`/`unsupported` on screen no matter what
      // had changed on the router since — and re-opening the page was the only
      // refresh. ⚠ Not awaited with the others: it is a local read that must not
      // be able to delay or fail the checks the button is named for.
      void refreshPortMapping();
      const here = results[1];
      // ⚠ `disposed` IS PART OF THE SAME QUESTION. A late result landing after
      // teardown has no card to be true of.
      if (!disposed
        && askedAbout !== null
        && askedAbout === addressToCheck()
        && here.status === 'fulfilled'
        && typeof here.value === 'boolean') {
        addressReachableHere = here.value;
        addressVerdictAt = clock();
        if (verdictExpiryTimer !== null) clearTimeout(verdictExpiryTimer);
        verdictExpiryTimer = setTimeout(() => {
          verdictExpiryTimer = null;
          render();
        }, ADDRESS_VERDICT_TTL_MS);
      }
      // ⛔⛔ COUNT ONLY THE CHECKS THAT ACTUALLY RAN. This was
      // `results.every(rejected)`, and a SKIPPED check FULFILS — with `undefined`
      // or `null` — so any reader missing one of the two callers could never see
      // an error at all. The common shape is the ordinary one: no certificate ⇒
      // no address ⇒ the from-here check is skipped and fulfils, so a genuine
      // outside failure (no diagnostics hostname, refused authorization, rate
      // limit) left the action completing silently.
      //
      // ⚠ AND `checkAddressFromHere` RESOLVES `false` ON A NETWORK ERROR — by
      // design, since an unreachable address IS the answer there — so it can
      // never contribute a rejection either. A vacuous `every()` over a set that
      // cannot reject is a guard that only ever passes.
      //
      // 🔑 The rule is unchanged in spirit — do not shout over a row that just
      // got answered — but it is now applied to the checks that were ATTEMPTED.
      const attemptedStatuses: string[] = [
        ...(opts.runOutsideChecks !== undefined ? [results[0]!.status] : []),
        ...(opts.checkAddressFromHere !== undefined && address !== null
          ? [results[1]!.status] : []),
      ];
      if (attemptedStatuses.length > 0
        && attemptedStatuses.every((st) => st === 'rejected')) {
        checkError = CHECK_FROM_OUTSIDE_ERROR;
      }
      checking = false;
      render();
    })();
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

    // ⛔ THE PAYOFF RENDERS BEFORE THE WORK, and above it. A card that opens with
    // what is missing is a card people close; this one opens with what they get.
    if (card.payoff !== undefined) {
      const payoff = el('p', card.payoff);
      payoff.className = 'connect-device-payoff';
      section.appendChild(payoff);
    }

    section.appendChild(el('p', card.body));

    if (card.steps !== undefined && card.steps.length > 0) {
      const list = el('ul');
      list.className = 'connect-device-steps';
      list.setAttribute(CONNECT_DEVICE_STEPS_ATTR, 'true');
      for (const step of card.steps) {
        const li = el('li');
        li.setAttribute(CONNECT_DEVICE_STEP_KEY_ATTR, step.key);
        li.setAttribute(
          CONNECT_DEVICE_STEP_DONE_ATTR,
          step.done === null ? 'unknown' : String(step.done),
        );
        // ⚠ Three marks for three states. `null` is "we cannot see this from
        // here" and gets its own, because a hollow box reads as "not done" —
        // a claim this machine is in no position to make about a router.
        const mark = el('span', step.done === true ? '✓' : step.done === false ? '○' : '?');
        mark.className = 'connect-device-step-mark';
        li.appendChild(mark);
        const text = el('span');
        text.className = 'connect-device-step-text';
        text.appendChild(el('strong', step.label));
        text.appendChild(el('span', ` ${step.hint}`));
        // ⛔ THE CHECK SITS ON THE STEP IT ANSWERS. It is the one step the reader
        // cannot settle by looking, and the answer lives on the far side of their
        // router — so the button that asks from there belongs in the row, not on
        // an operator page they would have to find and then read.
        // ⚠ NO CHECK BUTTON ON THE ROW ANY MORE. The row still shows its verdict;
        // the one check that fills it lives below both cards.
        li.appendChild(text);
        // ⛔ THE SETTING, HOWEVER, DOES BELONG HERE — see `ConnectDeviceStep.action`.
        // It is not a check, it answers nothing, and it is the row's own.
        // ⚠ GATED ON THE CALLER TOO: the copy decides whether flipping it is
        // worth OFFERING, this decides whether the panel can flip it at all. A
        // control rendered without a writer is a button that does nothing.
        if (step.action !== undefined && opts.setPortMappingEnabled !== undefined) {
          const action = step.action;
          const actionWrap = el('span');
          actionWrap.className = 'connect-device-step-action';
          const actionBtn = doc.createElement('button');
          actionBtn.className = 'connect-device-step-action-button';
          actionBtn.setAttribute('type', 'button');
          actionBtn.setAttribute(CONNECT_DEVICE_STEP_ACTION_ATTR, action.kind);
          // ⚠ The DIRECTION is on the element, not inferred from the label —
          // the label is copy, and a test that read it would break on a reword.
          actionBtn.setAttribute(
            'data-recued-connect-device-step-action-enable',
            String(action.enable),
          );
          actionBtn.textContent = flippingPortMapping ? 'Working…' : action.label;
          if (flippingPortMapping) {
            actionBtn.setAttribute('disabled', 'true');
            actionBtn.setAttribute('aria-busy', 'true');
          }
          actionBtn.addEventListener('click', () => { flipPortMapping(action.enable); });
          actionWrap.appendChild(actionBtn);
          actionWrap.appendChild(el('span', ` ${action.note}`));
          if (portMappingError !== null) {
            const err = el('span', portMappingError);
            err.className = 'connect-device-step-action-error';
            err.setAttribute(CONNECT_DEVICE_STEP_ACTION_ERROR_ATTR, 'true');
            actionWrap.appendChild(err);
          }
          li.appendChild(actionWrap);
        }
        list.appendChild(li);
      }
      section.appendChild(list);
    }

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

    // ⚠ The ways to get a certificate hang off the card that needs one, and are
    // rendered ONLY while it is still needed. They are the longest block on the
    // page (three routes, two of them with commands); leaving them up after the
    // certificate exists buries the address the reader came back for.
    if (card.state === 'one_step' && card.place === 'other_devices') {
      const heading = el('p', CERTIFICATE_ROUTES_HEADING);
      heading.className = 'connect-device-routes-heading';
      section.appendChild(heading);
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
    // Under the address, because it answers "I opened that and nothing happened".
    if (card.note !== undefined) {
      const note = el('p', card.note);
      note.className = 'connect-device-note';
      note.setAttribute(CONNECT_DEVICE_NOTE_ATTR, 'true');
      // ⛔ THE CHECK SITS ON THE FINDING IT CONFIRMS, on this card — not on the
      // router step one card over. The two verdicts have opposite signs, and a
      // reader who just learned "reachable ✓ = good" there must not meet the
      // same control here, where reachable is the thing to fix.
      section.appendChild(note);
    }

    const port = el('p', card.portNote);
    port.className = 'connect-device-port-note';
    section.appendChild(port);

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

    const intro = el('p', CONNECT_DEVICE_INTRO);
    intro.className = 'connect-device-intro';
    panel.appendChild(intro);

    const facts = currentFacts();
    for (const card of buildConnectDevicePlaces(facts)) panel.appendChild(renderCard(card));

    // ⛔ ONE ACTION, AFTER BOTH CARDS AND BEFORE PAIRING. It reads as a flow —
    // here are your addresses, check they work, then sign a device in — and it
    // answers questions on BOTH cards, so it cannot live inside either.
    if (canCheckAnything()) {
      const checkBlock = el('section');
      checkBlock.className = 'connect-device-check-block';
      const button = doc.createElement('button');
      button.className = 'connect-device-check';
      button.setAttribute('type', 'button');
      button.setAttribute(CONNECT_DEVICE_CHECK_BTN_ATTR, 'true');
      button.textContent = checking
        ? CHECK_FROM_OUTSIDE_RUNNING_LABEL
        : anythingChecked()
        ? CHECK_FROM_OUTSIDE_AGAIN_LABEL
        : CHECK_CONNECTION_LABEL;
      if (checking) button.setAttribute('disabled', 'true');
      button.addEventListener('click', runChecks);
      checkBlock.appendChild(button);
      const blurb = el('span', CHECK_CONNECTION_NOTE);
      blurb.className = 'connect-device-note';
      checkBlock.appendChild(blurb);
      if (checkError !== null) {
        const err = el('span', checkError);
        err.className = 'connect-device-check-error';
        err.setAttribute(CONNECT_DEVICE_CHECK_ERROR_ATTR, 'true');
        checkBlock.appendChild(err);
      }
      // ⚠ THE RAW ROWS, AFTER the plain-language rows above — never instead of
      // them. The tab this replaces made the table the ONLY answer, which is
      // what made it an operator surface; here it is the detail under an answer
      // the reader already has.
      const detail = opts.readProbeDetail?.() ?? [];
      if (detail.length > 0) {
        const list = el('ul');
        list.className = 'connect-device-probe-detail';
        list.setAttribute(CONNECT_DEVICE_PROBE_DETAIL_ATTR, 'true');
        for (const row of detail) {
          list.appendChild(el('li', `${row.kind}: ${row.status}${
            row.detail.length > 0 ? ` — ${row.detail}` : ''}`));
        }
        checkBlock.appendChild(list);
      }
      panel.appendChild(checkBlock);
    }

    // ⛔ AFTER BOTH CARDS, NOT INSIDE EITHER. The command is the same whichever
    // address the reader used, and putting it on both cards would print it
    // twice; putting it on one would imply it applies only to that route.
    const pairing = el('section');
    pairing.className = 'connect-device-pairing';
    pairing.setAttribute(CONNECT_DEVICE_PAIRING_ATTR, 'true');
    pairing.appendChild(el('h4', PAIRING_HEADING));
    const pairingList = el('ol');
    pairingList.className = 'connect-device-pairing-steps';
    for (const step of PAIRING_STEPS) pairingList.appendChild(el('li', step));
    pairing.appendChild(pairingList);
    const firstNote = el('p', PAIRING_FIRST_DEVICE_NOTE);
    firstNote.className = 'connect-device-note';
    pairing.appendChild(firstNote);
    panel.appendChild(pairing);

    const hosted = el('p', hostedAppNote(facts));
    hosted.className = 'connect-device-hosted-note';
    hosted.setAttribute(CONNECT_DEVICE_HOSTED_NOTE_ATTR, 'true');
    panel.appendChild(hosted);

    opts.host.appendChild(panel);
  };

  render();

  // Fire-and-forget: the panel is useful before this resolves, and a failed read
  // leaves `null` (not read) rather than `[]` (read, none) on purpose.
  if (opts.readPorts !== undefined) {
    void (async () => {
      try {
        const ports = await opts.readPorts!();
        if (disposed) return;
        // Each independently: a server may know one and not the other.
        if (typeof ports.lan_port === 'number') lanPort = ports.lan_port;
        if (typeof ports.public_port === 'number') {
          // ⛔ COMPARED AGAINST THE EFFECTIVE PORT, NOT THE STORED ONE. The
          // stored value is `undefined` until this resolves, so comparing it
          // would discard a verdict every time — including the ordinary case
          // where the rpc simply CONFIRMS the fallback and the address never
          // changed. What invalidates a verdict is the address moving, not a
          // field being filled in.
          if (effectivePublicPort() !== ports.public_port) forgetAddressVerdict();
          publicPort = ports.public_port;
        }
        // ⚠ Same rule again: assigned only when the server actually sent it, so
        // a server that cannot tell leaves the note unrendered rather than
        // asserting "not exposed" on nobody's behalf.
        // D-273 — ⛔ ASSIGNED EVEN WHEN ABSENT, unlike its neighbours. For every
        // other field here absent means "this server did not say" and the right
        // move is to keep what we had. This one is a LIVE divergence that the
        // server clears the moment a later port change succeeds — so holding a
        // stale value would keep telling the reader their port did not apply
        // after it did. Absent is a fact about now, not a silence.
        requestedPublicPort = ports.public_port_requested;
        if (ports.lan_exposure !== undefined) lanExposure = ports.lan_exposure;
        render();
      } catch {
        /* keep the opening guess — see the option's note */
      }
    })();
  }

  if (opts.readPortMapping !== undefined) void refreshPortMapping();

  if (opts.readWebclientPublicExposed !== undefined) {
    void (async () => {
      try {
        const exposed = await opts.readWebclientPublicExposed!();
        if (disposed) return;
        // ⚠ Assigned only when the server actually answered — same rule as the
        // ports and the mapping. A throw leaves the step unrendered, which is
        // "nobody asked", not "it is open".
        if (exposed !== undefined) webclientPublicExposed = exposed;
        render();
      } catch { /* unread — see the option's note */ }
    })();
  }

  if (opts.readCertifiedHostnames !== undefined) {
    void (async () => {
      try {
        const hostnames = await opts.readCertifiedHostnames!();
        if (disposed) return;
        // ⚠ Same rule for the other half of the address. A check cannot run
        // before this resolves (no certificate ⇒ no button), so today this only
        // fires on a genuine change — but the guard is on the COMPOSITION, not
        // on the order these two happen to resolve in.
        if (certifiedHostnames?.[0] !== hostnames[0]) forgetAddressVerdict();
        certifiedHostnames = hostnames;
        render();
      } catch {
        /* keep `null` — see the header note */
      }
    })();
  }

  return {
    refresh: render,
    dispose: () => {
      disposed = true;
      // ⚠ A pending expiry timer would call `render()` after teardown. `render`
      // already no-ops on `disposed`, so this is about not holding the closure
      // alive, not about correctness.
      if (verdictExpiryTimer !== null) {
        clearTimeout(verdictExpiryTimer);
        verdictExpiryTimer = null;
      }
    },
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
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-payoff {
  color: var(--fg);
  font-weight: 600;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-steps {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-steps li {
  display: flex;
  align-items: baseline;
  gap: 9px;
  line-height: 1.5;
  color: var(--fg-muted, var(--fg));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-step-mark {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--border-strong, var(--border));
  font-size: 11px;
  font-weight: 700;
}
[${CONNECT_DEVICE_PANEL_ATTR}] li[${CONNECT_DEVICE_STEP_DONE_ATTR}="true"] .connect-device-step-mark {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent, #fff);
}
[${CONNECT_DEVICE_PANEL_ATTR}] li[${CONNECT_DEVICE_STEP_DONE_ATTR}="unknown"] .connect-device-step-mark {
  border-style: dashed;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-step-text strong {
  color: var(--fg);
  font-weight: 600;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-check {
  margin-left: 8px;
  padding: 2px 10px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 999px;
  background: var(--surface, var(--bg));
  font: inherit;
  font-size: 12px;
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-check:hover:not([disabled]) {
  border-color: var(--accent);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-check[disabled] {
  cursor: default;
  opacity: 0.6;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-check-error {
  display: block;
  margin-top: 4px;
  color: var(--danger, var(--fg));
}
/* D-273 — the one setting on this page. Its own block under the step's text
   rather than inline beside it: the note is a full sentence about opening a
   port on the reader's internet connection, and a sentence that long wrapping
   around a pill button is how a consequence gets skimmed past. */
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-step-action {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--fg-muted, var(--fg));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-step-action-button {
  padding: 2px 10px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 999px;
  background: var(--surface, var(--bg));
  font: inherit;
  font-size: 12px;
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-step-action-button:hover:not([disabled]) {
  border-color: var(--accent);
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-step-action-button[disabled] {
  cursor: default;
  opacity: 0.6;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-step-action-error {
  display: block;
  margin-top: 4px;
  color: var(--danger, var(--fg));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-pairing {
  margin-top: 16px;
  padding-top: 12px;
  /* ⚠ A rule, not a card. The pairing block follows BOTH cards and applies to
     either; boxing it like a third card would read as a third place to go. */
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.3));
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-pairing h4 {
  margin: 0 0 6px;
  font-size: 14px;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-pairing-steps {
  margin: 0 0 6px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.5;
}
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-note {
  font-size: 12px;
  color: var(--fg-muted, var(--fg));
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
[${CONNECT_DEVICE_PANEL_ATTR}] .connect-device-routes-heading {
  margin: 6px 0 0;
  font-weight: 600;
  color: var(--fg);
}
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
