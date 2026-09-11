/** D-262 § B7 — the speech clip the transcription Test button sends.
 *
 *  ⚠ The bytes are sourced (see the provenance constant). When they are ABSENT
 *  the probe reports `no_sample` — an honest "could not test this", never a
 *  pass — because reporting success for a request that never left the process
 *  is how a "verified" badge starts lying. ⛔ And a silent or synthetic clip
 *  would be worse than none: the Gemini adapter raises
 *  `AI_RESPONSE_PARSE_FAILED` on an empty transcript, so silence would report a
 *  WORKING Gemini slot as broken.
 *
 *  ── What the clip has to be ───────────────────────────────────────
 *  1. **Speech**, ~1–2 seconds. See above; silence does not survive contact
 *     with one provider of three.
 *  2. **Self-describing, and ⛔ WITHOUT THE PRODUCT NAME.** "This is a transcript
 *     microphone test." The probe SHOWS the transcript to the owner, so a
 *     returned line about a brown fox reads as a bug in a settings panel rather
 *     than as the test it is — but "Recued" is not a word any ASR model has in
 *     its vocabulary, and every provider would return a different mangling of
 *     it ("recused", "re-cued", "rescued"). The owner would then be shown a
 *     WRONG-LOOKING transcript by a WORKING slot, which is the precise failure
 *     this panel exists to rule out. A brand name is the one thing a
 *     transcription self-test must not contain.
 *  3. **CC0 or equivalently unencumbered.** This repo is AGPL v3 and ships no
 *     `NOTICE` / `THIRD-PARTY` file, so this first bundled binary asset either
 *     arrives with no attribution obligation or it creates a file to maintain
 *     forever. Mozilla Common Voice is CC0; Piper's MIT-licensed voices
 *     generating our own line is equally clean.
 *     ⛔ NOT a platform TTS (macOS `say`, Windows SAPI): those voices are
 *     licensed for use on their platform, not for redistribution inside an
 *     AGPL source tree. ⛔ NOT espeak-ng, whose GPLv3 makes the question
 *     interesting for no benefit.
 *  4. **Ogg/Opus at ~16 kHz mono**, a few KB. Every transcription endpoint in
 *     `adapters/transcription.ts` accepts it, and `looksLikeAudio` recognises
 *     the `OggS` signature.
 *
 *  ── Why base64 in a .ts file rather than a .ogg on disk ───────────
 *  ⛔ `tsc --build` emits JS and nothing else; the server package bundles no
 *  assets today; and the release ships a Node SEA single binary. A loose file
 *  under `src/` would exist in the repo and vanish TWICE — from `dist/`, and
 *  again from the shipped binary. A few KB of base64 rides the normal build
 *  with no asset plumbing to get wrong.
 *
 *  ⚠ Record the clip's provenance and licence in the constant below when it
 *  lands, and state its language in the Settings copy: an English clip against
 *  a `transcription_language` pinned to `de` returns plausible nonsense, and
 *  the owner needs to read that as "my pin is working" rather than "this is
 *  broken". */

/** Provenance of the bundled clip.
 *
 *  🔑 THE LICENCE FLOWS FROM THE MODEL, NOT FROM THE SITE. `af_heart` is an
 *  official voice of Kokoro-82M (`hexgrad/Kokoro-82M`), released under
 *  **Apache 2.0**, which permits commercial use, modification and
 *  redistribution — and Apache 2.0 is one-way compatible with this repo's
 *  AGPL v3. soundtools.io runs that model CLIENT-SIDE ("your files are
 *  processed on your device and are not stored on our servers"), states that
 *  users retain all rights, and imposes no redistribution or commercial
 *  restriction. So the audio was generated on the owner's own machine by an
 *  Apache-2.0 model; the site delivered weights and JavaScript, it did not
 *  licence the output. The same bytes are reproducible offline from the same
 *  model, which is what makes this robust rather than dependent on one site's
 *  terms staying put.
 *
 *  ⛔ Contrast the source this REPLACED: a free wrapper around Microsoft/Azure
 *  neural voices, whose terms reserved commercial rights to a paid tier while
 *  making the user "solely responsible for … publication, distribution". That
 *  is the class this file's header rules out, and it is about REDISTRIBUTION
 *  being withheld — not about copyleft, which is fine here. */
export const TRANSCRIPTION_PROBE_SAMPLE_PROVENANCE =
  'Kokoro-82M voice `af_heart` (hexgrad/Kokoro-82M, Apache-2.0), synthesised '
  + 'client-side via soundtools.io on 2026-09-06, transcoded to 16 kHz mono Ogg/Opus.';

/** ✅ 2026-09-07 — THE BYTES WERE PLAYED TO A REAL ASR AND SAID THIS.
 *
 *  The bundled constant was decoded and sent through this repo's own
 *  `transcribe()` (openai-compatible adapter → Groq `whisper-large-v3`), which
 *  returned "This is a transcript microphone test." — byte-identical to
 *  {@link TRANSCRIPTION_PROBE_SAMPLE_TEXT} after trimming.
 *
 *  ⚠ WHY THIS IS A COMMENT AND NOT A TEST. The sibling suite proves the
 *  constant decodes to a real Ogg stream and that the TEXT avoids the product
 *  name, but nothing can assert that the AUDIO says the TEXT without calling a
 *  provider — and a unit test that needs a live key is a test that gets skipped
 *  and then rots. The pair is checked by hand when either side changes, and the
 *  failure it guards is specific: a clip that disagrees with its declared line
 *  makes the Settings panel show expected-vs-heard as a MISMATCH on a perfectly
 *  working slot, which is the exact wrong answer for a self-test.
 *  ⛔ Re-run it if you replace either the bytes or the sentence. */

/** Base64 Ogg/Opus. Empty ⇒ the probe answers `no_sample`.
 *
 *  ⚠ ~4.9 KB of audio, ~6.5 KB of base64 — small enough to ride the normal
 *  build, which is the whole reason it lives here rather than as a file that
 *  would vanish from `dist/` and again from the SEA binary. */
const TRANSCRIPTION_PROBE_SAMPLE_B64 = 'T2dnUwACAAAAAAAAAAB/l9asAAAAAOvoexIBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAH+X1qwBAAAA6gpOSwE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMQEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAxIGxpYm9wdXNPZ2dTAACAuwAAAAAAAH+X1qwCAAAA2YcF5zIICQgICAgICAgIDxAVGh4nLjYtJygvJSYtJSIlKywrLyUwHR4lLygmJCkmMTMmISkoI0gL5ME27MWASAfJcifhROpQSAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgH3hfZL1eI/okON1vnZUgI2UcdCAKpEBgEi4FKj8BIhhjfLi9qPs/r66Anc0Yf8u8ZUpZIhiHu7pHbDrKIO5qMhGjjV07E/FX1Ax3d/kiGIy6pq5CratyFCNaUSMtLres6yyVwfp3WJNSIQEiAI1dHEq2nnpMQyJd5z+nwk8bvSeEh+3RvvODAvUEYs6xIMXwzmEiZeC6PJKcfxdR44L4urKSF8715//+fbO4KlPfM5bM0PuEBY5uBR36VLTfSRexIrvfWJepWOiA4FNmlUktjLWnPrE20TPSMSHUOWf78IUtnvdAr7kqC4XCI/Ng+CZgAYkoFpEBIs6C9NZxV/2HYkkSrESSpj8S2ch/e8fTMpPSkW1pAsEFYy+NXDcpDw8r7/iBItPFAk46dg/e4rmjShIEXNJ/GgfcwnN3umFLGFYwSG/0l/3mpaQFItSdQ+rI3f6wzBH+VGH1G608mxob9E5HDIydIIQSlwB2VbVME8bDgSJTjkbI/zBmJLr1mRRvlRVg04cMbR1G9/yUpnwk/XSG1sN0LujSGL9tfdtdJvdpIlFbr9kcb2RLm3caQke2/PDG2mU85cpkbLLICREt/add61JbwSJMjDGbChU3q4hUTvx8HqcjPrgvZcBepRr+e0rZrqVnB5nqINMBIk077V6pt+cQPBTVGpu+7djw+55M3FmJYrY+dDQOPMDHs8REV/Nsy9wcN6t5IhI2uUL0hhS5yInOSFoT5on7LBX9mjqMZLMKwEG9gv2P+sX7LSLXSykG1cb9opyuuDj4U1BUlZpwy2qaaVUQ5SP7EEsQTGkiyEj4VdLhQplhtbo1iFYAfaWu8bLYBdTlrw+VGRzBqqzCmmclIslMUin2sOkYPFmewTeOnF1zHdWgM0K4XbSgRJfSYj1POxSZGuCvCnfDgSJN8Cjiquw0yeMIFho9i/XmhXUmkZ4jjsmEjNoJEz3vOQmEH4nYDw6Z+C4BIhCOIvxV3OD7nlSgv/koD1cOCJOL6JQ5CPpnTSSZ6Z0malbi7Xs/jimOASLW0TeUNRYYMWMWwcvlxHBRY745oOZvKzgO2euDWNPGcDxjjod9kbVuknXFQxvpItQffM7QKMPubGybZXxeXksvoC6TCSIrcSR/xHwUW0u7o8FmgSLTe41lK40d5VWOqpJrar8JtVD1UpsnYTz2tq1r2flOryh4NT9TQMsUpE0YlbWAgSKH3gMRjUFD27uMgCDbb/W6VJ2kyfAtD0eKbYAdIA1bPld1UqrECcY7X0lL1x1g3L7Wk8NmQFuVgZpVIgGPZ5aI73RvofMjk2+QqoCJe96Z53yH+1c0+/Y4D8cvAAYpASJXkBv+oaUbBwoVREEGLMCm4nd8gautX5dSTGTWNlfOORNs77PJcrcW8wrmXQYBIljBdM6tyQuAZ+erURwjZv0PtWRXffhA7MTJH4CfQde1m+8OAwDtySJWs+DOfuwgtW07c8A/uqwEj2bxwR+fw9j2fCBeCxQ+o6q/FqlBIlNOuSXjKFKFeSUnzv3fZDkzsG0p6ZI53e98+Juo/KP4ydRZIkwYdrhT4hJ+OF5g77sfCfxi5YO6nRv1dMppr5250SW/WYTKuCPGkGEiQIYehmrHAypx5j5uYR5mDA4WsJfG3u+VRmL4R9m/mBfOBz0DASIKGZyPSW+qy/yWwVepE8xNty7p0R+vXUOYL3F8MK1cvvLKkp0Q+rMIwS4gj5xdrcEis+IzndVVbnWICPrRCJK+qXbk3pfgNHATY3QqkQ640InwZRo2Ommyl3QOrpv7aJQ9UOEiuvYKct0wkSSlSQueBlQ77JFnBp0IbvynkfCeWsdvUYvzR734gSK69gK8afJhWfE4r5l/x1aO8Vh0NltR5PT7pa9lfEbZwSK6GDU/u6SnN/1/DlTI6iWF8kAKBvI+En0EVz1knE9z/XsxdJnyePGRIsOcLRGWr8OLmh6QIvOvwC9x1f5kXeTNbUd1dWh0TRiczFo28aGRwSLOUykmRm0DqXPqr+r/OhuT7/n6OQWqHcaCzDsTTi2NI7SBPZ2dTAAAAdwEAAAAAAH+X1qwDAAAAw5dC0TIsLScoKSIOIictIycmHSEQIiggNDAuLC8vJisoGSArLCY1KCckKSAlIyQjLSsnJiYsM0ixXQhdpW+F0jzmCwZOOhwqECL5Es15lw97nPzNjPKbmQOEBwjnUSsP4rkgSKXuvRYq+m5lOZ6e9Oq74tkLrkP0pN9mGq+MvgTqH1ycbJJnhc3pEWIp/faQSKDJny/WInOFPT19n5KJFdWsCna2PupkWuLcHil+v1RgpDavF1f0SIPGxhgTCyH1Y2ODOu1Nqeg8EJNtWNZRNMC1tOSXiexCi70WX8SNSEiV0fgw7Ey02+pPFWFBi9G0Pfqrl5K3/c8toNNZ5IuoxIrTnpUAcC0OSIUwU5KVqOb3W6RqxDS0EfI1EpYhPQC5WLkorlijXNYDmEgGBvAEWoA+X3D+B2D6SIBt67Q246sVjExBWMzwd5rDXoXdykNqBj284IdJnG7wwEiCkRX8F24xighG/nifDhVgDfwl6UD5gBfjcOLZB0OVTTmL+SQkuEiqOoFt/xmQ3UP7150Ct2spU32cJQXbqvt7onXAtc7hIw7VjkeqAJRO+afrjkiufAaf+uAu2CfwLj8Cu2wBmvDpgQObwtT/i9aKQ3vifKcgSKyVe8cL+JM045R1ECJR9yIM/HBP+cREFNW+HtRUpqkCBxFf+n9ASKM/4J54UhlFYMgeJi195oevH7/5N0UAxLsWK6IMN6O0rk6UgRBIJCkS8lUG5zuHX1u/ZobG+eSAsoynHlig9Jlg40iAYRGPWQ4BDkP4M70BMjPcT5b6ZgoXZwfM0n3Um1lhgEgFqLAETUZGfEu9CLbxT4hIgGQZchLSVhQFAaYnJkZDrqA8hahJqy/paznh+rEdmlUqSIOjFwSNt09huqtQJ74wHLuZ5g+CTx80azGogmFzW3rPq/rcQqZFoEiBHfXuQcJElojBnC1c/HT8wrCY+86bCa2hwkMQ5x/rSJzBaxHUV6FzbUwDJQ6sE3yfaUwvJPhM+jKbD5TDgzfkMIpBLY2XwDitNRaVQxqb0gMx10igEtown6wlsZUhclNWO8H3pNhYBbj9p1HBcuWbZD7cy/5dSBAGOS7xnbXV9zanrEikFaraOZ+A1p8K5C5ceOJnbm4SNqQbsuxkyICBh+rHTwTM56m1/GH3rTVC41RIru6930ShnIU6SSx1e273Df8GO5QUpQeXpN2DbMv3CcPNN1SUFrdAytpSIEiyBgHxib+tcOjShaK+0wkLXjHWNOHUqNZZZvkoY5OMoQ5RfZR7L5rG/Am/DJdASLQFNgERsvItHoUdSNrn+/wPA3a7e2egiuhNCixg5JMsRjlHeP63in5dQwYCNuBItMsdPMqcdolrQZdfyNcGc+NZz9Tdi1OyOu6U0brkWLXF5v8c9EivvnSvInOZ9JHykQgui7QkqQlG66X0QQK9f8nlY8LKUScAZPOCRC4rblBIggcAKq4Db76lcsWCCmaPWkTC9AAEmlSLhCyc6gUN3mz/P3UpNi3QSAM73qzMiEH/B4gBJ1gK74eHmRO1YQihIEiCLjb7RE48xRnnH5BNTj2/KdW4CRMjX2i+8FeO2EoJSIt0TxezotIdX15g1A03RnI216R3AfVj10us3I8RvoO6eRi6IkMpIYPYqEilhac24OCkSH6Fi2yUmregfddZm/5SXki8j+X+IRgjBt5Jvks8HVH2yn0FSKeKCgOOM9L2fLGBz3SZRSYQ78T3E34ogJpXs7NeYg5th2fltrZIpYvXnSZU7G64ALl8VfKX32uuuztvRXA59LH3rbdvjW2g1GPM7AOV5Lc6RMAhVIbr0rbrEkiQ27W9QZhHX1er+3U+W6jJHW+fVrjIfnvYnxMZ4V/f0cH2hzy019RIkLZlk8GM67UjnD6mIQwVCpeVi0P7tNZh+b3pnmVZvPKnemIO5YBIkGvWclfpd7Df5s8l9745eIJqk7Ss3xMN4KW6IQLcO3htQ1xIgzL26Xw01nLE6D6GnamNGAhuuPEiErcT7wZQeEUmsOjoon0YXtjZkEisymYLAsTU12ey5IYyEf3WU2hR05+7o+0VDg4+8regSKqyotmqWjxJsSEshhRbFS5QeQxGNPRd/krYEBlmdFHSFX2fhEimLF3Qco8NkKgYaanSRvqECqk9K1bLuLXNW8R2aoLGpWVvSKT/iumgG4cdTCrbZLc4sQcX5RO7xLzfjbT4w/Y7bR7M3THASKPOD98bhxhtXOo/cI4hCkkny9YEdGrBdd2x5yiI6zLV8kBIo57+w6mvRFQMo3Bsu2NSKje/zkahe1t9J3iscX9XLRrfV9NQ+y3ZEM/J9CZIohkuyVYGaZB7X/G4AB/oVbC2LhcGM+PTqsK/JchIfXKixfxJsoTNyfB4SJ5LhAminqmXSX3jUUw5yFkRAFxLnyZfFE6vzDs1Q7djP+CfTwU4SL3ON/nbSxLovZXFysJXLV/he1fK56AcPWsRtQ4ItwX1oqaB80BIgxIXX7stFrI90f6nRieaxMo9VUYFbXXiz1D4coFjQeIu3oWLQEiTc6wZPA7QSydKaM2PIGpszfCDfbkE65c6IceEbR/HI7PdezhkPdjG9rOASJEVAI5wlEsLdOvQT4axGlOMj5U6ebnJBa66nWqhkiehHzDDqEFXoiEdd2JsuLFIQ0JgT2dnUwAE2AQCAAAAAAB/l9asBAAAAMUBH7QmMCorLSQnKygrIiIiLRUbKisfGBYaFhQQEhITCQ8JCAgICAgICAhIkpNHsTmL6Js/37O7CfsnCrMtjvWhmz71JbzD/DQ2gZrK7QxBMqSce1l6p203pJBIspf6KI/pXMl1K2aqU5aZKIir6N2TsiPSavid5C1A+yCTgEB7ba2xj4BItOeZZ8SItMbmzOGVb8KtWQ2gdat3Q6bYKV4QVScXXlVMSF5cnOSv2T5wSLFsIgguKONwqx5F/qRUaJn/2PxBRytDJfLrGRO3ohLugrKlt7jCkQoBEGaASIOV+SRkbovqoZXwtjSiT1+oJoYTZTI32YmSoUCn1stGcBmASIPShWT4DOVaZWQCprLMrM5AXqNykCuZnK0QS0ygqVIP9zTcq8HASINQTvMG4venwN3ntyYbhR7JbBrv3bGjk9N95C+G54nw5fkWusINCeW+UEiPBWzXhLEu5mW5+IGwoZHKMXb9aOVdGjpaSIjASFc8teWp8HBHmnhIj20n9SF+2M1Y/qP6Ucqsys5KdaDfiDymvvs4UCxWryckiOy5/HWf35RASJIE5mLlY8dsxlmGL21q1WAlKb8La1g9ykd/bRGh9NFsfEiD52vorynmJrqbJ273ZFANx54GxmRqbC8GRjsfPvr0vMBIkhlURKEsCqOuPcWo8WF3rT0HP6PtQm6HSCaMr4GNVSdgSJLAbl9y78KgkbWGUF4U0y/pISmVDpr4kvaLhBIXPDhw5GQzlCMpi1UjMMPoSIOiABk9JtSeqBfR18TuLnlwst4gSID5oS5ifsDAzKCArhwqEg1vxY/538+BZLioSINsBvji/vl4b2dbM4r7MhG+4ZsFaipg5AtxHn5ZOjWQjKVb6skU/JMgSI1ZH4WNlvegLWVwHVJx+uH+/wKQCI8aLVuD9VaroC1/RvSDj6GLQZP/IEgqtdabLq3AJxRPvCW3YDNTG98sJM2bra6fOvVJ1IBIF/RmEwQDCnjdsM9uCCfN2z3tF9wcKTxIFEoWIKROtBSAqhOvOQz/dqEzkRKBSA7iZfWCnO1O4TKBh51uWG1X2tKnLQAVZIBIDuAOimC9SpwilW+yQpNJEJXEU3OoSAznBJ7qtBrwZKBx+9V1XIJunpBIC/7c0QPwgdmu8KmmyZ1FSApwE315yK6iOxO2xWeG0Wq9SApwjcW/VL5ocTgi8QMDtvHoSAo3sbbjAyDz0gtG5VGWkuXUIEgJSalt4N4vVkgIa+qNV828fcT1VIyYQEgHyXIn4UTqUEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8BIB8l5yMlXwEgHyXnIyVfASAfJecjJV8A=';

/** The spoken line, so the Settings panel can show expected-vs-heard. */
export const TRANSCRIPTION_PROBE_SAMPLE_TEXT = 'This is a transcript microphone test.';

export interface TranscriptionProbeSample {
  bytes: Uint8Array;
  mime_type: string;
  filename: string;
  /** What the clip says. Travels with the bytes so no surface keeps a second
   *  copy of a sentence that would have to stay equal to this one. */
  text: string;
}

/** The clip, or `undefined` while none is bundled. */
export const transcriptionProbeSample = (): TranscriptionProbeSample | undefined => {
  if (TRANSCRIPTION_PROBE_SAMPLE_B64.length === 0) return undefined;
  return {
    bytes: Buffer.from(TRANSCRIPTION_PROBE_SAMPLE_B64, 'base64'),
    mime_type: 'audio/ogg',
    filename: 'recued-microphone-test.ogg',
    // ⛔ ONE SOURCE FOR THE EXPECTED LINE. It rides with the clip so the
    // surface never has to keep its own copy — a second copy of a sentence
    // that must equal this one is the drift this avoids.
    text: TRANSCRIPTION_PROBE_SAMPLE_TEXT,
  };
};
