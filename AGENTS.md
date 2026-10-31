# AGENTS.md

给维护这个插件的人（或 agent）看的技术笔记。DSH 相关结论基于 `@deepseek-ai/dsh-desktop 0.2.1-rc.5`，内部 API 会变。

## 插件由什么组成

一个 DSH 插件是 npm 包 + 一份 cordis patch：

```
package.json        # dsh.bundle.patch 指向 patch；dsh.client 声明客户端入口
cordis.patch.yml    # - insert: [{ id, name, config }]
lib/index.js        # 服务端：export name / inject / Config / apply(ctx, config)
lib/client.js       # 客户端：window.__ModuleLoader__.load({ id, factory })
```

装在 `~/.dsh/profiles/desktop/node_modules/<pkg>/`，并在 profile 的 `package.json` 里登记两处：`dependencies` 和 `dsh.profile.bundles`。

源码打包在 `app.asar`（不是目录）。解析方式：`uint32(4) | uint32(pickle) | uint32(jsonSize) | json`，文件数据从 `16 + jsonSize` 起，按每个 entry 的 `offset/size` 取。

## 服务端：provider 契约

```js
ctx.subagents.registerProvider(provider)
```

provider 需要 `name`，以及 `start` 或 `prepareContinuable` 之一。

```js
provider.start(request) → Promise<{
  id: string,
  result: Promise<SubagentResult>,
  dispose(): Promise<void>
}>
```

**`SubagentResult` 的形状是硬约束**：

```js
{
  output: [{ type: 'text', text: '...' }],   // 内容块数组，不是字符串
  diagnostic?: string,
  stopReason?: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
}
```

`output` 返回裸字符串会让 `createSettlementMessage` 里的 `output.flatMap(...)` 抛 TypeError，而这个异常被 `notifySettlement` 的 catch 吞掉——表现是「agy 干完了活，但父代理收不到完成通知」，没有任何报错。

`request` 的实际结构（来自 `dsh-tool-subagent` 的 execute）：

```js
{
  cwd?, 
  prompt: [{ type: 'text', text }],   // 数组
  parent,                              // cordis 代理对象
  label, signal, agentPreset?, agentOptions?, maxDepth?
}
```

两个坑：

- `prompt` 是**数组**，不是字符串。早期按 `typeof === 'string'` 判断，永远提取不到。
- `parent` 是代理对象，**不能 `JSON.stringify(request)`**。会触发 `cannot get property "toJSON" without inject`。

本插件用 `pickPrompt()` 逐字段尝试 + 单字段 try/catch；失败时把 `requestKeys()` 塞进 diagnostic 回传，而不是猜。

### 进程外后端的额外要求

工具行必须写 `maxDepth: provider-managed`：

```yaml
- insert:
    - id: subagent-agy
      name: "@deepseek-ai/dsh-tool-subagent"
      config:
        provider: agy
        toolName: agy_worker
        maxDepth: provider-managed
```

因为 `assertSubagentProviderConfiguration` 会检查：如果 `resolveMaxDepth()` 有值而 provider 没有 `depthLimit` 能力，直接抛 `cannot enforce maxDepth`。这条错误发生在装配阶段，会拦下整个启动。

工具的 `execute` 也印证了请求格式：

```js
const request = {
  ...args.cwd === void 0 ? {} : { cwd: args.cwd },
  prompt: [{ type: 'text', text: args.prompt }],
  parent,
  ...
}
```

## 服务端：其余部分

| 组件 | 职责 |
|---|---|
| `TaskRegistry` | 运行中的任务，`provider.start` 登记、result settle 注销、`dispose` 也注销 |
| `HistoryStore` | 完成的任务，落盘 `~/.dsh/enslave-agy-history.json`，上限 200 |
| `modelState` | 当前模型，落盘 `~/.dsh/enslave-agy-model.json` |
| `AgySession` | 长驻会话（`--input-format stream-json`），面板的「派活」走这条 |
| `runAgyOnce` | 一次性执行，HTTP 路由内部用 |

取消为什么得自己做：DSH 自带的 `list_agents` / `interrupt_agent` 只覆盖**可续子代理**（continuable children），one-shot 的外部子代理不在它们的视野里。实测 `list_agents(children)` 返回 `(no subagents)`。

取消语义：被 kill 时 `stopReason` 必须是 `'aborted'` 而不是 `'error'`，否则父代理会把「用户主动停了」误读成「任务失败」。实现上用一个 `cancelled` 标志在 close 事件里优先判断。

另外取消时进程只留半截 stdout（通常是 `{status:ERROR,error:interrupted}` 这类原始 JSON），直接当 closing message 显示很脏。处理方式是先试着解析出部分回复，没有就给一句人话。

## HTTP 桥

客户端拿不到服务端状态，走宿主 web server 的同源路由：

```js
ctx.inject(['webServer'], (host) => {
  host.webServer.register({ kind: 'exact', path: '/__x/y', handler: (req, res) => {...} })
})
```

`handler` 是标准 Node `(req, res)`，自己写响应。用 `ctx.inject` 而非 `export const inject = ['webServer']`——后者在服务名不对时会让整个 `apply` 不执行，provider 也跟着没了。

路由清单：

```
/status   /run    /state   /reset
/tasks    /cancel /models  /model   /history
```

每个 handler 开头做 `isSameOrigin(req)` 校验（比对 `Origin` 的 host 与 `req.headers.Host`），防 CSRF。

## 客户端

```js
;(() => {
  function makeFactory() {
    return (require) => {
      const module = { exports: {} }
      const React = require('react')
      const h = React.createElement      // 见下方坑
      function apply(ctx) { ... }
      module.exports = { apply, inject: ['slots'], name: 'x' }
      return module.exports
    }
  }
  window.__ModuleLoader__.load({ id: 'pkg-id', factory: makeFactory() })
})()
```

客户端三个必踩的点：

**一、`h` 必须是 `React.createElement`。**
`const { jsx: h } = require('react/jsx-runtime')` 看起来能跑，但 `jsx(type, props, key)` 只有三个参数——多传的子元素会被**静默丢弃**。症状是图标渲染成空 SVG、面板渲染成一堆空 div，没有任何报错。

**二、所有 `slots.register` 都要用 `slots.inject(name, install)` 包裹。**
直接 `register` 在 slot 未就绪时抛错，插件激活失败会拦下 web boot，DSH 直接打不开。

```js
function install(ctx, key, options, component) {
  const register = () => {
    try { ctx.slots.register(options, component) }
    catch (error) { console.warn(error) }      // 异常绝不能冒泡
  }
  try {
    if (typeof ctx.slots.inject === 'function') ctx.slots.inject(key, register)
    else register()
  } catch { try { register() } catch {} }
}
```

**三、`main` 的描述符只写 `{ name, key }`。**
塞 `inject: () => ({ workbench: true })` 会让面板挂不上（那是别的插件的私有约定）。

侧栏图标组件返回 SVG 元素，接 `{ size, active }`；`label` 是渲染文字的，emoji 在这里出不来。

`package.json` 的 `dsh.client` 要 `{ "platform": "web", "immediately": true, "inject": [] }`。`immediately` 影响加载时机。

## 不采用的方案

**预热进程池**（实现过，删了）。

想法是预先起几个长驻 agy 进程，派活时直接取，省掉冷启动。

实测数据否掉了它：同一进程连续 4 个 turn，agent 耗时分别是 5.84 / 11.65 / 4.68 / 4.56 秒，稳定态 4.5–5 秒，且全程没有 `loadCodeAssist` / quota 预检（只有 `streamGenerateContent`）。也就是说 agy 每次 turn 的成本主要是模型推理本身，冷启动占比没有想象中高。

而池的实现在调试里暴露了两个硬伤：warmup turn 3 毫秒就返回（根本没跑）、空闲 25 秒后 session 变成 `child=null` 而 `status=idle` 的空壳（只可能来自 `reset()` 被调用过）。两者叠加导致「命中池」拿到的是没有进程的会话，`send` 里又 `ensureStarted` 一次，每次仍是 12–14 秒。

收益上限是「12 秒 → 5 秒」，修它要重构 turn 级关联和状态机，不值。删了。

## 调试

`debugLog()` 往 `/tmp/enslave-agy-debug.log` 追加行，绕过可能不可用的 `ctx.logger`（它也可能是 cordis 代理，访问属性就会抛）。关键路径都有埋点：

```
start id=... keys=[...]          # 收到什么形状的请求
promptLen=... cwd=...            # 提取结果
agyEnv HTTPS_PROXY=...           # 代理有没有拿到
spawning ... argv=...            # 实际命令行（验证 --model）
spawned pid=...
close code=... stdoutLen=...     # 退出状态
task registered / unregistered    # 注册表计数
```

`task registered ... running=N` 是判断有没有泄漏的最好指标。

启动时如果命令挂死、零输出，先看 `~/.gemini/antigravity-cli/cli.log`：反复出现 `play.googleapis.com` 的 IPv6 超时就是代理没注入，不是登录问题。

## 环境坑

agy 是 Go 写的，**不读 macOS 系统代理**。直连会卡在 `play.googleapis.com` 的 IPv6 超时，每 35 秒重试一次、永不返回。插件从 `scutil --proxy` 读系统代理注入 `HTTP(S)_PROXY`。

`~/.local/bin` 不在 DSH shell 的 PATH 里，启动 agy 时要显式拼 env。
