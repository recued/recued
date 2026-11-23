/** D-402 slice B2b — the job's answer found in what was read (§4, rule 7): each value read out of the
 *  page that showed it, by the element that holds it or by its row's label, which stays when the value
 *  changes; and the values a chat reply set apart. */
import { describe, expect, it } from 'vitest';
import type { BrowserPlanCallWithSteps } from '../bridges/browser-flow-record.js';
import { findValueInRead, readShows } from '../bridges/html-selector.js';
import { answerValuesOf } from '../answer-values.js';
import { compilePlan, placesIn } from '../plan-compiler.js';

const ARTICLE = `<h1 id="firstHeading"><span class="mw-page-title-main">Python (programming language)</span></h1>
<table class="infobox"><tbody><tr><th class="infobox-label">First appeared</th><td class="infobox-data">20 February 1991; 33 years ago</td></tr>
<tr><th class="infobox-label">Designed by</th><td class="infobox-data"><a href="/wiki/Guido_van_Rossum" ref="e30">Guido van Rossum</a></td></tr></tbody></table>
<dl><dt>Points</dt><dd>345</dd></dl>
<ul><li><span class="score">345 points</span></li><li><span class="score">120 points</span></li></ul>`;

describe('D-402 slice B2b — a value in a read', () => {
  it('in a row of a table or a definition: its row\'s label, which stays when the value changes', () => {
    expect(findValueInRead(ARTICLE, '20 February 1991')).toEqual({ find: 'First appeared', text: '20 February 1991; 33 years ago' });
    expect(findValueInRead(ARTICLE, 'Guido van Rossum')).toEqual({ find: 'Designed by', text: 'Guido van Rossum' });
    // 2026-11-20 — a label the page shows more than once is no `find`: a find answers every line that holds it,
    // whatever its case, so "Points" would read "345 points" and "120 points" too. The element alone instead.
    expect(findValueInRead(ARTICLE, '345')).toEqual({ selector: 'dd', text: '345' });
  });

  it('a row label other rows hold too (ranks "1." and "11."): the value\'s own element, first of its kind (task B)', () => {
    const ranks = [1, 2, 11, 21].map((rank) => `<tr class="athing"><td class="title"><span class="rank">${String(rank)}.</span></td>`
      + `<td class="title"><span class="titleline"><a href="https://news.example/${String(rank)}">Story ${String(rank)}</a>`
      + '<span class="sitebit"> (<a href="from?site=news.example">news.example</a>)</span></span></td></tr>').join('');
    expect(findValueInRead(`<table><tbody>${ranks}</tbody></table>`, 'Story 1'))
      .toEqual({ selector: 'span.titleline a', first: true, text: 'Story 1' });
  });

  it('a class every other row carries is no list: the first cell of the first `tr.even`, in the second row, is no first (task M)', () => {
    const row = (stripe: string, name: string, gender: string) => `<tr class="${stripe}"><td>${name}</td><td>${gender}</td></tr>`;
    const TABLE = `<table><tbody>${row('odd', 'Alice Johnson', 'Female')}${row('even', 'Bob Williams', 'Male')}`
      + `${row('odd', 'Carol King', 'Female')}${row('even', 'Dan Moore', 'Male')}</tbody></table>`;
    // Its row's label, read last: a later run whose page draws no stripes still reads the rows.
    expect(findValueInRead(TABLE, 'Bob Williams')).toEqual({ find: 'Male', text: 'Bob Williams' });
  });

  it('a value whose space the page draws by an element: found, spacing aside, never by its own text (task C)', () => {
    const CAPTION = '<table class="infobox"><tbody><tr><td colspan="2" class="infobox-image"><img alt="Portrait">'
      + '<div class="infobox-caption"><a href="/wiki/Daguerreotype">Daguerreotype</a> of Lovelace (<abbr title="circa">c.</abbr>'
      + '<span><span></span>1843</span>)<sup class="reference"><a href="#cite_note-1">[1]</a></sup></div></td></tr></tbody></table>';
    expect(readShows(CAPTION, 'Daguerreotype of Lovelace (c. 1843)')).toBe(true);
    expect(findValueInRead(CAPTION, 'Daguerreotype of Lovelace (c. 1843)'))
      .toEqual({ selector: 'div.infobox-caption', text: 'Daguerreotype of Lovelace ( c. 1843 ) [1]' });
    // Spacing aside only for a value of some length: two letters never match by their spacing alone.
    expect(findValueInRead('<p>a b</p>', 'ab')).toBeUndefined();
  });

  it('an element of its own: a selector that finds it alone; none when nothing lasting does', () => {
    expect(findValueInRead(ARTICLE, 'Python (programming language)')).toEqual({ selector: 'span.mw-page-title-main',
      text: 'Python (programming language)' });
    // Several alike, the value's the first: read as the first, as a top story is.
    expect(findValueInRead(ARTICLE, '345 points')).toEqual({ selector: 'span.score', first: true, text: '345 points' });
    // The second of them: nothing lasting reads it alone.
    expect(findValueInRead(ARTICLE, '120 points')).toEqual({ text: '120 points' });
    // A link's address names the item, not its place in the page, so an answer is never read by it.
    expect(findValueInRead('<ul><li><a class="title" href="/n/1">Build failed</a></li></ul>', 'Build failed'))
      .toEqual({ selector: 'a.title', text: 'Build failed' });
    expect(findValueInRead(ARTICLE, 'Rust')).toBeUndefined();
  });

  it('a reply in plain prose (slice B4): a sentence\'s short complement and a count with its unit, never what the request said', () => {
    expect(answerValuesOf('The last article listed under "See also" is Women in STEM fields.',
      'What is the last article listed under "See also" on Ada Lovelace\'s page?')).toEqual(['Women in STEM fields']);
    expect(answerValuesOf('The top story on Hacker News is "SpaceX catches the Starship" with 1288 points.', 'What is the top story?'))
      .toEqual(['SpaceX catches the Starship', '1288 points']);
    // A complement that is a phrase, not a value, is left.
    expect(answerValuesOf('The page is a list of quotes.')).toEqual([]);
  });

  it('a value the page shows in several places: the place that reads it lastingly, not the deepest (slice B4)', () => {
    // An article's infobox names its designer; the links at the page's foot name him again, deeper down.
    const PAGE = '<table class="infobox"><tbody><tr><th>Designed by</th><td><a href="/wiki/G">Guido van Rossum</a></td></tr></tbody></table>'
      + '<h2 id="External_links">External links</h2><div class="navbox"><table><tbody><tr><td><div><ul><li><a href="/wiki/G">Guido van Rossum</a></li>'
      + '<li><a href="/wiki/C">CPython</a></li></ul></div></td></tr></tbody></table></div>';
    expect(findValueInRead(PAGE, 'Guido van Rossum')).toEqual({ find: 'Designed by', text: 'Guido van Rossum' });
  });

  it('a value as an answer wrote it, loosely: a date in another form, names joined with commas (slice B4)', () => {
    const RUST = '<table class="infobox"><tbody><tr><th class="infobox-label">First appeared</th><td class="infobox-data">January 20, 2012; 14 years ago</td></tr>'
      + '<tr><th class="infobox-label">Designed by</th><td class="infobox-data"><a href="/wiki/R">Robert Griesemer</a><br><a href="/wiki/P">Rob Pike</a></td></tr></tbody></table>';
    // As written, neither is on the page.
    expect(findValueInRead(RUST, '20 January 2012')).toBeUndefined();
    expect(findValueInRead(RUST, 'Robert Griesemer, Rob Pike')).toBeUndefined();
    expect(findValueInRead(RUST, '20 January 2012', true)).toEqual({ find: 'First appeared', text: 'January 20, 2012; 14 years ago' });
    expect(findValueInRead(RUST, '2012-01-20', true)).toMatchObject({ find: 'First appeared' });
    expect(findValueInRead(RUST, 'Robert Griesemer, Rob Pike', true)).toEqual({ find: 'Designed by', text: 'Robert Griesemer Rob Pike' });
    // Another day is not this one.
    expect(findValueInRead(RUST, '21 January 2012', true)).toBeUndefined();
  });

  it('a value with nothing lasting to read it by, under a heading: the section, by its heading (slice B4)', () => {
    const SEE_ALSO = '<h2 id="See_also">See also</h2><div class="div-col"><ul><li><a href="/wiki/A">Women in computing</a></li>'
      + '<li><a href="/wiki/B">Women in STEM fields</a></li></ul></div><h2 id="Notes">Notes</h2><ul><li><a href="/wiki/C">Other</a></li></ul>';
    expect(findValueInRead(SEE_ALSO, 'Women in STEM fields')).toEqual({ find: 'See also', text: 'Women in STEM fields' });
  });

  it('a chat reply\'s values: a table\'s cells but not its header, a list item after its label, bold and quoted text', () => {
    expect(answerValuesOf([
      '| Language | First appeared |', '|---|---|', '| Python | 20 February 1991 |',
      '', '- Points: 345', '- **Designed by**: Guido van Rossum', 'The caption reads “Portrait by Chalon”.',
    ].join('\n'))).toEqual(['Python', '20 February 1991', '345', 'Guido van Rossum', 'Designed by', 'Portrait by Chalon']);
  });

  it('a complement with initials, after a colon, or of "<done> by <whom>": whom (task H, 2026-11-20)', () => {
    const REQUEST = 'Who said the second quote on that page, and what are its tags?';
    expect(answerValuesOf('The second quote on the page was said by C.S. Lewis. Its tags are: books, inspirational, reading, and tea.',
      REQUEST)).toEqual(['C.S. Lewis', 'books, inspirational, reading, and tea']);
    expect(answerValuesOf('It was written by C. S. Lewis.')).toEqual(['C. S. Lewis']);
    expect(answerValuesOf('Its price is 3.50.')).toEqual(['3.50']);
    // A sentence that ends on a letter is no initial: nothing, as before.
    expect(answerValuesOf('The answer is B. The next one is C.')).toEqual([]);
  });

  it('the item at the place a request names, among items alike: its own element there (task H, 2026-11-20)', () => {
    const quote = (who: string, tags: string[]) => `<div class="quote"><span class="text">“Words.”</span><span>by <small class="author">${who}</small></span>`
      + `<div class="tags">Tags: ${tags.map((tag) => `<a class="tag">${tag}</a>`).join('')}</div></div>`;
    const QUOTES = `<div id="quotesPlaceholder">${quote('George R.R. Martin', ['read'])}${quote('C.S. Lewis', ['books', 'tea'])}`
      + `${quote('Marilyn Monroe', [])}</div>`;
    expect(placesIn('Who said the second quote on that page, and what are its tags?')).toEqual([2]);
    expect(findValueInRead(QUOTES, 'C.S. Lewis', false, [2]))
      .toEqual({ selector: 'div.quote:nth-of-type(2) small.author', place: 2, text: 'C.S. Lewis' });
    expect(findValueInRead(QUOTES, 'books, and tea', true, [2]))
      .toEqual({ selector: 'div.quote:nth-of-type(2) div.tags', place: 2, text: 'Tags: books tea' });
    // Never a place the request did not name: nothing lasting reads the second of them, as before.
    expect(findValueInRead(QUOTES, 'C.S. Lewis', false, [3])).toEqual({ text: 'C.S. Lewis' });
    expect(findValueInRead(QUOTES, 'C.S. Lewis')).toEqual({ text: 'C.S. Lewis' });
    // A list whose children of that tag are not all items (an advert among them, before the items or after
    // them): the place counts the advert too, or would on a day it moves up.
    for (const mixed of [QUOTES.replace('<div class="quote">', '<div class="advert">Ad</div><div class="quote">'),
      QUOTES.replace(/<\/div>$/u, '<div class="advert">Ad</div></div>')]) {
      expect(findValueInRead(mixed, 'C.S. Lewis', false, [2])).toEqual({ text: 'C.S. Lewis' });
    }
  });

  it('the places a request names: from the second, never a word joined to another or a count of time', () => {
    expect(placesIn('the 3rd result and the 21st')).toEqual([3, 21]);
    expect(placesIn('The Second quote')).toEqual([2]);
    for (const request of ['the first quote', 'the second-largest city', 'wait a second', 'the quotes appear some seconds after']) {
      expect(placesIn(request)).toEqual([]);
    }
  });
});

describe('D-402 slice B2b — the compiler reads the answer out', () => {
  const page = 'bridge:work:3:D1';
  const PY = 'https://en.wikipedia.org/wiki/Python_(programming_language)';
  const read = (url: string, html: string, run: string, handle = page): BrowserPlanCallWithSteps => ({ run_id: run,
    recipe_id: 'inspect-web-page', args: { page: handle }, started_at: 1, finished_at: 1, outcome: 'done', bridge_ids: ['work'], acted: [],
    results: [{ step_id: 'inspect', result: { page: handle, url } }], reads: [{ page: handle, url, html }] });

  it('by its row\'s label or its element, on the page the job ended on, in place of reading the whole page', () => {
    const { recipe, notes } = compilePlan({ by: 'app', calls: [read(PY, ARTICLE, 'r1')],
      answer: [{ name: 'first', value: '20 February 1991' }, { name: 'title', value: 'Python (programming language)' }, { value: 'Rust' }] });
    expect((recipe.steps[0] as unknown as { args: { steps: unknown[] } }).args.steps).toEqual([
      { url: PY, do: 'read', find: 'First appeared' },
      { do: 'read', selector: 'span.mw-page-title-main', form: 'text' },
    ]);
    expect(notes).toEqual(['The answer\'s “Rust” is not shown by one element of the pages read, so the recipe does not read it out by itself.']);
  });

  it('a value in the item at the place the request names: read there, and the note says so (task H, 2026-11-20)', () => {
    const QUOTES = 'https://quotes.toscrape.com/js-delayed/page/5/';
    const item = (who: string) => `<div class="quote"><span>by <small class="author">${who}</small></span></div>`;
    const { recipe, notes } = compilePlan({ by: 'chat', calls: [read(QUOTES, `<div id="list">${item('Martin')}${item('C.S. Lewis')}</div>`, 'r1')],
      request: 'Who said the second quote on that page?', answer: [{ value: 'C.S. Lewis' }] });
    expect((recipe.steps[0] as unknown as { args: { steps: unknown[] } }).args.steps).toEqual([
      { url: QUOTES, do: 'read', selector: 'div.quote:nth-of-type(2) small.author', form: 'text' }]);
    expect(notes).toEqual(['The answer\'s “C.S. Lewis” was in the second of several items alike, the place your request names: the recipe '
      + 'reads it there (div.quote:nth-of-type(2) small.author), whichever item is there at each run.']);
  });

  it('a value as written, in any read, before a value found loosely in a newer one (slice B4)', () => {
    const NEWS = 'https://news.example.com/today';
    const { recipe } = compilePlan({ by: 'chat', calls: [
      read(PY, '<table><tr><th>Released</th><td>20 January 2012</td></tr></table>', 'r1'),
      read(NEWS, '<table><tr><th>Posted</th><td>January 20, 2012</td></tr></table>', 'r2', 'bridge:work:4:D1')],
    answer: [{ value: '20 January 2012' }] });
    expect((recipe.steps[0] as unknown as { args: { steps: unknown[] } }).args.steps).toEqual([{ url: PY, do: 'read', find: 'Released' }]);
  });

  it('a value read on an earlier page is read there, by its address', () => {
    const RUST = 'https://en.wikipedia.org/wiki/Rust_(programming_language)';
    const { recipe } = compilePlan({ by: 'chat', calls: [read(PY, ARTICLE, 'r1'),
      read(RUST, '<h1 id="firstHeading">Rust</h1><table><tr><th>Developer</th><td>Rust Foundation</td></tr></table>', 'r2', 'bridge:work:4:D1')],
    answer: [{ value: 'Guido van Rossum' }, { value: 'Rust Foundation' }] });
    expect((recipe.steps[0] as unknown as { args: { steps: unknown[] } }).args.steps).toEqual([
      { url: PY, do: 'read', find: 'Designed by' },
      { url: RUST, do: 'read', find: 'Developer' },
    ]);
  });

  it('a read of the page the job\'s own click opened continues on that tab; one made before it keeps its address', () => {
    const SEARCH = 'https://shop.example.com/search';
    const RESULTS = 'https://shop.example.com/search?q=lamp';
    const tab = 'bridge:work:9:D1';
    const act: BrowserPlanCallWithSteps = { run_id: 'a1', recipe_id: 'act-on-web-page', started_at: 2, finished_at: 2, outcome: 'done',
      bridge_ids: ['work'], args: { page: tab, steps: [{ do: 'type', selector: '#q', typed: true }, { do: 'click', selector: '#go' }] },
      acted: [{ do: 'type', url: SEARCH, title: 'Search', element: { role: 'search box', label: 'Search', selector: '#q' }, value: 'lamp', at: 2, position: 1 },
        { do: 'click', url: SEARCH, title: 'Search', element: { role: 'button', label: 'Go', selector: '#go' }, at: 2, position: 2 }],
      results: [{ step_id: 'act', result: { page: 'bridge:work:9:D2', url: RESULTS } }] };
    const before = read(SEARCH, '<p class="hint">Try a lamp</p>', 'r0', tab);
    const after = read(RESULTS, '<h2 class="first-hit">Brass lamp</h2>', 'r2', 'bridge:work:9:D2');
    const { recipe } = compilePlan({ by: 'chat', calls: [before, act, after], answer: [{ value: 'Brass lamp' }, { value: 'Try a lamp' }] });
    expect((recipe.steps[0] as unknown as { args: { steps: unknown[] } }).args.steps).toEqual([
      { url: SEARCH, do: 'type', selector: '#q', value: '{{config.text_1}}' },
      { do: 'click', selector: '#go' },
      // The results of today's search, on the tab the click left: no address.
      { do: 'read', selector: 'h2.first-hit', form: 'text' },
      // The search page as it was before the search: by its address.
      { url: SEARCH, do: 'read', selector: 'p.hint', form: 'text' },
    ]);
  });
});

