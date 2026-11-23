import { BROWSER_ACT_MAX_STEPS, BROWSER_ACT_MAX_WAIT_SECONDS, BROWSER_ACT_READ_MAX_CHARS } from './browser-act.js';
import { BROWSER_COLLECT_MAX_ITEMS, BROWSER_COLLECT_MAX_PAGES, BROWSER_COLLECT_MAX_SECONDS } from './browser-collect.js';
import { BROWSER_DATA_MAX_OPERATIONS, BROWSER_DATA_TRANSFORMS } from './browser-data.js';
import { OPS } from './conditions.js';

/** Compact common authoring surface. The strict runtime parsers remain the
 * authority for operation-specific combinations; advanced parameters are open
 * and discoverable via data.describe without repeating every transform schema. */
export const BROWSER_ACT_STEPS_ARGUMENT_SCHEMA = {
  type: 'array', minItems: 1, maxItems: BROWSER_ACT_MAX_STEPS,
  items: { type: 'object', 'x-recued-browser-data': true, additionalProperties: true, allOf: [{
    if: { properties: { do: { const: 'type' } }, required: ['do'] },
    then: { allOf: [
      { oneOf: [{ required: ['ref'] }, { required: ['selector'] }, { required: ['text'] }] },
      { oneOf: [{ required: ['value'] }, { required: ['secret'] }] },
    ] },
  }, {
    if: { properties: { do: { const: 'collect' } }, required: ['do'] },
    then: { required: ['items', 'fields', 'max_pages'] },
  }, {
    if: { properties: { do: { const: 'data' } }, required: ['do'] },
    then: { not: { required: ['id'] } },
  }], properties: {
    do: { type: 'string', enum: ['type', 'click', 'press', 'submit', 'wait', 'read', 'collect', 'data', 'table', 'ask', 'scroll', 'go', 'back', 'reload', 'close', 'hover', 'download', 'upload'],
      description: `Choose an operation supported by the observed target. type requires a captured editable target; links/buttons use click. For an unfamiliar destination, batch its observed click and a read. collect requires max_pages (integer 1-${BROWSER_COLLECT_MAX_PAGES}); max_items is integer 1-${BROWSER_COLLECT_MAX_ITEMS}. Larger limits refuse the whole batch before actions.` },
    page: { type: 'string', description: 'Each new browser batch needs a starting page: supply the call page or the first step page/url. Later steps in that batch may omit page to follow its current tab, including a read after navigation. Exact returned document handle for observed refs; copy page/ref together. A URL does not bind refs after navigation. Do not combine with url.' },
    url: { type: 'string', description: 'HTTP/S address of this step\'s tab; use page for a handle. Do not combine with page.' },
    ref: { type: 'string', pattern: '^e[1-9]\\d{0,8}$', description: 'Observed outline ref for an action, table or scoped read. [button: Save](e13) means {"do":"click","ref":"e13"}; e13 belongs in ref, not selector. Refs name one document: page must be its returned handle after navigation. Wait does not take ref.' },
    selector: { type: 'string', description: 'Observed CSS selector for an action, table, wait or scoped read. A read selects one matching root, not all matches. matched_count counts matches; selected_index is 1-based DOM order: 1=first, 2=second. Complete covers only that root subtree, not another ordinal or the full page. Outline refs such as e13 belong in ref.' },
    role: { type: 'string', description: 'Element action: optionally narrow an observed text label by its role, such as button or link.' },
    value: { type: 'string', description: 'Type: replacement text, username/email or an observed native select option; checkbox uses "true"/"false", radio "true". Password/PIN/sign-in code use secret instead; omit value for those steps.' },
    key: { type: 'string', description: 'Press: key such as Enter, Escape or Tab, with supported modifiers when needed.' },
    secret: { type: 'string', enum: ['password', 'PIN', 'sign-in code'], description: 'Type: supported site-bound secret entry. Name the observed field by ref/selector/text and omit value. The server uses a saved secret or asks the owner outside the model; it types the answer into that field.' },
    submit: { type: 'boolean', description: 'Type: true sends the field\'s form after filling. Submit only when requested.' },
    pick: { type: 'string', description: 'Type: exact observed suggestion label to choose after typing.' },
    address: { type: 'string', description: 'Go: destination URL. Download: observed file URL. url/page select the tab, not the destination.' },
    file: { type: 'string', pattern: '^file:[0-9a-f]{32}$', description: 'Upload: copy the entire returned file: reference with exactly 32 lowercase hex digits. Attachment references name stored files; use their exact canonical value.' },
    question: { type: 'string', description: 'Ask: page question; invokes a separate AI. Use read/table for direct extraction.' },
    to: { type: 'string', enum: ['next', 'previous', 'top', 'bottom'], description: 'Scroll direction; next is default. This is scrolling, not pagination.' },
    screen: { type: 'integer', minimum: 1, description: 'Scroll: numbered screen from the top, instead of to.' },
    success_when: { type: 'object', additionalProperties: false, properties: {
      page_changes: { type: 'boolean', description: 'Document/address navigation, not an in-place DOM update. Same-URL pagination needs wait/read or an observed result condition.' },
      shows: { type: 'string', description: 'Observed CSS selector of an element that must become visible, never its visible label. "Login" selects a <login> tag. Use text for visible text within the selected element.' },
      gone: { type: 'string', description: 'Observed CSS selector of an element that must cease to be visible; never a visible label.' },
      text: { type: 'string', description: 'Visible text required within the shows element. With no shows selector, checks the page body. Never interpreted as CSS.' }, url_includes: { type: 'string' },
      seconds: { type: 'number', exclusiveMinimum: 0, maximum: BROWSER_ACT_MAX_WAIT_SECONDS },
    }, description: 'Optional observed result check; omit a guessed destination condition and read its page instead. A passed check proves only its predicate, not application acceptance. Wait accepts one equivalent shows/gone/url_includes condition. Conflicting/compound wait checks are refused. page_changes belongs on the preceding action.' },
    fail_when: { type: 'object', additionalProperties: false, properties: {
      shows: { type: 'string', description: 'Observed CSS selector of an element whose appearance means failure; never its visible label.' },
      text: { type: 'string', description: 'Visible text indicating failure within the shows element, or the page body when shows is omitted. Never interpreted as CSS.' }, url_includes: { type: 'string' },
      seconds: { type: 'number', exclusiveMinimum: 0, maximum: BROWSER_ACT_MAX_WAIT_SECONDS },
    }, description: 'Action/wait: observed failure condition; stops when reached.' },
    then_read: { type: 'string', description: 'Action: observed CSS region to wait for and read afterward. For an unfamiliar result page, append a full read step instead.' },
    then_read_form: { type: 'string', enum: ['outline', 'text'], description: 'then_read presentation; requires then_read. The returned region is limited to 4,000 characters.' },
    until: { type: 'string', enum: ['shown', 'gone', 'ready'], description: 'Wait with selector: shown (default) or gone. ready waits only for observed document readiness, without selector/text/url_includes; it does not establish delayed AJAX content or application success. A plain wait of seconds waits for the page to change and hold still.' },
    seconds: { type: 'number', exclusiveMinimum: 0, maximum: BROWSER_ACT_MAX_WAIT_SECONDS, description: 'Wait: at most these seconds. A plain wait ends once the page has changed since it was last read and holds still.' },
    text: { type: 'string', description: 'Wait with selector: expected text; actions: observed control label.' },
    url_includes: { type: 'string', description: 'Wait: expected URL fragment; cannot combine with selector.' },
    form: { type: 'string', enum: ['outline', 'text'], description: 'Read presentation only. entries belongs in data_format, never form.' },
    find: { type: 'string', minLength: 1, maxLength: 200, description: 'Read: heading/text search; CSS find requires form:"text". ref or selector instead scopes outline/text to one observed element. Omit find with ref/selector or from.' },
    from: { type: 'integer', minimum: 1, description: 'Read: returned continuation line; cannot combine with find.' },
    chars: { type: 'integer', minimum: 1, maximum: BROWSER_ACT_READ_MAX_CHARS, description: 'Read: maximum characters in this part.' },
    items: { type: 'string', description: 'Collect: required observed CSS selector for repeated records. For an HTML table or ARIA grid, prefer table.' },
    fields: { type: 'object', minProperties: 1, additionalProperties: { anyOf: [{ type: 'string' }, {
      type: 'object', required: ['selector'], additionalProperties: false, properties: {
        selector: { type: 'string' }, attribute: { type: 'string', enum: ['href', 'src', 'title', 'alt', 'value', 'aria-label', 'name', 'id'] },
        many: { type: 'boolean' }, required: { type: 'boolean' },
      },
    }] }, description: 'Collect: field names map to observed selectors within each item. Fields are required by default; many changes cardinality only.' },
    next: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, selector: { type: 'string' } },
      description: 'Collect: exactly one observed text or selector for Next. Automatic traversal follows same-origin links that change URL. Same-URL controls return pagination_recovery; use a checked click/table batch.' },
    dedupe_by: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Collect: declared fields identifying duplicates. Conflicting values stop collection.' },
    where: { type: 'object', required: ['field', 'equals'], additionalProperties: false, properties: { field: { type: 'string' }, equals: { type: 'string' } },
      description: 'Collect: exact text or array membership filter on a declared field.' },
    max_pages: { type: 'integer', enum: Array.from({ length: BROWSER_COLLECT_MAX_PAGES }, (_, i) => i + 1), minimum: 1, maximum: BROWSER_COLLECT_MAX_PAGES, description: `Collect: required traversal cap 1-${BROWSER_COLLECT_MAX_PAGES}, not the site's displayed page count. Stops earlier when Next ends. 1 reads this page only; lower the cap for a requested page subset. Larger values refuse the whole batch. Only data may follow collect.` },
    max_items: { type: 'integer', minimum: 1, maximum: BROWSER_COLLECT_MAX_ITEMS, default: 200, description: `Collect: integer 1-${BROWSER_COLLECT_MAX_ITEMS}; counts source items including duplicates. Default 200. Larger values refuse the whole batch.` },
    max_seconds: { type: 'number', minimum: 1, maximum: BROWSER_COLLECT_MAX_SECONDS, default: 60 },
    source: { type: 'string', description: 'Data: use "latest" after a fresh read/table/collect in this call, or an exact retained data_ref for pinned data-only reuse. Omission also uses latest in this call. Explicit refs never auto-upgrade.' },
    data_format: { type: 'string', enum: ['lines', 'entries'], description: 'Read retained data: entries = semantic list items/definition terms inside the selected scope, not one row per CSS match or prose card; lines = text lines. Use {do:"read",data_format:"entries"}, never form:"entries". ref/selector scopes the retained capture; find/from only change its displayed part.' },
    select: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' }, description: 'Data: columns of the final result, e.g. title and price. Omit to return it whole.' },
    return: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' }, description: 'Data: named operation IDs for branches, not column names. Usually omit; select chooses columns.' },
    describe: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'Data: [] lists transforms, or name up to six to fetch schemas. No pipeline/source needed.' },
    pipeline: { type: 'array', minItems: 1, maxItems: BROWSER_DATA_MAX_OPERATIONS,
      description: 'One pipeline per data step. Operation IDs and $id references exist only inside that pipeline; data steps have no id. For separate snapshots use explicit {data_ref} inputs with table.concat, never cross-step $id references.',
      items: { type: 'object', required: ['transform'], additionalProperties: true, allOf: [{
        if: { anyOf: [
          { properties: { transform: { const: 'sort' } }, required: ['transform'] },
          { properties: { transform: { const: 'map' } }, required: ['transform', 'expression'] },
        ] },
        then: { not: { anyOf: [{ required: ['input'] }, { required: ['object'] }] } },
      }, {
        if: { properties: { transform: { const: 'project' } }, required: ['transform'] },
        then: { not: { anyOf: [{ required: ['input'] }, { required: ['array'] }] } },
      }],
      properties: {
        transform: { type: 'string', enum: BROWSER_DATA_TRANSFORMS },
        id: { type: 'string', description: 'Name this operation for later $id references or return in the SAME pipeline only. Put id here, never on the data step. $input is this pipeline\'s input.' },
        field: { type: 'string' }, operator: { type: 'string', enum: [...OPS, 'count', 'sum', 'avg', 'min', 'max', 'first', 'last'], description: 'filter comparison or reduce aggregation.' },
        value: { description: 'Filter comparison value; contains tests exact array membership or a text substring.' },
        array: { description: 'Input override for array transforms such as filter/map/sort: $input or an earlier $id. count uses input; project uses object. Normally automatic.' },
        input: { description: 'count input override: $input or an earlier $id. Normally automatic; return retained rows and their count together when requested.' },
        object: { description: 'project input override for one object, not an array of rows. Use map to reshape array rows. Normally automatic.' },
        expression: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'array', items: {} }, { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
          description: 'map/project: actual JSON object preserves types, e.g. {"name":"{{item.name}}"}. Exact quoted keys work: {{item["Student Name"]}}. Array indexes use dots: {{item.parts.0}}. Arithmetic outside braces: "{{item.amount}} / 100". No JavaScript or prototype access. Return/select existing fields when sufficient.' },
        apply: { type: 'string', description: 'map: scalar transform such as replace (literal, never regex), split, trim or to_number; requires output_field. Collection transforms belong in their own pipeline step. Use describe for parameters.' },
        output_field: { type: 'string' }, pattern: { type: 'string' }, replacement: { type: 'string' },
        direction: { type: 'string', enum: ['asc', 'desc'] }, start: { type: 'integer' }, end: { type: 'integer' },
        value_type: { type: 'string', enum: ['number'], description: 'sort/min_by/max_by/sum: require a valid numeric comparison. Preserve raw row values; format declares parsing.' },
        format: { type: 'object', additionalProperties: false, required: ['style'], properties: {
          style: { enum: ['number', 'currency', 'percent'] }, unit: { type: 'string', description: 'currency: exact observed prefix, e.g. £ or USD' },
          decimal: { enum: ['.', ','] }, group: { enum: ['.', ',', ' '] },
        }, description: 'to_number (including map.apply) and value_type:number: explicit format; no blanket character stripping. Percent strings become fractions. Raw values remain in the source capture.' },
        on_invalid: { type: 'string', enum: ['error', 'null', 'exclude'], description: 'Default error. to_number may explicitly return null with diagnostics; typed numeric ranking may explicitly exclude invalid rows and reports their count. An all-invalid ranking fails.' },
        aggregate: { type: 'object', description: 'group_by: output columns map to {operator:count/sum/avg/min/max/first/last,field?}. first/last return the observed first/last field value, or whole row when field is omitted. E.g. {count:{operator:"count"},last:{operator:"last",field:"text"}}. Group entries by group (heading path) rather than parsing their text.' },
      } } },
  } },
} as const;
