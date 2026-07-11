# hyperresearch-pi

> Deep research harness for pi — 16-step adversarial pipeline with persistent searchable vault.

Ports [hyperresearch](https://github.com/jordan-gibbs/hyperresearch) to a native pi extension.

## Install

### Prerequisite

The 16-step pipeline hard-depends on the `subagent` tool (13 of 17 steps spawn subagents). pi-subagents is a separate npm package, not built into pi — install it first:

```bash
pi install npm:pi-subagents
```

### Install

```bash
pi install npm:hyperresearch-pi
```

The extension auto-installs the `hyperresearch` Python CLI on first launch (requires Python 3.11–3.13). If auto-install fails, run `pip install hyperresearch` manually, or set `HYPERRESEARCH_BIN` to the executable path.

Verify: run `/hr` — it shows vault status when ready.

## Uninstall

```
/hr-uninstall                          # clean up deployed agent files in the project
pi remove hyperresearch-pi             # unregister the package
```

Vault data (`research/`, `.hyperresearch/`) and model config are **not** deleted — remove manually if desired.

## Commands

| Command | Description |
|---|---|
| `/hyperresearch <question>` | Run the 16-step research pipeline |
| `/hr` | Show vault status |
| `/hr-search <query>` | Quick vault search |
| `/hr-uninstall` | Remove deployed agent files (run before `pi remove`) |

## Usage

```
/hyperresearch your research question
```

The pipeline auto-classifies into a tier: `light` (~30 min) or `full` (~1.5–2.5 hours), decided by step 1.

## Model configuration

### Config file

`~/.pi/agent/hyperresearch-models.json` (auto-created from a template on first run; `/reload` picks up edits):

```json
{
  "tiers": {
    "opus": {
      "model": "opus",
      "fallbackModels": ["sonnet"]
    },
    "sonnet": {
      "model": "sonnet",
      "fallbackModels": []
    }
  },
  "agents": {
    "hyperresearch-fetcher": {
      "_note": "fetcher runs in high parallelism, use a cheap model",
      "model": "sonnet",
      "fallbackModels": []
    }
  }
}
```

The `model` values in the template are placeholders (`opus`/`sonnet`). Replace them with real IDs from `pi --list-models` (format `provider/model-id`) before actual use.

### Model ID format

`provider/model-id` — i.e. the first/second column of `pi --list-models`. Example: `zai-glm/glm-5.2`, not `glm-5.2`.

### Priority

High → low: `subagent` tool's `model` param (per-spawn, temporary) > `agents.<name>` (persistent, per-agent override) > `tiers.<tier>` (persistent, tier default)

### Fallback

When the primary model fails on a retryable error (no API key, rate limit, 502/503, timeout), pi-subagents auto-tries each `fallbackModels` entry in order. If the whole chain is unavailable, the spawn hard-fails — pass a `model` param at spawn time to use a different model.

### Note

`.pi/agents/hyperresearch/*.md` are auto-generated deploy artifacts — don't hand-edit them, `/reload` overwrites. To force regeneration, delete that directory and `/reload`.

## License

MIT
