/**
 * tools.ts — pi custom tools that wrap the hyperresearch Python CLI.
 *
 * Each tool maps to one or more `hyperresearch` subcommands, always passing
 * `--json` and parsing the result. Tools truncate large output to keep the
 * LLM context lean.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { runHpr, runHprRaw } from "./hpr.js";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";

/**
 * load_skill — load a hyperresearch pipeline step skill's full content.
 *
 * Replaces Claude Code's `Skill(skill: "name")` invocation. The orchestrator
 * calls this to load each of the 16 step procedures on-demand, keeping them
 * out of context until needed (defeats context-rot, same principle as V8).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

function loadSkillContent(name: string): string | null {
  // Try <name>.md (flat file) then <name>/SKILL.md (directory)
 const flat = join(SKILLS_DIR, `${name}.md`);
  try {
    return readFileSync(flat, "utf8");
  } catch {
    /* try directory form */
  }
  const dirForm = join(SKILLS_DIR, name, "SKILL.md");
  try {
    return readFileSync(dirForm, "utf8");
  } catch {
    return null;
  }
}

/** Helper: format a runHpr result into a tool result with truncation. */
function fmtResult<T>(res: { ok: boolean; data?: T; error?: string; stderr?: string }) {
  if (!res.ok) {
    return {
      content: [{ type: "text" as const, text: `Error: ${res.error}\n${res.stderr ?? ""}` }],
      details: { error: res.error },
      isError: true,
    };
  }
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
  const trunc = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let out = trunc.content;
  if (trunc.truncated) {
    out += `\n\n[Output truncated: ${trunc.outputLines} of ${trunc.totalLines} lines (${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)})]`;
  }
  return {
    content: [{ type: "text" as const, text: out }],
    details: { data: res.data, truncated: trunc.truncated },
  };
}

export function registerTools(pi: ExtensionAPI): void {
  // ── hr_search ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_search",
    label: "Vault Search",
    description:
      "Full-text search across the research vault (hyperresearch search). Returns matching notes with titles, summaries, tags. Use this BEFORE web_search — the vault compounds across sessions and may already have the source you need.",
    promptSnippet: "Search the research vault (FTS5). Prefer over web_search when sources may already exist.",
    promptGuidelines: [
      "Use hr_search before hr_fetch or web_search when researching a topic — the persistent vault may already contain relevant sources from prior runs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query (FTS5, supports natural language)" }),
      tag: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags (AND logic)" })),
      status: Type.Optional(StringEnum(["draft", "review", "evergreen", "stale", "deprecated", "archive"], { description: "Filter by status" })),
      note_type: Type.Optional(StringEnum(["note", "raw", "index", "moc", "interim", "source-analysis"], { description: "Filter by note type" })),
      tier: Type.Optional(StringEnum(["ground_truth", "institutional", "practitioner", "commentary", "unknown"], { description: "Epistemic tier: ground_truth|institutional|practitioner|commentary|unknown" })),
      content_type: Type.Optional(StringEnum(["paper", "docs", "article", "blog", "forum", "dataset", "policy", "code", "book", "transcript", "review", "unknown"], { description: "paper|docs|article|blog|forum|dataset|policy|code|book|transcript|review|unknown" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["search", params.query];
      params.tag?.forEach((t) => args.push("--tag", t));
      if (params.status) args.push("--status", params.status);
      if (params.note_type) args.push("--type", params.note_type);
      if (params.tier) args.push("--tier", params.tier);
      if (params.content_type) args.push("--content-type", params.content_type);
      if (params.limit) args.push("--limit", String(params.limit));
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_fetch ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_fetch",
    label: "Fetch to Vault",
    description:
      "Fetch a URL and save its content as a research note in the vault (hyperresearch fetch). Auto-detects PDFs (arXiv, NBER, direct .pdf) and extracts full text. Supports authenticated crawling via crawl4ai. Returns the new note metadata.",
    promptSnippet: "Fetch a URL into the vault as a markdown note (PDF-aware, authenticated crawling supported).",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      tag: Type.Optional(Type.Array(Type.String(), { description: "Tags to apply" })),
      suggested_by: Type.Optional(Type.Array(Type.String(), { description: "Note IDs that suggested this URL (provenance breadcrumbs)" })),
      summary: Type.Optional(Type.String({ description: "Custom summary" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["fetch", params.url];
      params.tag?.forEach((t) => args.push("--tag", t));
      if (params.summary) args.push("--summary", params.summary);
      params.suggested_by?.forEach((s) => args.push("--suggested-by", s));
      const res = await runHpr(args, { signal, cwd: ctx.cwd, timeoutMs: 120_000 });
      return fmtResult(res);
    },
  });

  // ── hr_fetch_batch ───────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_fetch_batch",
    label: "Batch Fetch",
    description:
      "Fetch multiple URLs in one batched operation and save each as a research note (hyperresearch fetch-batch). Faster than repeated hr_fetch calls because sync is batched. Use for parallel fetcher waves.",
    promptSnippet: "Batch-fetch multiple URLs into the vault (batched sync, faster than sequential hr_fetch).",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "URLs to fetch" }),
      tag: Type.Optional(Type.Array(Type.String())),
      suggested_by: Type.Optional(Type.String({ description: "Single note ID that suggested this batch" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["fetch-batch"];
      params.urls.forEach((u) => args.push(u));
      params.tag?.forEach((t) => args.push("--tag", t));
      if (params.suggested_by) args.push("--suggested-by", params.suggested_by);
      const res = await runHpr(args, { signal, cwd: ctx.cwd, timeoutMs: 300_000 });
      return fmtResult(res);
    },
  });

  // ── hr_note_show ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_note_show",
    label: "Read Note",
    description: "Read one or more notes by ID, returning full metadata and body (hyperresearch note show).",
    promptSnippet: "Read full note content by ID from the vault.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "Note IDs (slugs) to read" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["note", "show", ...params.ids];
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_note_new ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_note_new",
    label: "Create Note",
    description:
      "Create a new research note in the vault (hyperresearch note new). Use for interim reports, synthesis notes, etc. Prefer --body-file for long content.",
    promptSnippet: "Create a new markdown note in the vault with frontmatter, tags, and type.",
    parameters: Type.Object({
      title: Type.String({ description: "Note title" }),
      tag: Type.Optional(Type.Array(Type.String(), { description: "Tags to apply (repeatable)" })),
      note_type: Type.Optional(
        StringEnum(["note", "raw", "index", "moc", "interim", "source-analysis"], {
          description: "Note type. One of: note, raw, index, moc, interim, source-analysis. Default: note.",
        }),
      ),
      status: Type.Optional(
        StringEnum(["draft", "review", "evergreen", "stale", "deprecated", "archive"], {
          description: "Initial status. Default: draft.",
        }),
      ),
      body_file: Type.Optional(Type.String({ description: "Path to a markdown body file (relative to cwd)" })),
      summary: Type.Optional(Type.String({ description: "One-line summary" })),
      source: Type.Optional(Type.String({ description: "Source URL or path" })),
      parent: Type.Optional(Type.String({ description: "Parent topic slug" })),
      tier: Type.Optional(
        StringEnum(["ground_truth", "institutional", "practitioner", "commentary", "unknown"], {
          description: "Epistemic tier: ground_truth|institutional|practitioner|commentary|unknown",
        }),
      ),
      content_type: Type.Optional(
        StringEnum(["paper", "docs", "article", "blog", "forum", "dataset", "policy", "code", "book", "transcript", "review", "unknown"], {
          description: "Artifact kind: paper|docs|article|blog|forum|dataset|policy|code|book|transcript|review|unknown",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["note", "new", params.title];
      params.tag?.forEach((t) => args.push("--tag", t));
      if (params.note_type) args.push("--type", params.note_type);
      if (params.status) args.push("--status", params.status);
      if (params.body_file) args.push("--body-file", params.body_file);
      if (params.summary) args.push("--summary", params.summary);
      if (params.source) args.push("--source", params.source);
      if (params.parent) args.push("--parent", params.parent);
      if (params.tier) args.push("--tier", params.tier);
      if (params.content_type) args.push("--content-type", params.content_type);
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_note_update ───────────────────────────────────────────────────
  // NOTE: `note update` only modifies frontmatter fields — it does NOT
  // support --title or --body-file (unlike `note new`). Tags use
  // --add-tag / --remove-tag (not --tag).
  pi.registerTool({
    name: "hr_note_update",
    label: "Update Note",
    description:
      "Update frontmatter fields on an existing research note (hyperresearch note update). Only modifies metadata — not the note body. Use hr_note_new to create, or edit the markdown file directly to change body content.",
    promptSnippet: "Update an existing vault note's frontmatter (status, tags, summary, tier, etc.).",
    parameters: Type.Object({
      id: Type.String({ description: "Note ID to update" }),
      status: Type.Optional(
        StringEnum(["draft", "review", "evergreen", "stale", "deprecated", "archive"], {
          description: "Set status",
        }),
      ),
      add_tag: Type.Optional(Type.Array(Type.String(), { description: "Tag(s) to add" })),
      remove_tag: Type.Optional(Type.Array(Type.String(), { description: "Tag(s) to remove" })),
      summary: Type.Optional(Type.String({ description: "Set one-line summary" })),
      parent: Type.Optional(Type.String({ description: "Set parent topic slug" })),
      source: Type.Optional(Type.String({ description: "Set source URL/path" })),
      tier: Type.Optional(
        StringEnum(["ground_truth", "institutional", "practitioner", "commentary", "unknown"], {
          description: "Set epistemic tier",
        }),
      ),
      content_type: Type.Optional(
        StringEnum(["paper", "docs", "article", "blog", "forum", "dataset", "policy", "code", "book", "transcript", "review", "unknown"], {
          description: "Set artifact kind",
        }),
      ),
      deprecate: Type.Optional(Type.Boolean({ description: "Mark as deprecated" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["note", "update", params.id];
      if (params.status) args.push("--status", params.status);
      params.add_tag?.forEach((t) => args.push("--add-tag", t));
      params.remove_tag?.forEach((t) => args.push("--remove-tag", t));
      if (params.summary !== undefined) args.push("--summary", params.summary);
      if (params.parent !== undefined) args.push("--parent", params.parent);
      if (params.source !== undefined) args.push("--source", params.source);
      if (params.tier) args.push("--tier", params.tier);
      if (params.content_type) args.push("--content-type", params.content_type);
      if (params.deprecate) args.push("--deprecate");
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_graph ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_graph",
    label: "Graph Query",
    description:
      "Knowledge graph analysis (hyperresearch graph). Subcommands: hubs (most-connected notes), backlinks (reverse links to a note), orphans (unlinked notes).",
    promptSnippet: "Query the knowledge graph: hubs, backlinks, or orphans.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("hubs"), Type.Literal("backlinks"), Type.Literal("orphans")]),
      note_id: Type.Optional(Type.String({ description: "Note ID (required for backlinks)" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["graph", params.action];
      if (params.note_id) args.push(params.note_id);
      if (params.limit) args.push("--limit", String(params.limit));
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_lint ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_lint",
    label: "Vault Lint",
    description:
      "Health-check the vault (hyperresearch lint). Detects broken links, missing tags, scaffold leaks, unresolved critical findings, provenance issues.",
    promptSnippet: "Health-check the vault for structural failures.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const res = await runHpr(["lint"], { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_status ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_status",
    label: "Vault Status",
    description: "Show vault health and statistics (hyperresearch status): note counts, tags, graph metrics, word counts.",
    promptSnippet: "Show vault statistics and health.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const res = await runHpr(["status"], { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_sync ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_sync",
    label: "Vault Sync",
    description: "Sync the SQLite index with markdown files on disk (hyperresearch sync). Run after manual file edits.",
    promptSnippet: "Reconcile the SQLite index with on-disk markdown.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Full rescan ignoring mtime/hash" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["sync"];
      if (params.force) args.push("--force");
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_vault_tag ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_vault_tag",
    label: "Mint Vault Tag",
    description:
      "Mint a unique vault_tag of the form `<slug>-<6-hex>` (hyperresearch vault-tag). Guarantees no overwrite of prior run artifacts.",
    promptSnippet: "Generate a unique run tag for a research session.",
    parameters: Type.Object({
      slug: Type.String({ description: "Short topical slug (3–5 hyphen-separated words)" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const res = await runHpr(["vault-tag", params.slug], { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_archive_run ───────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_archive_run",
    label: "Archive Run",
    description:
      "Archive prior per-run artifacts (scaffold, loci.json, comparisons, critic-findings, temp/) into research/runs/archive-*/ (hyperresearch archive-run). Safe no-op on fresh vault.",
    promptSnippet: "Archive the previous run's scratch artifacts before starting a new run.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const res = await runHpr(["archive-run"], { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_tags ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_tags",
    label: "List Tags",
    description: "List all tags with note counts (hyperresearch tags).",
    promptSnippet: "List all vault tags and their note counts.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const res = await runHpr(["tags"], { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_init ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_init",
    label: "Init Vault",
    description:
      "Initialize a new hyperresearch vault in the current directory (hyperresearch init). Creates .hyperresearch/ + research/ structure. Idempotent-safe via hr_status check first.",
    promptSnippet: "Initialize the research vault if not already present.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Vault name" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["init", "."];
      if (params.name) args.push("--name", params.name);
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_link ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_link",
    label: "Auto-Link",
    description: "Auto-discover and insert wiki-links between notes (hyperresearch link).",
    promptSnippet: "Auto-discover wiki-links across the vault.",
    parameters: Type.Object({
      note_id: Type.Optional(Type.String({ description: "Scope to one note" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["link", "auto"];
      if (params.note_id) args.push(params.note_id);
      const res = await runHpr(args, { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_dedup ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "hr_dedup",
    label: "Find Duplicates",
    description: "Find near-duplicate notes by content similarity (hyperresearch dedup).",
    promptSnippet: "Find near-duplicate notes in the vault.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const res = await runHpr(["dedup"], { signal, cwd: ctx.cwd });
      return fmtResult(res);
    },
  });

  // ── hr_academic ──────────────────────────────────────────────────────
  // Thin wrapper that runs `hyperresearch research` (the CLI's built-in
  // academic-API sweep + web search). The skill layer orchestrates this
  // for the width-sweep step.
  pi.registerTool({
    name: "hr_academic",
    label: "Academic Search",
    description:
      "Run an academic-API sweep (Semantic Scholar, arXiv, OpenAlex, PubMed) followed by web search, saving results as linked vault notes (hyperresearch research). Use BEFORE generic web_search for any topic with a research literature.",
    promptSnippet: "Academic-API literature sweep + web search, saved to vault.",
    promptGuidelines: [
      "Use hr_academic before web_search for research topics — academic APIs return citation-ranked canonical papers, web search returns derivative commentary.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Research query" }),
      tag: Type.Optional(Type.Array(Type.String())),
      max_results: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["research", params.query];
      params.tag?.forEach((t) => args.push("--tag", t));
      if (params.max_results) args.push("--max-results", String(params.max_results));
      const res = await runHpr(args, { signal, cwd: ctx.cwd, timeoutMs: 300_000 });
      return fmtResult(res);
    },
  });

  // ── load_skill ───────────────────────────────────────────────────────
  // Replaces Claude Code's Skill(skill: "name") — loads a pipeline step
  // skill's full content on demand.
  pi.registerTool({
    name: "load_skill",
    label: "Load Pipeline Step",
    description:
      "Load the full content of a hyperresearch pipeline step skill by name (e.g. 'hyperresearch-1-decompose'). Replaces Claude Code's Skill() invocation. Returns the skill's complete procedure so you can execute that step.",
    promptSnippet: "Load a hyperresearch pipeline step skill's full instructions by name.",
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name, e.g. 'hyperresearch-1-decompose', 'hyperresearch-2-width-sweep', ..., 'hyperresearch-16-readability-audit', or 'hyperresearch' (entry router)",
      }),
    }),
    async execute(_id, params) {
      const content = loadSkillContent(params.name);
      if (!content) {
        return {
          content: [{ type: "text" as const, text: `Skill not found: ${params.name}` }],
          details: { error: "not_found", name: params.name },
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: content }],
        details: { name: params.name, length: content.length },
      };
    },
  });
}
