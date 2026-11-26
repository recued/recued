/** Recognize an explicit JSON delivery instruction in the owner's request. */
export const requestsJsonResponse = (message: string): boolean =>
  /(?:^|[.!?\n]\s*)\s*(?:please\s+)?(?:return|reply|respond|output|write|give|provide|answer)\s+(?:(?:me|only|the\s+(?:answer|result|data))\s+)*(?:(?:as|in)\s+)?(?:(?:raw|valid|strict)\s+)?json\b/i.test(message);

/** The final answer may itself be JSON. The delivery envelope still holds text. */
export const serializeJsonResponse = (body: unknown): unknown => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const output = body as Record<string, unknown>;
  if (!Array.isArray(output.tool_calls) || output.tool_calls.length !== 0
    || output.response === null || typeof output.response !== 'object') return body;
  try { return { ...output, response: JSON.stringify(output.response) }; }
  catch { return body; }
};
