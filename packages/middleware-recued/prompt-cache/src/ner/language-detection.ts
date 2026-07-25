/** Evidence-ranked language detection for the deterministic prompt path.
 *
 * This is intentionally a ladder, not a whole-sentence classifier:
 * an explicit supported locale is strongest, intent-bearing lexical cues
 * come next, script evidence adds extraction candidates, and English is the
 * final fallback. `locale` selects the intent/template language while
 * `localeCandidates` tells NER which language bundles may contribute spans.
 * Mixed-language prompts therefore keep every evidenced bundle in play. */

export const SUPPORTED_LOCALES = [
  'en',
  'de',
  'es',
  'fr',
  'ja',
  'pt',
  'zh',
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const SUPPORTED = new Set<string>(SUPPORTED_LOCALES);

export const normaliseLocale = (raw: string): string => {
  const lower = raw.trim().toLowerCase();
  const separator = lower.search(/[-_]/);
  return separator === -1 ? lower : lower.slice(0, separator);
};

export const isSupportedLocale = (raw: string): raw is SupportedLocale =>
  SUPPORTED.has(raw);

interface Cue {
  readonly locale: SupportedLocale;
  readonly patterns: ReadonlyArray<RegExp>;
}

/** Intent words carry more weight than a person's script: the language of
 * the request should choose the response even when the referenced name is in
 * another writing system. Patterns are deliberately tied to the four
 * deterministic read families rather than attempting general-purpose
 * language identification. */
const INTENT_CUES: ReadonlyArray<Cue> = [
  {
    locale: 'en',
    patterns: [
      /\bwhat(?:['’]s| is)\b/i,
      /\b(?:can|could|would|will)\s+you\s+(?:tell|show|give)\b/i,
      /\b(?:email address|phone number|where does|work(?:s|ing)? at)\b/i,
      /\b(?:next|upcoming|soonest)\s+(?:meeting|call|sync|appointment)\b/i,
      /\bhow many\s+(?:emails?|messages?)\b/i,
      /\bdoes\b.+\bhave\s+(?:an?\s+)?e-?mail\b/i,
      /\bdo\s+(?:i|we|you)\s+have\b/i,
      /\b(?:have|has)\s+(?:i|we|you)\s+(?:got|gotten)\b/i,
      /\bis there\s+(?:an?\s+|the\s+)?e-?mail\b/i,
      /\b(?:job title|birthday|date of birth)\b/i,
      /\b(?:what are|show me|list)\s+(?:the\s+)?(?:email addresses|phone numbers|employers|job titles|birthdays)\s+for\b/i,
    ],
  },
  {
    locale: 'de',
    patterns: [
      /\b(?:was ist|wie lautet|welche(?:r|s)?|wo arbeitet)\b/i,
      /\b(?:e-?mail-?adresse|telefonnummer|arbeitgeber|firma)\b/i,
      /\b(?:n[aä]chste[rsn]?|kommende[rsn]?)\s+(?:besprechung|termin|meeting)\b/i,
      /\bwie viele\s+(?:e-?mails?|nachrichten)\b/i,
      /\bhat\b.+\b(?:eine?\s+)?e-?mail(?:-adresse)?\b/i,
      /\b(?:habe ich|haben wir)\b.+\be-?mail(?:-adresse)?\b/i,
      /\b(?:berufsbezeichnung(?:en)?|geburtstag|geburtstage)\b/i,
      /\b(?:wann hat|wann sind|wie lauten|wer sind)\b/i,
    ],
  },
  {
    locale: 'es',
    patterns: [
      /\b(?:cu[aá]l es|dime|d[oó]nde trabaja)\b/i,
      /\b(?:correo electr[oó]nico|direcci[oó]n de correo|tel[eé]fono|empresa)\b/i,
      /\bpr[oó]xima\s+(?:reuni[oó]n|llamada|cita)\b/i,
      /\bcu[aá]ntos?\s+(?:correos?|mensajes?)\b/i,
      /\b(?:tiene|dispone de)\b.+\bcorreo(?: electr[oó]nico)?\b/i,
      /\b(?:tengo|tenemos)\b.+\b(?:correo|e-?mail)\b/i,
      /\b(?:cargo(?:s)?|cumplea[nñ]os)\b/i,
      /\b(?:cu[aá]les son|cu[aá]ndo es|cu[aá]ndo son)\b/i,
    ],
  },
  {
    locale: 'fr',
    patterns: [
      /\b(?:quel(?:le)? est|dis-moi|o[uù] travaille)\b/i,
      /\b(?:adresse e-?mail|courriel|t[eé]l[eé]phone|entreprise|employeur)\b/i,
      /\bprochaine\s+(?:r[eé]union|visio|appel)\b/i,
      /\bcombien (?:d['’])?(?:e-?mails?|courriels?|messages?)\b/i,
      /\b(?:a|poss[eè]de)\b.+\b(?:une?\s+)?(?:adresse e-?mail|courriel)\b/i,
      /\b(?:ai-je|avons-nous)\b.+\b(?:adresse e-?mail|courriel)\b/i,
      /\b(?:poste(?:s)?|anniversaire)\b/i,
      /\b(?:quand est|quels sont|quelles sont)\b/i,
    ],
  },
  {
    locale: 'pt',
    patterns: [
      /(?:^|\s)(?:qual\s+[eé](?=\s|[?.!,]|$)|diga-me|onde trabalha)/i,
      /\b(?:endere[cç]o de e-?mail|telefone|empresa|empregador)\b/i,
      /(?:^|\s)e-?mail\s+d[eo](?=\s)/i,
      /\bpr[oó]xima\s+(?:reuni[aã]o|chamada|consulta)\b/i,
      /\bquantos?\s+(?:e-?mails?|mensagens?)\b/i,
      /\btem\b.+\b(?:um\s+)?e-?mail\b/i,
      /\b(?:tenho|temos)\b.+\be-?mail\b/i,
      /\b(?:cargo(?:s)?|anivers[aá]rio(?:s)?)\b/i,
      /\b(?:quando [eé]|quando s[aã]o|quais s[aã]o)\b/i,
    ],
  },
  {
    locale: 'ja',
    patterns: [
      /(?:メール(?:アドレス)?|電話番号|勤務先|会社|役職|誕生日)(?:は|を|です|について)/u,
      /の(?:メール(?:アドレス)?|電話番号|勤務先|会社|役職|誕生日)(?:は|を|です|について|教えて|確認して|[?.!。？！]|$)/u,
      /(?:次|今度)の(?:会議|ミーティング|通話|予定)/u,
      /(?:何通|何件)の?(?:メール|メッセージ)/u,
      /(?:メール(?:アドレス)?)(?:が|は)?ありますか/u,
      /(?:役職|誕生日)(?:は|を)?(?:何ですか|いつですか|教えて|確認して)/u,
    ],
  },
  {
    locale: 'zh',
    patterns: [
      /(?:邮箱|电子邮件地址?|电话号码|手机号|公司|雇主|职位|职务|生日)(?:是|为|多少|什么|什么时候|哪天|吗|么|？|\?)/u,
      /(?:下次|下一次|最近的)(?:会议|通话|会面)/u,
      /(?:多少封|多少个|几封)(?:邮件|电子邮件|消息)/u,
      /(?:邮件|电子邮件|消息).{0,3}(?:多少封|多少个|几封)/u,
      /(?:有|有没有).{0,8}(?:电子邮件|邮箱)/u,
      /(?:请)?(?:告诉我|列出).{0,48}(?:邮箱|电子邮件|电话|公司|职位|职务|生日)/u,
    ],
  },
];

const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_RE = /\p{Script=Han}/u;
const GERMAN_MARK_RE = /[äöüß]/iu;
const SPANISH_MARK_RE = /[¿¡ñ]/iu;
const FRENCH_MARK_RE = /[œæ]/iu;
const PORTUGUESE_MARK_RE = /[ãõ]/iu;
const ROMANCE_MARK_RE = /[áàâãçéèêëíîïóôõúùûüÿœæ]/iu;

export interface LanguageDetection {
  readonly locale: SupportedLocale;
  readonly localeCandidates: ReadonlyArray<SupportedLocale>;
}

export const detectLanguages = (
  text: string,
  explicitLocale?: string,
): LanguageDetection => {
  const evidenceScores = new Map<SupportedLocale, number>();
  const intentScores = new Map<SupportedLocale, number>();
  const addEvidence = (locale: SupportedLocale, score: number): void => {
    evidenceScores.set(locale, (evidenceScores.get(locale) ?? 0) + score);
  };
  const addIntent = (locale: SupportedLocale, score: number): void => {
    intentScores.set(locale, (intentScores.get(locale) ?? 0) + score);
    addEvidence(locale, score);
  };

  for (const cue of INTENT_CUES) {
    for (const pattern of cue.patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) addIntent(cue.locale, 4);
    }
  }

  // Script/orthography evidence contributes extraction candidates but is
  // weaker than intent language. Han alone can be a Japanese or Chinese
  // name, so both bundles get a small score; kana makes Japanese certain.
  if (KANA_RE.test(text)) addEvidence('ja', 3);
  if (HAN_RE.test(text)) {
    addEvidence('zh', 1);
    addEvidence('ja', 1);
  }
  if (GERMAN_MARK_RE.test(text)) addEvidence('de', 1);
  if (SPANISH_MARK_RE.test(text)) addEvidence('es', 2);
  if (FRENCH_MARK_RE.test(text)) addEvidence('fr', 2);
  if (PORTUGUESE_MARK_RE.test(text)) addEvidence('pt', 2);
  if (ROMANCE_MARK_RE.test(text)) {
    addEvidence('es', 1);
    addEvidence('fr', 1);
    addEvidence('pt', 1);
  }

  const explicitPrimary = explicitLocale === undefined
    ? undefined
    : normaliseLocale(explicitLocale);
  const explicit = explicitPrimary !== undefined && isSupportedLocale(explicitPrimary)
    ? explicitPrimary
    : undefined;

  const rankedIntent = SUPPORTED_LOCALES
    .filter((locale) => (intentScores.get(locale) ?? 0) > 0)
    .sort((a, b) => (intentScores.get(b) ?? 0) - (intentScores.get(a) ?? 0));
  const rankedEvidence = SUPPORTED_LOCALES
    .filter((locale) => (evidenceScores.get(locale) ?? 0) > 0)
    .sort((a, b) => (evidenceScores.get(b) ?? 0) - (evidenceScores.get(a) ?? 0));
  // A person's script/diacritics may widen extraction, but cannot choose the
  // response language. Without an explicit locale or an intent-bearing cue,
  // the deterministic response remains English.
  const locale = explicit ?? rankedIntent[0] ?? 'en';
  const localeCandidates = [
    locale,
    ...rankedEvidence.filter((candidate) => candidate !== locale),
  ];

  return { locale, localeCandidates };
};
