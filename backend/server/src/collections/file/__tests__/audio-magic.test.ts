/** D-172 — `looksLikeAudio` audio-container recognizer (Codex review-of-fix
 *  fold). Guards the messenger eager-transcribe path: an `audio/*` label is
 *  trusted only when the head bytes match a real audio container, so non-audio
 *  bytes mislabelled `audio/ogg` can't force a transcription call. */

import { describe, expect, it } from 'vitest';
import { looksLikeAudio } from '../audio-magic.js';

const head = (...bytes: number[]): Buffer => Buffer.from(bytes);

describe('looksLikeAudio — recognizes real audio containers', () => {
  it('Ogg (Opus/Vorbis) — OggS', () => {
    expect(looksLikeAudio(head(0x4f, 0x67, 0x67, 0x53, 0x00, 0x02))).toBe(true);
  });
  it('MP3 with ID3v2 tag — ID3', () => {
    expect(looksLikeAudio(head(0x49, 0x44, 0x33, 0x04, 0x00))).toBe(true);
  });
  it('FLAC — fLaC', () => {
    expect(looksLikeAudio(head(0x66, 0x4c, 0x61, 0x43, 0x00))).toBe(true);
  });
  it('WAV — RIFF....WAVE', () => {
    expect(
      looksLikeAudio(head(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45)),
    ).toBe(true);
  });
  it('M4A / MP4 (ISO-BMFF) — ftyp at offset 4', () => {
    expect(
      looksLikeAudio(head(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20)),
    ).toBe(true);
  });
});

describe('looksLikeAudio — rejects non-audio + degenerate input', () => {
  it('a PNG header is not audio', () => {
    expect(looksLikeAudio(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false);
  });
  it('a PDF header is not audio', () => {
    expect(looksLikeAudio(head(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe(false);
  });
  it('raw MPEG/ADTS frame-sync is NOT trusted (a 2-byte 0xFF 0xE0 prefix would re-open the spoof)', () => {
    // Deliberately dropped: ~11 bits is trivially forgeable + false-positives on
    // ordinary 0xFF-leading binary (Codex review-of-fix P2). Headerless MP3/ADTS
    // simply isn't eager-transcribed.
    expect(looksLikeAudio(head(0xff, 0xfb, 0x90, 0x00))).toBe(false);
    expect(looksLikeAudio(head(0xff, 0xf1, 0x50, 0x80))).toBe(false);
    expect(looksLikeAudio(head(0xff, 0xe0, 0x13, 0x37, 0x00, 0x42))).toBe(false);
  });
  it('arbitrary text bytes are not audio (the spoof payload)', () => {
    expect(looksLikeAudio(Buffer.from('not actually audio'))).toBe(false);
  });
  it('a near-RIFF without WAVE (e.g. AVI/WEBP) is not audio', () => {
    expect(
      looksLikeAudio(head(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20)),
    ).toBe(false);
  });
  it('empty / 1-byte buffers are not audio', () => {
    expect(looksLikeAudio(Buffer.alloc(0))).toBe(false);
    expect(looksLikeAudio(head(0xff))).toBe(false);
  });
});
