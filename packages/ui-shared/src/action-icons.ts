/** Shared action glyphs. Each path uses a 24-unit canvas and the same outline treatment.
 * Edit these native SVG paths directly; colour follows the surrounding control. */
const glyph = (label: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}">${body}</svg>`;

export const ACTION_ICONS = {
  "reply": glyph("Reply", "<path d=\"m9 7-5 5 5 5M4 12h11a5 5 0 0 1 5 5v1\"/>"),
  "reply-all": glyph("Reply all", "<path d=\"m6 7-5 5 5 5m6-10-5 5 5 5M7 12h8a5 5 0 0 1 5 5v1\"/>"),
  "forward": glyph("Forward", "<path d=\"m15 7 5 5-5 5m5-5H9a5 5 0 0 0-5 5v1\"/>"),
  "refresh": glyph("Refresh", "<path d=\"M20 4v6h-6M4 20v-6h6M5.4 8A7 7 0 0 1 17 5l3 5M4 14l3 5a7 7 0 0 0 11.6-3\"/>"),
  "close": glyph("Close", "<path d=\"m6 6 12 12M18 6 6 18\"/>"),
  "more": glyph("More actions", "<circle cx=\"5\" cy=\"12\" r=\"1\" fill=\"currentColor\"/><circle cx=\"12\" cy=\"12\" r=\"1\" fill=\"currentColor\"/><circle cx=\"19\" cy=\"12\" r=\"1\" fill=\"currentColor\"/>"),
  "attach": glyph("Attach file", "<path d=\"m21 12-8 8a6 6 0 0 1-8.5-8.5L13 3a4 4 0 0 1 5.7 5.7l-8.5 8.5a2 2 0 0 1-2.8-2.8l7.8-7.8\"/>"),
  "send": glyph("Send", "<path d=\"m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3\"/>"),
  "save": glyph("Save", "<path d=\"M5 3h12l4 4v14H3V3h2Z\"/><path d=\"M7 3v6h10V3M7 21v-8h10v8\"/>"),
  "download": glyph("Download", "<path d=\"M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4\"/>"),
  "copy": glyph("Copy", "<rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\"/><path d=\"M15 9V4H4v11h5\"/>"),
  "mailbox": glyph("Save to mailbox", "<path d=\"M12 3v9m-3-3 3 3 3-3M5 8l-2 6v6h18v-6l-2-6M3 14h5l2 3h4l2-3h5\"/>"),
  "schedule": glyph("Schedule", "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>"),
  "rename": glyph("Rename", "<path d=\"m4 16 12-12 4 4L8 20l-5 1 1-5ZM14 6l4 4\"/>"),
  "delete": glyph("Delete", "<path d=\"M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7\"/>"),
  "undo": glyph("Undo", "<path d=\"M3 4v6h6M3 10a8 8 0 1 1 1 8\"/>"),
  "link": glyph("Connect", "<path d=\"M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2\"/>"),
  "unlink": glyph("Disconnect", "<path d=\"m7 7-3 3a5 5 0 0 0 7 7l2-2m4 2 3-3a5 5 0 0 0-7-7l-2 2M3 3l18 18\"/>"),
  "sign-out": glyph("Sign out", "<path d=\"M10 4H4v16h6m5-12 4 4-4 4m-6-4h10\"/>"),
  "external-link": glyph("Open external page", "<path d=\"M14 3h7v7m0-7L11 13m-1-8H3v16h16v-7\"/>"),
  "shield-alert": glyph("Key security", "<path d=\"m12 3-8 3v6c0 4.5 8 9 8 9s8-4.5 8-9V6l-8-3ZM12 8v5m0 4h.01\"/>"),
  "upload": glyph("Upload", "<path d=\"M12 15V3m-5 5 5-5 5 5M5 16v4h14v-4\"/>"),
  "pause": glyph("Pause", "<path d=\"M8 5v14m8-14v14\"/>"),
} as const;
