# 贡献指南

hyperresearch-pi 是 hyperresearch（Claude Code 版）的 pi 移植。开发相关说明在此。

## 架构

```
Pi 扩展层 (TypeScript)
  ├─ 18 个 hr_* 工具 + load_skill + 命令
  ├─ tool_call hook (web 搜索前提醒查 vault)
  ├─ before_agent_start hook (注入 vault 规约)
  ├─ session_start hook (部署 agent + 自动安装 CLI + 进度 widget)
  └─ 模型注入 (读 JSON 配置 → 注入 agent frontmatter)
      │
桥接层 (pi.exec → hyperresearch Python CLI --json)
      │
Python 核心层 (hyperresearch CLI, 原样保留)
  vault / SQLite / FTS5 / crawl4ai / pymupdf
```

保留 hyperresearch 核心原则：patch never regenerate（patcher/polish 工具锁 Read+Edit）、canonical query is gospel、markdown is truth SQLite is cache、progressive disclosure（load_skill 按需加载步骤防 context-rot）。

## 目录结构

```
hyperresearch-pi/
├── package.json              # pi 包清单 (extensions + skills)
├── config/
│   └── models.json           # 模型配置模板 (首次复制到 ~/.pi/agent/)
├── extensions/
│   ├── index.ts              # 入口: async factory, 命令 (/hyperresearch, /hr, /hr-uninstall)
│   ├── hpr.ts                # CLI 桥接: 路径解析 + execFile + 自动安装 (ensureHpr)
│   ├── tools.ts              # 18 个工具 (hr_* + load_skill), StringEnum 枚举校验
│   ├── hooks.ts              # session_start (部署 agent) + tool_call + before_agent_start + widget
│   └── models.ts             # 读 JSON 配置 + 注入 model/fallbackModels 到 agent frontmatter
├── skills/                   # 17 个 pi skill (16 步流水线 + 入口路由)
│   ├── hyperresearch.md      # 入口路由 (含 pi 适配说明 + 工具映射表)
│   └── hyperresearch-{1..16}-*.md
└── agents/                   # 14 个 subagent 定义 (仅 tier: opus|sonnet, 无供应商)
```

## 模型注入机制

agent 源文件只标 `tier: opus|sonnet`，不含供应商信息。`session_start` 时：

1. `ensureConfig()` — 配置文件不存在则从 `config/models.json` 复制到 `~/.pi/agent/`
2. `readConfig()` — `JSON.parse` 解析（node 原生，无 YAML 依赖）
3. `deployAgentWithModels(src, dst, cfg)` — 遍历 14 个 agent，按 `agents.<name>` > `tiers.<tier>` 解析，注入 frontmatter

**关键**：pi-subagents 的 frontmatter 解析器把 `fallbackModels` 当逗号分隔字符串处理（`.split(",")`），所以部署文件必须是 `fallbackModels: a, b` 单行逗号格式，不能是 YAML 块列表。扩展负责这个转换——你的 JSON 配置用数组，部署时转逗号字符串。

## 关键设计决策

- **Python CLI 保留而非重写**：vault/SQLite/FTS5/crawl4ai/pymupdf 是测试过的成熟逻辑，TS 包装层通过 `pi.exec` 调用 `--json` 接口
- **模型配置用 JSON 而非 YAML**：node 原生 `JSON.parse`，零依赖，无手写解析器 bug。pi 模块树虽有 `yaml` 传递依赖但未在 peerDependencies 声明，不可靠
- **agent 源文件无供应商信息**：只标 tier，换 provider 改一个 JSON 文件即可，不用动 14 个 .md
- **StringEnum 校验**：`note_type`/`tier`/`content_type`/`status` 用 `StringEnum` 在 JSON Schema 层拦截非法值（如错误的 `"source"`），避免 Pydantic ValidationError 泄露本地路径
- **`hr_note_update` 字段映射**：CLI `note update` 用 `--add-tag`/`--remove-tag`（非 `--tag`），且无 `--title`/`--body-file`（只改 frontmatter），工具层须一一对应

## 从 hyperresearch 源码更新

当上游 hyperresearch 更新 skill/agent 定义时：

```bash
# skill 文件: 从 src/hyperresearch/skills/ 复制到 skills/
#   替换 Skill(skill: "X") → load_skill(name: "X")
#   替换 {hpr_path} → hyperresearch
#   frontmatter 须在文件顶部 (pi 要求)

# agent 定义: 从 src/hyperresearch/core/hooks.py 的 XXX_AGENT 常量提取
#   保留 model: sonnet/opus → 转为 tier: sonnet/opus
#   工具映射: Bash→bash, Read→read, Write→write, Edit→edit, Task→subagent, WebSearch→web_search
#   {hpr_path} → hyperresearch
```

## 开发验证

```bash
# TS 语法检查
node --experimental-strip-types --check extensions/*.ts

# CLI 冒烟测试
hyperresearch init . --json
hyperresearch status --json
hyperresearch note new "test" --type note --body-file body.md --json
hyperresearch note update <id> --add-tag x --json

# 模型 ID 校验
pi --list-models   # 确认配置文件里的 ID 都在列表中
```

## License

MIT
