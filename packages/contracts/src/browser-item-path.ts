const blocked = new Set(['__proto__', 'constructor', 'prototype']);

/** A property path, never JavaScript. Quoted keys are exact, including dots and
 * spaces. Numeric array indexes retain the existing dotted form. */
export const parseBrowserItemPath = (text: string): string[] | undefined => {
  if (text.length > 1_024 || !text.startsWith('item')) return undefined;
  const parts: string[] = [];
  let at = 4;
  while (at < text.length) {
    let key: string;
    if (text[at] === '.') {
      const match = /^\.([A-Za-z0-9_]+)/.exec(text.slice(at));
      if (!match) return undefined;
      key = match[1]!; at += match[0].length;
    } else if (text[at] === '[' && ['"', "'"].includes(text[at + 1] ?? '')) {
      const quote = text[++at]!; at++;
      let raw = '', closed = false;
      while (at < text.length) {
        const char = text[at++]!;
        if (char === quote) { closed = true; break; }
        if (char === '\\') {
          const escaped = text[at++];
          if (escaped !== quote && escaped !== '\\') return undefined;
          raw += escaped;
        } else raw += char;
      }
      if (!closed || text[at++] !== ']') return undefined;
      key = raw;
    } else return undefined;
    if (!key.length || key.length > 160 || /[\u0000-\u001f]/.test(key) || blocked.has(key) || parts.length >= 32) return undefined;
    parts.push(key);
  }
  return parts;
};

export interface BrowserItemReference { start: number; end: number; path: string[]; quoted: boolean }
export const browserItemReferences = (text: string): BrowserItemReference[] | undefined => {
  const refs: BrowserItemReference[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf('{{', from);
    if (start < 0) return text.slice(from).includes('}}') ? undefined : refs;
    if (text.slice(from, start).includes('}}')) return undefined;
    const close = text.indexOf('}}', start + 2);
    if (close < 0) return undefined;
    const content = text.slice(start + 2, close).trim();
    const path = parseBrowserItemPath(content);
    if (!path || refs.length >= 64) return undefined;
    refs.push({ start, end: close + 2, path, quoted: content.includes('[') });
    from = close + 2;
  }
  return refs;
};
