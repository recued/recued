/** D-402 slice B4 — the benchmark's own site whose pages change by themselves, for its tasks X and Y,
 *  copied from `recued-bridge-vs-browser-use/harness/live-site/site.mjs` (D-347 follow-up 21) so the
 *  replay drive does not reach into another repository. Keep the two in step.
 *
 *  - `/inbox`: eight emails; a new one arrives at the top every 6 s and the list is drawn again into the
 *    same rows (keyed by position), with a notice over the list for 2.5 s. A row's Delete deletes what
 *    that row shows when it is clicked.
 *  - `/offers`: four offers stacked in one banner, the one on top changing every 2.5 s; each opens
 *    `/offer/<slug>`, which gives its code.
 *
 *  What the pages did is recorded here, where no model reaches it: each email deleted, each offer opened.
 *  A run is held to that record as well as to its answer, since an answer cannot see a click that landed
 *  on another row. */
import { createServer } from 'node:http';

const INBOX = `<!doctype html><html><head><meta charset="utf-8"><title>Inbox</title><style>
body { font-family: sans-serif } ul { list-style: none; padding: 0; width: 560px } li { padding: 8px; border-bottom: 1px solid #ddd }
#toast { position: fixed; top: 0; left: 0; width: 600px; height: 640px; background: rgba(255,255,255,0.97); z-index: 9; font-size: 22px; padding: 24px }
</style></head><body>
<h1>Inbox</h1>
<ul id="mails"></ul>
<div id="toast" role="status" hidden></div>
<script>
const mails = [['Ada', 'Lunch on Friday?'], ['Bob', 'Invoice 1043 for October'], ['Cy', 'Your parcel is on its way'],
  ['Dee', 'Team offsite agenda'], ['Eve', 'Re: contract draft'], ['Fay', 'Gym membership renewal'],
  ['Gus', 'Photos from the weekend'], ['Hal', 'Quarterly report']];
const arriving = [['Ivy', 'Newsletter: autumn picks'], ['Jay', 'Your receipt from the cafe'], ['Kim', 'Meeting moved to Thursday'],
  ['Lou', 'Password changed'], ['Max', 'Weekend plans'], ['Ned', 'Library books due'], ['Oz', 'New sign-in on your account'],
  ['Pam', 'The recipe you asked for'], ['Quin', 'Parking permit'], ['Rae', 'Concert tickets'], ['Sol', 'Garden club'],
  ['Tia', 'School trip form'], ['Uma', 'Dentist reminder'], ['Val', 'Book club'], ['Wes', 'Car service due']];
const list = document.getElementById('mails');
const draw = () => {
  while (list.children.length < mails.length) {
    const row = document.createElement('li');
    row.innerHTML = '<span class="from"></span> — <span class="subject"></span> <button type="button">Delete</button>';
    row.querySelector('button').addEventListener('click', () => {
      const i = [...list.children].indexOf(row);
      const [from, subject] = mails[i];
      fetch('/log?deleted=' + encodeURIComponent(from + ' — ' + subject));
      mails.splice(i, 1);
      draw();
    });
    list.append(row);
  }
  while (list.children.length > mails.length) list.lastElementChild.remove();
  mails.forEach(([from, subject], i) => {
    list.children[i].querySelector('.from').textContent = from;
    list.children[i].querySelector('.subject').textContent = subject;
  });
};
draw();
let next = 0;
setInterval(() => {
  if (next >= arriving.length) return;
  const [from, subject] = arriving[next++];
  mails.unshift([from, subject]);
  draw();
  const toast = document.getElementById('toast');
  toast.textContent = 'New mail from ' + from;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 2500);
}, 6000);
</script></body></html>`;

const OFFERS = `<!doctype html><html><head><meta charset="utf-8"><title>Offers</title><style>
#banner { position: relative; width: 520px; height: 160px }
#banner a { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 26px;
  background: #f3f3f3; color: #222; text-decoration: none; z-index: 0 }
#banner a.on { z-index: 1 }
</style></head><body>
<h1>This week's offers</h1>
<div id="banner">
<a href="/offer/summer-sale" class="on">Summer sale: a fifth off</a>
<a href="/offer/winter-tyres">Winter tyres, fitting included</a>
<a href="/offer/free-delivery">Free delivery this week</a>
<a href="/offer/gift-cards">Gift cards for every occasion</a>
</div>
<p>Offers change every few seconds.</p>
<script>
const offers = [...document.querySelectorAll('#banner a')];
let on = 0;
setInterval(() => { offers[on].classList.remove('on'); on = (on + 1) % offers.length; offers[on].classList.add('on'); }, 2500);
</script></body></html>`;

const CODES: Readonly<Record<string, readonly [string, string]>> = {
  'summer-sale': ['Summer sale: a fifth off', 'SS-2981'],
  'winter-tyres': ['Winter tyres, fitting included', 'WT-4417'],
  'free-delivery': ['Free delivery this week', 'FD-7730'],
  'gift-cards': ['Gift cards for every occasion', 'GC-5106'],
};

export type LiveSiteEvent = { deleted: string } | { opened: string };

/** Starts the site on a free port of this machine: its address, and its record of what its pages did. */
export const startLiveSite = async () => {
  let events: LiveSiteEvent[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const html = (body: string) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    };
    if (url.pathname === '/inbox') return html(INBOX);
    if (url.pathname === '/offers') return html(OFFERS);
    if (url.pathname.startsWith('/offer/')) {
      const slug = url.pathname.slice('/offer/'.length);
      events.push({ opened: slug });
      const [title, code] = CODES[slug] ?? ['No such offer', '—'];
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>`
        + `<p>Your code is ${code}. Show it at checkout.</p></body></html>`);
    }
    if (url.pathname === '/log') {
      events.push({ deleted: url.searchParams.get('deleted') ?? '' });
      response.writeHead(204);
      return response.end();
    }
    response.writeHead(404);
    return response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the live site has no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    reset: () => { events = []; },
    events: () => [...events],
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};

/** What a run's record holds, each event once ("opened winter-tyres"), in the order first seen. */
export const liveSiteRecord = (events: readonly LiveSiteEvent[]): string[] =>
  [...new Set(events.map((event) => ('deleted' in event ? `deleted ${event.deleted}` : `opened ${event.opened}`)))];
