/** D-172 — audio-container magic-byte recognition.
 *
 *  The mail/messenger mime detector (`detectMailAttachmentMimeType`) recognizes
 *  image/PDF/text by magic bytes but has NO audio signatures, so it falls back
 *  to the *reported* mime for any binary it can't place — including a bogus
 *  `audio/*` label on non-audio bytes. That mislabel matters on the messenger
 *  path: `mediaClassForMimeType` maps `audio/*` → `media_class: 'voice'`, and a
 *  voice-only turn is transcribed EAGERLY (D-172 A.9). So a bound-conversation
 *  sender could force an AI transcription call on arbitrary bytes by reporting
 *  them as `audio/ogg`.
 *
 *  This recognizer lets the messenger ingest sink TRUST an `audio/*` label only
 *  when the head bytes actually match a known audio container; otherwise the
 *  sink downgrades the stored mime so `media_class` is not `voice` and the
 *  eager-transcribe path is never auto-selected. Legitimate voice notes — Ogg
 *  (Telegram Opus), MP3, M4A/MP4 (Slack), WAV, FLAC — pass; an uncommon codec
 *  we don't list simply doesn't auto-transcribe (it still lands + is readable).
 *
 *  Head-bytes only (the first ~12 bytes captured at download); never reads the
 *  whole file. */

/** True when `head` begins with a recognized audio-container signature.
 *
 *  NOT airtight: magic bytes are forgeable (a sender can prepend a real
 *  signature to arbitrary bytes). The gate's value is making the stored mime
 *  honest + raising the bar past a label-only spoof; the real backstop is that
 *  `transcribe` fails gracefully on non-decodable bytes and the sender is
 *  confined to the bound conversation. So we recognize only signatures needing
 *  >= 4 specific bytes that rarely collide with innocent binary, and
 *  DELIBERATELY OMIT the raw MPEG/ADTS frame-sync (`0xFF` + 3 set bits): at ~11
 *  bits a 2-byte `0xFF 0xE0` prefix would re-open the spoof and it
 *  false-positives on ordinary `0xFF`-leading binary (Codex review-of-fix P2).
 *  Headerless MP3 / raw-ADTS is uncommon for voice notes (Telegram = Opus, most
 *  MP3s carry an ID3 tag), so the coverage loss is minimal: such media simply
 *  isn't eager-transcribed. */
export const looksLikeAudio = (head: Buffer): boolean => {
  if (head.length < 3) return false;

  // Ogg (Opus / Vorbis) — "OggS"
  if (head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
    return true;
  }
  // MP3 with an ID3v2 tag — "ID3"
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    return true;
  }
  // FLAC — "fLaC"
  if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
    return true;
  }
  // WAV — "RIFF" .... "WAVE"
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45
  ) {
    return true;
  }
  // ISO-BMFF (M4A / MP4 / AAC-in-MP4) — bytes 4..7 = "ftyp"
  if (
    head.length >= 8 &&
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
  ) {
    return true;
  }
  return false;
};
