/** Context-bound CJK name extraction.
 *
 * Capitalisation cannot identify a name in CJK scripts. We therefore emit a
 * span only beside one of the deterministic contact/meeting/mail intents (or
 * an English contact/with/from bridge). The exact-contact lookup remains the
 * second half of the certainty gate. */

import type { RawSlot } from '../extract.js';

const JA_NAME = String.raw`(?:\p{Script=Han}{2,8}(?:[ \u3000]\p{Script=Han}{1,4})?|[\p{Script=Katakana}ー]{2,12}(?:・[\p{Script=Katakana}ー]{2,12})?|\p{Script=Hiragana}{2,8})`;
const ZH_NAME = String.raw`\p{Script=Han}{2,4}?`;

const makePatterns = (name: string, locale: 'ja' | 'zh'): ReadonlyArray<RegExp> => {
  const common = [
    new RegExp(String.raw`(${name})['’]s\s+(?:e-?mail|phone|company)\b`, 'giu'),
    new RegExp(String.raw`\b(?:an?\s+|the\s+)?e-?mail(?:\s+address)?\s+for\s+(${name})(?=\s|[?.!,]|$)`, 'giu'),
    new RegExp(String.raw`\b(?:with|from)\s+(${name})(?=\s|[?.!,]|$)`, 'giu'),
    new RegExp(String.raw`\bwhere\s+does\s+(${name})\s+work\b`, 'giu'),
    new RegExp(String.raw`\b(?:what|which)\s+(?:company|employer)\s+does\s+(${name})\s+work\s+(?:for|at)\b`, 'giu'),
  ];
  if (locale === 'ja') {
    return [
      ...common,
      new RegExp(String.raw`(?:教えて|確認して|検索して)?\s*(${name})の(?:メール(?:アドレス)?|電話番号|勤務先|会社)`, 'gu'),
      new RegExp(String.raw`(${name})との(?:次|今度)の(?:会議|ミーティング|通話|予定)`, 'gu'),
      new RegExp(String.raw`(?:次|今度)の(?:会議|ミーティング|通話|予定)(?:は)?(${name})と`, 'gu'),
      new RegExp(String.raw`(${name})からの(?:メール|メッセージ)`, 'gu'),
    ];
  }
  return [
    ...common,
    new RegExp(String.raw`(?:有没有|请问|查询|告诉我|有)?\s*(${name})的(?:邮箱|电子邮件地址?|电话号码|手机号|公司|雇主)`, 'gu'),
    new RegExp(String.raw`(?:与|和)(${name})的(?:下次|下一次|最近的)(?:会议|通话|会面)`, 'gu'),
    new RegExp(String.raw`(?:下次|下一次|最近的)(?:会议|通话|会面)(?:是)?(?:与|和)(${name})`, 'gu'),
    new RegExp(String.raw`(?:来自|从)(${name})的(?:邮件|电子邮件|消息)`, 'gu'),
  ];
};

const JA_PATTERNS = makePatterns(JA_NAME, 'ja');
const ZH_PATTERNS = makePatterns(ZH_NAME, 'zh');
const JA_STOP_NAMES = new Set([
  'から', 'との', 'メール', 'メッセージ', '電話', '会社', '会議', '今度',
]);

export const extractContextualCjkNames = (
  text: string,
  locale: 'ja' | 'zh',
): ReadonlyArray<RawSlot> => {
  const slots: RawSlot[] = [];
  for (const pattern of locale === 'ja' ? JA_PATTERNS : ZH_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const raw = match[1]?.trim();
      if (
        raw !== undefined
        && raw.length > 0
        && (locale !== 'ja' || !JA_STOP_NAMES.has(raw))
      ) {
        const relative = match[0].indexOf(raw);
        slots.push({
          kind: 'entity.name',
          raw,
          position: match.index + Math.max(relative, 0),
        });
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }
  return slots;
};
