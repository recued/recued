/**
 * D-315 — recognizing a security notice, best effort (§3, §9).
 *
 * Sign-in codes, password resets and new-device alerts are skipped: no fact is
 * read from them and none is sent to AI. There is no standard pattern that
 * covers them all — the owner: *"there are not standard pattern for full
 * coverage so it is just best effort"* — so this catches the common forms, in
 * the languages an owner most often receives them in, and says so.
 *
 * A phrase counts only as whole words, in the subject or the opening text, with
 * what is not words taken out first — links, `%2F`-style escapes, style rules
 * and colours — so an HTML-only email's markup cannot match (`%2Fa` is not
 * "2fa", `#f2faff` is not either). The phrases are the notices' own: a
 * booking's door passcode or "your new device is on its way" is ordinary mail,
 * and skipping it would lose its facts without a word.
 *
 * What holds by design is narrower and firmer: the AI sees an email only after
 * an AI-on template's entrance was met by rules from more than the sender's
 * domain (§4.1). This recognizer is the layer in front of that.
 */

import { canonicalMailFactText } from '@recued/contracts';

import type { MailFactSourceEmail } from './rules-pass.js';

/** Phrases a security notice carries in its subject or its opening lines. */
const SECURITY_PHRASES: readonly string[] = [
  // English
  'verification code', 'security code', 'one-time code', 'one time code', 'one-time password',
  'one time password', 'one-time passcode', 'one time passcode', 'sign-in code', 'sign in code',
  'login code', 'log-in code', 'authentication code',
  'two-factor', 'two factor', '2-step verification', 'two-step verification',
  'password reset', 'reset your password', 'reset password', 'new sign-in', 'new sign in', 'new login',
  'sign-in from a new device', 'sign in from a new device', 'login from a new device', 'new device sign-in',
  'unrecognized device', 'unrecognised device', 'suspicious sign-in', 'suspicious activity',
  'unusual sign-in', 'sign-in attempt', 'login attempt', 'security alert',
  'confirm your email', 'verify your email', 'magic link', 'sign-in link', 'login link',
  // German
  'bestätigungscode', 'sicherheitscode', 'einmalcode', 'passwort zurücksetzen', 'neue anmeldung',
  // French
  'code de vérification', 'code de sécurité', 'réinitialiser votre mot de passe', 'nouvelle connexion',
  // Spanish
  'código de verificación', 'código de seguridad', 'restablecer tu contraseña', 'nuevo inicio de sesión',
];

/** The opening text looked at, once what is not words is out. */
const HEAD_CHARS = 600;
/** How much of the body is cleaned to find that opening. */
const SCAN_CHARS = 8_000;

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every phrase as whole words: no letter or digit may touch either end. A
 *  space or hyphen inside one may be any run of them. */
const PHRASES_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${SECURITY_PHRASES
    .map((phrase) => escapeRe(phrase).replace(/[ -]+/g, '[\\s\\-]+'))
    .join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/** What is not words: tags, links, percent escapes, style rules and colours. */
const NOT_WORDS: readonly RegExp[] = [
  /<[^<>]*>/g,
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\S+@\S+\.\S+/g,
  /%[0-9a-f]{2}/gi,
  /[^\s{}]*\{[^{}]*\}/g,
  /#[0-9a-f]{3,8}\b/gi,
];

const words = (text: string): string => NOT_WORDS.reduce((out, re) => out.replace(re, ' '), text);

/** The check itself, on a subject and a body — also for a stored email, whose
 *  mail detail view offers no fact actions on one (§6). Each read canonical
 *  (§9): a notice in fullwidth letters, or with a zero-width space in its
 *  words, is still one. */
export const looksLikeSecurityNoticeText = (subject: string, bodyText: string): boolean => {
  // Cut before and after: a text that grows as it is read stays bounded.
  const read = (text: string): string => canonicalMailFactText(text.slice(0, SCAN_CHARS)).slice(0, SCAN_CHARS);
  return PHRASES_RE.test(`${words(read(subject))}\n${words(read(bodyText)).replace(/\s+/g, ' ').trim().slice(0, HEAD_CHARS)}`);
};

export const looksLikeSecurityNotice = (email: MailFactSourceEmail): boolean =>
  looksLikeSecurityNoticeText(email.subject, email.body_text);
