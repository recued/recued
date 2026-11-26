/** D-335 slice O — a page read as an outline, made on the server from the cleaned HTML the Bridge
 *  answers (`bridges/page-outline.ts`). The HTML here is written as `inspectPage` writes it (its
 *  own tags, a closed list of attributes, text and values escaped, refs on what can be acted on);
 *  the real Bridge's HTML through the real adapter is pinned in `browser-toolkit-browser.test.ts`. */

import { describe, expect, it } from 'vitest';

import {
  controlsSaid,
  createPageReadStore,
  findControl,
  outlinePage,
  PAGE_FIND_MAX_LINES,
  PAGE_FIND_SECTIONS,
  PAGE_OUTLINE_LINE_CHARS,
  PAGE_OUTLINE_PART_CHARS,
  PAGE_COVER_NOTE_TAIL,
  PAGE_TEXT_PART_CHARS,
  parseInspectHtml,
} from '../bridges/page-outline.js';

import { browserFieldEvidence } from '../bridges/browser-field-evidence.js';

const URL_ = 'https://en.example.org/wiki/Ada';
const lines = (html: string, url = URL_) => outlinePage(html, { url }).text.split('\n');

describe('D-335 slice O — the Bridge\'s HTML, parsed', () => {
  it('excludes structural placeholders from outlines, text, controls and field evidence', () => {
    const visible = '<p>Visible</p><input ref="e2" name="public" value="Ada">';
    const placeholders = '<p data-recued-structural-only><p>Hidden</p></p>'
      + '<input data-recued-structural-only ref="e99" name="private" value="secret">'
      + '<script data-recued-structural-only></script><meta data-recued-structural-only>';
    const html = `<body>${placeholders}${visible}</body>`;
    expect(outlinePage(html, { url: URL_ })).toEqual(outlinePage(`<body>${visible}</body>`, { url: URL_ }));
    expect(browserFieldEvidence(html, { whole: true, truncated: false }))
      .toEqual(browserFieldEvidence(`<body>${visible}</body>`, { whole: true, truncated: false }));
    const preserved = parseInspectHtml(html, true);
    expect(JSON.stringify(preserved)).not.toMatch(/Hidden|secret|private|e99/);
    expect(JSON.stringify(preserved)).toContain('structuralOnly');
  });

  it('reads its escaped text and attributes, void elements and booleans, and tolerates what it never writes', () => {
    const root = parseInspectHtml('<body><p class="a b">x &lt;y&gt; &amp; "z"<br>w</p><input ref="e1" value="a &quot;b&quot;" disabled><a href="#q">q</a> 1 < 2</body>');
    const body = root.children[0] as { tag: string; children: Array<{ kind: string; tag?: string; text?: string; attrs?: Record<string, unknown> }> };
    expect(body.tag).toBe('body');
    const p = body.children[0] as unknown as { attrs: Record<string, unknown>; children: Array<{ kind: string; text?: string; tag?: string }> };
    expect(p.attrs.class).toBe('a b');
    expect(p.children.map((c) => c.kind === 'text' ? c.text : `<${c.tag!}>`)).toEqual(['x <y> & "z"', '<br>', 'w']);
    const input = body.children[1] as unknown as { tag: string; attrs: Record<string, unknown>; children: unknown[] };
    expect(input).toMatchObject({ tag: 'input', attrs: { ref: 'e1', value: 'a "b"', disabled: true }, children: [] });
    // A "<" that opens no tag is text.
    expect((body.children.at(-1) as { text?: string }).text).toBe(' 1 < 2');
  });
});

describe('D-335 slice O — one line per block, what can be acted on as [label](ref)', () => {
  it('distinguishes identically named links and buttons without changing lookup names or page text', () => {
    const out = outlinePage('<main><p>Use <a ref="e24" href="/login">Login</a> first.</p>'
      + '<p><button ref="e25">Login</button></p><p><input ref="e26" type="email" aria-label="Email"></p>'
      + '<p><span ref="e27" role="button">Continue</span></p>'
      + '<p><span ref="e28" role="link">Docs</span></p><p><button ref="e29" role="link">Help</button></p>'
      + '<p><button ref="e30" disabled>Cancel</button></p></main>', { url: URL_ });
    expect(out.shown).toEqual(['Use [link: Login](e24) first.', '[button: Login](e25)', '[input type="email": Email](e26)',
      '[span role="button": Continue](e27)', '[span role="link": Docs](e28)', '[button role="link": Help](e29)', '[button: Cancel disabled](e30)']);
    expect(findControl(out.controls, 'Login', 'link')).toMatchObject({ ref: 'e24', control: { names: ['Login'] } });
    expect(findControl(out.controls, 'Login', 'button')).toMatchObject({ ref: 'e25', control: { names: ['Login'] } });
    expect(findControl(out.controls, 'Continue', 'button')).toMatchObject({ ref: 'e27' });
    expect(findControl(out.controls, 'Help', 'link')).toMatchObject({ ref: 'e29' });
    expect(out.lines[0]!.plain).toBe('Use Login first.');
  });

  it('headings, paragraphs, nested lists, a quote, and a table row of cells', () => {
    expect(lines('<body><h1>Ada</h1><p>Mathematician.</p><ul><li>One<ul><li>Inner</li></ul></li><li>Two</li></ul>'
      + '<blockquote>Said.</blockquote><table><tbody><tr><th>Born</th><td>10 December 1815</td></tr></tbody></table></body>'))
      .toEqual(['# Ada', 'Mathematician.', '- One', '  - Inner', '- Two', '> Said.', '| Born | 10 December 1815']);
  });

  it('a link, a field named by its label (whose own line goes), a checkbox, a list with its choice, a text area, buttons', () => {
    expect(lines('<body><p>See <a ref="e1" href="https://x.org/a">the page</a>.</p>'
      + '<div><label for="q">Search for</label><input ref="e2" id="q" type="search" value="ada"></div>'
      + '<div><input ref="e3" type="checkbox" checked aria-label="Remember me"></div>'
      + '<div><select ref="e4" aria-label="Country"><option>France</option><option selected>Japan</option></select></div>'
      + '<div><textarea ref="e5" placeholder="Note">Hello</textarea></div>'
      // Side by side in one block, they share its line.
      + '<div><button ref="e6">Send</button><span ref="e7" role="button" tabindex="0">Close</span></div></body>'))
      .toEqual(['See [link: the page](e1).', '[input type="search": Search for = "ada"](e2 #q)', '[input type="checkbox": Remember me checked](e3)',
        '[select: Country = "Japan": France | Japan](e4)', '[textarea: Note = "Hello"](e5)', '[button: Send](e6) [span role="button": Close](e7)']);
  });

  it('keeps all selected labels in a multiple select, including grouped options', () => {
    const html = '<main><select ref="e1" multiple aria-label="Tags"><option value="a" selected>Alpha</option>'
      + '<optgroup label="Other"><option value="b" selected>Beta</option><option value="c">Gamma</option></optgroup></select></main>';
    const out = outlinePage(html);
    expect(out.text).toBe('[select multiple: Tags = ["Alpha","Other / Beta"]: Alpha | Other (Beta | Gamma)](e1)');
    expect(out.controls).toMatchObject([{ ref: 'e1', kind: 'list', names: ['Tags'] }]);
    expect(findControl(out.controls, 'Tags')).toMatchObject({ ref: 'e1' });
  });

  it('a long list is cut with its line, and its block names every option', () => {
    const countries = Array.from({ length: 30 }, (_, i) => `<option>Country ${String(i + 1)}</option>`).join('');
    const outline = outlinePage(`<body><div><select ref="e1" aria-label="Country">${countries}</select></div></body>`, { url: URL_ });
    // Slice AU — one link, cut in its label's middle: its first options and its last.
    expect(outline.text).toMatch(/^\[select: Country: Country 1 \| Country 2 \| [^\]]*…[^\]]*Country 29 \| Country 30\]\(e1\)…\(b1\)$/);
    expect(outline.blocks.get('b1')).toMatch(/Country 29 \| Country 30\]\(e1\)$/);
  });

  it('a field or a button names its own id, for a step by selector; a link\'s own id stays out', () => {
    expect(lines('<body><div><input ref="e1" id="email" type="email" aria-label="Email"><button ref="e2" id="go">Go</button>'
      + '<a ref="e3" id="up_45789" href="https://h.n/vote">vote</a><input ref="e4" id="2col:x" aria-label="Odd"></div></body>'))
      .toEqual(['[input type="email": Email](e1 #email) [button: Go](e2 #go) [link: vote](e3) [input: Odd](e4)']);
  });

  it('a link to a part of the same page names its #id; a link elsewhere does not', () => {
    expect(lines('<body><ul><li><a ref="e1" href="https://en.example.org/wiki/Ada#Early_life">Early life</a></li>'
      + '<li><a ref="e2" href="#Work">Work</a></li><li><a ref="e3" href="https://en.example.org/wiki/Byron#Life">Byron</a></li></ul></body>'))
      .toEqual(['- [link: Early life](e1 #Early_life)', '- [link: Work](e2 #Work)', '- [link: Byron](e3)']);
  });

  it('things side by side get the space the page shows, but none inside brackets; a citation reads [1]', () => {
    expect(lines('<body><table><tbody><tr><td>668 points by <a ref="e1" href="https://h.n/u">josemrb</a><span><a ref="e2" href="https://h.n/i">2 hours ago</a></span></td></tr>'
      + '<tr><td><a ref="e3" href="https://h.n/s">Sshole</a><span> (<a ref="e4" href="https://h.n/f">sshhole.com</a>)</span></td></tr></tbody></table>'
      + '<p>Lovelace<sup><a ref="e5" href="#cite_note-1"><span>[</span>1<span>]</span></a></sup></p></body>'))
      .toEqual(['| 668 points by [link: josemrb](e1) [link: 2 hours ago](e2)', '| [link: Sshole](e3) ([link: sshhole.com](e4))', 'Lovelace [link: [1]](e5 #cite_note-1)']);
  });

  it('a space the Bridge dropped from an element of its own is a space again, but none after an opening bracket or before a closing mark', () => {
    // Wikipedia writes each &nbsp; in a span of its own, and the Bridge sends it empty.
    expect(lines('<body><table><tbody><tr><th>First<span></span>appeared</th><td>January<span></span>20, 2012<span><span>;</span><span></span>14 years ago</span></td></tr></tbody></table>'
      + '<p>(<abbr title="born">b.</abbr><span></span>1894) <a ref="e1" href="https://x.org/k">Kulikovsky</a><span></span>– 1958</p>'
      + '<h2>Did you know<span></span>...</h2><p>wo<wbr>rd (<span></span>x)</p>'
      + '<p>Find sources: <a ref="e2" href="https://x.org/s">"Go"<span></span>programming language</a></p></body>'))
      .toEqual(['| First appeared | January 20, 2012; 14 years ago', '(b. 1894) [link: Kulikovsky](e1) – 1958', '## Did you know...', 'word (x)',
        'Find sources: [link: "Go" programming language](e2)']);
  });

  it('a row stays one line around a link in a center or div; a list or paragraph in a cell makes its own lines', () => {
    expect(lines('<body><table><tbody><tr><td>1.</td><td><center><a ref="e1" href="https://h.n/v"><div title="upvote"></div></a></center></td>'
      + '<td><a ref="e2" href="https://h.n/s">Story</a></td></tr>'
      + '<tr><td>Known for</td><td><ul><li>Engines</li><li>Notes</li></ul></td></tr></tbody></table></body>'))
      .toEqual(['| 1. | [link: upvote](e1) | [link: Story](e2)', 'Known for', '- Engines', '- Notes']);
  });

  it('a picture shows the start of its description, so its caption beside it is not what a cut takes; its block holds it whole', () => {
    const outline = outlinePage('<body><table><tbody><tr><td><a ref="e1" href="https://x.org/f"><img alt="Augusta Ada King, Countess of Lovelace, daguerrotype portrait circa 1843"></a>'
      + '<div><a ref="e2" href="https://x.org/d">Daguerreotype</a> of Lovelace (c. 1843)</div></td></tr></tbody></table></body>', { url: URL_ });
    // Slice T — the mark is where the description was shortened, so the caption reads as whole.
    expect(outline.text).toBe('| [link: [image: Augusta Ada King, Countess of Lovelace,…(b1)]](e1) [link: Daguerreotype](e2) of Lovelace (c. 1843)');
    // Slice Q — the line in full, and the page's text, have the description whole.
    expect(outline.blocks.get('b1')).toBe('[link: [image: Augusta Ada King, Countess of Lovelace, daguerrotype portrait circa 1843]](e1) '
      + '[link: Daguerreotype](e2) of Lovelace (c. 1843)');
    expect(outline.lines[0]!.plain).toBe('| [image: Augusta Ada King, Countess of Lovelace, daguerrotype portrait circa 1843] Daguerreotype of Lovelace (c. 1843)');
  });

  it('slice T — of two shortened descriptions the first is marked; a line also cut short ends with the mark instead', () => {
    const alt = (who: string) => `${who}, a portrait painted in oils on a wooden panel around 1840`;
    // Two shortened descriptions side by side are 100 characters: the line is not cut.
    const two = outlinePage(`<body><p><img alt="${alt('Ada')}"><img alt="${alt('Charles')}"></p></body>`, { url: URL_ });
    expect(two.text).toBe(`[image: ${alt('Ada').slice(0, 40).trimEnd()}…(b1)][image: ${alt('Charles').slice(0, 40).trimEnd()}…]`);
    expect(two.blocks.get('b1')).toBe(`[image: ${alt('Ada')}][image: ${alt('Charles')}]`);
    const long = outlinePage(`<body><p><img alt="${alt('Ada')}"> ${'word '.repeat(30)}</p></body>`, { url: URL_ });
    expect(long.text).toMatch(new RegExp(`^\\[image: ${alt('Ada').slice(0, 40).trimEnd()}…\\] word( word)*…word( word)*…\\(b1\\)$`));
  });

  it('something to act on that holds whole blocks of text is a region: its own line, then its content', () => {
    const text = 'A paragraph of the repository page. '.repeat(8);
    expect(lines(`<body><div ref="e1" tabindex="0"><h2>About</h2><p>${text}</p><a ref="e2" href="https://g.h/x">Readme</a></div></body>`)
      .slice(0, 3)).toEqual(['[region](e1)', '## About', expect.stringMatching(/^A paragraph of the repository page\. .*…\(b1\)$/)]);
    // A card with a title and a line stays one link.
    expect(lines('<body><a ref="e1" href="https://x.org/c"><div><h3>Card</h3><p>One line.</p></div></a></body>')).toEqual(['[link: Card One line.](e1)']);
  });
});

describe('D-335 slice O — a line cut at 100 characters, kept whole for block', () => {
  // Slice AU — the owner: "Cut in the middle". Task G with thinking off named the wrong authors in both
  // runs: a long quote's line, cut at its end, had lost its author.
  it('one … where the middle was, when the cut falls across a line\'s pieces', () => {
    const a = 'alpha '.repeat(12).trim();
    const b = 'omega '.repeat(12).trim();
    const outline = outlinePage(`<body><p>${a} <a ref="e2" href="https://x.org/m">middle link</a> ${b}</p></body>`, { url: URL_ });
    // 60 characters of its start, 40 of its end; the link the cut passed over is in the block.
    expect(outline.text).toBe(`${'alpha '.repeat(10).trim()}…mega ${'omega '.repeat(6).trim()}…(b1)`);
    expect(outline.blocks.get('b1')).toContain('[link: middle link](e2)');
  });

  it('a long quote keeps its author: the line\'s end shows, the quote\'s middle is cut', () => {
    const quote = 'The world as we have created it is a process of our thinking. It cannot be changed without changing our thinking.';
    const outline = outlinePage(`<body><div><span>“${quote}”</span><span>by <small>Albert Einstein</small> `
      + '<a ref="e3" href="/author/Albert-Einstein">(about)</a></span></div></body>', { url: URL_ });
    expect(outline.text).toMatch(/^“The world as we have created it is a process.*….*our thinking\.”by Albert Einstein \[link: \(about\)\]\(e3\)…\(b1\)$/);
    expect(outline.blocks.get('b1')).toBe(`“${quote}”by Albert Einstein [link: (about)](e3)`);
  });
  // Slice AU — cut in its middle: the start and the end show, so a late link and the line's last words
  // are there to act on and read.
  it('cuts in its middle at the line length, ends with its block, and keeps the whole line with its refs', () => {
    const long = `${'word '.repeat(30)}<a ref="e9" href="https://x.org/late">late link</a> and more.`;
    const outline = outlinePage(`<body><p>${long}</p><p>Short.</p></body>`, { url: URL_ });
    const [cut, short] = outline.text.split('\n');
    expect(cut).toMatch(/^word( word)*…(word )+\[link: late link\]\(e9\) and more\.…\(b1\)$/);
    // The text it shows, its links' words counted, the one `…` between: within the line length.
    expect(cut!.replace(/…\(b1\)$/, '').replace(/\[link: ([^\]]*)\]\(e\d+\)/g, '$1').length).toBeLessThanOrEqual(PAGE_OUTLINE_LINE_CHARS + 1);
    expect(short).toBe('Short.');
    expect(outline.blocks.get('b1')).toMatch(/word \[link: late link\]\(e9\) and more\.$/);
  });

  it('preformatted text is one line in the outline and keeps its line breaks in full', () => {
    const code = 'const a = 1;\nconst b = 2;\n'.repeat(6);
    const outline = outlinePage(`<body><pre>${code}</pre></body>`, { url: URL_ });
    expect(outline.text).not.toContain('\n');
    expect(outline.blocks.get('b1')).toBe(code.replace(/\n$/, ''));
  });
});

describe('D-335 slice O — the reads a server keeps: block and find', () => {
  const page = '7:DOC1';
  const read = (html: string, whole = true, truncated = false) => ({ url: URL_, title: 'Ada', html, truncated, whole });
  const LONG = `<p>${'Lovelace wrote the first program. '.repeat(5)}</p>`;

  it('a block answers its line in full; a new read of the page numbers on, so an old block names nothing', () => {
    const store = createPageReadStore();
    expect(store.outline(page, read(`<body>${LONG}</body>`)).text).toMatch(/…\(b1\)$/);
    expect(store.block(page, 'b1')).toMatchObject({ text: 'Lovelace wrote the first program. '.repeat(5).trim() });
    expect(store.outline(page, read(`<body>${LONG}</body>`)).text).toMatch(/…\(b2\)$/);
    // Slice Q — and says so, apart from a block the page never had.
    expect(store.block(page, 'b1')).toBe('replaced');
    expect(store.block(page, 'b9')).toBeUndefined();
    expect(store.block(page, 'b2')).toBeDefined();
    expect(store.block('7:OTHER', 'b2')).toBeUndefined();
  });

  it('a read of one part adds its lines and blocks to the page\'s, numbered on', () => {
    const store = createPageReadStore();
    expect(store.outline(page, read(`<body><h1>Ada</h1>${LONG}</body>`, true, true)).start).toBe(1);
    expect(store.outline(page, read(`<section><h2>Legacy</h2>${LONG}</section>`, false)).start).toBe(3);
    expect(store.block(page, 'b1')).toBeDefined();
    expect(store.block(page, 'b2')).toBeDefined();
    expect(store.find(page, 'legacy')).toMatchObject({ matches: 1, truncated: true,
      lines: expect.stringMatching(/^line 3: ## Legacy\n {2}line 4: Lovelace wrote the first program\./) });
    expect(store.part(page, 3)).toMatchObject({ from: 3, to: 4, total: 4, text: expect.stringMatching(/^## Legacy\nLovelace/) });
  });

  it('find answers every line holding the text, ignoring case, by its number and under its heading; a long one around the text', () => {
    const store = createPageReadStore();
    expect(store.find(page, 'x')).toBeUndefined();
    store.outline(page, read(`<body><h2>Life</h2><p>Born in London.</p><p>${'filler '.repeat(60)}London again.</p></body>`));
    const found = store.find(page, 'LONDON')!;
    expect(found.matches).toBe(2);
    const [first, second] = found.lines.split('\n');
    expect(first).toBe('line 2: Born in London.   (under "Life")');
    expect(second).toMatch(/^line 3: ….*London again\.…\(b1\)   \(under "Life"\)$/);
  });

  // D-335 slice P — the server reads a whole page; a model gets it in parts.
  it('a long outline comes in parts: each the lines that fit, the next from the line after, none past the end', () => {
    const store = createPageReadStore();
    expect(store.part(page, 1)).toBeUndefined();
    const rows = 3_000;
    store.outline(page, read(`<body>${Array.from({ length: rows }, (_, i) => `<p>Paragraph ${String(i + 1)} of the long page.</p>`).join('')}</body>`));
    const first = store.part(page, 1)!;
    expect(first).toMatchObject({ from: 1, total: rows, truncated: false });
    expect(first.text.length).toBeLessThanOrEqual(PAGE_OUTLINE_PART_CHARS);
    // The next line would not have fitted.
    expect(first.text.length + `\nParagraph ${String(first.to + 1)} of the long page.`.length).toBeGreaterThan(PAGE_OUTLINE_PART_CHARS);
    expect(first.text.split('\n')).toHaveLength(first.to);
    const second = store.part(page, first.to + 1)!;
    expect(second.text.startsWith(`Paragraph ${String(first.to + 1)} of the long page.`)).toBe(true);
    const last = store.part(page, rows)!;
    expect(last).toMatchObject({ from: rows, to: rows, text: `Paragraph ${String(rows)} of the long page.` });
    expect(store.part(page, rows + 1)).toMatchObject({ from: rows + 1, to: rows, text: '' });
  });

  it('find names how many more lines than it shows', () => {
    const store = createPageReadStore();
    store.outline(page, read(`<body>${'<p>row</p>'.repeat(PAGE_FIND_MAX_LINES + 5)}</body>`));
    const found = store.find(page, 'row')!;
    expect(found.matches).toBe(PAGE_FIND_MAX_LINES + 5);
    expect(found.lines.split('\n')).toHaveLength(PAGE_FIND_MAX_LINES + 1);
    expect(found.lines).toMatch(/…and 5 more lines$/);
  });

  it('a read goes after its time unused, and the least recently used goes first past the limit', () => {
    let now = 0;
    const store = createPageReadStore({ now: () => now, ttlMs: 1_000, maxPages: 2 });
    store.outline('a', read(`<body>${LONG}</body>`));
    store.outline('b', read(`<body>${LONG}</body>`));
    now = 500;
    expect(store.block('a', 'b1')).toBeDefined(); // a is now the most recent
    store.outline('c', read(`<body>${LONG}</body>`));
    expect(store.block('b', 'b1')).toBeUndefined();
    expect(store.block('a', 'b1')).toBeDefined();
    now = 2_000;
    expect(store.block('a', 'b1')).toBeUndefined();
  });
});

describe('D-335 slice Q — the page as text, contents that name lines, a heading found with its section', () => {
  const page = '7:DOC1';
  const read = (html: string, whole = true, truncated = false) => ({ url: URL_, title: 'Ada', html, truncated, whole });
  const LONG = `${'Lovelace wrote the first program for the engine. '.repeat(4)}`;

  it('the text keeps paragraphs whole and pictures described in full, links as their words, and leaves out controls', () => {
    const store = createPageReadStore();
    store.outline(page, read('<body><h1>Ada</h1>'
      + `<p>${LONG}See <a ref="e1" href="https://x.org/b">Babbage</a>.</p>`
      + '<p><img alt="Augusta Ada King, Countess of Lovelace, daguerrotype portrait circa 1843"> Daguerreotype</p>'
      + '<form><input ref="e2" aria-label="Search"><button ref="e3">Go</button></form>'
      + '<ul><li><a ref="e4" href="https://x.org/w">Women in computing</a></li></ul>'
      + '<pre>line one\n  indented</pre></body>'));
    const part = store.part(page, 1, 'text')!;
    expect(part.text.split('\n')).toEqual(['# Ada', `${LONG}See Babbage.`.replace(/\s+/g, ' ').replace(' See', ' See'),
      '[image: Augusta Ada King, Countess of Lovelace, daguerrotype portrait circa 1843] Daguerreotype',
      '- Women in computing', 'line one', '  indented']);
    // The line of controls alone is not text; the numbers are the outline's, so line 4 is skipped.
    expect(part).toMatchObject({ from: 1, to: 6, total: 6, more: false, hasMain: false });
  });

  it('on a page that marks its main content, the text is that content alone, on the outline\'s line numbers', () => {
    const store = createPageReadStore();
    store.outline(page, read('<body><nav><a ref="e1" href="https://x.org/">Home</a></nav>'
      + '<main><h1>Ada</h1><p>She wrote the notes.</p></main><footer>Privacy policy</footer></body>'));
    expect(store.part(page, 1, 'outline')!.text).toBe('[link: Home](e1)\n# Ada\nShe wrote the notes.\nPrivacy policy');
    expect(store.part(page, 1, 'text')).toMatchObject({ text: '# Ada\nShe wrote the notes.', from: 2, to: 3, total: 4, hasMain: true });
    // An article is the main content when it is the page's one.
    const article = createPageReadStore();
    article.outline(page, read('<body><div>Menu</div><article><p>The story.</p></article></body>'));
    expect(article.part(page, 1, 'text')).toMatchObject({ text: 'The story.', hasMain: true });
  });

  it('a long text comes in parts of its own size, never cut inside a line', () => {
    const store = createPageReadStore();
    const paragraph = (i: number) => `Paragraph ${String(i)}: ${'a sentence of the long article. '.repeat(6)}`;
    store.outline(page, read(`<body>${Array.from({ length: 300 }, (_, i) => `<p>${paragraph(i + 1)}</p>`).join('')}</body>`));
    const first = store.part(page, 1, 'text')!;
    expect(first.more).toBe(true);
    expect(first.text.length).toBeLessThanOrEqual(PAGE_TEXT_PART_CHARS);
    expect(first.text.split('\n').at(-1)).toBe(paragraph(first.to).trim());
    // The outline of the same lines is cut at 100 characters, in smaller parts.
    expect(store.part(page, 1, 'outline')!.to).toBeGreaterThan(first.to);
    expect(store.part(page, first.to + 1, 'text')!.text.startsWith(`Paragraph ${String(first.to + 1)}:`)).toBe(true);
  });

  it('a link to a heading on the page names the line its section starts at, for from', () => {
    const outline = outlinePage('<body><ul><li><a ref="e1" href="#Work">Work</a></li><li><a ref="e2" href="#Legacy">Legacy</a></li></ul>'
      + '<h2 id="Work"><a ref="e3" href="#Work">Work</a></h2><p>Notes.</p>'
      + '<h2><span id="Legacy">Legacy</span></h2><p>Day.</p><p>See <a ref="e4" href="#cite-1">[1]</a>.</p></body>', { url: URL_ });
    expect(outline.text.split('\n')).toEqual(['- [link: Work](e1 #Work, line 3)', '- [link: Legacy](e2 #Legacy, line 5)',
      // A heading's link to itself, and a link to anything but a heading, name no line.
      '## [link: Work](e3 #Work)', 'Notes.', '## Legacy', 'Day.', 'See [link: [1]](e4 #cite-1).']);
    // Counted among the page's kept lines: a read of one part adds after them.
    expect(outlinePage('<body><a ref="e1" href="#Work">Work</a><h2 id="Work">Work</h2></body>', { url: URL_, firstLine: 41 }).text)
      .toBe('[link: Work](e1 #Work, line 42)\n## Work');
  });

  it('a heading found includes its whole section and nested headings, with refs and no duplicate matches', () => {
    const store = createPageReadStore();
    const rows = Array.from({ length: 11 }, (_, i) => `<li>Entry ${String(i + 1)}</li>`).join('');
    store.outline(page, read(`<body><h2>See also</h2><ul>${rows}</ul><h2>Notes</h2><p>A note on see also.</p>`
      + '<h3>Short</h3><p>One.</p><h3>Next</h3></body>'));
    const found = store.find(page, 'see also')!;
    expect(found).toMatchObject({ complete: true, truncated: false });
    expect(found.lines.split('\n')).toEqual(['line 1: ## See also',
      ...Array.from({ length: 11 }, (_, i) => `  line ${String(i + 2)}: - Entry ${String(i + 1)}`),
      'line 14: A note on see also.   (under "Notes")']);
    // A section ends at the next heading of its rank or above.
    expect(store.find(page, 'Short')!.lines).toBe('line 15: ### Short\n  line 16: One.');
    const many = createPageReadStore();
    many.outline(page, read(`<body>${'<h2>Part</h2><p>Body.</p>'.repeat(PAGE_FIND_SECTIONS + 2)}</body>`));
    expect(many.find(page, 'part')).toMatchObject({ complete: false, next: 7 });
    store.outline(page, read('<main><h2>Submitted Values</h2>' + rows
      + '<h3>Choices</h3><p>cb1 cb2 rd3</p><a ref="e3" href="/saved">Open saved</a>'
      + '<h2>Other section</h2><p>Not a submitted value</p></main>'));
    const choices = store.find(page, 'Submitted Values|Choices')!;
    expect(choices).toMatchObject({ complete: true, matches: 2 });
    expect(choices.lines).toContain('cb1 cb2 rd3');
    expect(choices.lines).toContain('[link: Open saved](e3)');
    expect(choices.lines.match(/### Choices/g)).toHaveLength(1);
    expect(choices.lines).not.toContain('Other section');
  });

  it('a section that exceeds the response budget reports a continuation separately from source truncation', () => {
    const store = createPageReadStore();
    store.outline(page, read('<main><h2>Results</h2>'
      + Array.from({ length: 400 }, (_, i) => `<p>Result ${i}: ${'x'.repeat(70)}</p>`).join('') + '</main>'));
    const found = store.find(page, 'Results')!;
    expect(found).toMatchObject({ complete: false, truncated: false, next: expect.any(Number) });
    expect(found.lines.length).toBeLessThanOrEqual(PAGE_OUTLINE_PART_CHARS);
    const next = found.next!;
    expect(found.lines).not.toContain(`line ${next}:`);
    expect(store.part(page, next)!.text).toContain(`Result ${next - 2}:`);
    store.outline(page, read('<h2>Results</h2><p>One result.</p>', true, true));
    expect(store.find(page, 'Results')).toMatchObject({ complete: false, truncated: true });
    store.outline(page, read('<h2>Results</h2><p>One result.</p>'));
    store.markLoading(page, true);
    expect(store.find(page, 'Results')).toMatchObject({ complete: false, truncated: false });
  });
});

describe('D-335 slice Q — a page read again: the same lines keep their numbers, others replace them', () => {
  const page = '7:DOC1';
  const LONG = `<p>${'Lovelace wrote the first program. '.repeat(5)}</p>`;

  it('how old the kept read is, and how an action ends it', () => {
    let now = 1_000;
    const store = createPageReadStore({ now: () => now });
    expect(store.age(page)).toBeUndefined();
    store.outline(page, { url: URL_, title: 'Ada', html: `<body>${LONG}</body>`, truncated: false, whole: false });
    // A read of one part is no read of the whole page.
    expect(store.age(page)).toBeUndefined();
    store.outline(page, { url: URL_, title: 'Ada', html: `<body>${LONG}</body>`, truncated: false, whole: true });
    now = 4_000;
    expect(store.age(page)).toBe(3_000);
    store.markChanged(page);
    expect(store.age(page)).toBe(Infinity);
  });

  it('a read of the same lines keeps the kept one, its blocks and numbers; a changed one replaces it and says what it had', () => {
    let now = 0;
    const store = createPageReadStore({ now: () => now });
    store.outline(page, { url: URL_, title: 'Ada', html: `<body><h1>Ada</h1>${LONG}</body>`, truncated: false, whole: true });
    now = 20_000;
    expect(store.refresh(page, { url: URL_, title: 'Ada', html: `<body><h1>Ada</h1>${LONG}</body>`, truncated: false })).toEqual({ changed: false });
    expect(store.age(page)).toBe(0);
    expect(store.block(page, 'b1')).toMatchObject({ text: expect.stringMatching(/^Lovelace/) });
    const changed = store.refresh(page, { url: URL_, title: 'Ada', html: `<body><p>New at the top.</p><h1>Ada</h1>${LONG}</body>`, truncated: false });
    expect(changed.changed).toBe(true);
    expect(changed.previous?.map((line) => line.text)).toEqual(['# Ada', expect.stringMatching(/^Lovelace/)]);
    expect(store.block(page, 'b1')).toBe('replaced');
    // Where a line read before is now: the nearest that reads the same.
    expect(store.locate(page, '# Ada', 1)).toBe(2);
    expect(store.locate(page, 'gone', 1)).toBeUndefined();
  });
});


describe('D-335 slice R — frames in the outline', () => {
  it('a frame from another site names the page it is, or says it cannot be read; a frame from this site is read in place', () => {
    const outline = outlinePage('<body><p>Top.</p>'
      + '<iframe src="https://forms.example/f?id=1" title="Contact form" page="7:DOC9"></iframe>'
      + '<iframe src="https://pay.example/card" title="Card" unread=""></iframe>'
      + '<iframe src="https://en.example.org/wiki/Note" title="Note"><body><p>Inside the frame.</p>'
      + '<button ref="e4" type="button">Inner</button></body></iframe></body>', { url: URL_ });
    expect(outline.text.split('\n')).toEqual(['Top.',
      '(Frame "Contact form" from forms.example: its content is a page of its own, 7:DOC9; inspect that page to read it or act in it.)',
      '(Frame "Card" from pay.example: the Browser Bridge cannot read it.)',
      'Inside the frame.', '[button type="button": Inner](e4)']);
    // A note is never cut, and the page's text says it too.
    expect(outline.lines[1]!.plain).toBe(outline.lines[1]!.text);
    expect(outline.lines[1]!.block).toBeUndefined();
  });

  it('an editor\'s frame body is a text editor, however much it holds, never a region', () => {
    const draft = 'A long draft of the message that goes on and on. '.repeat(8);
    const [first] = outlinePage(`<body><iframe title="Editor"><body ref="e3" contenteditable="true"><p>${draft}</p><p>More.</p></body></iframe></body>`,
      { url: URL_ }).text.split('\n');
    expect(first).toMatch(/^\[body contenteditable="true": "A long draft of the message.*\]\(e3\)…\(b1\)$/);
  });
});

// D-335 slice U — a dialog that blocks the page: the outline's first line says it is open and where.
describe('D-335 slice U — an open dialog', () => {
  const SHOP = '<body><h1>Shop</h1><p>Some text.</p><button ref="e1">Buy</button>'
    + '<dialog modal><h2>Cookie choices</h2><p>We use cookies.</p><button ref="e2">Accept</button></dialog></body>';

  it('a dialog shown as a modal one: the first line names it and its line, and every number after it holds', () => {
    const outline = outlinePage(SHOP);
    expect(outline.text.split('\n')).toEqual([
      '(A dialog is open at line 5: “Cookie choices”. Answer it or close it first: what is behind it cannot be used until then.)',
      '# Shop', 'Some text.', '[button: Buy](e1)', '## Cookie choices', 'We use cookies.', '[button: Accept](e2)']);
    // The page's text has it too, and it counts as main content.
    expect(outline.lines[0]).toMatchObject({ main: true, block: undefined });
  });

  it('a box marked aria-modal, by its label; none marked, no line', () => {
    expect(outlinePage('<body><div role="dialog" aria-modal="true" aria-label="Sign up"><p>Join us</p></div><p>After.</p></body>')
      .text.split('\n')[0]).toBe('(A dialog is open at line 2: “Sign up”. Answer it or close it first: what is behind it cannot '
        + 'be used until then.)');
    expect(outlinePage('<body><dialog open><p>Not modal.</p></dialog><p>Page.</p></body>').text.split('\n')[0]).toBe('Not modal.');
  });

  it('a read of one part says nothing of it, leaving it to the read of the whole page', () => {
    expect(outlinePage(SHOP, { firstLine: 40 }).text.split('\n')[0]).toBe('# Shop');
  });
  // 2026-11-22 (the owner: "build the 'show the blocker' version") — what covers the page though the page marks it
  // hidden, which the Bridge marks `data-recued-cover`: the first line says so, and what is behind it is not chosen
  // by name, as behind a dialog.
  it('a cover the Bridge marks: the first line says something covers the page; what is behind it is blocked', () => {
    const outline = outlinePage('<body><main><a ref="e1" href="/a">Story</a></main><div data-recued-cover><p>Advertisement</p>'
      + '<p>You can close this ad in 5 seconds.</p><button ref="e2">Close</button></div></body>');
    expect(outline.text.split('\n')).toEqual([`(Something covers this page at line 3: “Advertisement”. ${PAGE_COVER_NOTE_TAIL})`,
      '[link: Story](e1)', 'Advertisement', 'You can close this ad in 5 seconds.', '[button: Close](e2)']);
    expect(outline.controls.find(control => control.ref === 'e1')?.blocked).toBe(true);
    expect(outline.controls.find(control => control.ref === 'e2')?.blocked).toBeUndefined();
    // A page's own attribute of that name never reaches the outline: the Bridge writes only the attributes it keeps.
    expect(PAGE_COVER_NOTE_TAIL).toContain('wait if it says when');
  });

  // 2026-11-22 (the owner: "do the two followups") — under Google's vignette ad its own note names the cover, with how
  // to close it (dom-adapter.ts): the outline says nothing of it, and what the cover shows starts the outline.
  it('a cover under Google\'s vignette ad: no line for it, its own words first', () => {
    const html = '<body><div data-recued-cover><p>Advertisement</p></div></body>';
    expect(outlinePage(html, { url: 'https://x.example/a#google_vignette' }).text.split('\n')).toEqual(['Advertisement']);
    expect(outlinePage(html, { url: 'https://x.example/a#offer' }).text.split('\n')[0]).toMatch(/^\(Something covers this page/);
  });
});

describe('D-335 slice Y — an element named by its text, found among the controls the outline names', () => {
  const PAGE = '<body><main>'
    + '<form><label for="q">Search for</label><input ref="e1" id="q" type="search" placeholder="Search Wikipedia" '
    + 'aria-label="Search Wikipedia"><button ref="e2">Search</button></form>'
    + '<p><a ref="e3" href="https://x.org/login">Sign in</a> or <a ref="e4" href="https://x.org/new">Create account</a></p>'
    + '<div><label for="email">Email *</label><input ref="e5" id="email" type="email"></div>'
    + '<div><input ref="e6" type="checkbox" aria-label="Remember me"></div>'
    + '<div><button ref="e7">Save</button><button ref="e8">Save</button></div>'
    + '<div><a ref="e9" href="https://x.org/help">Help with signing in</a></div>'
    + '<div><input ref="e10" type="submit" value="Log in"><span ref="e11" role="tab" tabindex="0">Settings</span>'
    + '<a ref="e12" href="https://x.org/me" title="Your profile"><img alt="Ada Lovelace" src="a.png"></a></div>'
    + '</main></body>';
  const controls = () => outlinePage(PAGE, { url: URL_ }).controls;
  const refOf = (text: string, role?: string) => {
    const match = findControl(controls(), text, role);
    return 'ref' in match ? match.ref : match;
  };

  it('every control, in page order, with its kind and every name the page gives it', () => {
    expect(controls()).toMatchObject([
      { ref: 'e1', kind: 'search box', names: ['Search Wikipedia', 'Search for'], field: 'id:q' },
      { ref: 'e2', kind: 'button', names: ['Search'] },
      // D-345 slice E — a link with the address it leads to.
      { ref: 'e3', kind: 'link', names: ['Sign in'], href: 'https://x.org/login' },
      { ref: 'e4', kind: 'link', names: ['Create account'], href: 'https://x.org/new' },
      { ref: 'e5', kind: 'email field', names: ['Email *'], field: 'id:email' },
      { ref: 'e6', kind: 'checkbox', names: ['Remember me'] },
      { ref: 'e7', kind: 'button', names: ['Save'] },
      { ref: 'e8', kind: 'button', names: ['Save'] },
      { ref: 'e9', kind: 'link', names: ['Help with signing in'], href: 'https://x.org/help' },
      { ref: 'e10', kind: 'button', names: ['Log in'] },
      { ref: 'e11', kind: 'tab', names: ['Settings'] },
      { ref: 'e12', kind: 'link', names: ['Your profile', '[image: Ada Lovelace]', 'Ada Lovelace'], href: 'https://x.org/me' },
    ].map(control => ({ ...control, landmark: 'main' })));
  });

  it('by any of its names, ignoring case, spacing, quotes, and a label\'s colon or star', () => {
    expect(refOf('Search Wikipedia')).toBe('e1');
    expect(refOf('  search   WIKIPEDIA ')).toBe('e1');
    expect(refOf('Search for')).toBe('e1');
    expect(refOf('“Sign in”')).toBe('e3');
    expect(refOf('Email')).toBe('e5');
    expect(refOf('email:')).toBe('e5');
    expect(refOf('Log in')).toBe('e10');
    expect(refOf('Your profile')).toBe('e12');
    expect(refOf('Ada Lovelace')).toBe('e12');
  });

  it('a name that is the text before one that holds it as whole words; a role narrows it to its kinds', () => {
    // "Search" is the button's whole name, and only part of the box's.
    expect(refOf('Search')).toBe('e2');
    // A field: any kind a person types into.
    expect(refOf('Search', 'field')).toBe('e1');
    expect(refOf('Sign in', 'link')).toBe('e3');
    expect(refOf('Remember me', 'checkbox')).toBe('e6');
    expect(refOf('Settings', 'tab')).toBe('e11');
    // A role it does not list names the kinds that hold it.
    expect(refOf('Email', 'email')).toBe('e5');
    // No whole words, no match: "Sign" is not in "signing".
    expect(refOf('Help with signing')).toBe('e9');
    expect(refOf('Sign', 'link')).toBe('e3');
  });

  it('a field inside a label is named by the label\'s own words, and by the name the outline shows it by', () => {
    const wrapped = outlinePage('<body><form><label>Email <input ref="e1" id="email" name="email" type="email"></label>'
      + '<label>Country <select ref="e2" name="country"><option>France</option><option>Japan</option></select></label>'
      + '<input ref="e3" name="passwd" type="password"></form></body>', { url: URL_ });
    // The surrounding label stays; a fallback name equal to #email is redundant.
    expect(wrapped.text.split('\n')[0]).toBe('Email [input type="email"](e1 #email) Country [select: France | Japan](e2) '
      + '[input type="password": passwd](e3)');
    expect(wrapped.controls).toMatchObject([
      { ref: 'e1', kind: 'email field', names: ['Email', 'email'], field: 'name:email' },
      // A list's options are not words of its label.
      { ref: 'e2', kind: 'list', names: ['Country', 'country'], field: 'name:country' },
      { ref: 'e3', kind: 'password field', names: ['passwd'], field: 'name:passwd' },
    ]);
    const match = findControl(wrapped.controls, 'Email');
    expect('ref' in match && match.ref).toBe('e1');
  });

  it('several at the best level are several; none, with the controls that share a word with it', () => {
    expect(refOf('Save')).toMatchObject({ several: [{ ref: 'e7', kind: 'button', names: ['Save'], landmark: 'main' }, { ref: 'e8', kind: 'button', names: ['Save'], landmark: 'main' }] });
    expect(refOf('Sign up')).toMatchObject({ none: [{ ref: 'e3', kind: 'link', names: ['Sign in'], href: 'https://x.org/login', landmark: 'main' }] });
    expect(refOf('Settings', 'button')).toEqual({ none: [] });
    expect(controlsSaid(controls())).toBe('the search box “Search Wikipedia” (e1), the button “Search” (e2), the link “Sign in” (e3), '
      + 'the link “Create account” (e4), the email field “Email *” (e5), the checkbox “Remember me” (e6), and 6 more');
  });

  // D-347 follow-up (2026-11-08) — many sites show a pager above a list and below it.
  it('of several called the same, links to one address are one, the first; a place given takes the one there', () => {
    const pager = outlinePage('<body><nav><a ref="e1" href="/page/3/">Next</a> <a ref="e2" href="#top">Top</a></nav>'
      + '<ol><li><a ref="e3" href="/q/1">Read</a></li><li><a ref="e4" href="/q/2">Read</a></li></ol>'
      + '<nav><a ref="e5" href="/page/3/">Next</a> <a ref="e6" href="#top">Top</a></nav>'
      + '<div><button ref="e7">More</button><button ref="e8">More</button></div></body>', { url: URL_ }).controls;
    // Both "Next" lead to page 3: following either is the same.
    expect(findControl(pager, 'Next')).toMatchObject({ ref: 'e1' });
    expect(findControl(pager, 'next', 'link')).toMatchObject({ ref: 'e1' });
    // Links to different addresses, links to a part of the page (a script may handle each its own way), and
    // buttons stay several.
    expect(findControl(pager, 'Read')).toMatchObject({ several: [{ ref: 'e3' }, { ref: 'e4' }] });
    expect(findControl(pager, 'Top')).toMatchObject({ several: [{ ref: 'e2' }, { ref: 'e6' }] });
    expect(findControl(pager, 'More')).toMatchObject({ several: [{ ref: 'e7' }, { ref: 'e8' }] });
    // A ref found again on a new page: the one in its place on the page it was read on, when there are as many.
    expect(findControl(pager, 'More', 'button', { at: 1, of: 2 })).toMatchObject({ ref: 'e8' });
    expect(findControl(pager, 'Read', 'link', { at: 1, of: 2 })).toMatchObject({ ref: 'e4' });
    expect(findControl(pager, 'Next', 'link', { at: 1, of: 2 })).toMatchObject({ ref: 'e5' });
    expect(findControl(pager, 'Next', 'link', { at: 1, of: 3 })).toMatchObject({ ref: 'e1' });
    expect(findControl(pager, 'More', 'button', { at: 1, of: 3 })).toMatchObject({ several: [{ ref: 'e7' }, { ref: 'e8' }] });
    // Wikipedia's search pager, above its results and below them: icon links shown as buttons, named by their label.
    const icons = outlinePage(['e1', 'e2'].map((ref) => `<div><a ref="${ref}" role="button" aria-label="Next page" `
      + 'title="Next page" href="/w/index.php?title=Special:Search&amp;limit=20&amp;offset=20"><span></span></a></div>').join(''),
    { url: URL_ }).controls;
    expect(icons).toMatchObject([{ kind: 'link', names: ['Next page'] }, { kind: 'link', names: ['Next page'] }]);
    expect(findControl(icons, 'Next page')).toMatchObject({ ref: 'e1' });
    // And as the words of their name, as the steps help writes it.
    expect(findControl(icons, 'Next')).toMatchObject({ ref: 'e1' });
  });

  it('the kept read answers its controls while nothing has acted on the page, and says whether it is whole and cut short', () => {
    const store = createPageReadStore();
    const page = '7:DOC1';
    expect(store.controls(page)).toBeUndefined();
    store.outline(page, { url: URL_, title: 'Ada', html: PAGE, truncated: true, whole: true });
    expect(store.controls(page)).toMatchObject({ whole: true, truncated: true });
    expect(store.controls(page)!.controls.map((control) => control.ref)).toHaveLength(12);
    store.markChanged(page);
    expect(store.controls(page)).toBeUndefined();
    const part = createPageReadStore();
    part.outline(page, { url: URL_, title: 'Ada', html: PAGE, truncated: false, whole: false });
    expect(part.controls(page)).toMatchObject({ whole: false, truncated: false });
  });

  it('the kept read answers a control\'s place among those of its kind called as it is, after an action too', () => {
    const store = createPageReadStore();
    const page = '7:DOC1';
    expect(store.positionOf(page, 'e8')).toBeUndefined();
    store.outline(page, { url: URL_, title: 'Ada', html: PAGE, truncated: false, whole: true });
    expect(store.positionOf(page, 'e7')).toEqual({ at: 0, of: 2 });
    expect(store.positionOf(page, 'e8')).toEqual({ at: 1, of: 2 });
    // The button "Search", and not the search box whose name holds it.
    expect(store.positionOf(page, 'e2')).toEqual({ at: 0, of: 1 });
    store.markChanged(page);
    expect(store.controls(page)).toBeUndefined();
    expect(store.positionOf(page, 'e8')).toEqual({ at: 1, of: 2 });
    expect(store.positionOf(page, 'e99')).toBeUndefined();
  });
});
