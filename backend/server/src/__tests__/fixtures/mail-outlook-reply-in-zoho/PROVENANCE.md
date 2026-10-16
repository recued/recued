# An Outlook 16 reply, received in a Zoho mailbox

`reply.eml` reproduces the STRUCTURE of a real message the owner shared on
2026-10-14 (an Outlook 16 reply, Chinese locale with English header labels,
received in a Zoho Mail mailbox, carrying a chain of earlier Zoho and Outlook
replies). Every word, name, address, number and identifier in it is new: the
correspondence itself is not in the repository.

What is kept, because it is what the tests are about:

- **The MIME tree**: `multipart/related` › (`multipart/alternative` › `text/plain`,
  `text/html`) + one `image/jpeg` with a `Content-ID` and **no
  `Content-Disposition`** — how Outlook sends a signature logo. The image bytes
  are a stand-in.
- **Outlook's HTML**: `WordSection1`, `MsoNormal` paragraphs with `lang=EN-US`
  spans, the reply's typed "Best regards / name / firm" sign-off (no signature
  container), and the reply divider —
  `border-top:solid #E1E1E1 1.0pt` around bold `From:` / `Sent:` / `To:` /
  `Subject:` — above each earlier message.
- **Zoho's quoting inside the chain**: a `border-top:solid #CCCCCC` spacer, a
  `From:` / `To:` / `Date:` / `Subject:` header block, and
  `<blockquote id="x_…blockquote_zmail">` (Outlook prefixes Zoho's ids with
  `x_` when it quotes them).
- **The logo appears only in the quoted history**, never in the reply.
- **Zoho's own `Authentication-Results` stamp** on top: `dkim=pass; spf=pass`,
  and no `dmarc=` result.
- **Outlook's plain text**: the reply, then the earlier messages under their
  header blocks, with no `>` quoting.
