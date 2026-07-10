/**
 * models.ts — read machine-level model config and inject into agent frontmatter.
 *
 * Config file: ~/.pi/agent/hyperresearch-models.json
 * Template:    <package>/config/models.json (copied on first run)
 *
 * The agent source .md files carry only a `tier: opus|sonnet` marker (no
 * provider-specific model). At deploy time the extension reads this JSON
 * config, resolves the model + fallbackModels for each agent's tier, and
 * injects them into the frontmatter of the copied file in
 * .pi/agents/hyperresearch/.
 *
 * Uses native JSON.parse — no YAML dependency, no hand-rolled parser.
 *
 * This lets users swap providers by editing one JSON file instead of 14.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface ModelConfig {
  model: string;
  fallbackModels: string[];
}

interface RawConfigFile {
  tiers?: Record<string, ModelConfig>;
  agents?: Record<string, ModelConfig>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "hyperresearch-models.json");
const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "models.json");

/** Ensure the config file exists, copying the template on first run. */
export function ensureConfig(): string {
  if (!existsSync(CONFIG_PATH)) {
    try {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      copyFileSync(TEMPLATE_PATH, CONFIG_PATH);
    } catch {
      return TEMPLATE_PATH;
    }
  }
  return CONFIG_PATH;
}

/** Read + parse the JSON config (cached after first read). */
let _cached: { tiers: Record<string, ModelConfig>; agents: Record<string, ModelConfig> } | undefined;

export function readConfig(force = false): { tiers: Record<string, ModelConfig>; agents: Record<string, ModelConfig> } {
  if (_cached && !force) return _cached;
  const path = ensureConfig();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RawConfigFile;
    _cached = {
      tiers: raw.tiers ?? {},
      agents: raw.agents ?? {},
    };
  } catch {
    _cached = { tiers: {}, agents: {} };
  }
  return _cached!;
}

/** Resolve the ModelConfig for a given agent by tier, with per-agent override. */
export function resolveAgentModel(
  agentName: string,
  tier: string,
  config?: { tiers: Record<string, ModelConfig>; agents: Record<string, ModelConfig> },
): ModelConfig | undefined {
  const cfg = config ?? readConfig();
  // per-agent override wins
  if (cfg.agents[agentName]) return cfg.agents[agentName];
  return cfg.tiers[tier];
}

/**
 * Inject model + fallbackModels into an agent file's frontmatter.
 *
 * Reads `tier:` from the source frontmatter, resolves the config, and writes
 * the resolved model fields into the destination frontmatter.
 *
 * NOTE: pi-subagents parses `fallbackModels` as a comma-separated STRING
 * (agents.ts: frontmatter.fallbackModels?.split(",")), not a YAML block list
 * or JSON array. So we emit inline comma format: `fallbackModels: a, b, c`.
 *
 * Returns true on success.
 */
export function deployAgentWithModels(
  srcPath: string,
  dstPath: string,
  config?: { tiers: Record<string, ModelConfig>; agents: Record<string, ModelConfig> },
): boolean {
  let content = readFileSync(srcPath, "utf8");
  const cfg = config ?? readConfig();

  // Extract frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    try { writeFileSync(dstPath, content, "utf8"); return true; } catch { return false; }
  }
  const fmText = fmMatch[1];
  const tierMatch = fmText.match(/^tier:\s*(.+)$/m);
  const nameMatch = fmText.match(/^name:\s*(.+)$/m);
  const agentName = nameMatch?.[1].trim() ?? "";
  const tier = tierMatch?.[1].trim() ?? "";

  // Remove any existing model / fallbackModels lines from source frontmatter
  let cleanedFm = fmText
    .replace(/^model:.*\r?\n/m, "")
    .replace(/^fallbackModels:.*\r?\n/m, "");

  // Resolve config and inject
  const mc = resolveAgentModel(agentName, tier, cfg);
  if (mc && mc.model) {
    if (!cleanedFm.endsWith("\n")) cleanedFm += "\n";
    cleanedFm += `model: ${mc.model}\n`;
    if (mc.fallbackModels.length > 0) {
      // pi-subagents splits fallbackModels on "," — must be inline comma format
      cleanedFm += `fallbackModels: ${mc.fallbackModels.join(", ")}\n`;
    }
  }

  content = `---\n${cleanedFm}---` + content.slice(fmMatch[0].length);
  try {
    writeFileSync(dstPath, content, "utf8");
    return true;
  } catch {
    return false;
  }
}
