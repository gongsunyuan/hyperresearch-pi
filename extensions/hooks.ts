/**
 * hooks.ts — pi event hooks for hyperresearch integration.
 *
 *  1. tool_call: when the LLM calls web_search / fetch_content, remind it to
 *     check the vault first (replaces the Claude Code PreToolUse hook).
 *  2. before_agent_start: inject vault-usage guidelines into the system
 *     prompt (replaces CLAUDE.md injection).
 *  3. session_start: verify the hyperresearch CLI is available and notify.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkHpr } from "./hpr.js";
import { deployAgentWithModels, ensureConfig, readConfig } from "./models.js";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VAULT_GUIDELINES = `

## Hyperresearch vault guidelines

A persistent research vault is available in this project (research/ directory, indexed by SQLite).
- BEFORE running a web search or fetching a URL, use hr_search to check whether the vault already contains relevant sources. The vault compounds across sessions.
- When you fetch new web sources, use hr_fetch (not raw downloads) so they land in the vault with provenance breadcrumbs.
- For any topic with a research literature, use hr_academic (Semantic Scholar / arXiv / OpenAlex / PubMed) BEFORE web_search — academic APIs return citation-ranked canonical papers.
- Notes are markdown with YAML frontmatter. Wiki-links [[note-id]] are the canonical citation form.
- "Patch, never regenerate": when revising a research report, apply surgical edits — never rewrite from scratch.
`;

export function registerHooks(
  pi: ExtensionAPI,
  getBootstrap?: () => { available: boolean; version?: string; justInstalled: boolean; error?: string } | undefined,
): void {
  // ── session_start: deploy agents + report CLI bootstrap result ───────
  let cliChecked = false;
  pi.on("session_start", async (_event, ctx) => {
    // Deploy bundled subagent definitions to .pi/agents/hyperresearch/ so
    // pi-subagents discovers them. Reads model config from
    // ~/.pi/agent/hyperresearch-models.yaml and injects model + fallbackModels
    // into each agent's frontmatter based on its tier. Idempotent.
    try {
      const agentsSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
      const agentsDst = join(ctx.cwd, ".pi", "agents", "hyperresearch");
      const configPath = ensureConfig();
      const cfg = readConfig();
      if (existsSync(agentsSrc)) {
        mkdirSync(agentsDst, { recursive: true });
        for (const f of readdirSync(agentsSrc)) {
          if (!f.endsWith(".md")) continue;
          const dst = join(agentsDst, f);
          // Always re-deploy with current model config (cheap; picks up
          // config edits on /reload without manual cleanup).
          deployAgentWithModels(join(agentsSrc, f), dst, cfg);
        }
      }
    } catch {
      // non-fatal — agent deployment is best-effort
    }

    if (cliChecked) return;
    cliChecked = true;
    const bs = getBootstrap?.();
    if (bs && !bs.available) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `hyperresearch CLI not installed. Auto-install failed: ${bs.error ?? "unknown"}. ` +
            `Run manually: pip install hyperresearch`,
          "error",
        );
      }
      return;
    }
    if (ctx.hasUI) {
      const status = bs ?? (await checkHpr());
      // Single startup notification instead of persistent status bar entries
      // (avoids crowding the footer).
      const modelHint = `models config: ~/.pi/agent/hyperresearch-models.json`;
      if (bs?.justInstalled) {
        ctx.ui.notify(
          `hyperresearch CLI auto-installed: ${status.version ?? "ready"}.\n${modelHint}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `hyperresearch ready: ${status.version ?? "hpr"}.\n${modelHint}`,
          "info",
        );
      }

      // hyperresearch's 16-step pipeline hard-depends on the `subagent` tool
      // (13 of 17 skills spawn subagents). pi-subagents is a separate npm
      // package, not built into pi — warn if it's missing so the user knows
      // to `pi install npm:pi-subagents` before running /hyperresearch.
      const allTools = pi.getAllTools();
      const hasSubagent = allTools.some(
        (t) => t.name === "subagent" || t.name === "Task",
      );
      if (!hasSubagent) {
        ctx.ui.notify(
          "hyperresearch needs the subagent tool. Install: pi install npm:pi-subagents",
          "warning",
        );
      }
    }
  });

  // ── before_agent_start: inject vault guidelines ──────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: event.systemPrompt + VAULT_GUIDELINES,
    };
  });

  // ── tool_call: vault-first reminder for web searches ─────────────────
  let reminderShownThisTurn = false;
  pi.on("turn_start", async () => {
    reminderShownThisTurn = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName;
    const isWebSearch =
      tool === "web_search" || tool === "fetch_content" || tool === "hr_fetch";
    if (!isWebSearch) return;
    if (reminderShownThisTurn) return;

    // Only remind if the user hasn't already searched the vault this turn.
    // Lightweight heuristic: show the reminder once per turn.
    reminderShownThisTurn = true;
    if (ctx.hasUI) {
      ctx.ui.setWidget("hr-reminder", [
        "💡 hyperresearch vault active — consider hr_search before fetching new sources.",
        "   The vault compounds across sessions and may already have what you need.",
      ]);
      // Auto-clear after 8 seconds
      setTimeout(() => ctx.ui.setWidget("hr-reminder", undefined), 8000);
    }
  });

  // ── Pipeline progress widget ─────────────────────────────────────────
  // Track which pipeline step the orchestrator is on by watching
  // load_skill tool calls, and surface progress in a footer widget.
  const STEP_NAMES: Record<string, string> = {
    "hyperresearch-1-decompose": "1/16 Decompose",
    "hyperresearch-2-width-sweep": "2/16 Width sweep",
    "hyperresearch-3-contradiction-graph": "3/16 Contradiction graph",
    "hyperresearch-4-loci-analysis": "4/16 Loci analysis",
    "hyperresearch-5-depth-investigation": "5/16 Depth investigation",
    "hyperresearch-6-cross-locus-reconcile": "6/16 Cross-locus reconcile",
    "hyperresearch-7-source-tensions": "7/16 Source tensions",
    "hyperresearch-8-corpus-critic": "8/16 Corpus critic",
    "hyperresearch-9-evidence-digest": "9/16 Evidence digest",
    "hyperresearch-10-triple-draft": "10/16 Triple draft",
    "hyperresearch-11-synthesize": "11/16 Synthesize",
    "hyperresearch-12-critics": "12/16 Critics",
    "hyperresearch-13-gap-fetch": "13/16 Gap fetch",
    "hyperresearch-14-patcher": "14/16 Patcher",
    "hyperresearch-15-polish": "15/16 Polish",
    "hyperresearch-16-readability-audit": "16/16 Readability audit",
  };

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "load_skill") return;
    const skillName = (event.input as { name?: string })?.name ?? "";
    const label = STEP_NAMES[skillName];
    if (label && ctx.hasUI) {
      ctx.ui.setWidget("hr-progress", [`🔬 hyperresearch pipeline — Step ${label}`]);
    }
  });

  // Clear progress widget when the agent settles
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setWidget("hr-progress", undefined);
    }
  });
}
