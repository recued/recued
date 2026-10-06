/** D-172 P5 / A.10 — provider-native rendering of `ContentPart[]`.
 *
 *  The LLM layer carries media as provider-neutral `ContentPart`s
 *  (`text | image | audio | document`, each with a base64-or-url
 *  `ContentSource`). Each provider takes a different on-the-wire shape:
 *    - Anthropic: `content` is an array of typed blocks
 *      (`{ type:'image', source:{ type:'base64', media_type, data } }`).
 *    - Gemini: a `parts` array (`{ inlineData:{ mimeType, data } }` /
 *      `{ fileData:{ mimeType, fileUri } }`).
 *    - OpenAI: `content` is an array of parts
 *      (`{ type:'image_url', image_url:{ url } }` /
 *      `{ type:'input_audio', input_audio:{ data, format } }` /
 *      `{ type:'file', file:{ file_data } }`).
 *
 *  These renderers are the single owner of that mapping so the three
 *  adapters stay thin. A renderer NEVER silently drops a part it can't
 *  express (I-6): it throws `AI_MODALITY_UNSUPPORTED`. In practice the
 *  match resolver has already routed to a modality-capable model
 *  (`modalities` flag, N.8), so these throws are defense-in-depth for a
 *  part type the provider genuinely can't carry (e.g. audio to Anthropic). */

import type { ContentPart, ContentSource } from '../types.js';
import { LLMError } from '../types.js';

const modalityUnsupported = (provider: string, modality: string): LLMError =>
  new LLMError(
    'AI_MODALITY_UNSUPPORTED',
    `${provider} cannot carry ${modality} content`,
    { provider, modality },
  );

// ─── Rendering-form predicates (D-164 prompt-cache restructure) ──────────────

/** True when any part is non-text (image / audio / document) — a genuinely
 *  multimodal turn that REQUIRES the provider's content-block array form. A
 *  text-only `ContentPart[]` (the prompt-cache prefix/suffix split) is
 *  byte-equivalent to the plain `content` string for every provider, so it does
 *  NOT force the array form on its own. */
export const hasNonTextPart = (parts: readonly ContentPart[]): boolean =>
  parts.some((p) => p.type !== 'text');

/** True when any text part carries a cache breakpoint. Only an explicit-caching
 *  adapter (Anthropic) acts on it — it must render the array form so the
 *  `cache_control` marker can attach to the right block. Other adapters ignore
 *  the marker and keep sending the plain string. */
export const hasCacheBreakpoint = (parts: readonly ContentPart[]): boolean =>
  parts.some((p) => p.type === 'text' && p.cache_breakpoint === true);

/** Concatenate the text of an all-text `ContentPart[]` into one string (no
 *  separator — adjacent text blocks are one continuous text stream). This is the
 *  string an adapter sends when a present `content_parts` carries no modality
 *  (and no breakpoint it must place via the array form).
 *
 *  Critically it joins the PARTS — it must NEVER be replaced by a fall-back to
 *  `LLMMessage.content`. A D-172 additive `content_parts` (e.g. the base prompt
 *  as a leading text part PLUS appended text parts) does NOT equal `content`, so
 *  reading `content` instead would silently drop the appended text. (For the
 *  D-164 cache split the two are byte-equal by construction, but the rest of the
 *  contract isn't.) Non-text parts are skipped — callers invoke this only on an
 *  all-text list. */
export const joinTextParts = (parts: readonly ContentPart[]): string =>
  parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

/** The media type a provider is sent.
 *
 *  ⚠ `image/jpg` is not a registered media type, but Home Assistant's camera
 *  proxy and other cameras label JPEGs with it, and Anthropic refuses any image
 *  media_type outside jpeg / png / gif / webp. Normalised HERE, where every path
 *  that sends a picture meets a provider (an `ai-*` step, the caption and text
 *  producers, chat), instead of in one producer that the next one would miss.
 *  The stored file keeps the vendor's label: that is the true record. */
export const wireMediaType = (mime: string): string =>
  mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime;

/** Build a `data:<mime>;base64,<data>` URI from a base64 source. */
const dataUri = (source: ContentSource): string =>
  source.kind === 'url' ? source.data : `data:${wireMediaType(source.media_type)};base64,${source.data}`;

// ─── Anthropic ───────────────────────────────────────────────────────────────

/** Anthropic block source: `{ type:'base64', media_type, data }` or
 *  `{ type:'url', url }`. Used for both image + document blocks. */
const anthropicSource = (source: ContentSource): Record<string, unknown> =>
  source.kind === 'url'
    ? { type: 'url', url: source.data }
    : { type: 'base64', media_type: wireMediaType(source.media_type), data: source.data };

/** Render `ContentPart[]` into an Anthropic Messages `content` block array.
 *  Anthropic supports text + image + document (PDF); it has NO audio block,
 *  so an audio part throws (the user's Anthropic slot should declare
 *  `modalities.audio: false`, keeping it out of match for audio turns). */
export const toAnthropicContent = (parts: readonly ContentPart[]): unknown[] =>
  parts.map((p) => {
    switch (p.type) {
      case 'text':
        // D-164 — a `cache_breakpoint` text part gets a 5-min ephemeral
        // `cache_control`, caching the prefix up to + including this block
        // (render order tools → system → messages; the breakpoint walks back
        // over both). The prompt-cache split marks the stable catalog block.
        return p.cache_breakpoint === true
          ? { type: 'text', text: p.text, cache_control: { type: 'ephemeral' } }
          : { type: 'text', text: p.text };
      case 'image':
        return { type: 'image', source: anthropicSource(p.source) };
      case 'document':
        return { type: 'document', source: anthropicSource(p.source) };
      case 'audio':
        throw modalityUnsupported('Anthropic', 'audio');
    }
  });

// ─── Google (Gemini) ─────────────────────────────────────────────────────────

/** Render `ContentPart[]` into Gemini `parts`. Gemini takes image / audio /
 *  document / video all through `inlineData` (base64) or `fileData` (a
 *  remote URI). camelCase field names match the existing google adapter's
 *  `generationConfig` / `maxOutputTokens` usage (proto3 JSON accepts both;
 *  camelCase is the documented canonical form). */
export const toGoogleParts = (parts: readonly ContentPart[]): unknown[] =>
  parts.map((p) => {
    if (p.type === 'text') return { text: p.text };
    return p.source.kind === 'url'
      ? { fileData: { mimeType: wireMediaType(p.source.media_type), fileUri: p.source.data } }
      : { inlineData: { mimeType: wireMediaType(p.source.media_type), data: p.source.data } };
  });

// ─── OpenAI (Chat Completions, multimodal) ───────────────────────────────────

/** OpenAI `input_audio.format` is a bare format string, not a MIME type.
 *  Map the common audio MIME types; default to the subtype after `audio/`. */
const openAIAudioFormat = (mime: string): string => {
  const sub = mime.toLowerCase().replace(/^audio\//, '').split(';')[0]!.trim();
  if (sub === 'mpeg' || sub === 'mp3') return 'mp3';
  if (sub === 'x-wav' || sub === 'wave') return 'wav';
  return sub || 'wav';
};

/** Render `ContentPart[]` into an OpenAI chat-completions `content` array.
 *  Images → `image_url` (data URI or passthrough URL); audio → `input_audio`
 *  (base64 + format); documents → `file` (`file_data` data URI). OpenAI
 *  audio is base64-only — a url-kind audio source throws. */
export const toOpenAIContent = (parts: readonly ContentPart[]): unknown[] =>
  parts.map((p) => {
    switch (p.type) {
      case 'text':
        return { type: 'text', text: p.text };
      case 'image':
        return { type: 'image_url', image_url: { url: dataUri(p.source) } };
      case 'audio':
        if (p.source.kind !== 'base64') throw modalityUnsupported('OpenAI', 'audio-url');
        return {
          type: 'input_audio',
          input_audio: { data: p.source.data, format: openAIAudioFormat(p.source.media_type) },
        };
      case 'document':
        return { type: 'file', file: { file_data: dataUri(p.source) } };
    }
  });
