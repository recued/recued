/** Lever-2 — the `tools.search` tool name, in a leaf module so BOTH
 *  `chat-orchestrator.ts` (which drops the entry from the per-turn catalog
 *  presentation on `full` turns) and `chat-tools-search.ts` (which owns the
 *  wrapper + entry) can import it without a cycle — `chat-tools-search.ts`
 *  already imports from `chat-orchestrator.ts`, so a value import back would
 *  form one. This constant has no dependencies. */
export const TOOLS_SEARCH_TOOL_NAME = 'tools.search';
