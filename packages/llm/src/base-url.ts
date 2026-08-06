/** Join a user-supplied `base_url` to an adapter's versioned path exactly once.
 *
 *  ⛔ THE DEFECT THIS FIXES. Every adapter did
 *  `${base_url.replace(/\/+$/, '')}/v1/chat/completions`, which assumes the
 *  user's `base_url` STOPS BEFORE the version segment. Most vendors document it
 *  the other way — the URL you are told to paste already ends in the version:
 *
 *      Groq       https://api.groq.com/openai/v1
 *      DashScope  https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *      Ollama     http://localhost:11434/v1
 *      vLLM       http://host:8000/v1
 *
 *  Paste any of those and the request goes to `…/v1/v1/chat/completions`. The
 *  provider answers 404, the executor reports `LLM error (404)` with an empty
 *  body, and the user sees a chat turn that produced nothing — with no hint
 *  that a duplicated path segment is the cause. Found by driving a real turn
 *  against a DashScope-hosted Qwen slot in the horizon audit.
 *
 *  🔑 The append is now IDEMPOTENT in the segment: a base that already ends in
 *  the version keeps working, and a base that does not is unchanged. Both
 *  conventions resolve to the same URL, so there is no wrong way to enter it.
 *
 *  ⚠ Only a TRAILING version segment is stripped, and only when it is a whole
 *  path segment. A host like `https://v1.example.com` or a path like
 *  `https://host/v10` is untouched — the match is on `/<version>` at the end,
 *  not a substring. */
export const joinApiBase = (base: string, versionSegment: string): string => {
  const trimmed = base.replace(/\/+$/, '');
  const suffix = `/${versionSegment}`;
  // Case-insensitive: a pasted `/V1` is the same endpoint to every provider
  // here, and failing on capitalisation would be the same unhelpful 404.
  return trimmed.toLowerCase().endsWith(suffix.toLowerCase())
    ? trimmed.slice(0, -suffix.length)
    : trimmed;
};
