/** Shared conservative proper-name extractor for Latin-script locales. */

import type { RawSlot } from '../extract.js';

const NAME_ATOM = String.raw`\p{Lu}[\p{Ll}\p{M}]+(?:[-'’]\p{Lu}[\p{Ll}\p{M}]+)*`;
const PARTICLE = String.raw`(?:al|bin|da|das|de|del|della|der|di|do|dos|du|la|le|van|von|zu|zur)`;
const NAME_RUN_RE = new RegExp(
  String.raw`(?<![\p{L}\p{M}'’\-])${NAME_ATOM}(?:\s+(?:${PARTICLE}\s+)*${NAME_ATOM})+(?![\p{L}\p{M}\-]|['’](?![sS]\b))`,
  'gu',
);

/** A small set of read-request heads may fuse to the following capitalised
 * name. Trim just that head so code-switched forms such as `Dime María
 * García's email` preserve the actual contact span. The downstream anchored
 * read grammar + exact-contact lookup remain the certainty checks. */
const TRIM_READ_HEADS = new Set([
  'tell', 'show', 'zeige', 'sag', 'dime', 'muestra', 'montre', 'mostre',
]);

/** German capitalises attribute nouns. In the strict `... <noun> von <Name>`
 * read grammars that makes the noun + particle look like one long proper-name
 * run. Strip only this closed grammar prefix so the actual contact survives;
 * arbitrary capitalised prose remains untouched. */
const GERMAN_ATTRIBUTE_PREFIX_RE =
  /^(?:Telefonnummern?|Berufsbezeichnung(?:en)?|Arbeitgeber|Geburtstage)\s+von\s+/iu;

/** Cross-language command heads are global because a mixed-language prompt
 * may run more than one bundle. Write-like/other imperative heads drop the
 * whole capitalised run; a missed real name only falls through downstream. */
const DROP_HEADS = new Set([
  // English
  'find', 'email', 'show', 'send', 'get', 'fetch', 'compare', 'status',
  'forward', 'reply', 'open', 'add', 'update', 'delete', 'list', 'search',
  'tell', 'pull', 'draft', 'write', 'summarize', 'summarise', 'generate',
  'schedule', 'remind', 'cancel', 'confirm', 'prepare', 'review', 'check',
  'remove', 'archive', 'export', 'import', 'sort', 'filter',
  // German
  'finde', 'zeige', 'sende', 'suche', 'ändere', 'aendere', 'aktualisiere',
  'lösche', 'loesche', 'entferne', 'plane',
  // Spanish
  'busca', 'muestra', 'envía', 'envia', 'cambia', 'actualiza', 'elimina',
  'borra', 'programa',
  // French
  'cherche', 'trouve', 'montre', 'envoie', 'change', 'modifie', 'supprime',
  'planifie',
  // Portuguese
  'busque', 'procure', 'mostre', 'envie', 'altere', 'atualize', 'exclua',
  'apague', 'agende',
]);

const SUFFIXES = new Set([
  'jr', 'sr', 'filho', 'neto', 'junior', 'júnior',
  // German capitalises common nouns, so the strict birthday form
  // `Wann hat <Name> Geburtstag?` otherwise fuses the intent noun into the
  // proper-name run. It is grammar, never part of the contact reference.
  'geburtstag',
]);

export const extractLatinNames = (text: string): ReadonlyArray<RawSlot> => {
  if (text.length === 0) return [];
  const slots: RawSlot[] = [];
  NAME_RUN_RE.lastIndex = 0;
  let match = NAME_RUN_RE.exec(text);
  while (match !== null) {
    let raw = match[0];
    let position = match.index;
    const germanAttributePrefix = GERMAN_ATTRIBUTE_PREFIX_RE.exec(raw)?.[0];
    if (germanAttributePrefix !== undefined) {
      position += germanAttributePrefix.length;
      raw = raw.slice(germanAttributePrefix.length);
    }
    let words = raw.split(/\s+/u);
    const first = words[0]!.toLowerCase();
    if (TRIM_READ_HEADS.has(first) && words.length > 2) {
      const headWidth = /^\S+\s+/u.exec(raw)?.[0].length ?? 0;
      position += headWidth;
      raw = raw.slice(headWidth);
      words = words.slice(1);
    }
    if (!DROP_HEADS.has(first) || raw !== match[0]) {
      const final = words[words.length - 1]!.replace(/\.$/u, '').toLowerCase();
      if (SUFFIXES.has(final) && words.length > 2) {
        raw = words.slice(0, -1).join(' ');
      }
      slots.push({ kind: 'entity.name', raw, position });
    }
    if (match.index === NAME_RUN_RE.lastIndex) NAME_RUN_RE.lastIndex += 1;
    match = NAME_RUN_RE.exec(text);
  }
  return slots;
};
