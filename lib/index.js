/**
 * dsh-enslave-agy —— 服务端（host half）
 *
 * 把 Antigravity CLI (agy) 注册成 DSH 的 subagent provider。
 * 注册后 `dsh-tool-subagent` 只要把 provider 指向 `agy`，
 * 每次委派就会 spawn 一个独立 agy 进程干活，拿回结果。
 *
 * 关键点：
 *   - agy 是 Go 写的，不读 macOS 系统代理 → 必须注入 HTTP(S)_PROXY，
 *     否则会卡在 play.googleapis.com 的 IPv6 超时（无限重试、零输出）。
 *   - agy 在 ~/.local/bin，不在 host 进程的 PATH 里。
 */
import { spawn, execFile } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

const execFileAsync = promisify(execFile)
const DEFAULT_AGY = join(homedir(), '.local/bin/agy')

export const name = 'dsh-enslave-agy'
export const inject = ['subagents']

export const Config = z.object({
  providerName: z.string().default('agy'),
  agyPath: z.string().default(DEFAULT_AGY),
  timeoutMs: z.number().default(600_000),
  // 默认模型 id（agy models 里的 id）；留空用 agy 自己的默认
  model: z.string().default(''),
})

/**
 * 进程外后端的能力广告：全部 false。
 * 子代理在另一个进程里，父进程强制的 agentOptions/agentPreset/
 * outputSchema/depthLimit 都无法生效，所以必须如实声明不支持。
 */
const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

// 系统代理探测结果缓存（一次会话只探一次）
let proxyCache

/** 调试日志：写到固定文件，绕过可能不可用的 logger。验证完可删。 */
function debugLog(message) {
  try {
    appendFileSync('/tmp/enslave-agy-debug.log', `${new Date().toISOString()} ${message}\n`)
  } catch { /* 忽略 */ }
}

async function systemProxy() {
  if (proxyCache !== undefined) {
    debugLog(`systemProxy cached=${proxyCache}`)
    return proxyCache
  }
  try {
    const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 3000 })
    const host = /HTTPProxy\s*:\s*(\S+)/.exec(stdout)?.[1]
    const port = /HTTPPort\s*:\s*(\d+)/.exec(stdout)?.[1]
    proxyCache = host && port ? `http://${host}:${port}` : null
    debugLog(`scutil OK proxy=${proxyCache}`)
  } catch (error) {
    proxyCache = null
    debugLog(`scutil FAILED: ${error?.message ?? error}`)
  }
  return proxyCache
}

/** agy 需要的进程环境：PATH + 代理。 */
async function agyEnv() {
  const env = { ...process.env }
  const binDir = join(homedir(), '.local/bin')
  env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir
  if (!env.HTTPS_PROXY && !env.https_proxy) {
    const proxy = await systemProxy()
    if (proxy) {
      env.HTTP_PROXY = proxy
      env.HTTPS_PROXY = proxy
      env.http_proxy = proxy
      env.https_proxy = proxy
    }
  }
  debugLog(`agyEnv HTTPS_PROXY=${env.HTTPS_PROXY ?? '(none)'}`)
  return env
}

/**
 * 从委派请求里取 prompt。
 *
 * dsh-tool-subagent 的真实格式是**数组**（源码 lib/index.js 里）：
 *   request.prompt = [{ type: 'text', text: args.prompt }]
 * 不是字符串。早期版本只判 typeof === 'string'，所以永远提取不到。
 *
 * 另外 request 里还带着 `parent`（cordis 代理对象），
 * 绝不能 JSON.stringify 整个 request —— 会触发
 * "cannot get property toJSON without inject"。
 */
function pickPrompt(request) {
  const r = request ?? {}

  /** 字符串或 [{type:'text', text}] 文本块数组都能取。 */
  const asText = (value) => {
    if (typeof value === 'string') return value.trim() ? value : null
    if (Array.isArray(value)) {
      const text = value
        .map(block => {
          if (typeof block === 'string') return block
          if (block && block.type === 'text' && typeof block.text === 'string') return block.text
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return text.trim() ? text : null
    }
    if (value && typeof value === 'object' && typeof value.text === 'string' && value.text.trim()) {
      return value.text
    }
    return null
  }

  // 按优先级尝试；每个都单独 try，属性可能是代理。
  for (const key of ['prompt', 'content', 'task', 'message', 'instruction', 'input', 'text']) {
    try {
      const text = asText(r[key])
      if (text) return text
    } catch { /* 这一项读不了就跳过 */ }
  }

  return ''
}

/** 安全列出 request 的键，给诊断用。 */
function requestKeys(request) {
  try {
    return Object.keys(request ?? {}).join(',')
  } catch {
    return '?'
  }
}

/** 安全日志：ctx.logger 可能是 cordis 代理，访问属性本身就可能抛错。 */
function safeLog(logger, level, message) {
  try {
    logger?.[level]?.(message)
  } catch { /* 日志失败一律吞掉 */ }
}

/**
 * 历史任务记录：持久化到 JSON，重启不丢。
 * 只保留最近 limit 条，字段都是排错需要的最小集。
 */
class HistoryStore {
  constructor(file, limit = 200) {
    this.file = file
    this.limit = limit
    this.items = []
    this.load()
  }

  load() {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.items = Array.isArray(parsed) ? parsed : []
    } catch {
      this.items = []
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.items.slice(0, this.limit)), 'utf8')
    } catch (error) {
      debugLog(`history save failed: ${error?.message ?? error}`)
    }
  }

  add(record) {
    this.items.unshift(record)
    if (this.items.length > this.limit) this.items.length = this.limit
    this.save()
  }

  list(count = 30) {
    return this.items.slice(0, count)
  }
}

/**
 * 活跃任务注册表。
 *
 * 每次 provider.start 登记的运行中 agy 进程，供面板列出和取消。
 * 注意：one-shot 的外部子代理不在 DSH 的 list_agents 视野里
 * （那个工具只管可续子代理），所以取消只能由插件自己实现。
 */
class TaskRegistry {
  constructor() {
    this.records = new Map()
  }

  add(record) {
    this.records.set(record.id, record)
  }

  remove(id) {
    this.records.delete(id)
  }

  get(id) {
    return this.records.get(id)
  }

  /** 给客户端看的快照，绝不暴露 dispose。 */
  list() {
    const now = Date.now()
    return [...this.records.values()].map(record => ({
      id: record.id,
      cwd: record.cwd,
      prompt: record.prompt,
      startedAt: record.startedAt,
      runningSeconds: Math.round((now - record.startedAt) / 100) / 10,
    }))
  }

  get size() {
    return this.records.size
  }
}

class AgyProvider {
  name
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  constructor(name, options, logger, tasks, modelState, history) {
    this.name = name
    this.options = options
    this.logger = logger
    this.tasks = tasks
    this.modelState = modelState
    this.history = history
  }

  /** 一次性执行：spawn agy → 收集 JSON → 交回 run handle。 */
  async start(request) {
    const id = randomUUID()
    debugLog(`start id=${id} keys=[${requestKeys(request)}]`)
    const prompt = pickPrompt(request)
    debugLog(`promptLen=${prompt.length} cwd=${String(request?.cwd ?? '(none)')}`)

    // 拿不到 prompt 就直接把诊断交回去，不要跑一个空任务。
    if (!prompt) {
      return {
        id,
        result: Promise.resolve({
          output: [{ type: 'text', text: `没能从委派请求里提取到 prompt。request keys = [${requestKeys(request)}]` }],
          diagnostic: `没能从委派请求里提取到 prompt。request keys = [${requestKeys(request)}]`,
          stopReason: 'error',
        }),
        dispose: async () => {},
      }
    }

    const cwd = typeof request?.cwd === 'string' ? request.cwd : process.cwd()

    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ]
    // 面板选定的全局默认模型（留空则用 agy 自己的默认）
    const model = this.modelState?.current
    if (model) args.push('--model', model)
    const env = await agyEnv()

    safeLog(this.logger, 'info', `[enslave-agy] start ${id} cwd=${cwd}`)

    debugLog(`spawning ${this.options.agyPath} cwd=${cwd} argv=${args.slice(3).join(' ')}`)
    let child
    try {
      child = spawn(this.options.agyPath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      debugLog(`spawned pid=${child.pid}`)
    } catch (error) {
      debugLog(`spawn THREW: ${error?.message ?? error}`)
      return {
        id,
        result: Promise.resolve({
          output: [{ type: 'text', text: `spawn failed: ${error?.message ?? error}` }],
          diagnostic: `spawn failed: ${error?.message ?? error}`,
          stopReason: 'error',
        }),
        dispose: async () => {},
      }
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
    }, this.options.timeoutMs)

    // 主动取消标记：区分"用户停了"和"任务失败"
    let cancelled = false

    const result = new Promise(resolve => {
      const finish = (payload) => {
        clearTimeout(timer)
        resolve(payload)
      }
      child.on('error', error => {
        debugLog(`child error: ${error?.message ?? error}`)
        finish({
          output: [{ type: 'text', text: `agy process error: ${error?.message ?? error}` }],
          stopReason: 'error',
        })
      })
      child.on('close', code => {
        if (cancelled) {
          // 被主动取消：进程只留下半截 stdout，通常是 {status:ERROR,error:interrupted}
          // 这种原始 JSON，直接当 closing message 显示很脏。
          // 有可用的部分回复就用它，否则给一句人话。
          debugLog(`close after cancel code=${code} stdoutLen=${stdout.length}`)
          const partial = parseAgyJson(stdout)
          const partialText = typeof partial?.response === 'string' ? partial.response.trim() : ''
          finish({
            output: [{ type: 'text', text: partialText || '（任务被中途停止）' }],
            stopReason: 'aborted',
          })
          return
        }
        debugLog(`close code=${code} stdoutLen=${stdout.length} stderrLen=${stderr.length}`)

        // 关键：SubagentResult.output 必须是内容块数组 [{type:'text',text}]。
        // 返回裸字符串会让 createSettlementMessage 的 output.flatMap 抛
        // TypeError，被 notifySettlement 的 catch 吞掉 —— 表现就是
        // "agy 干完了活，但父代理收不到完成通知"。
        const asBlocks = (text) => [{ type: 'text', text: String(text ?? '') }]

        const parsed = parseAgyJson(stdout)
        const text = typeof parsed?.response === 'string'
          ? parsed.response
          : (typeof parsed?.error === 'string' ? parsed.error : stdout)

        if (parsed?.status === 'SUCCESS') {
          finish({ output: asBlocks(text), stopReason: 'completed' })
          return
        }

        if (parsed) {
          finish({
            output: asBlocks(text),
            diagnostic: String(parsed?.error ?? '').slice(0, 4000) || `agy status ${parsed?.status}`,
            stopReason: 'error',
          })
          return
        }

        if (code === 0) {
          finish({ output: asBlocks(stdout), stopReason: 'completed' })
        } else {
          finish({
            output: asBlocks(stdout),
            diagnostic: (stderr || `agy exited with code ${code}`).slice(0, 4000),
            stopReason: 'error',
          })
        }
      })
    })

    // 运行期登记，供面板列出/取消
    const dispose = async () => {
      cancelled = true
      clearTimeout(timer)
      try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      this.tasks?.remove(id)
    }
    const startedAt = Date.now()
    this.tasks?.add({
      id,
      cwd,
      prompt: prompt.slice(0, 160),
      startedAt,
      dispose,
    })
    debugLog(`task registered id=${id} running=${this.tasks?.size}`)

    // 自然结束（成功/失败/取消）时注销并写入历史
    result.catch(() => {}).then(payload => {
      this.tasks?.remove(id)
      const finishedAt = Date.now()
      try {
        this.history?.add({
          id,
          cwd,
          prompt: prompt.slice(0, 300),
          model: this.modelState?.current ?? '',
          startedAt,
          finishedAt,
          durationSeconds: Math.round((finishedAt - startedAt) / 100) / 10,
          status: payload?.stopReason === 'completed'
            ? 'completed'
            : (payload?.stopReason === 'aborted' ? 'aborted' : 'failed'),
          diagnostic: typeof payload?.diagnostic === 'string' ? payload.diagnostic.slice(0, 2000) : '',
          outputPreview: String(payload?.output?.[0]?.text ?? '').slice(0, 800),
        })
      } catch (error) {
        debugLog(`history add failed: ${error?.message ?? error}`)
      }
      debugLog(`task unregistered id=${id} running=${this.tasks?.size} status=${payload?.stopReason}`)
    })

    return { id, result, dispose }
  }
}

// ---------------------------------------------------------------------------
// HTTP 桥：给客户端面板的「连通性测试」用（P1）
// ---------------------------------------------------------------------------

/** 读请求体，超过 1MB 直接拒绝。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 1_000_000) {
        req.destroy()
        reject(new Error('request body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** 写 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 同源校验：只接受来自本 host 页面的请求。
 * 浏览器跨站请求会带 Origin，直接比对 host。
 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true   // curl / 同源非跨站
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * 从 agy 的 stdout 里提取 JSON 结果。
 *
 * agy 在内部重试时会把 `API error (attempt 1): ...` 这类日志写进 stdout，
 * 直接 JSON.parse 会炸。所以先试整体，再逐行，最后按首尾大括号截取。
 */
function parseAgyJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null

  try { return JSON.parse(text) } catch {}

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      try { return JSON.parse(t) } catch {}
    }
  }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  return null
}

/** 收集 JSON 之外的噪声行（重试日志等），用于提示不误判。 */
function extractNoise(stdout, stderr) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('{') && !line.startsWith('}'))
  const extra = String(stderr ?? '').trim()
  const all = extra ? [...lines, extra] : lines
  return all.length ? all.join('\n').slice(0, 2000) : ''
}

/**
 * 长驻 agy 会话。
 *
 * 用 `--input-format stream-json --output-format stream-json` 起一个常驻进程：
 * 冷启动约 10s 只在第一次付，之后每个 turn 只付模型时间（约 5-8s）。
 * 同时 stdout 本身就是 NDJSON 事件流，可以直接拿来做实时进度。
 *
 * 注意：一个进程 = 一个 conversation，上下文会累积。需要干净上下文时
 * 调 reset()（关进程，下次 send 重新起）。
 */
class AgySession {
  constructor(options, logger) {
    this.options = options
    this.logger = logger
    this.child = null
    this.buffer = ''
    this.pending = []
    this.events = []
    this.seq = 0
    this.turns = 0
    this.status = 'idle'      // idle | starting | running | dead
    this.lastError = null
    this.startedAt = null
  }

  get label() {
    return '哈基米'
  }

  _record(event) {
    this.seq += 1
    const entry = { seq: this.seq, at: Date.now(), ...event }
    this.events.push(entry)
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400)
    return entry
  }

  /** 状态快照；sinceSeq 用于增量拉事件。 */
  getState(sinceSeq = 0) {
    return {
      status: this.status,
      turns: this.turns,
      seq: this.seq,
      lastError: this.lastError,
      startedAt: this.startedAt,
      pending: this.pending.length,
      events: this.events.filter(e => e.seq > sinceSeq),
    }
  }

  async ensureStarted() {
    if (this.child) return
    this.status = 'starting'
    this._record({ type: 'log', text: '启动 agy 长驻会话…' })

    const env = await agyEnv()
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ]

    let child
    try {
      child = spawn(this.options.agyPath, args, {
        cwd: this.options.cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.status = 'dead'
      this.lastError = `spawn 失败: ${error?.message ?? error}`
      throw error
    }

    this.child = child
    this.buffer = ''
    this.startedAt = Date.now()

    child.stdout.on('data', chunk => this._onData(chunk))
    child.stderr.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) this._record({ type: 'stderr', text: line.trim().slice(0, 400) })
      }
    })
    child.on('error', error => {
      this.lastError = `进程错误: ${error?.message ?? error}`
      this._record({ type: 'error', text: this.lastError })
    })
    child.on('exit', (code, signal) => {
      this.child = null
      this.status = 'dead'
      this.lastError = `agy 退出 code=${code} signal=${signal ?? ''}`
      this._record({ type: 'exit', code, signal })
      this._rejectAll(this.lastError)
    })

    this.status = 'idle'
  }

  _onData(chunk) {
    this.buffer += chunk.toString()
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) this._onLine(line)
    }
  }

  _onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this._record({ type: 'noise', text: line.slice(0, 400) })
      return
    }

    if (msg.event === 'init') {
      this._record({ type: 'init', text: '会话就绪', data: msg.init })
      return
    }

    if (msg.event === 'step_update') {
      const step = msg.step_update || {}
      // 只记有价值的事件：工具调用、文本增量、结束
      if (step.step_type === 'tool' && step.state === 'DONE' && step.tool_name) {
        this._record({
          type: 'tool',
          tool: step.tool_name,
          text: step.tool_info?.parameters?.CommandLine || step.tool_info?.output || '',
        })
      } else if (step.step_type === 'agent_response' && step.text_delta) {
        this._record({ type: 'delta', text: step.text_delta })
      }
      return
    }

    if (msg.event === 'result') {
      const result = msg.result || {}
      this.turns += 1
      this.status = 'idle'
      this._record({ type: 'result', status: result.status })
      const turn = this.pending.shift()
      if (turn) {
        clearTimeout(turn.timer)
        turn.resolve({
          ok: result.status === 'SUCCESS',
          output: typeof result.response === 'string' ? result.response : '',
          durationSeconds: result.duration_seconds,
          usage: result.usage,
          conversationId: result.conversation_id,
          turns: this.turns,
        })
      }
      return
    }

    this._record({ type: 'unknown', text: line.slice(0, 300) })
  }

  _rejectAll(message) {
    while (this.pending.length) {
      const turn = this.pending.shift()
      clearTimeout(turn.timer)
      turn.reject(new Error(message))
    }
  }

  /** 发一个 turn，等它的 result。串行执行。 */
  async send(prompt, timeoutMs = this.options.timeoutMs) {
    if (!this.child || this.status === 'dead') {
      this.child = null
      await this.ensureStarted()
    }

    return await new Promise((resolve, reject) => {
      const turn = { resolve, reject }
      turn.timer = setTimeout(() => {
        const index = this.pending.indexOf(turn)
        if (index >= 0) this.pending.splice(index, 1)
        reject(new Error(`turn 超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)

      this.pending.push(turn)
      this.status = 'running'
      this._record({ type: 'prompt', text: String(prompt).slice(0, 300) })

      try {
        this.child.stdin.write(JSON.stringify({
          event: 'user',
          message: { content: prompt },
        }) + '\n')
      } catch (error) {
        clearTimeout(turn.timer)
        const index = this.pending.indexOf(turn)
        if (index >= 0) this.pending.splice(index, 1)
        reject(error)
      }
    })
  }

  /** 重置会话：关掉进程并清空历史，下次 send 重新起（付一次冷启动）。 */
  async reset() {
    const child = this.child
    this.child = null
    this.status = 'idle'
    this._rejectAll('会话已重置')
    if (child) {
      try { child.stdin.end() } catch {}
      try { child.kill('SIGTERM') } catch {}
    }
    this.events = []
    this.seq = 0
    this.turns = 0
    this.lastError = null
    this.startedAt = null
    this._record({ type: 'log', text: '会话已重置' })
  }
}

/** 模型选择的持久化路径与读写。 */
const MODEL_FILE = join(homedir(), '.dsh', 'enslave-agy-model.json')

function loadSavedModel() {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_FILE, 'utf8'))
    return typeof parsed?.model === 'string' ? parsed.model : ''
  } catch {
    return ''
  }
}

function saveModelSelection(model) {
  try {
    mkdirSync(dirname(MODEL_FILE), { recursive: true })
    writeFileSync(MODEL_FILE, JSON.stringify({ model }), 'utf8')
  } catch (error) {
    debugLog(`save model failed: ${error?.message ?? error}`)
  }
}

/**
 * 拉取 agy 支持的模型列表。
 * `agy models` 每次要跑几秒，所以缓存起来，只在没缓存时真跑。
 */
let modelsCache = null

async function listModels(options) {
  if (modelsCache) return modelsCache
  try {
    const env = await agyEnv()
    const { stdout } = await execFileAsync(options.agyPath, ['models'], {
      env,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    })
    const models = []
    for (const line of String(stdout).split(/\r?\n/)) {
      const match = /^([a-z0-9.\-]+)\s+(.+)$/i.exec(line.trim())
      if (match) models.push({ id: match[1], label: match[2].trim() })
    }
    modelsCache = models
    return models
  } catch (error) {
    debugLog(`listModels failed: ${error?.message ?? error}`)
    return []
  }
}

/** 跑一次 agy（阻塞到结束），返回结果。给 HTTP 路由用。 */
async function runAgyOnce(prompt, options, { model, cwd } = {}) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ]
  if (model) args.push('--model', model)

  const env = await agyEnv()
  const started = Date.now()

  return await new Promise((resolve) => {
    let child
    try {
      child = spawn(options.agyPath, args, {
        cwd: cwd || process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, output: '', diagnostic: `spawn failed: ${error?.message ?? error}` })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => { stdout += c.toString() })
    child.stderr.on('data', c => { stderr += c.toString() })

    const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, options.timeoutMs)

    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, output: '', diagnostic: `agy process error: ${error?.message ?? error}` })
    })

    child.on('close', code => {
      clearTimeout(timer)
      const durationSeconds = Math.round((Date.now() - started) / 100) / 10
      const parsed = parseAgyJson(stdout)
      const text = typeof parsed?.response === 'string' ? parsed.response : stdout
      const hasText = String(text ?? '').trim().length > 0

      // 正常成功
      if (parsed?.status === 'SUCCESS') {
        const noise = extractNoise(stdout, stderr)
        resolve({
          ok: true,
          output: text,
          // 成功但内部重试过：作为警告透出，不改判定
          warning: noise || undefined,
          durationSeconds,
          usage: parsed.usage,
          conversationId: parsed.conversation_id,
        })
        return
      }

      // 有 JSON 但状态非成功
      if (parsed) {
        resolve({
          ok: false,
          output: text,
          partial: hasText,
          diagnostic: (String(parsed?.error ?? '').trim() || extractNoise(stdout, stderr))
            .slice(0, 4000) || `agy status ${parsed?.status}`,
          durationSeconds,
        })
        return
      }

      // 完全没有 JSON：按退出码判断
      if (code === 0) {
        const noise = extractNoise(stdout, stderr)
        resolve({
          ok: true,
          output: stdout,
          warning: noise || undefined,
          durationSeconds,
        })
      } else {
        resolve({
          ok: false,
          output: stdout,
          partial: hasText,
          diagnostic: (stderr || `agy exited with code ${code}`).slice(0, 4000),
          durationSeconds,
        })
      }
    })
  })
}

export function apply(ctx, config = {}) {
  const options = {
    agyPath: config.agyPath ?? DEFAULT_AGY,
    timeoutMs: config.timeoutMs ?? 600_000,
  }
  const providerName = config.providerName ?? 'agy'

  // 活跃任务注册表：面板据此列出/取消运行中的 agy 进程。
  const tasks = new TaskRegistry()

  // 当前选中的模型（面板可改，内存态；config.model 是初始值）
  const modelState = { current: config.model || loadSavedModel() }

  // 历史任务记录（持久化，重启不丢）
  const history = new HistoryStore(join(homedir(), '.dsh', 'enslave-agy-history.json'))

  // 防御：provider 注册失败也不许拦下 host 启动。
  try {
    ctx.subagents.registerProvider(new AgyProvider(providerName, options, ctx.logger, tasks, modelState, history))
    safeLog(ctx.logger, 'info', `[enslave-agy] provider "${providerName}" registered (agy: ${options.agyPath})`)
  } catch (error) {
    safeLog(ctx.logger, 'warn', `[enslave-agy] provider 注册失败（不影响启动）: ${error?.message ?? error}`)
  }

  // HTTP 桥：面板的测试入口（走长驻会话）与状态查询。
  try {
    const session = new AgySession(options, ctx.logger)

    const routes = [
      {
        kind: 'exact',
        path: '/__dsh-enslave-agy/status',
        handler: (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          sendJson(res, 200, {
            ok: true,
            provider: providerName,
            agyPath: options.agyPath,
            timeoutMs: options.timeoutMs,
            mode: 'persistent',
          })
        },
      },
      {
        // 发一个 turn 给长驻会话，等结果。
        kind: 'exact',
        path: '/__dsh-enslave-agy/run',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const prompt = String(body?.prompt ?? '').trim()
            if (!prompt) return sendJson(res, 400, { error: 'prompt required' })
            const started = Date.now()
            const result = await session.send(prompt)
            sendJson(res, 200, { ...result, wallSeconds: Math.round((Date.now() - started) / 100) / 10 })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 增量拉状态与事件：?since=<seq>
        kind: 'exact',
        path: '/__dsh-enslave-agy/state',
        handler: (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          const url = new URL(req.url ?? '/', 'http://x')
          const since = Number(url.searchParams.get('since') ?? 0) || 0
          sendJson(res, 200, session.getState(since))
        },
      },
      {
        // 重置会话（清上下文，下次重新冷启动）
        kind: 'exact',
        path: '/__dsh-enslave-agy/reset',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            await session.reset()
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 列出运行中的 agy 任务
        kind: 'exact',
        path: '/__dsh-enslave-agy/tasks',
        handler: (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          sendJson(res, 200, { tasks: tasks.list() })
        },
      },
      {
        // 取消一个运行中的任务
        kind: 'exact',
        path: '/__dsh-enslave-agy/cancel',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const id = String(body?.id ?? '').trim()
            if (!id) return sendJson(res, 400, { error: 'id required' })
            const record = tasks.get(id)
            if (!record) return sendJson(res, 404, { error: 'task not found (可能已结束)' })
            await record.dispose()
            safeLog(ctx.logger, 'info', `[enslave-agy] cancelled ${id}`)
            sendJson(res, 200, { ok: true, id })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // agy 支持的模型列表（缓存）
        kind: 'exact',
        path: '/__dsh-enslave-agy/models',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          const models = await listModels(options)
          sendJson(res, 200, { models, current: modelState.current })
        },
      },
      {
        // 当前模型 / 切换模型
        kind: 'exact',
        path: '/__dsh-enslave-agy/model',
        handler: async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          if (req.method === 'GET') {
            sendJson(res, 200, { current: modelState.current })
            return
          }
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST only' })
          try {
            const raw = await readBody(req)
            const body = raw ? JSON.parse(raw) : {}
            const model = typeof body?.model === 'string' ? body.model.trim() : ''
            modelState.current = model
            saveModelSelection(model)
            safeLog(ctx.logger, 'info', `[enslave-agy] model → ${model || '(agy 默认)'}`)
            sendJson(res, 200, { ok: true, current: modelState.current })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 历史任务（倒序）
        kind: 'exact',
        path: '/__dsh-enslave-agy/history',
        handler: (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
          const url = new URL(req.url ?? '/', 'http://x')
          const count = Math.min(Number(url.searchParams.get('count') ?? 30) || 30, 200)
          sendJson(res, 200, { items: history.list(count) })
        },
      },
    ]

    // 用可选注入拿 webServer：服务名不对时 provider 仍然工作，只是没有测试路由。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (host) => {
        const server = host?.webServer ?? ctx.webServer
        if (typeof server?.register !== 'function') {
          host?.logger?.warn?.('[enslave-agy] webServer 不可用，跳过 http 桥')
          return
        }
        for (const route of routes) {
          try {
            server.register(route)
          } catch (error) {
            host?.logger?.warn?.(`[enslave-agy] 路由 ${route.path} 注册失败: ${error?.message ?? error}`)
          }
        }
        host?.logger?.info?.('[enslave-agy] http bridge mounted (persistent session)')
      })
    }
  } catch (error) {
    ctx.logger?.warn?.(`[enslave-agy] http 路由注册失败（不影响启动）: ${error?.message ?? error}`)
  }
}
