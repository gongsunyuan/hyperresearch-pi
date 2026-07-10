/**
 * hyperresearch-pi — main extension entry point.
 *
 * Wraps the hyperresearch Python CLI as a pi extension:
 *  - 18 custom tools (hr_search, hr_fetch, hr_note_*, load_skill, ...)
 *  - /hyperresearch command (kick off the 16-step research pipeline)
 *  - /hr command (shortcut to vault status)
 *  - /hr-search command (quick inline vault search)
 *  - tool_call hook (vault-first reminder before web searches)
 *  - before_agent_start hook (inject vault guidelines into system prompt)
 *  - progress widget (16-step pipeline tracker)
 *
 * The factory is ASYNC so pi awaits it before startup. We use this to
 * auto-install the hyperresearch Python CLI when missing — making
 * `pi install hyperresearch-pi` a truly one-step setup.
 *
 * The 18 research-pipeline skills live in ../skills/ (auto-discovered by
 * pi's package loader). The 14 subagent definitions live in ../agents/
 * and are deployed to .pi/agents/hyperresearch/ on session_start so
 * pi-subagents discovers them.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.js";
import { registerHooks } from "./hooks.js";
import { checkHpr, ensureHpr, runHpr, runHprRaw } from "./hpr.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Bootstrap result from the async factory (auto-install attempt). */
export interface HprBootstrap {
  available: boolean;
  version?: string;
  justInstalled: boolean;
  error?: string;
}

export default async function (pi: ExtensionAPI) {
  // Register tools + hooks first (cheap, synchronous). Pass a getter so
  // the session_start hook can read the bootstrap result once the factory
  // finishes the auto-install.
  let bootstrap: HprBootstrap | undefined;
  registerTools(pi);
  registerHooks(pi, () => bootstrap);

  // Auto-install the hyperresearch Python CLI if missing. This runs during
  // the async factory, so pi waits for it before session_start fires.
  try {
    bootstrap = await ensureHpr();
  } catch {
    bootstrap = { available: false, justInstalled: false };
  }

  // ── /hr-uninstall ───────────────────────────────────────────────────
  // Remove deployed agent files from .pi/agents/hyperresearch/ so the
  // project is clean after `pi remove`. Run this before `pi remove` in
  // each project that used hyperresearch-pi.
  pi.registerCommand("hr-uninstall", {
    description: "Remove hyperresearch agent files from .pi/agents/hyperresearch/ (run before `pi remove` to clean up)",
    handler: async (_args, ctx) => {
      const agentsDst = join(ctx.cwd, ".pi", "agents", "hyperresearch");
      if (existsSync(agentsDst)) {
        rmSync(agentsDst, { recursive: true, force: true });
        ctx.ui.notify(`Removed ${agentsDst}`, "info");
      } else {
        ctx.ui.notify("No hyperresearch agent files found in this project.", "info");
      }
      ctx.ui.notify(
        "Now run: pi remove <hyperresearch-pi-source> to unregister the package.",
        "info",
      );
    },
  });

  // ── /hyperresearch <query> ───────────────────────────────────────────
  pi.registerCommand("hyperresearch", {
    description:
      "Run the hyperresearch deep-research pipeline (16-step, tier-adaptive). Usage: /hyperresearch <your research question>",
    handler: async (args, ctx) => {
      const query = (args ?? "").trim();
      if (!query) {
        ctx.ui.notify("Usage: /hyperresearch <your research question>", "warning");
        return;
      }

      // Verify CLI (re-check in case auto-install happened)
      const check = await checkHpr();
      if (!check.available) {
        ctx.ui.notify(
          "hyperresearch CLI not available. Run: pip install hyperresearch",
          "error",
        );
        return;
      }

      // Ensure vault exists
      const statusRes = await runHpr(["status"], { cwd: ctx.cwd });
      if (!statusRes.ok) {
        ctx.ui.notify("Initializing research vault...", "info");
        await runHprRaw(["init", "."], { cwd: ctx.cwd });
      }

      // Archive any prior run artifacts
      await runHpr(["archive-run"], { cwd: ctx.cwd });

      ctx.ui.notify("Starting hyperresearch pipeline.", "info");

      // Inject the research query + skill-load directive as a user message.
      pi.sendUserMessage(
        `Run the hyperresearch deep-research pipeline for this query:\n\n---\n${query}\n---\n\n` +
          `Load the entry skill by running: /skill:hyperresearch\n` +
          `Then follow the orchestrator instructions in that skill to execute the 16-step pipeline.`,
      );
    },
  });

  // ── /hr ──────────────────────────────────────────────────────────────
  pi.registerCommand("hr", {
    description: "Show hyperresearch vault status (notes, tags, graph metrics)",
    handler: async (_args, ctx) => {
      const check = await checkHpr();
      if (!check.available) {
        ctx.ui.notify("hyperresearch CLI not available. Run: pip install hyperresearch", "error");
        return;
      }
      const res = await runHpr(["status"], { cwd: ctx.cwd });
      if (!res.ok) {
        ctx.ui.notify(`No vault in ${ctx.cwd}. Run /hyperresearch to initialize.`, "warning");
        return;
      }
      const data = res.data as {
        vault_name?: string;
        notes?: { total?: number };
        tags?: { total_unique?: number };
        graph?: { total_links?: number; broken_links?: number };
        total_words?: number;
      } | string;

      if (typeof data === "string") {
        ctx.ui.notify(data.slice(0, 200), "info");
        return;
      }
      ctx.ui.notify(
        `Vault: ${data?.vault_name ?? "?"} | ` +
          `${data?.notes?.total ?? 0} notes | ` +
          `${data?.tags?.total_unique ?? 0} tags | ` +
          `${data?.graph?.total_links ?? 0} links | ` +
          `${data?.total_words ?? 0} words`,
        "info",
      );
    },
  });

  // ── /hr-search <query> ───────────────────────────────────────────────
  pi.registerCommand("hr-search", {
    description: "Quick vault search. Usage: /hr-search <query>",
    handler: async (args, ctx) => {
      const query = (args ?? "").trim();
      if (!query) {
        ctx.ui.notify("Usage: /hr-search <query>", "warning");
        return;
      }
      const check = await checkHpr();
      if (!check.available) {
        ctx.ui.notify("hyperresearch CLI not available.", "error");
        return;
      }
      const res = await runHpr(["search", query, "--limit", "10"], { cwd: ctx.cwd });
      if (!res.ok) {
        ctx.ui.notify("No vault found. Run /hyperresearch to initialize.", "warning");
        return;
      }
      const data = res.data as Array<{ id?: string; title?: string; summary?: string }> | string;
      if (typeof data === "string") {
        ctx.ui.notify(data.slice(0, 300), "info");
        return;
      }
      if (!Array.isArray(data) || data.length === 0) {
        ctx.ui.notify("No matching notes found.", "info");
        return;
      }
      const lines = data.map(
        (n) => `${n.id ?? "?"}: ${n.title ?? "(untitled)"} — ${n.summary ?? ""}`.slice(0, 120),
      );
      ctx.ui.setWidget("hr-search-results", lines.slice(0, 10));
    },
  });
}
