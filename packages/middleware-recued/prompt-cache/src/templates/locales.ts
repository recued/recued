/** Shared locale helpers for built-in deterministic template families. */

import {
  isSupportedLocale,
  normaliseLocale,
  type SupportedLocale,
} from '../ner/language-detection.js';

export const resolveTemplateLocale = (raw: string): SupportedLocale => {
  const locale = normaliseLocale(raw);
  return isSupportedLocale(locale) ? locale : 'en';
};

export const normaliseTemplateText = (raw: string): string =>
  raw.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export const escapeTemplateRegExp = (raw: string): string =>
  raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Any mutation cue makes every read-only family decline. Unicode
 * lookarounds keep accented Latin verbs bounded; CJK verbs are matched as
 * whole semantic units because those scripts do not use spaces. */
const LATIN_MUTATION = [
  // Bounded conjugation families cover common imperatives/plurals without
  // treating arbitrary words or contact names that share a short stem as a
  // write. Romance forms include attached clitics (`cámbiame`). A false
  // positive only defers; a missed write could be silently answered as read.
  String.raw`(?:chang(?:e|es|ed|ing)|set(?:s|ting)?|update(?:s|d)?|updating|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying)|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|clear(?:s|ed|ing)?|reset(?:s|ting)?|correct(?:s|ed|ing)?|assign(?:s|ed|ing)?|schedule(?:s|d)?|scheduling|reschedule(?:s|d)?|rescheduling|cancel(?:s|led|ling|ed|ing)?|book(?:s|ed|ing)?|invit(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|add(?:s|ed|ing)?|mov(?:e|es|ed|ing)|postpon(?:e|es|ed|ing))`,
  String.raw`(?:[äa]ndern|aendern|[äa]ndere|aendere|[äa]ndert|aendert|setzen|setze|setzt|aktualisieren|aktualisiere|aktualisiert|bearbeiten|bearbeite|bearbeitet|l[oö]schen|loeschen|l[oö]sche|loesche|l[oö]scht|loescht|entfernen|entferne|entfernt|ersetzen|ersetze|ersetzt|umbenennen|umbenenne|umbenennt|planen|plane|plant|absagen|sage\s+ab)`,
  String.raw`(?:(?:cambiar|c[áa]mbia|cambie|cambien|establecer|establece|establezca|actualizar|actual[ií]za|actualice|editar|edita|edite|modificar|modif[ií]ca|modifique|eliminar|elim[ií]na|elimine|borrar|b[oó]rra|borre|reemplazar|reemplaza|reemplace|renombrar|renombra|renombre|programar|programa|programe|cancelar|cancela|cancele|agendar|agenda|agende)(?:me|te|lo|la|le|nos|os|los|las|les|se)?)`,
  String.raw`(?:changer|change|changez|d[eé]finir|d[eé]finis|d[eé]finissez|modifier|modifie|modifiez|mettre|mets|mettez|mettons|supprimer|supprime|supprimez|effacer|efface|effacez|remplacer|remplace|remplacez|renommer|renomme|renommez|planifier|planifie|planifiez|annuler|annule|annulez|r[eé]server|r[eé]serve|r[eé]servez)`,
  String.raw`(?:alterar|altere|alterem|definir|defina|definam|atualizar|atualize|atualizem|editar|edite|editem|modificar|modifique|modifiquem|excluir|exclua|excluam|apagar|apague|apaguem|substituir|substitua|substituam|renomear|renomeie|renomeiem|agendar|agende|agendem|cancelar|cancele|cancelem|marcar|marque|marquem|mudar|mude|mudem)`,
].join('|');

const MUTATION_RE = new RegExp(
  String.raw`(?<!\p{L})(?:${LATIN_MUTATION})(?!\p{L})|(?:変更|更新|編集|削除|消去|置換|設定|追加|予約|キャンセル|修改|更改|更新|编辑|删除|清除|替换|设置|添加|安排|取消)`,
  'iu',
);

export const hasMutationIntent = (text: string): boolean => MUTATION_RE.test(text);

export const LOCALIZED_TAIL = String.raw`\s*[?.!¿¡。？！]*$`;

export type { SupportedLocale };
