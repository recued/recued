/** D-318 step 4, part 2 — the owner's own lines of an email request (§4.4,
 *  ruling 5).
 *
 *  What reaches the model as the owner's words is what they typed: the quoted
 *  history, a signature after `-- `, and a mail app's footer (*"Sent from my
 *  iPhone"*) are left out. That also keeps the owner's phone number and address
 *  out of what the model is sent. The whole email stays in the chat mailbox,
 *  readable.
 *
 *  ⛔ WHAT IS CUT IS NOT ALWAYS HISTORY. Forwarded text, and the email the owner
 *  replied to when they start a conversation with it, is MAIL, not the owner's
 *  words: it must reach the model as mail, through the privacy layer, never
 *  inside the owner's message. So the cut part is reported (`mail_cut`), and the
 *  turn points the model at the email to read with the mail tool. Quoted text in
 *  a conversation that continues is the conversation itself — chat already has
 *  it — and is simply dropped.
 *
 *  Two shapes of quoting, handled differently:
 *  - **A marker, then the original** (an Outlook header block, a forward
 *    marker): everything from the marker on is the original.
 *  - **`>`-quoted lines** (Gmail, Apple Mail, most others): the quoted lines and
 *    their "On … wrote:" line go, wherever they are, so an owner who answered
 *    between the quoted lines keeps their own lines.
 *
 *  Spec: D-318 §4.4, §8 step 4. */

/** A forward marker: everything after it is the forwarded email. */
const FORWARD_MARKERS: readonly RegExp[] = [
  /^-{3,}\s*Forwarded message\s*-{3,}\s*$/i, // Gmail
  /^Begin forwarded message:\s*$/i, // Apple Mail
  /^-{3,}\s*Forwarded Message\s*-{3,}\s*$/i, // Thunderbird
  /^-{3,}\s*(?:Message transféré|Weitergeleitete Nachricht|Mensaje reenviado|Messaggio inoltrato)\s*-{3,}\s*$/i,
];

/** A marker before a quoted original. */
const ORIGINAL_MARKER = /^-{2,}\s*Original Message\s*-{2,}\s*$/i;
/** The first line of a mail app's header block before an original. */
const HEADER_FROM = /^\s*\*?(?:From|De|Von|Van|Da|Från|Fra)\s*:\*?\s/i;
/** Its date line, which every mail app writes: a header block is a `From:`
 *  line followed by a dated `Sent:` / `Date:` line, never `From:` and `To:`
 *  alone — "From: savings / To: checking" is the owner's own instruction (the
 *  D-318 audit). */
const HEADER_SENT = /^\s*\*?(?:Sent|Date|Envoyé|Date d'envoi|Gesendet|Datum|Verzonden|Enviado|Fecha|Inviato|Data|Skickat|Sendt)\s*:\*?\s.*\d/i;
/** Outlook on the web draws a line of underscores above its header block. */
const UNDERSCORE_RULE = /^_{10,}\s*$/;

/** "On … wrote:" in English and the common other languages — the name after
 *  the verb in German, Dutch and Swedish ("Am … schrieb Max <max@…>:"). */
const ATTRIBUTION = /^(?:On|Le|Am|El|Il|Op|Em|Den|På)\s.+(?:wrote|a écrit|schrieb|escribió|ha scritto|schreef|escreveu|skrev)\b[^:]{0,200}:\s*$/i;
const QUOTED = /^\s*>/;
/** A signature separator: `-- ` (RFC 3676), or `--` once a mail app trimmed it. */
const SIGNATURE = /^--\s?$/;

/** A mail app's line at the end of what was typed. */
const FOOTERS: readonly RegExp[] = [
  /^Sent from my (?:iPhone|iPad|iPod|Android|BlackBerry|Samsung|Galaxy|Huawei|Pixel|Xperia|Windows Phone|mobile)\b.*$/i,
  /^Sent from (?:Mail|Outlook|Yahoo Mail|Gmail|Proton ?Mail|Spark|Samsung Mobile|Mail for Windows)\b.*$/i,
  /^Sent with (?:Proton ?Mail|Spark|BlueMail)\b.*$/i,
  /^Sent via (?:the )?(?:Samsung|BlackBerry|Android|mobile)\b.*$/i,
  /^Get (?:Outlook|Gmail) for (?:iOS|Android)\b.*$/i,
  /^Envoyé de mon (?:iPhone|iPad)\b.*$/i,
  /^Von meinem (?:iPhone|iPad|Android|Samsung)\b.*gesendet\s*$/i,
  /^Enviado desde mi (?:iPhone|iPad|Android)\b.*$/i,
];

export interface MailChatOwnLines {
  /** What the owner typed: no quoted history, no signature, no footer. */
  readonly text: string;
  /** Something was cut that is mail, not conversation history: a forwarded
   *  email, or — starting a conversation — the email the owner replied to. */
  readonly mail_cut: boolean;
}

const startsHeaderBlock = (lines: readonly string[], i: number): boolean => {
  if (!HEADER_FROM.test(lines[i]!)) return false;
  for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
    if (HEADER_SENT.test(lines[j]!)) return true;
  }
  return false;
};

/** Where the original begins, after a marker, and whether that original was
 *  forwarded; `null` when there is no marker. */
const findMarker = (lines: readonly string[]): { at: number; forwarded: boolean } | null => {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FORWARD_MARKERS.some((marker) => marker.test(line))) return { at: i, forwarded: true };
    if (ORIGINAL_MARKER.test(line)) return { at: i, forwarded: false };
    if (UNDERSCORE_RULE.test(line) && i + 1 < lines.length && startsHeaderBlock(lines, i + 1)) {
      return { at: i, forwarded: false };
    }
    if (startsHeaderBlock(lines, i)) return { at: i, forwarded: false };
  }
  return null;
};

/** "On Tue, 14 Oct 2026 at 09:00, Ann <ann@" + "example.com> wrote:" — a mail
 *  app wraps a long attribution line, so two lines are read as one. */
const isAttribution = (lines: readonly string[], i: number): number => {
  const line = lines[i]!.trim();
  // It carries a date: *"On reflection, I wrote:"* is the owner's own line.
  if (ATTRIBUTION.test(line) && /\d/.test(line)) return 1;
  const next = lines[i + 1]?.trim();
  if (next !== undefined && /^\S+\s/.test(line) && ATTRIBUTION.test(`${line} ${next}`)
    && /\d/.test(`${line} ${next}`) && QUOTED.test(lines[i + 2] ?? '')) return 2;
  return 0;
};

/** The owner's own lines of an email, and whether what was cut is mail. A
 *  conversation that `continuing` already holds its quoted history; an email
 *  `forwarded` (its subject says so) carries mail below any marker and in any
 *  quoted line, even in a conversation — Outlook forwards with the same header
 *  block it quotes with. So in a forward, `mail_cut` also says whether the
 *  forwarded mail was found at all. */
export const mailChatOwnLines = (
  body: string,
  options: { readonly continuing: boolean; readonly forwarded?: boolean },
): MailChatOwnLines => {
  let lines = body.replace(/\r\n?/g, '\n').split('\n');
  let mailCut = false;

  const marker = findMarker(lines);
  if (marker !== null) {
    lines = lines.slice(0, marker.at);
    if (marker.forwarded || options.forwarded === true || !options.continuing) mailCut = true;
  }

  // `>`-quoted lines and their attribution line, wherever they are.
  const quotedIsMail = options.forwarded === true || !options.continuing;
  const kept: string[] = [];
  for (let i = 0; i < lines.length;) {
    const attribution = isAttribution(lines, i);
    if (attribution > 0) {
      i += attribution;
      if (quotedIsMail) mailCut = true;
      continue;
    }
    if (QUOTED.test(lines[i]!)) {
      if (quotedIsMail) mailCut = true;
      i += 1;
      continue;
    }
    kept.push(lines[i]!);
    i += 1;
  }

  // The signature: from its separator on.
  const signature = kept.findIndex((line) => SIGNATURE.test(line));
  const own = signature >= 0 ? kept.slice(0, signature) : kept;

  // A mail app's footer, and the blank lines around it, at the end.
  while (own.length > 0) {
    const last = own[own.length - 1]!.trim();
    if (last === '' || FOOTERS.some((footer) => footer.test(last))) own.pop();
    else break;
  }
  return { text: own.join('\n').trim(), mail_cut: mailCut };
};
