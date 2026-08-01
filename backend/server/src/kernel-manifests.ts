// AUTO-INLINED kernel ingredient manifests — kernel/community separation.
//
// The kernel ingredients (author=recued kernel substrate + the core-* anti-shadow
// capabilities), moved OUT of community/ingredients so the kernel substrate (a) ships in the server
// bundle — community/ is NOT copied into the production runtime image — and (b) can never leak into
// the marketplace ingredient listing. This file is now the source of truth; edit a manifest here.
import type { IngredientManifest } from '@recued/contracts';

const MANIFESTS = [
  {
    "slug": "ai-classify",
    "name": "AI Classifier",
    "description": "Picks one category from a provided list that best fits the input data. Returns the chosen category, a confidence score (0-1), and a one-sentence reasoning. Use this when you need the LLM to pick a label from a closed set — e.g., deal health tier, intent bucket, risk level — rather than write free-form text.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "classification",
      "labeling"
    ],
    "input": {
      "llm.data": null,
      "llm.categories": null,
      "llm.context": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "category": "category",
      "confidence": "confidence",
      "reasoning": "reasoning"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-compare",
    "name": "AI Comparator",
    "description": "Compares two pieces of data and produces a structured diff: concrete differences, concrete similarities, and a one-sentence recommendation. Optional llm.dimensions array focuses the comparison (e.g. ['price', 'features', 'support']). Use this for competitor analysis, proposal comparisons, and A/B recommendations.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "comparison",
      "analysis"
    ],
    "input": {
      "llm.data_a": null,
      "llm.data_b": null,
      "llm.dimensions": null,
      "llm.model_hint": null
    },
    "output": {
      "differences": "differences",
      "similarities": "similarities",
      "recommendation": "recommendation"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "source_b_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-extract",
    "name": "AI Field Extractor",
    "description": "Extracts a caller-specified set of fields from unstructured input (email body, meeting transcript, document, etc.) into a flat object. Fields not present in the source are returned as null — the LLM is instructed never to invent values. Returns an object whose keys match the llm.fields input array — access fields directly as {{step.extract.FIELD_NAME}} in recipes. Use this for parsing signatures, pulling deal terms out of emails, or any structured extraction task.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "extraction",
      "parsing"
    ],
    "input": {
      "llm.data": null,
      "llm.fields": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "extracted": "dynamic_fields_per_llm_fields_input"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-generate",
    "name": "AI Content Generator",
    "description": "Generates a piece of content from supplied data and a template_type (e.g. 'email', 'meeting_agenda', 'case_study', 'follow_up'). Optional llm.tone (default 'neutral') steers voice. Returns a single 'content' field ready for display or copy-paste. Use this when the recipe needs to draft text grounded in CRM data.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "generation",
      "drafting"
    ],
    "input": {
      "llm.data": null,
      "llm.template_type": null,
      "llm.tone": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "content": "content"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "accept_noise_floor",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash",
        "template_hash"
      ],
      "regen_triggers": [
        "source_change",
        "template_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-prompt",
    "name": "AI Custom Prompt",
    "description": "Uncontracted escape hatch for cases where none of the structured AI functions fit. The recipe supplies a raw llm.system_prompt and llm.prompt; the executor passes them straight through to the configured LLM and returns whatever comes back (parsed as JSON if llm.output_format is 'json', otherwise as plain text). Use this as a last resort — prefer ai-classify, ai-score, ai-extract, ai-summarize, ai-sentiment, ai-compare, ai-generate, ai-translate, or ai-rewrite whenever one of them fits the job.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "prompt",
      "freeform"
    ],
    "input": {
      "llm.system_prompt": null,
      "llm.prompt": null,
      "llm.instruction_block": null,
      "llm.data_block": null,
      "llm.output_format": null,
      "llm.model_hint": null,
      "llm.allow_search": null
    },
    "output": {
      "result": "result"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "configurable",
      "dedup_key": [
        "source_record_hash",
        "prompt_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "prompt_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-rewrite",
    "name": "AI Rewriter",
    "description": "Rewrites input text in a specified style (e.g. 'formal', 'friendly', 'concise', 'executive_summary') while preserving the original meaning. Optional llm.instructions add specific constraints like 'keep under 150 words' or 'remove technical jargon'. Use this for email tone adjustment, proposal cleanup, and content polishing.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "rewriting",
      "editing"
    ],
    "input": {
      "llm.data": null,
      "llm.style": null,
      "llm.instructions": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "rewritten": "rewritten"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "accept_noise_floor",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash",
        "style_hash"
      ],
      "regen_triggers": [
        "source_change",
        "style_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-score",
    "name": "AI Scorer",
    "description": "Scores input data against a list of criteria on a configurable scale. Returns an overall score (average, one decimal), a per-criterion breakdown with individual scores and short notes, and a 2-3 sentence reasoning. Use this for health scores, risk assessments, fit evaluations, and any task where the end user wants a numeric assessment with an explanation.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "scoring",
      "evaluation"
    ],
    "input": {
      "llm.data": null,
      "llm.criteria": null,
      "llm.scale": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "score": "score",
      "breakdown": "breakdown",
      "reasoning": "reasoning"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-sentiment",
    "name": "AI Sentiment Analyzer",
    "description": "Classifies the overall sentiment of input text as positive, neutral, or negative, with a numeric score between -1 and 1 and a list of short signal phrases that justified the verdict. Use this on customer emails, support replies, review text, or NPS comments to flag escalations or highlight wins.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "sentiment",
      "analysis"
    ],
    "input": {
      "llm.data": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "sentiment": "sentiment",
      "score": "score",
      "signals": "signals"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-summarize",
    "name": "AI Summarizer",
    "description": "Produces a short summary (length configurable via llm.max_length, default 200 words) and 3-5 extracted key points from long-form input such as meeting notes, thread transcripts, or support tickets. Optional llm.focus steers the summary toward a specific angle (e.g. 'risks and blockers', 'customer needs').",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "summarization",
      "synthesis"
    ],
    "input": {
      "llm.data": null,
      "llm.max_length": null,
      "llm.focus": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "summary": "summary",
      "key_points": "key_points"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "accept_noise_floor",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-translate",
    "name": "AI Translator",
    "description": "Translates input text into the specified target_language (either a natural name like 'French' or an ISO 639-1 code). Returns the translated text, the detected source language as an ISO 639-1 code, and a confidence score. Use this for inbound localization, cross-border outreach, and multilingual support workflows.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "translation",
      "localization"
    ],
    "input": {
      "llm.data": null,
      "llm.target_language": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "translated": "translated",
      "source_language": "source_language",
      "confidence": "confidence"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash",
        "target_lang"
      ],
      "regen_triggers": [
        "source_change",
        "lang_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "ai-embed",
    "name": "AI Embed",
    "description": "Compute an embedding vector for input text. Routes to the dedicated embeddings slot configured in Settings → AI/Models (OpenAI text-embedding-3-* / Google text-embedding-004 / an openai-compatible endpoint). Returns the float vector, its dimensions, and the provider's model identifier. Anthropic does not publish a public embeddings model — configure an OpenAI / Google / openai-compatible provider on the embeddings slot.",
    "author": "recued",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "ai",
      "embeddings",
      "vector"
    ],
    "input": {
      "llm.data": null,
      "llm.dimensions": null
    },
    "output": {
      "vector": "vector",
      "dimensions": "dimensions",
      "model": "model"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "model_id"
      ],
      "regen_triggers": [
        "source_change",
        "model_change",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-embed",
    "name": "AI Embed",
    "description": "Compute an embedding vector for input text. Routes to the dedicated embeddings slot configured in Settings → AI/Models (OpenAI text-embedding-3-* / Google text-embedding-004 / an openai-compatible endpoint). Returns the float vector, its dimensions, and the provider's model identifier. Anthropic does not publish a public embeddings model — configure an OpenAI / Google / openai-compatible provider on the embeddings slot.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "embeddings",
      "vector"
    ],
    "input": {
      "llm.data": null,
      "llm.dimensions": null
    },
    "output": {
      "vector": "vector",
      "dimensions": "dimensions",
      "model": "model"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "model_id"
      ],
      "regen_triggers": [
        "source_change",
        "model_change",
        "manual"
      ]
    }
  },
  {
    "slug": "annotation-create",
    "name": "Create or replace an annotation",
    "description": "Recipe-friendly write into the annotations sidecar. Accepts `target` as a combined `<collection>:<id>` string (e.g., `data.contact:jane@acme.com`) — the kernel adapter splits on the colon. `key` follows canonical-shapes.md (snake_case, dotted hierarchy ok), `value` is any JSON; optional `confidence` (0–1) is folded into the stored value as `{ value, confidence }` so consumers reading per-record refs see both. Idempotent on (target, key): re-runs replace the prior row's value rather than appending — engine deletes the previous annotation row before insert. Engine stamps source / recipe / model hashes for staleness; `recipe_hash` + `source_record_hash` are required wire-side. Routes via the paired server's `annotation.write` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "annotation",
      "warehouse",
      "write",
      "graph-builder"
    ],
    "input": {
      "target": null,
      "key": null,
      "value": null,
      "confidence": null,
      "authored_by_recipe_id": null,
      "source_record_hash": null,
      "recipe_hash": null,
      "model_used": null
    },
    "output": {
      "annotation_id": "annotation_id",
      "annotation": "annotation"
    }
  },
  {
    "slug": "annotation-delete",
    "name": "Delete annotations by filter",
    "description": "Bulk-delete annotations matching the filter. AT LEAST ONE filter field is required — refuses an empty filter to guard against accidental table-wipe. Returns the number of rows removed. Routes via the paired server's `annotation.delete` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "annotation",
      "warehouse",
      "delete"
    ],
    "input": {
      "target_collection": null,
      "target_id": null,
      "key": null,
      "authored_by_recipe_id": null,
      "since": null,
      "until": null
    },
    "output": {
      "ok": "ok",
      "deleted": "deleted"
    }
  },
  {
    "slug": "annotation-list",
    "name": "List annotations",
    "description": "Bulk-read annotations from the warehouse. Filters AND together; absent fields don't restrict. Indexes cover (target_collection, target_id) for per-record queries and (key) for cross-record bulk queries. Routes via the paired server's `annotation.list` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "annotation",
      "warehouse",
      "list"
    ],
    "input": {
      "target_collection": null,
      "target_id": null,
      "key": null,
      "authored_by_recipe_id": null,
      "since": null,
      "until": null,
      "limit": null
    },
    "output": {
      "annotations": "annotations"
    }
  },
  {
    "slug": "annotation-search",
    "name": "Full-text search across annotations",
    "description": "Run a SQLite FTS5 query against annotation values. Optional filters narrow by key or target_collection. Values larger than 64 KB (CAS-backed) are NOT indexed — documented limit, same as the shared store. Routes via the paired server's `annotation.search` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "annotation",
      "warehouse",
      "search",
      "fts"
    ],
    "input": {
      "query": null,
      "key": null,
      "target_collection": null,
      "limit": null
    },
    "output": {
      "matches": "matches"
    }
  },
  {
    "slug": "calendar-create",
    "name": "Create an event on a warehouse calendar collection",
    "description": "Push a new event to the provider on the named calendar instance, then reflect the verified canonical event back into the warehouse. Not idempotent — re-fire creates duplicates; authors that might re-fire dedupe via `shared.*` snapshots keyed by `ical_uid`. Returns `{ source_id, ical_uid }` on verified success. Rejects with `CALENDAR_CAPABILITY_DENIED` when caps lack `create_event`, `CALENDAR_QUOTA_EXCEEDED` on provider 429, `CALENDAR_IO_ERROR` for network / 5xx (outcome unknown — may have landed on the provider; the next sync tick reflects whatever actually happened).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "create"
    ],
    "input": {
      "slug": null,
      "calendar_id": null,
      "event": null
    },
    "output": {
      "source_id": "source_id",
      "ical_uid": "ical_uid"
    },
    "writes": {
      "collection": "calendar",
      "id_output_field": "source_id"
    }
  },
  {
    "slug": "calendar-delete",
    "name": "Delete an event from a warehouse calendar collection",
    "description": "Remove one event from the provider on the named calendar instance, then drop the warehouse row on verified success. Idempotent at the provider — re-invoking on a deleted event throws `CALENDAR_EVENT_NOT_FOUND`. `scope` controls recurring-series semantics: `'this_instance'` (default) deletes one occurrence; `'this_and_future'` truncates the series (gcal/graph only); `'series'` removes the master and every override. Returns `{ deleted: true, source_id }` on success (`source_id` echoes the removed event so callers + the D-120 provenance link can name it after the row is gone).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "destructive",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "delete"
    ],
    "input": {
      "slug": null,
      "source_id": null,
      "scope": null
    },
    "output": {
      "deleted": "deleted",
      "source_id": "source_id"
    },
    "writes": {
      "collection": "calendar",
      "id_output_field": "source_id"
    }
  },
  {
    "slug": "calendar-get",
    "name": "Fetch one event from a warehouse calendar collection",
    "description": "Return the full canonical event JSON for the given `source_id` on the named calendar instance. Reads the warehouse only — the adapter is never consulted. Missing events return `{ record: null }`; use `calendar-stat` first when the caller wants to branch on existence without paying for the JSON payload. Recipes typically pair `calendar-list` (rows) with `calendar-get` (full payload for transform / ai-summarize).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "get"
    ],
    "input": {
      "slug": null,
      "source_id": null
    },
    "output": {
      "record": "record"
    }
  },
  {
    "slug": "calendar-list",
    "name": "List events from a warehouse calendar collection",
    "description": "Read hot-field rows from `data.calendar.{slug}.*` ordered by `start_at` ascending. Filters: `calendar_id` (target one calendar on the account), `since` / `until` (unix-ms range on `start_at`), `status` ('confirmed' | 'cancelled' | 'tentative'). Returns metadata only — descriptions and attendee detail come from `calendar-get`. Reads the warehouse only; the adapter is never consulted on this path. Returns empty when no events match the filter.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "list"
    ],
    "input": {
      "slug": null,
      "calendar_id": null,
      "since": null,
      "until": null,
      "status": null,
      "limit": null
    },
    "output": {
      "records": "records"
    }
  },
  {
    "slug": "calendar-rsvp",
    "name": "Respond to a calendar invitation on the signed-in user's behalf",
    "description": "Submit an RSVP (`accepted` / `declined` / `tentative`) for the signed-in user on one event of the named calendar instance, then reflect the verified canonical event (with the updated attendee row) back into the warehouse. Rejects with `CALENDAR_ATTENDEE_NOT_SELF` when the user isn't an attendee, `CALENDAR_CAPABILITY_DENIED` when caps lack `rsvp` (CalDAV servers without iTIP support land here). Optional `comment` rides on the iTIP REPLY where the provider supports it (gcal yes, graph no).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "rsvp"
    ],
    "input": {
      "slug": null,
      "source_id": null,
      "response": null,
      "comment": null
    },
    "output": {
      "source_id": "source_id",
      "response_status": "response_status"
    }
  },
  {
    "slug": "calendar-search",
    "name": "Full-text search across warehouse calendar events",
    "description": "Run a SQLite FTS5 query over `summary` + `description` + `location` for events on the named calendar instance. Returns ranked hot-field rows with snippet (lower rank = better; FTS5 BM25). Descriptions above 64 KB are stored in CAS and NOT FTS-indexed (documented limit matching mail / shared). Pair with `calendar-get` to fetch the hit's full payload. Rejects with `CALENDAR_CAPABILITY_DENIED` when the adapter reports `search: 'none'`.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "search",
      "fts"
    ],
    "input": {
      "slug": null,
      "query": null,
      "limit": null
    },
    "output": {
      "matches": "matches"
    }
  },
  {
    "slug": "calendar-stat",
    "name": "Stat one event in a warehouse calendar collection",
    "description": "Cheap metadata read for a single event on the named calendar instance — `{ exists, start_at?, end_at?, status?, attendee_count?, last_modified_at? }`. Missing events surface as `{ exists: false }` (not an error) so recipes can use calendar-stat as a presence probe without try/catch. Other adapter failures (permission, IO) propagate as typed errors.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "stat"
    ],
    "input": {
      "slug": null,
      "source_id": null
    },
    "output": {
      "exists": "exists",
      "start_at": "start_at",
      "end_at": "end_at",
      "status": "status",
      "attendee_count": "attendee_count",
      "last_modified_at": "last_modified_at"
    }
  },
  {
    "slug": "calendar-update",
    "name": "Patch an event on a warehouse calendar collection",
    "description": "Apply a partial patch to one event on the named calendar instance, then reflect the verified canonical event back into the warehouse. Idempotent at the provider level — repeating a no-op patch is safe. `scope` controls recurring-series semantics: `'this_instance'` (default) edits one occurrence; `'this_and_future'` truncates the master series and creates a new one starting at this instance (gcal/graph only — caldav rejects with `CALENDAR_RRULE_UNSUPPORTED`); `'series'` patches the master RRULE. Returns `{ source_id }` on verified success.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "calendar",
      "warehouse",
      "update"
    ],
    "input": {
      "slug": null,
      "source_id": null,
      "patch": null,
      "scope": null
    },
    "output": {
      "source_id": "source_id"
    },
    "writes": {
      "collection": "calendar",
      "id_output_field": "source_id"
    }
  },
  {
    "slug": "calendar-watcher",
    "name": "Calendar Watcher",
    "description": "Reads the server warehouse `data.calendar.*` collection with two modes: `starting_soon` fires when one or more events start within the next `minutes_ahead` window (paired with a recurring auto_run cadence for meeting-reminder recipes); `changed_since` fires when events were created, updated, or deleted after the stored cursor. Metadata-only — attendee lists and descriptions never leave the warehouse.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "calendar",
      "warehouse",
      "trigger"
    ],
    "input": {
      "kind": null,
      "minutes_ahead": null,
      "since": null,
      "limit": null
    },
    "output": {
      "should_run": "should_run",
      "items": "items",
      "last_seen_at": "last_seen_at"
    }
  },
  {
    "slug": "commitment-cancel",
    "name": "Cancel commitment",
    "description": "Move a commitment's lifecycle_state to 'cancelled'. Allowed from 'pending' or 'expired'. Terminal lifecycle states (already 'fulfilled' / 'cancelled') reject the move. Stamps state_changed_at + lifecycle_changed_at.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "commitment",
      "work-entity",
      "lifecycle"
    ],
    "input": {
      "id": null,
      "cancelled_at": null
    },
    "output": {
      "commitment": "commitment"
    }
  },
  {
    "slug": "commitment-create",
    "name": "Create commitment",
    "description": "Create a commitment on the chosen Source. lifecycle_state defaults to 'pending'; due_status is derived from promised_for_at (no_deadline / not_due) at create time. expiry_policy defaults to 'escalate_overdue' so monetary + counterparty commitments escalate at the deadline instead of silently expiring (§ A.1.3 invariant). Returns the canonical commitment record.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "commitment",
      "work-entity",
      "write"
    ],
    "input": {
      "direction": null,
      "statement": null,
      "derivation": null,
      "promised_at": null,
      "promised_for_at": null,
      "expiry_policy": null,
      "derivation_confidence": null,
      "monetary_value": null,
      "counterparty_contact_id": null,
      "derived_from_mail_thread_id": null,
      "derived_from_meeting_id": null,
      "blocks_task_ids": null,
      "blocks_project_ids": null,
      "source_id": null,
      "evidence_blob": null
    },
    "output": {
      "commitment": "commitment"
    }
  },
  {
    "slug": "commitment-propose",
    "name": "Propose commitment",
    "description": "Create a commitment through the review-then-approve PROPOSAL surface (D-192 F1). Same input + mint effect as commitment-create, but the slug rides the commitment-proposal approval LIFT (op-risk-admission.ts): the dispatch HOLDS at the D-157 gate for EVERY actor — including unattended system fires — and the commitment mints only when the owner approves (optionally editing statement / deadline / direction / counterparty in the D-173 inbox first). The commitment-evidence capture producer is the primary caller; a recipe may also propose-for-review deliberately.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "commitment",
      "work-entity",
      "write",
      "proposal"
    ],
    "input": {
      "direction": null,
      "statement": null,
      "derivation": null,
      "promised_at": null,
      "promised_for_at": null,
      "expiry_policy": null,
      "derivation_confidence": null,
      "monetary_value": null,
      "counterparty_contact_id": null,
      "derived_from_mail_thread_id": null,
      "derived_from_meeting_id": null,
      "blocks_task_ids": null,
      "blocks_project_ids": null,
      "source_id": null,
      "evidence_blob": null
    },
    "output": {
      "commitment": "commitment"
    }
  },
  {
    "slug": "commitment-fulfill",
    "name": "Fulfill commitment",
    "description": "Move a commitment's lifecycle_state to 'fulfilled'. Allowed from 'pending' always; from 'expired' only when expiry_policy is 'escalate_overdue' or 'indefinite' (the load-bearing § A.1.3 invariant — strict_expire commitments stay terminal at the deadline). Stamps state_changed_at + lifecycle_changed_at.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "commitment",
      "work-entity",
      "lifecycle"
    ],
    "input": {
      "id": null,
      "fulfilled_at": null
    },
    "output": {
      "commitment": "commitment"
    }
  },
  {
    "slug": "commitment-update",
    "name": "Update commitment",
    "description": "Patch metadata fields on an existing commitment. lifecycle_state and due_status are NOT mutable here — use commitment-fulfill / commitment-cancel for lifecycle moves; the substrate's due_status sweep tracks deadline crossings. Source identity is inherited from the row.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "commitment",
      "work-entity",
      "write"
    ],
    "input": {
      "id": null,
      "statement": null,
      "promised_for_at": null,
      "expiry_policy": null,
      "monetary_value": null,
      "counterparty_contact_id": null,
      "derivation_confidence": null,
      "blocks_task_ids": null,
      "blocks_project_ids": null
    },
    "output": {
      "commitment": "commitment"
    }
  },
  {
    "slug": "connection",
    "name": "Connection (direct)",
    "description": "Direct adapter access for outbound api / mcp / notification calls keyed off enrolled connection records. High-trust escape hatch for recipes that need to call a specific connection record without going through a wrapper ingredient (slack-post, ticket-reader-hubspot, mcp-tool-call-<vendor>, etc.). Gated by `connection.direct` permission + admin risk_tier — Kitchen blocks recipes from binding this without explicit author intent. Wrapper ingredients with `kind: 'connection'` route through the same adapter at engine dispatch but carry their own per-call permission + risk_tier; this manifest only fronts the unwrapped direct-call path. Per-kind shape lives flat on the recipe step input (e.g. `method` / `path` / `query.<k>` for api; `mcp.tool` / `mcp.args` for mcp; `text` / `title` / `link_url` for notification) — recipe authors using a wrapper never see this layer.",
    "author": "recued",
    "kind": "connection",
    "version": 1,
    "category": "action",
    "risk_tier": "admin",
    "permission": "connection.direct",
    "tags": [
      "kernel",
      "connection",
      "advanced"
    ],
    "input": {
      "connection_kind": null,
      "connection": null,
      "params": null
    },
    "output": {
      "result": "result",
      "status": "status",
      "headers": "headers"
    }
  },
  {
    "slug": "connection-mcp-read",
    "name": "MCP Tool Call (read)",
    "description": "Kernel dispatch surface for a READ-classified tool on an enrolled MCP connection (D-177 P2b). Backs the chat Tier-3 path: the chat agent's `<connection>.<tool>` call routes through the run-ingredient kernel recipe onto this manifest, so the commit Gateway stamps the action envelope and the policy verdict applies like every other dispatch. The read tier is not self-declared at call time — the server's connection-adapter gate re-checks the user's per-tool classification (Settings → Connections → Tools) at dispatch and refuses any tool the user has not enabled and classified 'read' (MCP_TOOL_NOT_CLASSIFIED). connection_kind is pinned to 'mcp' by the same gate. Recipes may bind this directly, subject to the identical classification gate; for unclassified tools use the admin-tier `connection` escape hatch.",
    "author": "recued",
    "kind": "connection",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "permission": "connection.mcp_tool",
    "tags": [
      "kernel",
      "connection",
      "mcp",
      "chat"
    ],
    "input": {
      "connection_kind": "mcp",
      "connection": null,
      "tool": null,
      "args": {}
    },
    "output": {
      "result": "result"
    }
  },
  {
    "slug": "connection-mcp-write",
    "name": "MCP Tool Call (write)",
    "description": "Kernel dispatch surface for a WRITE-classified tool on an enrolled MCP connection (D-177 P2b). Backs the chat Tier-3 path: the chat agent's `<connection>.<tool>` call routes through the run-ingredient kernel recipe onto this manifest, so the commit Gateway stamps the action envelope and the policy verdict applies like every other dispatch — and because this slug is in OUTBOUND_SEND_INGREDIENT_SLUGS, an attended user_self dispatch is lifted to a preflight ask: a write-classified external tool call holds for approval instead of dispatching immediately (the D-177 N.12 hole closure). The server's connection-adapter gate re-checks the user's per-tool classification (Settings → Connections → Tools) at dispatch and refuses any tool the user has not enabled and classified (MCP_TOOL_NOT_CLASSIFIED); read-classified tools pass (over-gating is safe). connection_kind is pinned to 'mcp' by the same gate. Recipes may bind this directly, subject to the identical gates; for unclassified tools use the admin-tier `connection` escape hatch.",
    "author": "recued",
    "kind": "connection",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "permission": "connection.mcp_tool",
    "tags": [
      "kernel",
      "connection",
      "mcp",
      "chat"
    ],
    "input": {
      "connection_kind": "mcp",
      "connection": null,
      "tool": null,
      "args": {}
    },
    "output": {
      "result": "result"
    }
  },
  {
    "slug": "contact-resolve",
    "name": "Resolve a contact",
    "description": "Resolve a local contact_id from a single identifier — email, phone, alias, or a { platform, id } pair. Routes via the paired server's `contact.resolve` rpc; exactly one identifier must be supplied (zero or more than one is a bad_request the handler raises). The email path walks the D-138 merged_into chain so a stale post-merge address still surfaces the surviving canonical contact. Read-only — never writes data.contact. Returns { contact_id, confidence, alternatives, contact }: contact_id is null on a miss (with alternatives carrying candidate contact_ids for an ambiguous phone / alias lookup); confidence is 0 on a miss and up to 1.0 on a confident hit; contact is the full record when resolved. Pairs with contact-upsert — upsert writes the row, resolve reads an identifier back to its contact_id (e.g. to attach an extracted counterparty email to a commitment).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "contact",
      "warehouse",
      "read",
      "resolver"
    ],
    "input": {
      "email": "",
      "phone": "",
      "alias": "",
      "platform_id": ""
    },
    "output": {
      "contact_id": "contact_id",
      "confidence": "confidence",
      "alternatives": "alternatives",
      "contact": "contact"
    }
  },
  {
    "slug": "contact-upsert",
    "name": "Upsert a contact",
    "description": "Idempotent upsert into data.contact keyed on the canonical email. Supplied display_name + last_interaction + first_seen merge with the existing row when present (first-seen-wins on first_seen, latest-wins on last_interaction). Routes via the paired server's `contact.upsert` rpc; the underlying ContactStore canonicalizes the email (lowercases, strips +suffix per RFC 5322 conventions) before the upsert.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "contact",
      "warehouse",
      "write",
      "graph-builder"
    ],
    "input": {
      "email": null,
      "display_name": null,
      "last_interaction": null,
      "first_seen": null
    },
    "output": {
      "contact": "contact"
    }
  },
  {
    "slug": "core-ai-classify",
    "name": "AI Classifier",
    "description": "Picks one category from a provided list that best fits the input data. Returns the chosen category, a confidence score (0-1), and a one-sentence reasoning. Use this when you need the LLM to pick a label from a closed set — e.g., deal health tier, intent bucket, risk level — rather than write free-form text.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "classification",
      "labeling"
    ],
    "input": {
      "llm.data": null,
      "llm.categories": null,
      "llm.context": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "category": "category",
      "confidence": "confidence",
      "reasoning": "reasoning"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-compare",
    "name": "AI Comparator",
    "description": "Compares two pieces of data and produces a structured diff: concrete differences, concrete similarities, and a one-sentence recommendation. Optional llm.dimensions array focuses the comparison (e.g. ['price', 'features', 'support']). Use this for competitor analysis, proposal comparisons, and A/B recommendations.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "comparison",
      "analysis"
    ],
    "input": {
      "llm.data_a": null,
      "llm.data_b": null,
      "llm.dimensions": null,
      "llm.model_hint": null
    },
    "output": {
      "differences": "differences",
      "similarities": "similarities",
      "recommendation": "recommendation"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "source_b_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-extract",
    "name": "AI Field Extractor",
    "description": "Extracts a caller-specified set of fields from unstructured input (email body, meeting transcript, document, etc.) into a flat object. Fields not present in the source are returned as null — the LLM is instructed never to invent values. Returns an object whose keys match the llm.fields input array — access fields directly as {{step.extract.FIELD_NAME}} in recipes. Use this for parsing signatures, pulling deal terms out of emails, or any structured extraction task.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "extraction",
      "parsing"
    ],
    "input": {
      "llm.data": null,
      "llm.fields": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "extracted": "dynamic_fields_per_llm_fields_input"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-generate",
    "name": "AI Content Generator",
    "description": "Generates a piece of content from supplied data and a template_type (e.g. 'email', 'meeting_agenda', 'case_study', 'follow_up'). Optional llm.tone (default 'neutral') steers voice. Returns a single 'content' field ready for display or copy-paste. Use this when the recipe needs to draft text grounded in CRM data.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "generation",
      "drafting"
    ],
    "input": {
      "llm.data": null,
      "llm.template_type": null,
      "llm.tone": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "content": "content"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "accept_noise_floor",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash",
        "template_hash"
      ],
      "regen_triggers": [
        "source_change",
        "template_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-prompt",
    "name": "AI Custom Prompt",
    "description": "Publishable kernel variant of the uncontracted free-prompt escape hatch (§5 core capability). The recipe supplies a raw llm.system_prompt and llm.prompt; the executor passes them straight through to the configured LLM and returns whatever comes back (parsed as JSON if llm.output_format is 'json', otherwise as plain text). Unlike the bundled `ai-prompt`, this variant carries NO web-search egress: `llm.allow_search` is omitted here and is IGNORED — forced off by the LLM executor for every core- AI slug regardless of caller input — so a published recipe can transform already-gated data but cannot open a new egress path. Prefer ai-classify, ai-score, ai-extract, ai-summarize, ai-sentiment, ai-compare, ai-generate, ai-translate, or ai-rewrite whenever one of them fits the job.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "prompt",
      "freeform",
      "core"
    ],
    "input": {
      "llm.system_prompt": null,
      "llm.prompt": null,
      "llm.instruction_block": null,
      "llm.data_block": null,
      "llm.output_format": null,
      "llm.model_hint": null,
      "llm.allow_search": null
    },
    "output": {
      "result": "result"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "configurable",
      "dedup_key": [
        "source_record_hash",
        "prompt_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "prompt_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-rewrite",
    "name": "AI Rewriter",
    "description": "Rewrites input text in a specified style (e.g. 'formal', 'friendly', 'concise', 'executive_summary') while preserving the original meaning. Optional llm.instructions add specific constraints like 'keep under 150 words' or 'remove technical jargon'. Use this for email tone adjustment, proposal cleanup, and content polishing.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "rewriting",
      "editing"
    ],
    "input": {
      "llm.data": null,
      "llm.style": null,
      "llm.instructions": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "rewritten": "rewritten"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "accept_noise_floor",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash",
        "style_hash"
      ],
      "regen_triggers": [
        "source_change",
        "style_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-score",
    "name": "AI Scorer",
    "description": "Scores input data against a list of criteria on a configurable scale. Returns an overall score (average, one decimal), a per-criterion breakdown with individual scores and short notes, and a 2-3 sentence reasoning. Use this for health scores, risk assessments, fit evaluations, and any task where the end user wants a numeric assessment with an explanation.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "scoring",
      "evaluation"
    ],
    "input": {
      "llm.data": null,
      "llm.criteria": null,
      "llm.scale": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "score": "score",
      "breakdown": "breakdown",
      "reasoning": "reasoning"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-sentiment",
    "name": "AI Sentiment Analyzer",
    "description": "Classifies the overall sentiment of input text as positive, neutral, or negative, with a numeric score between -1 and 1 and a list of short signal phrases that justified the verdict. Use this on customer emails, support replies, review text, or NPS comments to flag escalations or highlight wins.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "sentiment",
      "analysis"
    ],
    "input": {
      "llm.data": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "sentiment": "sentiment",
      "score": "score",
      "signals": "signals"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "drift_significant",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-summarize",
    "name": "AI Summarizer",
    "description": "Produces a short summary (length configurable via llm.max_length, default 200 words) and 3-5 extracted key points from long-form input such as meeting notes, thread transcripts, or support tickets. Optional llm.focus steers the summary toward a specific angle (e.g. 'risks and blockers', 'customer needs').",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "summarization",
      "synthesis"
    ],
    "input": {
      "llm.data": null,
      "llm.max_length": null,
      "llm.focus": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "summary": "summary",
      "key_points": "key_points"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "accept_noise_floor",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash"
      ],
      "regen_triggers": [
        "source_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "core-ai-translate",
    "name": "AI Translator",
    "description": "Translates input text into the specified target_language (either a natural name like 'French' or an ISO 639-1 code). Returns the translated text, the detected source language as an ISO 639-1 code, and a confidence score. Use this for inbound localization, cross-border outreach, and multilingual support workflows.",
    "author": "recued-core",
    "kind": "ai",
    "version": 1,
    "category": "ai",
    "risk_tier": "read",
    "tags": [
      "ai",
      "translation",
      "localization"
    ],
    "input": {
      "llm.data": null,
      "llm.target_language": null,
      "llm.model_hint": null,
      "llm.id_field": ""
    },
    "output": {
      "translated": "translated",
      "source_language": "source_language",
      "confidence": "confidence"
    },
    "regen_policy": {
      "input_invariants": [
        "pii_hash_salt"
      ],
      "determinism": "temperature_zero",
      "dedup_key": [
        "source_record_hash",
        "producer_version_hash",
        "target_lang"
      ],
      "regen_triggers": [
        "source_change",
        "lang_change",
        "producer_change",
        "manual"
      ]
    }
  },
  {
    "slug": "core-mail-post",
    "name": "Mail Post Message",
    "description": "Send a single email through an enrolled email connection (Settings → Connections → Email). The connection record points at a send-capable mail account (`data.mail.<name>`) — IMAP+SMTP, gmail-api with the `gmail.send` scope, or microsoft-graph with `Mail.Send`. `body` carries the message text or HTML (toggle via `body_format`); `subject` falls back to '(no subject)' when omitted; `to` overrides the connection's `default_recipient` for one call. Sender ≠ to runtime guard rejects mail-to-self in the `to` list (cc / bcc self deliberately allowed for archival). Symmetric with `slack-post` / `telegram-send` — the user-facing notification-channel surface for email. Returns `message_id` for threading follow-ups.",
    "author": "recued-core",
    "kind": "connection",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "permission": "notification_send",
    "authority_args": [
      "to",
      "subtype"
    ],
    "tags": [
      "email",
      "mail",
      "notify",
      "channel-delivery",
      "action"
    ],
    "input": {
      "connection_kind": "notification",
      "connection": "{{config.email}}",
      "subtype": "email",
      "to": null,
      "subject": null,
      "body": null,
      "body_format": "text"
    },
    "output": {
      "status": "send_status",
      "result.message_id": "message_id",
      "result.sent_at": "sent_at"
    }
  },
  {
    "slug": "core-notification-send",
    "name": "Notification Send",
    "description": "Dispatches a rendered notification through one or more configured output channels (Slack DM, Telegram, email, in-app banner). Omitting `channels` fans out to every supported channel; recipes should set channels only when the user expressed a delivery preference. Channel implementations route via the existing remote-trigger config (Slack/Telegram/email — D-099) and the broadcast bus (in-app — D-121 Phase 6). Generic — alert recipes use this rather than channel-specific ingredients (slack-post, telegram-send, etc.) so channel choice stays in the recipe's config rather than its step graph. Returns delivery results per-channel: `delivered_to[]` for successful channels, `failed[]` for failures. `link_url` (renamed from `url` in the spec to avoid collision with the engine-locked HTTP routing key) carries an optional deep link surfaced alongside the body.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "permission": "notification_send",
    "tags": [
      "kernel",
      "notification",
      "alert",
      "action"
    ],
    "input": {
      "channels": [
        "slack",
        "telegram",
        "email",
        "in_app"
      ],
      "text": null,
      "title": null,
      "link_url": null
    },
    "output": {
      "delivered_to": "delivered_to",
      "failed": "failed"
    }
  },
  {
    "slug": "core-slack-post",
    "name": "Slack Post Message",
    "description": "Posts a message to a Slack channel via an enrolled Slack connection (Settings → Connections). Accepts `text` (plain-text body, required), optional `title` (bold heading prefix), and `link_url` (deep-link appended after the body). Use `recipient` to override the connection's default channel for one call. Returns `message_ts` and `channel` for threading follow-ups.",
    "author": "recued-core",
    "kind": "connection",
    "version": 2,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "slack",
      "notify",
      "channel-delivery",
      "action"
    ],
    "input": {
      "connection_kind": "notification",
      "connection": "{{config.slack}}",
      "text": null,
      "title": null,
      "link_url": null,
      "recipient": null
    },
    "output": {
      "status": "send_status",
      "result.ts": "message_ts",
      "result.channel": "channel"
    }
  },
  {
    "slug": "seller-offer-ensure",
    "name": "Ensure Seller Offer",
    "description": "Idempotently establishes a draft in the core-owned Seller offer registry. The offer schema, operation vocabulary, menu, and UI are fixed by core; recipes supply offer content and an optional fulfillment recipe reference. Replays must match the stored definition. This operation cannot activate or edit an offer, and pack, publisher, or version metadata never confers Seller identity or authority.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "offer",
      "registry"
    ],
    "input": {
      "offer_id": null,
      "kind": "document",
      "display_name": null,
      "description": "",
      "pricing_kind": null,
      "amount_minor": null,
      "currency": "",
      "fulfillment_recipe_id": "",
      "fulfillment_config": null
    },
    "output": {
      "result": "result",
      "offer": "offer"
    }
  },
  {
    "slug": "seller-offer-attach-fulfillment",
    "name": "Attach Seller Offer Fulfillment",
    "description": "Attaches one previously unlinked core Seller offer to the exact recipe executing this operation. Core derives the target from engine-stamped recipe provenance and requires that same recipe to have created the offer. The link is one-way and idempotent; another target, another creator, or an unlinked archived offer fails closed. This operation cannot edit offer content, pricing, state, pack, publisher, version, or transaction authority.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "offer",
      "fulfillment",
      "navigation"
    ],
    "input": {
      "offer_id": null
    },
    "output": {
      "result": "result",
      "offer": "offer"
    }
  },
  {
    "slug": "seller-offer-get",
    "name": "Get Seller Offer",
    "description": "Reads one core Seller offer by its stable local offer_id. Pack, publisher, and version are not part of Seller identity.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "seller",
      "offer",
      "registry"
    ],
    "input": {
      "offer_id": null
    },
    "output": {
      "offer": "offer"
    }
  },
  {
    "slug": "seller-offer-list",
    "name": "List Seller Offers",
    "description": "Lists fixed-shape offers from the core Seller registry, optionally filtered by the closed offer kind or owner-managed state.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "seller",
      "offer",
      "registry"
    ],
    "input": {
      "kind": "",
      "state": ""
    },
    "output": {
      "offers": "offers"
    }
  },
  {
    "slug": "seller-order-open",
    "name": "Open Seller Order",
    "description": "Opens one order for one purchase of one offer, and returns the provider correlation to use for the checkout call. Name WHICH offer, never what it costs: the server reads the offer row and snapshots its price, currency, and fulfillment recipe onto the order, so no amount can be supplied here and a later offer edit cannot change what a customer already agreed to pay. Deterministic in (offer_id, origin_ref), so a replay converges on the same order instead of minting a second one for the same purchase. An unpriced offer opens into the pricing phase, awaiting an owner quote. Returns both the internal order_key and the unguessable order_handle, which is the only order id a visitor may ever be shown. When the order sells tier access, pass the tier's entitlement_key (read it with seller-tier-get; the key itself, never a tier row id): it is snapshotted onto the order at open, and fulfilment issues access from the ORDER's snapshot, so a later configuration change cannot alter what this order sold. Reopening an existing order under a different entitlement_key is refused.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "offer_id": null,
      "origin_kind": null,
      "origin_ref": null,
      "customer_id": "",
      "entitlement_key": ""
    },
    "output": {
      "result": "result",
      "order": "order",
      "correlation": "correlation"
    }
  },
  {
    "slug": "seller-order-get",
    "name": "Get Seller Order",
    "description": "Reads one order by its internal order_key, or by its public order_handle. Supply exactly one.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": "",
      "order_handle": ""
    },
    "output": {
      "order": "order"
    }
  },
  {
    "slug": "seller-order-list",
    "name": "List Seller Orders",
    "description": "Lists orders, optionally filtered by offer, phase, or origin.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "offer_id": "",
      "phase": "",
      "origin_kind": "",
      "origin_ref": "",
      "limit": 0
    },
    "output": {
      "orders": "orders"
    }
  },
  {
    "slug": "seller-tier-get",
    "name": "Get Seller Tier",
    "description": "Reads one seller tier by the same (lifecycle_source, door_id, entitlement_key) triple that customer-access-issue consumes, so a flow reads exactly the tier it is about to open an order for or issue access against. Returns the tier's public terms only: entitlement_key, display_name, lifecycle_source, external_entitlement_id, pass_duration_seconds, and active. The template contract behind the tier is resolved server-side at issue time and is never returned, so no recipe can read or name the tools and scopes a tier grants. There is deliberately no tier row id anywhere in this family — the entitlement_key IS the tier's identity here, and it survives a re-synchronization while row ids do not. Returns tier: null when no tier matches the triple.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "seller",
      "tier",
      "commerce"
    ],
    "input": {
      "lifecycle_source": null,
      "door_id": null,
      "entitlement_key": null
    },
    "output": {
      "tier": "tier"
    }
  },
  {
    "slug": "seller-tier-list",
    "name": "List Seller Tiers",
    "description": "Lists seller tiers, optionally filtered by door_id, lifecycle_source, or active. Each row carries the same public terms as seller-tier-get — entitlement_key, display_name, lifecycle_source, external_entitlement_id, pass_duration_seconds, active — and the same projection: no template contract, no row ids. Omit active to list both active and inactive tiers.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "seller",
      "tier",
      "commerce"
    ],
    "input": {
      "door_id": "",
      "lifecycle_source": "",
      "active": false
    },
    "output": {
      "tiers": "tiers"
    }
  },
  {
    "slug": "seller-order-quote",
    "name": "Quote Seller Order",
    "description": "Pins a total onto an order that has not been paid for yet — the owner-priced leg of a quote request. Only a draft or pricing order can be quoted; once a customer has seen a total, it is fixed. Currency is normalized, so usd and USD can never read as two currencies.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "amount_minor": null,
      "currency": null
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-attach-payment",
    "name": "Attach Order Payment",
    "description": "Binds the provider checkout session created for this order and moves it to awaiting_payment. Call the provider with the idempotency key returned by seller-order-open, never one you compose yourself. Re-attaching the SAME session id converges silently, which is what makes a crash between the provider call and this bind safe to retry. Attaching a DIFFERENT session id is refused: it means the idempotency key did not hold and a second checkout session now exists, which is a double charge.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "provider": null,
      "provider_session_id": null,
      "checkout_url": "",
      "expires_at": 0
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-confirm-payment",
    "name": "Confirm Order Payment",
    "description": "The ONLY way an order can reach the paid phase. Supply what the provider reported; the server re-derives this order's correlation and compares it, so evidence from another order's session is refused, a session this order never attached is refused, a status other than paid is refused, and a total other than the server-computed amount is refused. Read the provider's own source of truth before calling this — it is what authorizes fulfilment.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "evidence": null
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-confirm-renewal-payment",
    "name": "Confirm Order Renewal Payment",
    "description": "The ONLY way an order keyed on a provider invoice can reach the paid phase — the D-196 renewal leg, one order per billing period. Supply what the provider reported for the PAID renewal invoice; the server re-derives the correlation from its own rows and refuses anything the evidence merely asserts: the evidence invoice must be the very invoice this order is keyed on, the acquisition order recovered from the provider-read subscription metadata must exist and must sell the same offer with the same entitlement snapshot, the status must be paid, and the collected amount must equal the server-computed order total. A session-keyed order is refused here — it confirms through seller-order-confirm-payment, whose session correlation it can actually satisfy. Read the provider's own source of truth before calling this; never pass event snapshot fields.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "evidence": null
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-confirm-refund",
    "name": "Confirm Order Refund",
    "description": "The ONLY way an order can reach the refunded phase. Supply what the provider reported for the payment this order recorded; evidence naming a different payment, or a refund that did not succeed, is refused.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "evidence": null
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-attach-artifact",
    "name": "Attach Order Artifact",
    "description": "Pins the immutable fulfilment output the customer paid for, by reference and content hash. Core re-reads the referenced bytes through the data.file boundary and refuses the call unless they actually hash to the submitted SHA-256: a data.file record id does not determine its bytes, so a pin taken on the caller's word would prove only that the caller was self-consistent. The hash you submit is your assertion of WHICH bytes you mean, and core proves the assertion true before storing it. Pinning is then one-way — an order that already pins an artifact refuses a different one. Together these close both swaps: re-pinning a different artifact, and repointing the record id under an artifact already approved.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "artifact_ref": null,
      "artifact_hash": null
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-transition",
    "name": "Transition Seller Order",
    "description": "Moves an order along its lifecycle: fulfilling, approved, delivering, complete, cancelled, expired, needs_owner, ambiguous, failed. It CANNOT reach paid or refunded — those assert that money moved and are writable only by seller-order-confirm-payment and seller-order-confirm-refund, which verify provider evidence. Guarded by expected_revision, so a decision made on a stale order is never applied to a current one.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "next_phase": null,
      "error_code": ""
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-link-customer",
    "name": "Link Order Customer",
    "description": "Binds a paid order to the seller customer its fulfilment issued access to. An order opened at checkout has no customer yet — the customer row is minted by Issue Customer Access once the payment is evidence-backed — so this closes the money-to-access edge afterwards. One-way: re-linking the same customer is a no-op so a replayed fulfilment cannot fail, while re-pointing at a different customer refuses.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce",
      "customer-access"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "customer_id": null
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "seller-order-link-work-entity",
    "name": "Link Order Work Entity",
    "description": "Optionally links this order's money lifecycle to an obligation lifecycle — a task, or a commitment for anything with a time. Whether a flow produces an order, a commitment, or both linked is a decision for the recipe; core provides the link and privileges none of the three. One-way: an order already linked refuses a different entity.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "order",
      "commerce"
    ],
    "input": {
      "order_key": null,
      "expected_revision": null,
      "work_entity_kind": null,
      "work_entity_id": null
    },
    "output": {
      "result": "result",
      "order": "order"
    }
  },
  {
    "slug": "customer-access-issue",
    "name": "Issue Customer Access",
    "description": "Issues or extends seller-customer access for a source-qualified customer. On first issue, stamps a customer-instance contract from the configured seller tier template, mints a bound inbound token, and returns only a short-lived one-time claim capability. Newly created provider customers attempt claim delivery through the configured mail sender and return the post-commit outcome. Replays for the same customer and tier extend access without minting another token or sending another claim.",
    "author": "recued",
    "kind": "storage",
    "version": 2,
    "min_version": 2,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "customer-access",
      "contract",
      "claim-delivery"
    ],
    "input": {
      "lifecycle_source": null,
      "door_id": null,
      "source_customer_id": null,
      "entitlement_key": null,
      "email": "",
      "period_end": null,
      "source_status": "",
      "external_subscription_id": ""
    },
    "output": {
      "result": "result",
      "customer": "customer",
      "claim": "claim",
      "claim_email_delivery": "claim_email_delivery"
    }
  },
  {
    "slug": "customer-access-extend",
    "name": "Extend Customer Access",
    "description": "Extends an existing seller customer by customer_id or by lifecycle_source, source_customer_id, and door_id. Updates period, source status, and optional email metadata without changing the customer's tier or token.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "customer-access",
      "contract"
    ],
    "input": {
      "customer_id": "",
      "lifecycle_source": "",
      "door_id": "",
      "source_customer_id": "",
      "period_end": null,
      "source_status": "",
      "email": ""
    },
    "output": {
      "customer": "customer"
    }
  },
  {
    "slug": "customer-access-swap-tier",
    "name": "Swap Customer Tier",
    "description": "Swaps an existing seller customer to another entitlement tier on the same source and door. Restamps the customer's contract grants from the target tier template while preserving the customer identity and token binding.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "customer-access",
      "contract"
    ],
    "input": {
      "customer_id": "",
      "lifecycle_source": "",
      "door_id": "",
      "source_customer_id": "",
      "entitlement_key": null,
      "period_end": null,
      "source_status": ""
    },
    "output": {
      "customer": "customer"
    }
  },
  {
    "slug": "customer-access-close",
    "name": "Close Customer Access",
    "description": "Closes a seller customer by customer_id or by lifecycle_source, source_customer_id, and door_id. Revokes the bound inbound MCP token, revokes the customer-instance contract, and marks the customer closed with a supported close reason.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "seller",
      "customer-access",
      "contract",
      "mcp-token"
    ],
    "input": {
      "customer_id": "",
      "lifecycle_source": "",
      "door_id": "",
      "source_customer_id": "",
      "reason": null,
      "source_status": ""
    },
    "output": {
      "customer": "customer"
    }
  },
  {
    "slug": "data-annotate",
    "name": "Annotate a record",
    "description": "Write a derived value (summary, classification, score, …) back to a source record in any data.* collection. Accepts either a canonical record reference (`ref: \"{{item}}\"` inside a foreach) or explicit `target_collection` + `target_id`. Engine stamps source / recipe / model hashes so the annotation reads as `⚠ stale` when its dependencies move; recipes opt into auto-eviction with `annotation_policy: \"evict_on_stale\"` on metadata. Routes via the paired server's `annotation.write` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "annotation",
      "warehouse",
      "write"
    ],
    "input": {
      "ref": null,
      "target_collection": null,
      "target_id": null,
      "key": null,
      "value": null,
      "authored_by_recipe_id": null,
      "source_record_hash": null,
      "recipe_hash": null,
      "model_used": null
    },
    "output": {
      "annotation": "annotation"
    }
  },
  {
    "slug": "data-file-read",
    "name": "Read inbound file content",
    "description": "Read one inbound data.file.received record by record_id through the Gateway-gated content boundary. The handler re-reads the CAS blob and verifies its bytes against the content-addressed blob_hash. By default it returns base64-encoded bytes plus mime_type, filename, size_bytes, and blob_hash. With metadata_only=true, the kernel strips bytes_b64 before the result enters recipe step state while still requiring the verified blob read; this is the D-200 exact-artifact approval probe.",
    "author": "recued",
    "kind": "storage",
    "version": 2,
    "category": "data",
    "mcp_exposed": true,
    "risk_tier": "read",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "read",
      "content"
    ],
    "input": {
      "record_id": null,
      "metadata_only": null
    },
    "output": {
      "record_id": "record_id",
      "bytes_b64": "bytes_b64",
      "mime_type": "mime_type",
      "filename": "filename",
      "size_bytes": "size_bytes",
      "blob_hash": "blob_hash"
    }
  },
  {
    "slug": "data-link",
    "name": "Link two records",
    "description": "Write a typed cross-collection relationship between two records (`from` → `role` → `to`). Either side accepts a canonical record reference (`from: \"{{item}}\"` inside a foreach) or explicit `from_collection`+`from_id` / `to_collection`+`to_id`. Cascade-on-parent-delete is automatic — when either endpoint is removed from the warehouse, every link with that endpoint is removed in the same transaction. Routes via the paired server's `link.write` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "link",
      "warehouse",
      "write"
    ],
    "input": {
      "from": null,
      "to": null,
      "from_collection": null,
      "from_id": null,
      "to_collection": null,
      "to_id": null,
      "role": null,
      "authored_by_recipe_id": null
    },
    "output": {
      "link": "link"
    }
  },
  {
    "slug": "dom-read",
    "name": "DOM Read",
    "description": "Kernel backing ingredient for the Tier-K `core.dom.read` op. Given a `target` URL pattern + a CSS `selector` (both op args), reads the matched element's trimmed text from the page actuated by the paired Browser Bridge and returns it as `{ text }` (null when no element matches). No per-tool manifest selector map — the Bridge is the uniform DOM executor and the selector/target ride as op args. Extension-actuated: SERVER_NOT_REACHABLE without a paired Bridge. read-tier (no DOM mutation).",
    "author": "recued",
    "kind": "dom",
    "surface_kind": "reading",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "dom",
      "core.dom",
      "extension",
      "read"
    ],
    "input": {
      "target": null,
      "selector": null
    },
    "output": {
      "text": "text"
    }
  },
  {
    "slug": "dom-write",
    "name": "DOM Write",
    "description": "Kernel backing ingredient for the Tier-K `core.dom.write` op. Given a `target` URL pattern, a CSS `selector`, and a `value` (op args), fills the value into the matched element on the page actuated by the paired Browser Bridge; an optional `submit_selector` presses Enter on a second element afterward (e.g. submit a web-chat prompt). Returns `{ written, fields, failed }` (or `{ writes, clicked }` when a submit fires). No per-tool manifest selector map — the Bridge is the uniform DOM executor and the selector/target/value ride as op args. Extension-actuated: SERVER_NOT_REACHABLE without a paired Bridge. write-tier: a DOM mutation, approval-gated.",
    "author": "recued",
    "kind": "dom",
    "surface_kind": "authoring",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "dom",
      "core.dom",
      "extension",
      "write"
    ],
    "input": {
      "target": null,
      "selector": null,
      "value": null,
      "submit_selector": null
    },
    "output": {
      "written": "written"
    }
  },
  {
    "slug": "email-get",
    "name": "Fetch a single email record from a warehouse collection",
    "description": "Return one record from `data.email.{slug}.*` by record_id. `record_id` comes from `email-list` or `email-search` output (the provider's `source_id` hashed to a 32-char SHA-256 prefix — stable across re-syncs). `record.body_inline` carries plaintext bodies up to 64 KB; larger messages spill to the CAS blob store accessible via `record.blob_hash`. `hot_fields` exposes `{ from, to, cc, subject, thread_id, folder, is_read, has_attachments, labels?, message_id, rfc_message_id? }`; `message_id` is provider-native while `rfc_message_id`, when present, is the normalized RFC 5322 header value.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "email",
      "mail",
      "warehouse",
      "get"
    ],
    "input": {
      "slug": null,
      "record_id": null
    },
    "output": {
      "record": "record"
    }
  },
  {
    "slug": "email-list",
    "name": "List emails from a mail warehouse collection",
    "description": "Return records from `data.email.{slug}.*` filtered by hot-field equality, `received_at` range, and limit. Hot fields: `{ from, to, cc, subject, thread_id, folder, is_read, has_attachments, labels?, message_id, rfc_message_id? }`; `message_id` is provider-native while `rfc_message_id`, when present, is the normalized RFC 5322 header value. Set `metadata_only: true` to strip both `body_inline` and `blob_hash` at the kernel boundary before records enter recipe state; use `email-get` when body materialization is intended. IMAP collections key `folder` to the RFC-5322 folder path (`INBOX`, `INBOX/Archive`, …); Gmail folds labels into the first match from `INBOX > IMPORTANT > STARRED > SENT > DRAFT`; Graph stores the Graph `parentFolderId`.",
    "author": "recued",
    "kind": "storage",
    "version": 2,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "email",
      "mail",
      "warehouse",
      "list"
    ],
    "input": {
      "slug": null,
      "metadata_only": false
    },
    "output": {
      "records": "records"
    }
  },
  {
    "slug": "email-search",
    "name": "Full-text search across warehouse emails",
    "description": "Run a SQLite FTS5 query against `data.email.{slug}.*` message bodies. Returns ranked matches (lower = better; FTS5 BM25 default). Messages above 64 KB are stored in CAS and NOT FTS-indexed — documented limit matching the `shared-search` + collection table semantics. Typical recipes pair this with `email-get` to fetch the hit's full body for downstream transforms / AI functions.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "email",
      "mail",
      "warehouse",
      "search",
      "fts"
    ],
    "input": {
      "slug": null,
      "query": null
    },
    "output": {
      "matches": "matches"
    }
  },
  {
    "slug": "enrichment-list",
    "name": "Enrichment List",
    "description": "Governed read into data.enrichment. Filters by topic + optional scope + optional target_id. Returns paginated rows ordered by ingested_at descending. Used by alert recipes to look up cheap pre-summarized rollups (e.g., topic: 'calendar_event_rollup') without paginating through timeline-read.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "enrichment",
      "warehouse",
      "read"
    ],
    "input": {
      "topic": null,
      "scope": null,
      "target_id": null,
      "authored_by_recipe_id": null,
      "limit": null,
      "offset": null
    },
    "output": {
      "entries": "entries",
      "next_cursor": "next_cursor"
    }
  },
  {
    "slug": "enrichment-upsert",
    "name": "Enrichment Upsert",
    "description": "Generic write into data.enrichment. Looks up `topic` in the registry, validates `value` against the topic's value_schema, upserts by (topic, scope, target_id, authored_by_recipe_id) for Shape A topics or by (topic, _id) for Shape B derived entities. Idempotent — re-runs replace in place. Engine stamps source / recipe / model hashes for staleness; cascade engine fires on subsequent source-record changes per the topic's policy preset. ONE ingredient covers all enrichment topics — adding a new topic is a registry entry plus a producer, no kernel surface change.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "enrichment",
      "warehouse",
      "write"
    ],
    "input": {
      "topic": null,
      "scope": null,
      "id": null,
      "value": null,
      "authored_by_recipe_id": null,
      "mode": null
    },
    "output": {
      "_id": "_id",
      "wrote": "wrote"
    }
  },
  {
    "slug": "form-response-list",
    "name": "List accepted form responses",
    "description": "Return a bounded page of owner-approved data.form_response records with optional endpoint, form-definition, lifecycle, and keyset filters. Records include mutable working values and visitor identity; the sealed Reception submission remains the immutable evidence twin. The operation is owner-default-only and contracted execution is fenced to the exact data.form_response scope.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "form-response",
      "warehouse",
      "reception",
      "list"
    ],
    "input": {
      "endpoint_id": null,
      "form_definition_id": null,
      "lifecycle_states": null,
      "before": null,
      "limit": 100
    },
    "output": {
      "records": "records",
      "next_cursor": "next_cursor"
    }
  },
  {
    "slug": "form-response-get",
    "name": "Fetch an accepted form response",
    "description": "Return one owner-approved intake response from `data.form_response` by submission_id. The full frozen form definition, arbitrary visitor values, visitor identity, and metadata are returned only through this explicit recipe-side read. The operation is owner-default-only, and contracted execution is additionally evaluated against the exact `data.form_response` scope.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "form-response",
      "warehouse",
      "reception",
      "get"
    ],
    "input": {
      "submission_id": null
    },
    "output": {
      "record": "record"
    }
  },
  {
    "slug": "form-response-set-state",
    "name": "Advance a form response's lifecycle",
    "description": "Move one `data.form_response` record through the owner's lifecycle: received, in_review, accepted, declined, or no_show. This is the only recipe operation that changes lifecycle, and it changes state and nothing else. Owner UI/admin RPCs may edit the working answers or visitor identity; use form-response-get to read the record. The sealed, never-edited record of what the visitor actually submitted lives on the reception submission, so neither kind of owner change rewrites history. `no_show` means the response was accepted and the person did not turn up \u2014 it is deliberately distinct from `declined` (you turned them down), because a repeat-no-show rule cannot be computed once the two collapse. Re-applying the state a record already has is a no-op and does not move `state_changed_at`. The operation is owner-default-only, and contracted execution is additionally evaluated against the exact `data.form_response` scope.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "form-response",
      "warehouse",
      "reception",
      "lifecycle"
    ],
    "input": {
      "submission_id": null,
      "lifecycle_state": null
    },
    "output": {
      "record": "record"
    }
  },
  {
    "slug": "webhook-event-get",
    "name": "Fetch one accepted webhook event for the active recipe run",
    "description": "Return one decoded accepted webhook event through the D-201 consumer-binding gate. The authored input carries only an opaque event_ref; the engine supplies the recipe_id and run_id out of unforgeable StepMeta. Authorization requires the current installed binding, exact recipe trigger, scoped_read grant, active dispatch, and payload pin both before and after decryption. It never returns raw request bytes, signature headers, credentials, or sibling batch events.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "webhook",
      "accepted-event",
      "scoped-read"
    ],
    "input": {
      "event_ref": null
    },
    "output": {
      "event": "event",
      "delivery": "delivery",
      "payload": "payload"
    }
  },
  {
    "slug": "file-delete",
    "name": "Delete a file record from a warehouse file collection",
    "description": "Remove a single record from the named file instance. Rejects with `FILE_CAPABILITY_DENIED` when the instance lacks the `delete` cap, `FILE_INSTANCE_DEGRADED` when auth has drifted, `FILE_NOT_FOUND` when the record is already gone. Adapter-side semantics are hard-delete — no trash / undo layer. Returns `{ ok: true }` on success.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "destructive",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "delete"
    ],
    "input": {
      "slug": null,
      "path": null
    },
    "output": {
      "ok": "ok"
    }
  },
  {
    "slug": "file-get",
    "name": "Fetch a single file record from a warehouse collection",
    "description": "Return one record from `data.file.{slug}.*` by record_id. `record_id` comes from `file-list` output (stable SHA-256 prefix of the file's relative path). The response's `record.body_inline` contains text bodies up to 64 KB; larger files live in the CAS blob store (reachable via `record.blob_hash`). Files above `max_body_bytes` return metadata only with `hot_fields.on_disk_only = true`.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "get"
    ],
    "input": {
      "slug": null,
      "record_id": null
    },
    "output": {
      "record": "record"
    }
  },
  {
    "slug": "file-list",
    "name": "List files in a warehouse file collection",
    "description": "Return records from `data.file.{slug}.*` filtered by hot-field equality, `received_at` range, and limit. Use `file-get` to fetch the full body of a specific record_id. Recipes typically walk the results with a `foreach` transform. Files above the collection's `max_body_bytes` have `hot_fields.on_disk_only = true` and no body_inline — callers that want their bytes read them from disk via the `hot_fields.path` relative path.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "list"
    ],
    "input": {
      "slug": null
    },
    "output": {
      "records": "records"
    }
  },
  {
    "slug": "file-move",
    "name": "Move a file record between warehouse file locations",
    "description": "Relocate a record from `(from_slug, from_path)` to `(to_slug, to_path)`. Destination slug may equal source slug — the server handles cross-adapter moves by staging the body through a bounded buffer. Executed as read-source → write-destination → delete-source; a failure on destination-write leaves the source intact (rollback), but a failure AFTER destination-write (during source-delete) is NOT rolled back because the destination is the desired outcome. Both instances need `write` + `delete` caps respectively and must be in `healthy` auth_state. Returns `{ ok: true }` on success.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "destructive",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "move"
    ],
    "input": {
      "from_slug": null,
      "from_path": null,
      "to_slug": null,
      "to_path": null
    },
    "output": {
      "ok": "ok"
    }
  },
  {
    "slug": "file-render-markdown-template",
    "name": "Render a strict Markdown template",
    "description": "Fill one bounded UTF-8 Markdown data.file template with a closed set of scalar values and return one run-scoped temp file_ref plus SHA-256 hashes. Strict v1 accepts only response.<field>, visitor.email, and system.accepted_date placeholders in text positions; missing or malformed placeholders fail before file creation. Inserted values are escaped as Markdown text and cannot select link destinations, reference labels, or attributes. Raw angle-bracket markup, Pandoc raw-output attributes, template backslashes/TeX control sequences, YAML metadata, and Markdown images are refused, so a later local renderer cannot turn the template into code or an implicit local/network resource read. Authored input exposes no local path, shell, flags, network fetch, or executable template mode. The local CAS source identity and hash are revalidated. The temp result is confined to the current run and must be consumed or persisted before run cleanup; its absolute path is redacted from durable commit output. MCP-reserved and recipe-internal.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "file",
      "markdown",
      "template",
      "deterministic",
      "temp",
      "d-200"
    ],
    "input": {
      "template_file_ref": null,
      "values": null,
      "strict": true
    },
    "output": {
      "file_ref": "file_ref",
      "template_sha256": "template_sha256",
      "content_sha256": "content_sha256",
      "used_keys": "used_keys",
      "missing_keys": "missing_keys"
    }
  },
  {
    "slug": "file-persist",
    "name": "Persist a temp file to durable storage",
    "description": "Keep a run-scoped temp file_ref (a storage:'temp' cli op's output) by ingesting its bytes into the content-addressed data.file.received warehouse, returning a durable cas_ref record_id. The explicit, gateable temp->cas keep step (D-185 §2): without it a temp artifact is reclaimed at run end, so a recipe that wants the converted/extracted file to survive adds one core.storage.file.persist step. Input is a temp file_ref; a cas ref is already durable and is rejected. The bytes are read CONFINED to the producing run's scratch root (no separate file.read gate — the producing op was already gated as its own write-tier step). Gated under the data.file scope like data-file-read.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "write",
      "persist",
      "cas"
    ],
    "input": {
      "ref": null
    },
    "output": {
      "cas_ref": "cas_ref",
      "record_id": "record_id",
      "mime_type": "mime_type",
      "filename": "filename",
      "size_bytes": "size_bytes"
    }
  },
  {
    "slug": "file-read",
    "name": "Read a file record from a warehouse file collection",
    "description": "Fetch the full body of a single record on the named file instance. Returns `{ body_b64, mime? }` — bytes are base64-encoded to keep the rpc envelope JSON-clean. `mime` rides on a cheap stat-equivalent probe; absent when the adapter cannot determine it. Missing records reject with `FILE_NOT_FOUND`; use `file-stat` first when the caller wants to branch on existence without paying for the body. Subject to the adapter's v1 size ceiling — bodies above it reject with `FILE_TOO_LARGE`.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "read"
    ],
    "input": {
      "slug": null,
      "path": null
    },
    "output": {
      "body_b64": "body_b64",
      "mime": "mime"
    }
  },
  {
    "slug": "file-set-scan-status",
    "name": "Report a file's virus-scan verdict",
    "description": "Patch a data.file.received record's scan_status hot field to a local virus scanner's verdict ('clean' / 'flagged'; 'pending' / 'unscanned' are also accepted) and emit an `updated` event. The reception inbox reads scan_status back, so a 'flagged' upload surfaces a sharper warning at approve while a 'clean' one clears the advisory scan-gate (D-173 P5). Idempotent: re-reporting the same verdict is a no-op (no spurious `updated`). Driven by the ClamAV scanner pack's reactive recipe after a local clamdscan over a freshly-ingested file. MCP-RESERVED: this kernel ingredient (author 'recued') is never exposed as an agent tool, so an external AI agent can never forge a 'clean' verdict on a malicious file — only the local scan recipe writes here. Gated under the data.file scope like file-persist / data-file-read.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "write",
      "scan",
      "verdict",
      "security"
    ],
    "input": {
      "record_id": null,
      "status": null
    },
    "output": {
      "record_id": "record_id",
      "scan_status": "scan_status"
    }
  },
  {
    "slug": "file-stat",
    "name": "Stat a file record in a warehouse file collection",
    "description": "Cheap metadata read for a single record on the named file instance — `{ exists, size_bytes?, modified_at_ms?, mime? }`. Missing records surface as `{ exists: false }` (not an error) so recipes can use file-stat as an \"does this exist?\" probe. Other adapter failures (permission denied, IO error) propagate as typed errors. `mime` is adapter-best-effort: fs derives from extension, s3 reports stored Content-Type, ext-downloads reads `chrome.downloads.mime` — absent when the adapter cannot determine it.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "stat"
    ],
    "input": {
      "slug": null,
      "path": null
    },
    "output": {
      "exists": "exists",
      "size_bytes": "size_bytes",
      "modified_at_ms": "modified_at_ms",
      "mime": "mime"
    }
  },
  {
    "slug": "file-watcher",
    "name": "File Watcher",
    "description": "Reads the server warehouse `data.file.*` collection and returns `should_run: true` when any file record modified after `since` matches the (optional) path prefix / extension / size bounds. Metadata-only — file contents never leave the warehouse. Same routing as mail-watcher: pair rpc from extension, direct read on server.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "file",
      "warehouse",
      "trigger"
    ],
    "input": {
      "since": null,
      "path_prefix": null,
      "extension": null,
      "min_size": null,
      "max_size": null,
      "limit": null
    },
    "output": {
      "should_run": "should_run",
      "items": "items",
      "last_seen_at": "last_seen_at"
    }
  },
  {
    "slug": "file-write",
    "name": "Write a file record to a warehouse file collection",
    "description": "Persist bytes to a record on the named file instance. Body is base64-encoded in the input so the rpc envelope stays JSON-clean. `mime` is optional — when omitted the adapter falls back to extension-based detection (fs) or the adapter's default (s3, ext-downloads). Creates the record when absent, overwrites in place when present. Rejects with `FILE_CAPABILITY_DENIED` when the instance lacks the `write` cap, `FILE_INSTANCE_DEGRADED` when auth has drifted, `FILE_TOO_LARGE` when the body exceeds the adapter's v1 ceiling. Returns `{ ok: true, bytes_written }` on success.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "file",
      "warehouse",
      "write"
    ],
    "input": {
      "slug": null,
      "path": null,
      "body_b64": null,
      "mime": null
    },
    "output": {
      "ok": "ok",
      "bytes_written": "bytes_written"
    }
  },
  {
    "slug": "http-watcher",
    "name": "HTTP Watcher",
    "description": "Polls `target_url` and compares the response's ETag (or body hash when ETag is absent) against a stored cursor. Returns `should_run: true` on first tick and whenever the target has changed since the last recorded cursor. Pairs with a `shared-write` step that records the new etag/hash so the next tick is idempotent. Kernel ingredient — the watcher dispatcher owns the fetch; authors pass the URL via recipe step input (not the attested HTTP url key).",
    "author": "recued",
    "kind": "http",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "http",
      "polling",
      "trigger"
    ],
    "input": {
      "target_url": null,
      "previous_etag": null,
      "previous_hash": null
    },
    "output": {
      "should_run": "should_run",
      "body": "body",
      "status": "status",
      "etag": "etag",
      "hash": "hash"
    }
  },
  {
    "slug": "link-create",
    "name": "Create a typed cross-collection link",
    "description": "Recipe-friendly write into the links graph. Accepts `source` / `target` as combined `<collection>:<id>` strings (e.g., `data.mail:msg-abc`) — the kernel adapter splits on the colon. `kind` carries the link taxonomy (`extraction.derived_contact`, `extraction.thread_participant`, …); engine-emitted kinds prefixed `execution.*` are reserved. Optional `confidence` (0–1) + `evidence` short string surface in the Memory tab provenance block. Idempotent on (source, target, kind): re-runs replace the prior row's confidence + evidence in place (no duplicate accretion). Routes via the paired server's `link.write` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "link",
      "warehouse",
      "write",
      "graph-builder"
    ],
    "input": {
      "source": null,
      "target": null,
      "kind": null,
      "confidence": null,
      "evidence": null,
      "authored_by_recipe_id": null
    },
    "output": {
      "link": "link"
    }
  },
  {
    "slug": "link-delete",
    "name": "Delete links by filter",
    "description": "Bulk-delete links matching the filter. AT LEAST ONE filter field is required — refuses an empty filter to guard against accidental table-wipe. Returns the number of rows removed. Routes via the paired server's `link.delete` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "link",
      "warehouse",
      "delete"
    ],
    "input": {
      "from_collection": null,
      "from_id": null,
      "to_collection": null,
      "to_id": null,
      "role": null,
      "authored_by_recipe_id": null,
      "since": null,
      "until": null
    },
    "output": {
      "ok": "ok",
      "deleted": "deleted"
    }
  },
  {
    "slug": "link-list",
    "name": "List links",
    "description": "Bulk-read links from the warehouse. Filters AND together; absent fields don't restrict. Indexes cover (from_collection, from_id) for outbound queries and (to_collection, to_id) for inbound queries — both directions are O(index seek). Routes via the paired server's `link.list` rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "link",
      "warehouse",
      "list"
    ],
    "input": {
      "from_collection": null,
      "from_id": null,
      "to_collection": null,
      "to_id": null,
      "role": null,
      "authored_by_recipe_id": null,
      "since": null,
      "until": null,
      "limit": null
    },
    "output": {
      "links": "links"
    }
  },
  {
    "slug": "mail-body-read",
    "name": "Read mail body",
    "description": "Materialize the full body text of one mail record by (slug, record_id). Hydrates body_inline directly when the body is ≤64 KB, or reads it back from content-addressed storage when the body spilled to a blob_hash (>64 KB) — so a recipe gets usable body text regardless of size. Closes the gap where bodies over 64 KB resolve to nothing via {{step.record.body_inline}} and large messages are silently skipped. Returns { body, found, size_bytes, truncated }: body is an empty string for an empty-but-present body, and null when the record is missing, has no body, or the CAS blob is unresolvable; found is true iff the record exists. Pass max_chars (a positive integer) to cap the returned body for LLM-bound extraction; omit it to get the full body, which is still bounded by a 1,000,000-character safety ceiling for pathologically large messages. truncated is true whenever either cap cut the body. Pairs with mail-get — mail-get returns the raw record (hot_fields + the inline-or-hash body pointer), mail-body-read returns the materialized body string.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "mail",
      "warehouse",
      "read",
      "body"
    ],
    "input": {
      "slug": null,
      "record_id": null,
      "max_chars": null
    },
    "output": {
      "body": "body",
      "found": "found",
      "size_bytes": "size_bytes",
      "truncated": "truncated"
    }
  },
  {
    "slug": "mail-get",
    "name": "Mail Get",
    "description": "Fetches a single mail record from the warehouse by record_id. Returns the full canonical mail JSON; missing records return { record: null }. Symmetric with calendar-get — the load-record primitive recipes use when a mail-watcher trigger surfaces a record_id and the body wants to materialize {{step.record.*}} for downstream step.* refs (no nested templates required).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "mail",
      "warehouse",
      "read"
    ],
    "input": {
      "slug": null,
      "record_id": null
    },
    "output": {
      "record": "record"
    }
  },
  {
    "slug": "mail-sent-reconcile",
    "name": "Reconcile one outbound send against provider source truth",
    "description": "Answers exactly one question: did the message you claimed at this reconciliation_id actually leave the building? It takes the reconciliation_id and NOTHING else. Core reads the claim mail-send durably wrote BEFORE it dispatched, derives the whole provider query from that row — recipient, subject, time window, and the attachment byte-proof — and asks the provider's Sent source truth. You cannot supply the recipient, the sender, the subject, the window, the provider evidence, the ambiguity reason, or the outcome: a caller who could author those could forge a match, and a forged match marks a document DELIVERED that was never sent. The claim settles on the provider's verdict, never on a status you name. ⛔ NOTHING HERE AUTHORIZES A RESEND, INCLUDING not_found. Absent from the Sent folder is not the same as not sent — the provider may not have indexed it, the window can miss it, IMAP lags — so not_found and unavailable change nothing at all, and the claim stays exactly where a machine must not re-send it from. Only matched settles it (reconciled, pinning the provider message id), and contradictory evidence settles it ambiguous for a human. A settled claim never moves again, so repeated calls do not churn it. Re-sending an unresolved claim is a decision for the owner, not for a retry.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "mail",
      "reconciliation",
      "no-resend"
    ],
    "input": {
      "reconciliation_id": null
    },
    "output": {
      "status": "status",
      "settled": "settled",
      "provider_message_id": "provider_message_id",
      "sent_at": "sent_at",
      "ambiguity_reason": "ambiguity_reason",
      "scanned_candidates": "scanned_candidates"
    }
  },
  {
    "slug": "mail-send",
    "name": "Send mail",
    "description": "Send mail through a registered data.mail.<name> account. Recipe-author surface for direct mail deliverables (follow-up drafts, scheduled sends, recipe-output digests). The named sender account must be enrolled with send capability — IMAP+SMTP, gmail-api with the gmail.send scope, or microsoft-graph with Mail.Send. Body is text or html (single-format); cc / bcc / threading headers (in_reply_to / references) / reply_to all forward to the underlying provider. An optional bounded reconciliation_id is carried as X-Recued-Reconciliation-ID and indexed again on provider ingest for exact post-dispatch lookup. Supplying one opts into the no-resend fence: core durably CLAIMS the send BEFORE dispatching, so a crash or timeout mid-send leaves a record to reconcile against rather than a guess. It therefore IS an idempotency anchor — a message the provider acknowledged, or that provider source truth has confirmed, is never dispatched twice and returns already_sent. The price of that promise is that an attempt whose outcome was never learned is refused (MAIL_SEND_CLAIM_UNRESOLVED) rather than blindly repeated: re-sending might duplicate a message the customer already has, not re-sending might never send, and neither is safe to guess — resolve it with core.mail.sent.reconcile. Absence still never authorizes a resend. A send with more than one recipient cannot carry a reconciliation_id, because a single-recipient envelope match cannot prove a fan-out. Omit the id for ordinary retry semantics. Optional attachments are exact data.file record refs, independently admitted through the data-file-read policy boundary before their bytes leave the warehouse. Sender ≠ to runtime guard rejects mail-to-self in the to list (cc / bcc self is allowed for archival). Sent records show up in your warehouse Sent folder on the next inbound delta. Routes via the paired server's collection.mail.send rpc.",
    "author": "recued",
    "kind": "storage",
    "version": 2,
    "category": "action",
    "risk_tier": "write",
    "permission": "mail_send",
    "authority_args": [
      "sender_mail_instance",
      "to",
      "cc",
      "bcc",
      "reply_to",
      "in_reply_to",
      "references",
      "reconciliation_id",
      "attachments"
    ],
    "tags": [
      "kernel",
      "mail",
      "send",
      "warehouse",
      "write"
    ],
    "input": {
      "sender_mail_instance": null,
      "to": null,
      "cc": null,
      "bcc": null,
      "subject": null,
      "body": null,
      "body_format": "text",
      "in_reply_to": null,
      "references": null,
      "reply_to": null,
      "reconciliation_id": null,
      "attachments": null
    },
    "output": {
      "source_id": "source_id",
      "message_id": "message_id",
      "sent_at": "sent_at",
      "thread_id": "thread_id",
      "warnings": "warnings",
      "_id": "_id",
      "_collection": "_collection"
    }
  },
  {
    "slug": "notify-booking-visitor",
    "name": "Notify a booking's visitor",
    "description": "Tell the visitor behind a reception booking that their appointment changed (e.g. it was rescheduled) — server-side, without ever holding their email. Given booking_id (a data.booking row), the visitor's SEALED address is resolved INTERNALLY: the dispatcher follows the booking's own reception_record_id back to the reception submission row, decrypts ONLY the email, and sends — the recipient is never an argument, never reaches step state, and never appears in the output, so a recipe (or an AI step) can notify a booking's visitor with zero access to their PII. sender_mail_instance is a registered send-capable data.mail.<name> account (the owner's own sender — IMAP+SMTP, gmail.send, or Mail.Send); subject and body are the message (body_format text or html). Delivery routes through the same collection.mail.send path as mail-send, so the capability check, sender ≠ recipient guard, and mail_send audit row all fire — with the recipient list REDACTED from that audit row (D-210 audit finding 3b: the row records recipient_count, subject and message-id, never the sealed address; before the fix a one-recipient send always fell under the noise-redaction threshold and wrote it in plaintext to a durable row that travels with a backup). Returns { notified, reason }: notified:false with a coarse reason (not_a_reception_booking — the booking did not come from a visitor request, so there is nobody sealed behind it; booking_not_found; no_visitor_email — the visitor gave none) when there is nothing to send, and the address is never surfaced in any branch. This IS an irreversible external send: it lifts to the D-157 preflight gate, where the owner approves the notice bound to a specific booking (the raw email is deliberately not shown — it never left the substrate). Pair it with a booking-watcher reactive recipe to close the loop: the audit trail records that the owner moved the booking, this records that the visitor was told. Routes via the paired server; server-only because the visitor PII lives sealed in the warehouse.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "permission": "mail_send",
    "authority_args": [
      "event_source_id",
      "sender_mail_instance"
    ],
    "tags": [
      "kernel",
      "reception",
      "mail",
      "send",
      "notify",
      "write"
    ],
    "input": {
      "booking_id": null,
      "sender_mail_instance": null,
      "subject": null,
      "body": null,
      "body_format": "text"
    },
    "output": {
      "notified": "notified",
      "reason": "reason"
    }
  },
  {
    "slug": "mail-thread-reader",
    "name": "Assemble a mail thread",
    "description": "Bundle every data.mail record sharing the same thread_id into a chronologically-sorted thread. Returns the messages array (oldest → newest by received_at), message_count, and first_at / last_at boundary timestamps. Bounded by max_messages (default 50) — older messages drop off the head when the thread exceeds the cap, so first_at reflects the bounded window's start, not the absolute thread start. Routes via the paired server's `mail.thread.read` rpc — server-only because mail bodies live in the warehouse.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "mail",
      "warehouse",
      "thread",
      "read",
      "graph-builder"
    ],
    "input": {
      "slug": null,
      "thread_id": null,
      "max_messages": null
    },
    "output": {
      "messages": "messages",
      "message_count": "message_count",
      "first_at": "first_at",
      "last_at": "last_at"
    }
  },
  {
    "slug": "mail-watcher",
    "name": "Mail Watcher",
    "description": "Reads the server warehouse `data.mail.*` collection and returns `should_run: true` when any message newer than `since` matches the (optional) from / subject / label filter. Metadata-only — body contents never leave the warehouse. Extension invocations route via pair rpc to the paired recued-server; extensions without a paired server get `should_run: false` and a `no_paired_server` flag so the scheduler can advance the circuit-breaker counter rather than spinning silently.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "mail",
      "warehouse",
      "trigger"
    ],
    "input": {
      "since": null,
      "from": null,
      "subject": null,
      "label": null,
      "limit": null
    },
    "output": {
      "should_run": "should_run",
      "items": "items",
      "last_seen_at": "last_seen_at"
    }
  },
  {
    "slug": "note-create",
    "name": "Create note",
    "description": "Create a note on the chosen Source. Default Source is the per-kind pinned default (prefs.note.last_used_source_id) falling back to the Recued built-in. last_user_action_at is stamped to now. Returns the canonical note record. Optional `container_names` names the destination container up front — a map from the Source's container dependency ref (the `dependency_ref` a container pick surfaces, e.g. `project` on Asana / `team` on Linear / `tasklist` on Google Tasks) to that container's name, `{ project: 'Roadmap' }` — so a caller that already knows the destination skips the ambiguous-container pick. A granted name that doesn't exist yet plans the container's creation for the owner to confirm; naming only disambiguates, so the write itself is still approval-gated.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "note",
      "work-entity",
      "write"
    ],
    "input": {
      "body": null,
      "title": null,
      "related_contact_ids": null,
      "related_calendar_event_ids": null,
      "related_mail_thread_ids": null,
      "related_project_ids": null,
      "source_id": null,
      "container_names": {}
    },
    "output": {
      "note": "note"
    }
  },
  {
    "slug": "note-delete",
    "name": "Delete note",
    "description": "Tombstone (default) or hard-delete a note. Tombstoning preserves the row + access ledger; hard-delete cascades through the note_access_ledger. Returns { ok, id, tombstoned }.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "destructive",
    "tags": [
      "kernel",
      "note",
      "work-entity",
      "delete"
    ],
    "input": {
      "id": null,
      "tombstone": null
    },
    "output": {
      "ok": "ok",
      "id": "id",
      "tombstoned": "tombstoned"
    }
  },
  {
    "slug": "note-update",
    "name": "Update note",
    "description": "Patch named fields on an existing note. last_user_action_at advances on every successful update (this counts as an explicit user edit). Source identity is inherited from the row.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "note",
      "work-entity",
      "write"
    ],
    "input": {
      "id": null,
      "body": null,
      "title": null,
      "related_contact_ids": null,
      "related_calendar_event_ids": null,
      "related_mail_thread_ids": null,
      "related_project_ids": null
    },
    "output": {
      "note": "note"
    }
  },
  {
    "slug": "notification-send",
    "name": "Notification Send",
    "description": "Dispatches a rendered notification through one or more configured output channels (Slack DM, Telegram, email, in-app banner). Omitting `channels` fans out to every supported channel; recipes should set channels only when the user expressed a delivery preference. Channel implementations route via the existing remote-trigger config (Slack/Telegram/email — D-099) and the broadcast bus (in-app — D-121 Phase 6). Generic — alert recipes use this rather than channel-specific ingredients (slack-post, telegram-send, etc.) so channel choice stays in the recipe's config rather than its step graph. Returns delivery results per-channel: `delivered_to[]` for successful channels, `failed[]` for failures. `link_url` (renamed from `url` in the spec to avoid collision with the engine-locked HTTP routing key) carries an optional deep link surfaced alongside the body.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "permission": "notification_send",
    "tags": [
      "kernel",
      "notification",
      "alert",
      "action"
    ],
    "input": {
      "channels": [
        "slack",
        "telegram",
        "email",
        "in_app"
      ],
      "text": null,
      "title": null,
      "link_url": null
    },
    "output": {
      "delivered_to": "delivered_to",
      "failed": "failed"
    }
  },
  {
    "slug": "schedule-recipe",
    "name": "Schedule Installed Recipe",
    "description": "Creates a server-owned recurring or one-shot schedule for a recipe that is already installed on this local instance. This is a control-plane kernel operation: callers provide only recipe_id plus schedule timing, never inline recipe JSON or new recipe steps. One-shot schedules fire once and then disable themselves after the terminal attempt.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "schedule",
      "recipe",
      "automation"
    ],
    "input": {
      "recipe_id": null,
      "mode": null,
      "run_at": 0,
      "cron_expression": "",
      "dish_id": "",
      "enabled": true
    },
    "output": {
      "schedule": "schedule"
    }
  },
  {
    "slug": "work-entity-list",
    "name": "List native work entities",
    "description": "Recipe-callable polymorphic read over one native work-entity kind. Optional source_id scopes to one Source; parent_project_id is an exact task/project-only scope applied in storage before rows enter recipe state. Returns canonical tagged entities plus the full matching count before pagination.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "work-entity",
      "read",
      "list"
    ],
    "input": {
      "kind": null,
      "source_id": null,
      "sync_states": null,
      "include_deleted": false,
      "include_disabled": false,
      "parent_project_id": null,
      "limit": null,
      "offset": null
    },
    "output": {
      "entities": "entities",
      "total": "total"
    }
  },
  {
    "slug": "work-entity-get",
    "name": "Get a native work entity",
    "description": "Recipe-callable by-id read over one native work-entity kind. Tombstoned and orphaned rows remain excluded by the resolver. Returns the canonical tagged entity or null and an explicit found flag.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "work-entity",
      "read",
      "get"
    ],
    "input": {
      "kind": null,
      "id": null
    },
    "output": {
      "entity": "entity",
      "found": "found"
    }
  },
  {
    "slug": "project-archive",
    "name": "Archive project",
    "description": "Move a project's state to 'archived'. Idempotent — re-archiving an already-archived project is a no-op (returns the unchanged record). Stamps updated_at on the row only when the state transition actually happens.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "project",
      "work-entity",
      "lifecycle"
    ],
    "input": {
      "id": null
    },
    "output": {
      "project": "project"
    }
  },
  {
    "slug": "project-create",
    "name": "Create project",
    "description": "Create a project on the chosen Source. state defaults to 'active'; last_activity_at is stamped to now. parent_project_id is depth-checked (PROJECT_HIERARCHY_MAX_DEPTH = 3) and cycle-checked. Returns the canonical project record. Optional `container_names` names the destination container up front — a map from the Source's container dependency ref (the `dependency_ref` a container pick surfaces, e.g. `workspace` on Asana / `team` on Linear) to that container's name, `{ workspace: 'Acme' }` — so a caller that already knows the destination skips the ambiguous-container pick. A granted name that doesn't exist yet plans the container's creation for the owner to confirm; naming only disambiguates, so the write itself is still approval-gated.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "project",
      "work-entity",
      "write"
    ],
    "input": {
      "title": null,
      "description": null,
      "state": null,
      "target_completion_at": null,
      "related_contact_ids": null,
      "parent_project_id": null,
      "source_id": null,
      "container_names": {}
    },
    "output": {
      "project": "project"
    }
  },
  {
    "slug": "project-update",
    "name": "Update project",
    "description": "Patch named fields on an existing project. parent_project_id changes are depth-checked + cycle-checked at write time. Source identity is inherited from the row.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "project",
      "work-entity",
      "write"
    ],
    "input": {
      "id": null,
      "title": null,
      "description": null,
      "state": null,
      "target_completion_at": null,
      "related_contact_ids": null,
      "parent_project_id": null
    },
    "output": {
      "project": "project"
    }
  },
  {
    "slug": "booking-create",
    "name": "Create booking",
    "description": "Create a booking \u2014 the BUSINESS record for a reservation: who the customer is, when it is, what it is worth, and how it ended. The booking carries its OWN appointment time in `slot_start_at` / `slot_end_at` (epoch ms). A booking is NOT a calendar event and never appears in the calendar. Supply both slot fields or neither \u2014 a start without an end is refused. Omit both when the time is not agreed yet. Do NOT send a duration: it is `slot_end_at` minus `slot_start_at`. `lifecycle_state` defaults to 'confirmed' (a booking is normally created at the moment it is approved); use 'pending' only for a flow with a real pre-confirmation step. You CANNOT set the originating reception record — that provenance is written by the server when a reservation is approved, and is not an argument here. `monetary_value` is both `amount` (decimal string, scale 2) and `currency` (ISO 4217) or neither. Returns the canonical booking record.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "booking",
      "work-entity",
      "write"
    ],
    "input": {
      "title": null,
      "lifecycle_state": null,
      "slot_start_at": null,
      "slot_end_at": null,
      "monetary_value": null,
      "counterparty_contact_id": null,
      "source_id": null
    },
    "output": {
      "booking": "booking"
    }
  },
  {
    "slug": "booking-update",
    "name": "Update booking",
    "description": "Patch named fields on an existing booking, including `lifecycle_state` \u2014 this is the ONLY lifecycle path; there are no separate cancel / complete ingredients. Moving to 'completed' / 'no_show' / 'cancelled' re-stamps `state_changed_at`; a metadata-only edit does NOT, so `state_changed_at` keeps meaning \"when this booking reached its current state\". To RESCHEDULE, send `slot_start_at` AND `slot_end_at` together (epoch ms) \u2014 this ingredient is how a booking moves in time, and there is no calendar event to update instead. Sending only one of the two is refused rather than half-applied: keeping the old end against a new start would silently change the booking's duration. `reception_record_id` is write-once provenance and is preserved. Omitted fields are preserved, not cleared.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "booking",
      "work-entity",
      "write"
    ],
    "input": {
      "id": null,
      "title": null,
      "lifecycle_state": null,
      "slot_start_at": null,
      "slot_end_at": null,
      "monetary_value": null,
      "counterparty_contact_id": null
    },
    "output": {
      "booking": "booking"
    }
  },
  {
    "slug": "booking-delete",
    "name": "Delete booking",
    "description": "Tombstone (default) or hard-delete a booking. Prefer setting `lifecycle_state` to 'cancelled' via booking-update \u2014 a cancelled booking is a business fact worth keeping, and deleting the row discards the money and customer it recorded. Returns { ok, id, tombstoned }.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "destructive",
    "tags": [
      "kernel",
      "booking",
      "work-entity",
      "delete"
    ],
    "input": {
      "id": null,
      "tombstone": null
    },
    "output": {
      "ok": "ok",
      "id": "id",
      "tombstoned": "tombstoned"
    }
  },
  {
    "slug": "reception-materialize",
    "name": "Complete a reviewed reception submission",
    "description": "Internal kernel ingredient: the LOCAL dispatch target the Gateway routes a reception catalog op's `materialize` to on approve-resume (D-173 P1-dispatch). A reception core-pack op (reception-intake / reception-approval) is a catalog-form `approval_required` operation whose REST binding points at the local-only `https://reception.local` sentinel; the D-157 gate HOLDS it pending until the inbox approves, then the engine re-dispatches the gated op. The ingredient executor recognises the reception-local surface dispatch and routes it here instead of an HTTP call, so completion runs in-process through runReceptionProjection. Entity targets write through their destination Source; `form_response` creates or verifies the mutable working destination while preserving its immutable sealed Reception evidence twin. INTENDED as the dispatch sink only — but ⛔ that is NOT ENFORCED and this description used to claim it was: nothing stops a recipe naming this slug directly, and a direct `{ingredient: ...}` step reaches it WITHOUT the D-157 gate, because that gate only runs on the catalog path for `{operation, args}`-shaped steps (`catalog-gateway.ts`). The substrate has no flag to express `internal` / `dispatch_sink` (there is no such field on any manifest); `chat_exposed` is catalog visibility and `MCP_EXPOSED_KERNEL_INGREDIENTS` is the MCP tool surface, and neither governs a recipe reference. Marketplace publish blocks it (`isCoreCapabilitySlug` requires a `core-` prefix) but that policy is marketplace-side only and the server never re-runs it, so bundled + locally-installed recipes are unaffected by it. See D-210 (the declared-not-backed finding).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "reception",
      "materialize",
      "warehouse",
      "write"
    ],
    "input": {
      "top_tier_kind": null,
      "id": null,
      "title": null,
      "body": null,
      "metadata": null,
      "source_id": null,
      "contact_email": null,
      "contact_name": null,
      "promised_for_at": null,
      "reject_if_slot_past": null,
      "start_at": null,
      "notify_visitor": null,
      "duration_minutes": null,
      "timezone": null,
      "booking_request_id": null,
      "booking_binding": null,
      "is_all_day": null,
      "file_id": null
    },
    "output": {
      "top_tier_kind": "top_tier_kind",
      "target_id": "target_id"
    }
  },
  {
    "slug": "recipe-watcher",
    "name": "Recipe Watcher",
    "description": "Watches the local audit log for recipe runs matching a target `recipe_id` + outcome. Three modes via `kind`: `succeeded_since` (fires when a target recipe has a successful run after the stored cursor), `failed_since` (same for failures), `stopped_since` (same for user-stopped runs). Returns `{ should_run, runs }` where `runs[]` is the matching audit rows. Author advances a `shared.<cursor>` key after each fire so the next tick picks up only fresher runs.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "recipe",
      "audit",
      "trigger"
    ],
    "input": {
      "kind": null,
      "recipe_id": null,
      "since_ms": null
    },
    "output": {
      "should_run": "should_run",
      "runs": "runs"
    }
  },
  {
    "slug": "shared-compare-and-set",
    "name": "Compare and set a shared record",
    "description": "Atomically create or advance one revision-controlled data.shared.* record. expected_revision null means create-if-absent and requires value.revision 0. A numeric expectation requires an existing row at that revision and value.revision exactly one higher. Values are inline-only and must serialize to at most 64 KiB, so a stale conflict never strands a pre-transaction blob. Conflicts fail the step with a typed conflict so a later reconciler can re-read source truth; this ingredient never spins or retries in-run.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "shared",
      "compare-and-set",
      "concurrency"
    ],
    "input": {
      "key": null,
      "expected_revision": null,
      "value": null
    },
    "output": {
      "ok": "ok",
      "key": "key",
      "revision": "revision",
      "created": "created",
      "bytes_written": "bytes_written"
    }
  },
  {
    "slug": "shared-delete",
    "name": "Delete from shared store",
    "description": "Delete a single shared.* or data.shared.* record by key. Routing by key prefix matches shared-write. Returns ok:true whether or not the key existed. A revision-controlled data.shared.* row rejects with a typed conflict and remains intact; it can only advance through shared-compare-and-set.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "shared",
      "delete"
    ],
    "input": {
      "key": null
    },
    "output": {
      "ok": "ok",
      "key": "key"
    }
  },
  {
    "slug": "shared-delete-prefix",
    "name": "Delete shared records by prefix",
    "description": "Delete every shared.* or data.shared.* record whose key matches the given prefix. DESTRUCTIVE — approval-gated. Recipe authors should prefer narrow prefixes; the kernel does not attempt to prevent a `data.shared.` full-namespace wipe. If any matched data.shared.* row is revision-controlled, the operation reports a typed conflict and deletes nothing. Otherwise it returns the count of deleted records.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "destructive",
    "tags": [
      "kernel",
      "shared",
      "delete",
      "prefix"
    ],
    "input": {
      "prefix": null
    },
    "output": {
      "ok": "ok",
      "prefix": "prefix",
      "deleted": "deleted"
    }
  },
  {
    "slug": "shared-list",
    "name": "List shared records by prefix",
    "description": "Return every shared.* or data.shared.* record whose key starts with the given prefix. One entry per record — the caller walks the resulting array with a transform / foreach.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "shared",
      "list"
    ],
    "input": {
      "prefix": null
    },
    "output": {
      "entries": "entries"
    }
  },
  {
    "slug": "shared-read",
    "name": "Read one shared record by key",
    "description": "Return one exact shared.* or data.shared.* record by key. Use this when a recipe already knows the full key and should not pay a prefix list or full-text search cost. Missing keys return found:false.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "shared",
      "read"
    ],
    "input": {
      "key": null
    },
    "output": {
      "found": "found",
      "key": "key",
      "value": "value",
      "cas_revision": "cas_revision"
    }
  },
  {
    "slug": "shared-search",
    "name": "Full-text search across shared records",
    "description": "Run a SQLite FTS5 query against the shared store scoped to a key glob (`deal.*`) or exact key. Returns ranked matches with the record value inlined. Values larger than 64 KB (content-addressed-blob-backed) are NOT indexed — documented limit per the Phase A spec.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "shared",
      "search",
      "fts"
    ],
    "input": {
      "scope": null,
      "query": null
    },
    "output": {
      "matches": "matches"
    }
  },
  {
    "slug": "shared-write",
    "name": "Write to shared store",
    "description": "Persist a value under a shared.* (cache tier, LRU+TTL) or data.shared.* (durable SQLite plus content-addressed blobs) key. The kernel routes by key prefix — cache keys go through the ext's local cache + peer broadcast; durable keys rpc to the paired recued-server. Returns bytes_written on success. A revision-controlled durable key rejects with a typed conflict and must advance through shared-compare-and-set.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "shared",
      "write"
    ],
    "input": {
      "key": null,
      "value": null,
      "ttl": null
    },
    "output": {
      "ok": "ok",
      "key": "key",
      "bytes_written": "bytes_written"
    }
  },
  {
    "slug": "task-create",
    "name": "Create task",
    "description": "Create a task on the chosen Source. Default Source is the per-kind pinned default (prefs.task.last_used_source_id) falling back to the Recued built-in. Connection-derived Sources require write_capable: true (set by the first-dispatch capability probe). Optional idempotency_key switches to atomic create-or-reuse on one deterministic Recued-local task id; it cannot route to a sticky or vendor Source. Returns the canonical task record stamped with _id + _collection. Optional `container_names` names the destination container up front — a map from the Source's container dependency ref (the `dependency_ref` a container pick surfaces, e.g. `project` on Asana / `team` on Linear / `tasklist` on Google Tasks) to that container's name, `{ project: 'Roadmap' }` — so a caller that already knows the destination skips the ambiguous-container pick. A granted name that doesn't exist yet plans the container's creation for the owner to confirm; naming only disambiguates, so the write itself is still approval-gated.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "task",
      "work-entity",
      "write"
    ],
    "input": {
      "title": null,
      "idempotency_key": null,
      "body": null,
      "due_at": null,
      "priority": null,
      "state": null,
      "progress": null,
      "done": null,
      "completed_at": null,
      "assigned_contact_id": null,
      "parent_calendar_event_id": null,
      "linked_mail_thread_id": null,
      "parent_project_id": null,
      "blocks_task_ids": null,
      "source_extension_blob": null,
      "source_id": null,
      "container_names": {}
    },
    "output": {
      "task": "task"
    }
  },
  {
    "slug": "task-delete",
    "name": "Delete task",
    "description": "Tombstone (default) or hard-delete a task. Tombstoning preserves the row with sync_state: 'tombstoned' so cascade history + audit references resolve; hard-delete is escape-hatch only. Returns { ok, id, tombstoned }.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "destructive",
    "tags": [
      "kernel",
      "task",
      "work-entity",
      "delete"
    ],
    "input": {
      "id": null,
      "tombstone": null
    },
    "output": {
      "ok": "ok",
      "id": "id",
      "tombstoned": "tombstoned"
    }
  },
  {
    "slug": "task-mark-done",
    "name": "Mark task done",
    "description": "Flip a task's done flag. Defaults to done: true with completed_at: now. Pass done: false to un-complete (rare — user-error correction). Returns the post-update canonical task record.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "task",
      "work-entity",
      "write"
    ],
    "input": {
      "id": null,
      "done": null,
      "completed_at": null
    },
    "output": {
      "task": "task"
    }
  },
  {
    "slug": "task-update",
    "name": "Update task",
    "description": "Patch named fields on an existing task. Source identity is inherited from the row — updating across Sources is not supported (pin a default through Settings to switch Sources). Returns the post-update canonical task record.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "action",
    "risk_tier": "write",
    "tags": [
      "kernel",
      "task",
      "work-entity",
      "write"
    ],
    "input": {
      "id": null,
      "title": null,
      "body": null,
      "due_at": null,
      "priority": null,
      "state": null,
      "progress": null,
      "assigned_contact_id": null,
      "parent_calendar_event_id": null,
      "linked_mail_thread_id": null,
      "parent_project_id": null,
      "blocks_task_ids": null,
      "source_extension_blob": null
    },
    "output": {
      "task": "task"
    }
  },
  {
    "slug": "time-relative-watcher",
    "name": "Time-Relative Watcher",
    "description": "Fires when wall-clock time crosses a declared offset relative to a field on a warehouse record. Generic temporal anchor — drives meeting reminders, deadline alerts, renewal nudges, anniversary triggers, follow-up windows. Sweeper queries the collection every TIME_RELATIVE_SWEEP_MS (60 s) for records whose (anchor_field + offset) has crossed since the last sweep. Per-fire output surfaces `fired` + `trigger_record_id` + `trigger_record` + `trigger_offset` so the recipe body can branch on which boundary fired. Lives inside `trigger_steps` of an `auto_run` recipe.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "time",
      "trigger"
    ],
    "input": {
      "collection": null,
      "anchor_field": null,
      "offsets": null,
      "filter": null
    },
    "output": {
      "should_run": "should_run",
      "fired": "fired",
      "trigger_record_id": "trigger_record_id",
      "trigger_record": "trigger_record",
      "trigger_offset": "trigger_offset",
      "anchor_at": "anchor_at"
    }
  },
  {
    "slug": "time-watcher",
    "name": "Time Watcher",
    "description": "Pure time predicate for reactive-recipe gating. Returns `should_run: true` when the current moment falls inside the declared window (optional weekday set, optional start/end hour range in local TZ). Useful as the 'only fire during business hours' guard in a trigger_steps chain, AND-combined with a data-source watcher so reactive ticks stay quiet outside the window. Local TZ = the Recued runtime's host TZ; no data, no I/O, runs on every tick.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "time",
      "trigger"
    ],
    "input": {
      "weekdays": null,
      "start_hour": null,
      "end_hour": null
    },
    "output": {
      "should_run": "should_run"
    }
  },
  {
    "slug": "timeline-read",
    "name": "Read an entity's timeline",
    "description": "Recipe-side access to data.timeline(entity) — assembles a chronological feed of mail / calendar / contact / annotation / memory rows hanging off a single warehouse entity. Same primitive that MCP exposes; surfacing it inside recipes lets extraction recipes read prior context (existing annotations, neighbouring mail, prior backfill activity) before deciding whether to write. `entity` is a combined `<collection>:<id>` string. `axis` defaults to `event` (sort by underlying real-world date, COALESCE(event_at, ts)); `ingestion` flips to wall-clock-recorded order. Cursor pagination via the opaque `cursor` token. Channel-isolated from MCP per the channel invariant — same SELECT, separate dispatcher.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "memory",
      "timeline",
      "read",
      "graph-builder"
    ],
    "input": {
      "entity": null,
      "axis": null,
      "since": null,
      "until": null,
      "limit": null,
      "cursor": null
    },
    "output": {
      "entries": "entries",
      "next_cursor": "next_cursor"
    }
  },
  {
    "slug": "webhook-get",
    "name": "Fetch a single webhook delivery",
    "description": "Return one record from `data.webhook.{slug}.*` by record_id. `record_id` comes from `webhook-list` output (`webhook:{ULID}` — lexicographic by arrival time). `record.body_inline` holds text bodies up to 64 KB; larger payloads are reachable via `record.blob_hash`. `hot_fields.headers_subset` keeps the provider-relevant signature + event headers (github, slack, stripe) the listener captured at receive time.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "webhook",
      "warehouse",
      "get"
    ],
    "input": {
      "slug": null,
      "record_id": null
    },
    "output": {
      "record": "record"
    }
  },
  {
    "slug": "webhook-list",
    "name": "List webhook deliveries",
    "description": "Return inbound-webhook deliveries from `data.webhook.{slug}.*` filtered by hot-field equality, `received_at` range, and limit. Deliveries carry `hot_fields = { method, headers_subset, remote_ip, query, content_type }`. Bodies ≤ 64 KB live inline (utf8 for text / json, base64 otherwise); larger payloads move to the CAS blob store. Requires a paired `[webhook.{slug}]` configured on the server with `public_reachable=true` + `webhook_port>0` (D-096: no cloud relay).",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "webhook",
      "warehouse",
      "list"
    ],
    "input": {
      "slug": null
    },
    "output": {
      "records": "records"
    }
  },
  {
    "slug": "webhook-watcher",
    "name": "Webhook Watcher",
    "description": "Server-only. Registers an inbound webhook endpoint at `<server_base>/hook/<recipe_id>/<slug>`. Incoming POSTs queue in a bounded in-memory buffer between ticks; on tick, the watcher drains the queue and returns `should_run: queue.length > 0` with the drained payloads. Requires a publicly reachable recued-server (D-096 — cloud never relays webhooks). Extension instances see `should_run: false` with a `server_only: true` flag and eventually auto-disable via circuit breaker.",
    "author": "recued",
    "kind": "storage",
    "version": 1,
    "category": "data",
    "risk_tier": "read",
    "tags": [
      "kernel",
      "watcher",
      "webhook",
      "server-only",
      "trigger"
    ],
    "input": {
      "recipe_id": null,
      "slug": null
    },
    "output": {
      "should_run": "should_run",
      "requests": "requests",
      "queue_size": "queue_size"
    }
  }
];

export const KERNEL_MANIFESTS = MANIFESTS as unknown as IngredientManifest[];

export const KERNEL_MANIFEST_SLUGS: ReadonlySet<string> = new Set(
  KERNEL_MANIFESTS.map((m) => m.slug),
);
