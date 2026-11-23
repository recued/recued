/** The Bridge's field read and write (`apps/bridge/src/actions/page-fields.ts`)
 *  in real Chrome, through BOTH executors the extension runs: the ordinary one,
 *  which finds the tab by pattern, and the reviewed one, bound to a Chrome
 *  documentId. chrome.scripting serializes the functions into the page exactly
 *  as the shipped Bridge does, so a function that leaned on anything outside
 *  itself would fail here, which no unit test can show.
 *
 *  ⚠ The editors are stand-ins: a plain contenteditable; one that applies input
 *  itself from `beforeinput` and renders its model afterwards (the Lexical /
 *  Slate shape); one that lets the browser edit and reads the page back on
 *  `input` (the Quill / ProseMirror shape); and one that will not take input.
 *  They prove the text reaches each kind of model and that a refused write is
 *  reported. They are not X's or LinkedIn's composers, which this never loads.
 *
 *  ⛔ The `beforeinput` model check is the one that caught a false success: with
 *  only the browser's insert command, Chrome sends no `beforeinput`, so that
 *  editor's model stayed empty while the page showed the text and the fill
 *  reported `filled`. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeCommand, BridgeIngredientRef, BridgeResult } from '@recued/contracts';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

/** A Bridge answer as a check that page content is absent reads it: without the command id and the time
 *  Recued generates around it. The id is a random UUID, and the sweep at `820a2e263` failed when one,
 *  `b65e4111-…`, held "4111", the card number's start; a read taking 4,111 ms would do the same. */
const pageContentOf = (result: BridgeResult): string =>
  JSON.stringify({ ...result, command_id: undefined, duration_ms: undefined });

const FIELDS = `<!doctype html><html><body>
<input id="name" value="Ada">
<textarea id="notes">initial text</textarea>
<select id="stage"><option value="">Choose</option><option value="appt">Appointment scheduled</option>
  <option value="won" selected>Closed won</option></select>
<select id="tags" multiple><option value="a">Alpha</option><option value="b" selected>Beta</option>
  <option value="c">Gamma</option></select>
<select id="refusing-select"><option value="old" selected>Old</option><option value="new">New</option></select>
<select id="restricted"><option value="ok" selected>Allowed</option><option value="locked" disabled>Locked</option>
  <option value="secret" hidden>Private hidden choice</option><option value="a">Same label</option><option value="b">Same label</option></select>
<input type="checkbox" id="refusing-check">
<input type="checkbox" id="vip">
<input type="radio" name="tier" id="gold" checked><input type="radio" name="tier" id="silver">
<input type="password" id="pw" value="hunter2">
<input type="hidden" id="csrf" value="token-123">
<input id="card" autocomplete="billing cc-number" value="4111111111111111">
<input type="number" id="amount">
<input type="file" id="upload">
<div id="label">Hello <b>world</b></div>
<div id="plain" contenteditable="true"><p>old text</p></div>
<div id="framework" contenteditable="true"></div>
<div id="mirroring" contenteditable="true"><p>draft</p></div>
<div id="refusing" contenteditable="true">keep</div>
<script>
  // What a person typed after load: the value no longer matches the markup.
  document.querySelector('#notes').value = 'typed later';
  document.querySelector('#tags').options[2].selected = true;
  // An editor that applies input itself: it keeps its own model, cancels the
  // browser's edit and renders the model afterwards.
  const framework = document.querySelector('#framework');
  window.frameworkModel = '';
  framework.addEventListener('beforeinput', event => {
    event.preventDefault();
    window.frameworkModel = event.inputType.startsWith('delete') ? '' : (event.data ?? '');
    setTimeout(() => { framework.textContent = window.frameworkModel; }, 0);
  });
  // An editor that lets the browser edit, then reads its model back from the page.
  const mirroring = document.querySelector('#mirroring');
  window.mirroredModel = 'draft';
  mirroring.addEventListener('input', () => { window.mirroredModel = mirroring.innerText; });
  // An editor that will not take the input, and puts its text back.
  const refusing = document.querySelector('#refusing');
  refusing.addEventListener('beforeinput', event => event.preventDefault());
  refusing.addEventListener('input', () => setTimeout(() => { refusing.textContent = 'keep'; }, 0));
  // The page's own handlers, as a framework's would be.
  window.heard = [];
  document.querySelector('#refusing-select').addEventListener('change', () => setTimeout(() => {
    document.querySelector('#refusing-select').value = 'old';
  }, 0));
  document.querySelector('#refusing-check').addEventListener('change', () => setTimeout(() => {
    document.querySelector('#refusing-check').checked = false;
  }, 0));
  for (const id of ['name', 'stage', 'tags', 'vip']) {
    document.getElementById(id).addEventListener('change', () => window.heard.push(id));
  }
</script></body></html>`;

/** D-335 slice I — what a click is: the page records every event each button
 *  hears, in order, with where it landed. */
const CLICKS = `<!doctype html><html><head><title>Clicks</title><style>body { margin: 0 }</style></head><body>
<button id="plain" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Plain</button>
<div id="pressmenu" tabindex="0" style="position:absolute;left:20px;top:80px;width:160px;height:30px">Choose</div>
<ul id="menu" hidden><li>Option A</li></ul>
<button id="covered" style="position:absolute;left:20px;top:140px;width:120px;height:40px">Covered</button>
<div id="cover" role="dialog" aria-label="Accept cookies"
  style="position:absolute;left:0;top:130px;width:300px;height:60px;background:rgba(0,0,0,0.5)">Cookies</div>
<button id="off" disabled style="position:absolute;left:20px;top:220px;width:120px;height:40px">Off</button>
<button id="icon" style="position:absolute;left:200px;top:20px;width:80px;height:40px;padding:0"><span id="glyph"
  style="display:inline-block;width:80px;height:40px">*</span></button>
<button id="unseen" style="display:none">Unseen</button>
<button id="far" style="position:absolute;left:20px;top:2400px;width:120px;height:40px">Far</button>
<div style="height:3000px"></div>
<script>
  window.events = [];
  const TYPES = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove', 'pointerdown',
    'mousedown', 'focus', 'pointerup', 'mouseup', 'click'];
  for (const id of ['plain', 'covered', 'off', 'icon', 'glyph', 'unseen', 'far']) {
    for (const type of TYPES) {
      document.getElementById(id).addEventListener(type, event => window.events.push(
        [id, event.type, event.isTrusted, Math.round(event.clientX ?? -1), Math.round(event.clientY ?? -1)]));
    }
  }
  // A widget that opens on the press, as many app menus and lists do.
  document.querySelector('#pressmenu').addEventListener('mousedown', () => { document.querySelector('#menu').hidden = false; });
</script></body></html>`;

/** D-335 slice I — React's value tracking, as react-dom's
 *  inputValueTracking.js does it: the element keeps the last value it was
 *  given on itself, and an input event whose value matches it is dropped, so
 *  the app's state (here a mirror) never hears of it. A stand-in, like the
 *  editors above: it is that mechanism, not React. Also a field that puts its
 *  own value back. */
const TRACKED = `<!doctype html><html><head><title>Tracked</title></head><body>
<input id="tracked"><textarea id="tracked-notes"></textarea><output id="state"></output>
<input id="locked" value="fixed">
<script>
  window.appState = {};
  for (const [id, proto] of [['tracked', HTMLInputElement.prototype], ['tracked-notes', HTMLTextAreaElement.prototype]]) {
    const field = document.getElementById(id);
    const own = Object.getOwnPropertyDescriptor(proto, 'value');
    let last = own.get.call(field);
    Object.defineProperty(field, 'value', { configurable: true,
      get() { return own.get.call(this); },
      set(next) { last = String(next); own.set.call(this, next); } });
    field.addEventListener('input', () => {
      const now = own.get.call(field);
      if (now === last) return;
      last = now;
      window.appState[id] = now;
    });
  }
  const locked = document.querySelector('#locked');
  locked.addEventListener('input', () => { locked.value = 'fixed'; });
</script></body></html>`;

const OWNER = '<!doctype html><html data-recued-owner-surface><body><input id="draft" value="pending review"></body></html>';

const PATHS = ['ordinary', 'reviewed'] as const;
type Path = typeof PATHS[number];

describe('Bridge field read and write in real Chrome', () => {
  let server: Server | undefined;
  let base = '';
  let target = '';
  let ingredient: BridgeIngredientRef;
  let browser: Awaited<ReturnType<typeof createReviewedBrowserFixture>> | undefined;

  // ⚠ 240s: the fixture bounds Chrome's MV3 worker start at 180s with a named
  // error, and an outer bound below that would hide it (see the fixture).
  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/owner' ? OWNER : request.url === '/clicks' ? CLICKS : request.url === '/tracked' ? TRACKED : FIELDS);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no page server port');
    base = `http://127.0.0.1:${address.port}`;
    target = `${base}/*`;
    ingredient = { publisher_id: 'fixture', slug: 'page-fields', version: '1', surface_kind: 'authoring',
      domain_allowlist: [target], domain_allowlist_signature: '' };
    browser = await createReviewedBrowserFixture('about:blank');
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve(undefined));
  }, 120_000);

  /** A fresh page, granted, and a way to send it read and fill commands through
   *  one executor. `reset` clears grants too, so grant after it. */
  const open = async (path: Path, at = '/fields') => {
    const fixture = browser!;
    await fixture.reset(base + at);
    await fixture.grant(ingredient);
    const reviewed = path === 'reviewed'
      ? (await fixture.documents()).find(document => document.url === base + at)
      : undefined;
    if (path === 'reviewed' && !reviewed) throw new Error(`the bridge did not inventory ${at}`);
    const send = async (action: 'read_dom' | 'fill' | 'click', args: Record<string, unknown>) => {
      const command: BridgeCommand = { command_id: randomUUID(), recipe_run_id: 'page-fields', step_id: 'field',
        ingredient, action, target_domain_pattern: target, args,
        expects_output_keys: [action === 'fill' ? 'filled' : action === 'click' ? 'clicked' : 'text'], timeout_ms: 30_000,
        idempotency_key: randomUUID(), ...(reviewed ? { reviewed_document: reviewed } : {}) };
      return (path === 'reviewed' ? await fixture.command(command) : await fixture.ordinaryCommand(command)).result;
    };
    return {
      page: fixture.page,
      read: (selector: string) => send('read_dom', { selector }),
      fill: (selector: string, value: string) => send('fill', { selector, value }),
      click: (selector: string) => send('click', { selector }),
      heard: () => fixture.page.evaluate(() => (window as unknown as { heard: string[] }).heard),
    };
  };

  it.each(PATHS)('%s: a form field reads as what it holds, everything else as its text', async path => {
    const { read } = await open(path);
    expect(await read('#name')).toMatchObject({ status: 'ok', outputs: { text: 'Ada' } });
    // innerText of a textarea is its markup; the value is what was typed.
    expect(await read('#notes')).toMatchObject({ status: 'ok', outputs: { text: 'typed later' } });
    expect(await read('#stage')).toMatchObject({ status: 'ok', outputs: { text: 'Closed won' } });
    expect(await read('#tags')).toMatchObject({ status: 'ok', outputs: { text: 'Beta\nGamma' } });
    expect(await read('#vip')).toMatchObject({ status: 'ok', outputs: { text: 'false' } });
    expect(await read('#gold')).toMatchObject({ status: 'ok', outputs: { text: 'true' } });
    expect(await read('#label')).toMatchObject({ status: 'ok', outputs: { text: 'Hello world' } });
    expect(await read('#absent')).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
  }, 60_000);

  it.each(PATHS)('%s: a password, hidden or card field is never read', async path => {
    const { read } = await open(path);
    for (const selector of ['#pw', '#csrf', '#card']) {
      const result = await read(selector);
      expect(result, selector).toMatchObject({ status: 'error', error: { code: 'field_protected' } });
      expect(result.outputs, selector).toBeUndefined();
      expect(pageContentOf(result), selector).not.toMatch(/hunter2|token-123|4111/);
    }
  }, 60_000);

  it.each(PATHS)('%s: inputs, lists and checkboxes take a value the page hears', async path => {
    const { fill, page, heard } = await open(path);
    expect(await fill('#name', 'Grace')).toMatchObject({ status: 'ok', outputs: { filled: true } });
    expect(await page.locator('#name').inputValue()).toBe('Grace');
    // A list takes an option by its value or by the text a person sees.
    expect(await fill('#stage', 'appt')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#stage').inputValue()).toBe('appt');
    expect(await fill('#stage', 'Closed won')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#stage').inputValue()).toBe('won');
    expect(await fill('#tags', 'Alpha\nGamma')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#tags option:checked').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value))).toEqual(['a', 'c']);
    expect(await fill('#vip', 'true')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#vip').isChecked()).toBe(true);
    expect(await fill('#amount', '12.5')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#amount').inputValue()).toBe('12.5');
    expect(await heard()).toEqual(['name', 'stage', 'stage', 'tags', 'vip']);
  }, 60_000);

  it.each(PATHS)('%s: a value the field does not end up holding is reported, not filled', async path => {
    const { fill, page } = await open(path);
    const notApplied = (message: string) => ({ status: 'error', error: { code: 'value_not_applied', message } });
    expect(await fill('#stage', 'Lost')).toMatchObject(notApplied('No option in the list matches the value.'));
    expect(await page.locator('#stage').inputValue()).toBe('won');
    expect(await fill('#vip', 'maybe')).toMatchObject(notApplied('A checkbox or radio button takes true or false.'));
    // A radio button is cleared by choosing another, never by clicking it again.
    expect(await fill('#gold', 'false')).toMatchObject(notApplied('Select another radio button in this group with true; an already selected radio cannot be cleared by clicking it.'));
    expect(await page.locator('#gold').isChecked()).toBe(true);
    expect(await fill('#amount', 'twelve')).toMatchObject(notApplied('The field emptied the value. Check its format.'));
    expect(await fill('#upload', 'C:\\report.pdf')).toMatchObject(notApplied('A file field cannot be typed into.'));
    expect(await fill('#label', 'new')).toMatchObject(notApplied('The element is not a field or an editor.'));
    expect(await page.locator('#label').innerText()).toBe('Hello world');
  }, 60_000);

  it.each(PATHS)('%s: checked writes are idempotent, select radio groups, and detect asynchronous refusal', async path => {
    const { fill, page, heard } = await open(path);
    expect(await fill('#vip', 'true')).toMatchObject({ status: 'ok' });
    expect(await fill('#vip', 'true')).toMatchObject({ status: 'ok' });
    expect((await heard()).filter(id => id === 'vip')).toHaveLength(1);
    expect(await fill('#silver', 'true')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#silver').isChecked()).toBe(true);
    expect(await page.locator('#gold').isChecked()).toBe(false);
    expect(await fill('#silver', 'false')).toMatchObject({ status: 'error' });
    expect(await page.locator('#silver').isChecked()).toBe(true);
    expect(await fill('#refusing-select', 'new')).toMatchObject({ status: 'error', error: { code: 'value_not_applied' } });
    expect(await page.locator('#refusing-select').inputValue()).toBe('old');
    expect(await fill('#refusing-check', 'true')).toMatchObject({ status: 'error', error: { code: 'value_not_applied' } });
    expect(await page.locator('#refusing-check').isChecked()).toBe(false);
  }, 60_000);

  it.each(PATHS)('%s: hidden, disabled and ambiguous options do not change the selection', async path => {
    const { fill, page } = await open(path);
    for (const value of ['locked', 'secret', 'Same label']) {
      expect(await fill('#restricted', value)).toMatchObject({ status: 'error' });
      expect(await page.locator('#restricted').inputValue()).toBe('ok');
    }
    expect(await fill('#restricted', 'b')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#restricted').inputValue()).toBe('b');
  }, 60_000);

  it.each(PATHS)('%s: field writes stay in the active dialog', async path => {
    const { fill, page } = await open(path);
    await page.evaluate(() => {
      const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = '<label>Category<select id="inside"><option>Home</option><option>Work</option></select></label>';
      document.body.append(modal);
    });
    expect(await fill('#stage', 'appt')).toMatchObject({ status: 'error', error: { code: 'value_not_applied' } });
    expect(await page.locator('#stage').inputValue()).toBe('won');
    expect(await fill('#inside', 'Work')).toMatchObject({ status: 'ok' });
    expect(await page.locator('#inside').inputValue()).toBe('Work');
  }, 60_000);

  it.each(PATHS)('%s: a rich-text editor takes the text through its own input events', async path => {
    const { fill, page } = await open(path);
    expect(await fill('#plain', 'A new post')).toMatchObject({ status: 'ok', outputs: { filled: true } });
    expect(await page.locator('#plain').innerText()).toBe('A new post');
    // This editor cancels the browser's edit and renders its model: the text
    // arrived only if its own `beforeinput` handler received it.
    expect(await fill('#framework', 'Typed into the model')).toMatchObject({ status: 'ok' });
    expect(await page.evaluate(() => (window as unknown as { frameworkModel: string }).frameworkModel))
      .toBe('Typed into the model');
    // This one never cancels: the browser edits, and it reads the page back.
    expect(await fill('#mirroring', 'Read back from the page')).toMatchObject({ status: 'ok' });
    expect(await page.evaluate(() => (window as unknown as { mirroredModel: string }).mirroredModel))
      .toBe('Read back from the page');
    expect(await fill('#plain', '')).toMatchObject({ status: 'ok' });
    expect((await page.locator('#plain').innerText()).trim()).toBe('');
  }, 60_000);

  it.each(PATHS)('%s: an editor that does not take the text is reported, not filled', async path => {
    const { fill, page } = await open(path);
    expect(await fill('#refusing', 'A new post')).toMatchObject({
      status: 'error', error: { code: 'value_not_applied', message: 'The editor did not take the text.' } });
    expect(await page.locator('#refusing').innerText()).toBe('keep');
  }, 60_000);

  // The reviewed path never reaches the owner client: its inventory leaves it
  // out (`describeOpenBridgeDocuments`), so only the ordinary path can try.
  // D-335 slice I — a click is the whole gesture a person makes.
  type Heard = Array<[string, string, boolean, number, number]>;
  const heardBy = async (page: { evaluate: (f: () => unknown) => Promise<unknown> }, id: string) =>
    ((await page.evaluate(() => (window as unknown as { events: Heard }).events)) as Heard).filter(event => event[0] === id);

  it.each(PATHS)('%s: a click points, presses and lets go at the element\'s centre, focuses it, then clicks', async path => {
    const { page, click } = await open(path, '/clicks');
    expect(await click('#plain')).toMatchObject({ status: 'ok', outputs: { clicked: true } });
    const heard = await heardBy(page, 'plain');
    expect(heard.map(event => event[1])).toEqual(['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove',
      'mousemove', 'pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']);
    // The page can still tell the pointer and mouse were not a person's. Focus
    // moves for real: Chrome itself sends the focus event a focus() causes.
    expect(heard.filter(event => event[2]).map(event => event[1])).toEqual(['focus']);
    const clicked = heard.find(event => event[1] === 'click')!;
    expect([clicked[3], clicked[4]]).toEqual([80, 40]);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('plain');
  });

  it.each(PATHS)('%s: a menu that opens on the press opens, which element.click() never did', async path => {
    const { page, click } = await open(path, '/clicks');
    // The control: the click the Bridge used to send.
    await page.evaluate(() => (document.querySelector('#pressmenu') as HTMLElement).click());
    expect(await page.evaluate(() => (document.querySelector('#menu') as HTMLElement).hidden)).toBe(true);
    expect(await click('#pressmenu')).toMatchObject({ status: 'ok' });
    expect(await page.evaluate(() => (document.querySelector('#menu') as HTMLElement).hidden)).toBe(false);
  });

  it.each(PATHS)('%s: something on top of the element, or its being disabled, means nothing is clicked, and why', async path => {
    const { page, click } = await open(path, '/clicks');
    expect(await click('#covered')).toMatchObject({ status: 'error', error: { code: 'value_not_applied',
      message: 'Something else on the page covers it (“Accept cookies”), so it was not clicked. Close or answer that first.',
      obstruction: { target: { tag: 'button' }, blocker: { tag: 'div', label: 'Accept cookies', role: 'dialog' }, executed: false } } });
    await page.evaluate(() => document.querySelector('#cover')!.setAttribute('aria-label', 'Long label '.repeat(12)));
    const longLabel = await click('#covered');
    expect(longLabel.error?.obstruction?.blocker).toMatchObject({ label: 'Long label '.repeat(12).trim().slice(0, 80), label_truncated: true });
    await page.evaluate(() => {
      const cover = document.querySelector('#cover')!;
      cover.removeAttribute('aria-label'); cover.removeAttribute('title'); cover.textContent = '';
      cover.setAttribute('ref', 'e999');
    });
    const unlabeled = await click('#covered');
    expect(unlabeled).toMatchObject({ status: 'error', error: { obstruction: {
      operation: 'click', executed: false, reason: 'target_occluded', source: 'hit_test',
      blocker: { tag: 'div', role: 'dialog' }, waited_ms: expect.any(Number) } } });
    expect(unlabeled.error!.obstruction!.blocker).not.toHaveProperty('label');
    expect(unlabeled.error!.obstruction!.blocker).not.toHaveProperty('ref');
    expect(await click('#off')).toMatchObject({ status: 'error', error: { code: 'value_not_applied',
      message: 'It is disabled, so it was not clicked.' } });
    expect(await heardBy(page, 'covered')).toEqual([]);
    expect(await heardBy(page, 'off')).toEqual([]);
  });

  it.each(PATHS)('%s: a part of the element takes the click, as a person\'s would; one below the fold is scrolled to', async path => {
    const { page, click } = await open(path, '/clicks');
    expect(await click('#icon')).toMatchObject({ status: 'ok' });
    // The icon inside the button is what the press landed on, and the button hears it.
    expect((await heardBy(page, 'glyph')).map(event => event[1])).toContain('pointerdown');
    expect((await heardBy(page, 'icon')).map(event => event[1])).toContain('click');
    expect(await click('#far')).toMatchObject({ status: 'ok' });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1_000);
    expect((await heardBy(page, 'far')).map(event => event[1])).toContain('mousedown');
  });

  it.each(PATHS)('%s: an element that draws nothing still gets its click, as before', async path => {
    const { page, click } = await open(path, '/clicks');
    expect(await click('#unseen')).toMatchObject({ status: 'ok' });
    expect((await heardBy(page, 'unseen')).map(event => event[1])).toEqual(['click']);
  });

  // D-335 slice I — typing reaches an app that keeps the field's last value on the element.
  it.each(PATHS)('%s: typing reaches a React-built field\'s state, which a plain value assignment never did', async path => {
    const { page, fill } = await open(path, '/tracked');
    // The control: what the Bridge used to do leaves the app's state unchanged.
    await page.evaluate(() => {
      const field = document.querySelector('#tracked') as HTMLInputElement;
      field.value = 'old way';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.evaluate(() => (window as unknown as { appState: Record<string, string> }).appState)).toEqual({});
    expect(await fill('#tracked', 'Ada Lovelace')).toMatchObject({ status: 'ok', outputs: { filled: true } });
    expect(await fill('#tracked-notes', 'first line')).toMatchObject({ status: 'ok' });
    expect(await page.evaluate(() => (window as unknown as { appState: Record<string, string> }).appState))
      .toEqual({ tracked: 'Ada Lovelace', 'tracked-notes': 'first line' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('tracked-notes');
  });

  it.each(PATHS)('%s: a field that puts its own value back is reported, not filled', async path => {
    const { fill } = await open(path, '/tracked');
    expect((await fill('#locked', 'changed')).error).toMatchObject({ code: 'value_not_applied',
      message: 'The page put back what the field held, so the value did not go in.' });
  });

  it('refuses to read or fill the owner client, and leaves it untouched', async () => {
    const { read, fill, page } = await open('ordinary', '/owner');
    expect(await read('#draft')).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(await fill('#draft', 'changed')).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(await page.locator('#draft').inputValue()).toBe('pending review');
  }, 60_000);
});

describe('the check that a protected field is never answered', () => {
  const answer = (message: string) => ({ command_id: 'b65e4111-6ac0-43d8-85d5-c5accc2dcd14', duration_ms: 4111,
    bridge_version: '0.0.7', idempotency_key_seen: false, status: 'error',
    error: { code: 'field_protected', message } }) as BridgeResult;

  it('reads the answer, not its random id or its time, and still finds a secret in it', () => {
    expect(pageContentOf(answer('The Browser Bridge does not read password fields.'))).not.toMatch(/hunter2|token-123|4111/);
    expect(pageContentOf(answer('The card field holds 4111 1111 1111 1111.'))).toMatch(/4111/);
  });
});
