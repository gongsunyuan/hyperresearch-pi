# hyperresearch-pi

> Deep research harness for pi — 16-step adversarial pipeline with persistent searchable vault.

Ports [hyperresearch](https://github.com/jordan-gibbs/hyperresearch) to a native pi extension.

## 安装

### 前置依赖

hyperresearch 的 16 步流水线强依赖 `subagent` 工具（13/17 步 spawn 子代理）。pi-subagents 是独立 npm 包，非 pi 内置，需先装：

```bash
pi install npm:pi-subagents
```

### 安装

```bash
pi install npm:hyperresearch-pi
```

扩展首次启动时自动安装 `hyperresearch` Python CLI（需 Python 3.11–3.13）。若自动安装失败，手动 `pip install hyperresearch` 或设置 `HYPERRESEARCH_BIN` 指向可执行文件路径。

验证：`/hr` 显示 vault 状态即就绪。

## 卸载

```
/hr-uninstall                          # 清理项目内部署的 agent 文件
pi remove /path/to/hyperresearch-pi    # 移除包
```

vault 数据（`research/`、`.hyperresearch/`）和模型配置不删除，按需手动清理。

## 命令

| 命令 | 说明 |
|---|---|
| `/hyperresearch <问题>` | 启动 16 步研究流水线 |
| `/hr` | 查看 vault 状态 |
| `/hr-search <关键词>` | 快速检索 vault |
| `/hr-uninstall` | 清理部署的 agent 文件（卸载前运行） |

## 使用

```
/hyperresearch 你的研究问题
```

流水线自动分级：`light`（~30 分钟）或 `full`（~1.5–2.5 小时），由第 1 步分类决定。

## 模型配置

### 配置文件

`~/.pi/agent/hyperresearch-models.json`（首次运行自动从模板创建，`/reload` 生效）：

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

模板里 `model` 值是占位符（`opus`/`sonnet`），需替换成 `pi --list-models` 里的真实 ID（格式 `provider/model-id`）才能实际调用。

### 模型 ID 格式

`provider/model-id`，即 `pi --list-models` 第一列/第二列。例：`zai-glm/glm-5.2`，不是 `glm-5.2`。

### 优先级

高 → 低：`subagent` 的 `model` 参数（单次）> `agents.<name>`（持久覆盖）> `tiers.<tier>`（持久默认）

### 回退

主模型因无 key / 限流 / 502 等可重试错误失败时，自动依次尝试 `fallbackModels`。全链失败则硬报错，此时 spawn 时传 `model` 参数指定可用模型。

### 注意

`.pi/agents/hyperresearch/*.md` 是自动生成的部署产物，别手改——`/reload` 会覆盖。要强制重新生成，删掉该目录后 `/reload`。

## License

MIT
