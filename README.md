# dsh-enslave-agy / 哈基米go work！

把 [Antigravity CLI](https://antigravity.google)（`agy`）接进 DeepSeek Harness，作为可并行的子代理干活。

DSH 的 subagent 工具原本只跑进程内的子代理。这个插件注册一个 `agy` provider，让任务改由独立的 agy 进程执行——能同时跑多个、能中途掐断、能用 agy 那边的 Claude / Gemini 模型。

## 前提

- 已安装 Antigravity CLI（`~/.local/bin/agy`，或自己配路径）
- 已用桌面版 Antigravity 登录过一次（CLI 复用它的 keychain 凭据）
- 系统代理已开（agy 是 Go 写的，不读 macOS 系统代理，插件会替你注入 `HTTP(S)_PROXY`）

## 安装

```bash
# 1. 放插件
mkdir -p ~/.dsh/profiles/desktop/node_modules/dsh-enslave-agy
cp -R lib package.json cordis.patch.yml ~/.dsh/profiles/desktop/node_modules/dsh-enslave-agy/

# 2. 登记到 profile
#    ~/.dsh/profiles/desktop/package.json 里两处：
#      dependencies  加 "dsh-enslave-agy": "0.1.0"
#      dsh.profile.bundles  数组加 "dsh-enslave-agy"
```

然后重启 DSH。

## 开始奴役哈基米 (Gemini)

左侧栏出现「哈基米go work！」，点开：

| 区域 | 作用 |
|---|---|
| 模型下拉 | 选 agy 用的模型，即时生效并记住 |
| 输入框 + 派活给 agy | 走长驻会话，适合调试和一次性问答 |
| 运行中 | 正在跑的 agy 任务，带实时计时和「停止」 |
| 历史 | 已完成的任务，点一行展开 cwd / 模型 / 输出 / 诊断 |

真正干活的是 `agy_worker` 工具（由 `dsh-tool-subagent` 生成）。在会话里说「用 agy 跑这个任务」，模型就会调它。它和面板里的长驻会话是两条独立通道：`agy_worker` 每次起独立进程，上下文干净。

## 配置

`cordis.patch.yml` 里可调：

```yaml
- insert:
    - id: dsh-enslave-agy
      name: dsh-enslave-agy
      config:
        providerName: agy               # 注册用的 provider 名
        agyPath: /custom/path/to/agy    # 默认 ~/.local/bin/agy
        timeoutMs: 600000               # 单任务超时，默认 10 分钟
        model: claude-sonnet-5-5-medium # 初始模型，留空用 agy 默认
```

`agy_worker` 工具那一行必须带 `maxDepth: provider-managed`，见 [AGENTS.md](AGENTS.md)。

## 已知限制

- **模型是全局的**，不能按任务指定。`agy_worker` 的参数由 DSH 生成，插件加不了字段。
- **一次性**：派出去的活没有多轮追问，得一次说清。
- **`--dangerously-skip-permissions` 全放行**：agy 会直接执行命令、改文件，只在可信目录里用。
- 每次派活有约 10 秒冷启动（agy 进程初始化），这是 agy 自身的开销。

## License

如果你觉得这项目有点用的话可以请我喝啤酒 [LICENSE](LICENSE)。
