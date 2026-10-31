/**
 * dsh-enslave-agy —— 客户端（browser half）
 *
 * 左侧栏入口「哈基米go work！」+ 主区域面板。
 *
 * 必须遵守的点（从 dsh-metaphysics 抄来的可工作写法）：
 *   1. h 必须是 React.createElement —— jsx-runtime 的 jsx(type, props, key)
 *      只有三个参数，多传的子元素会被静默丢弃。
 *   2. main 的注册描述符只写 { name, key }，不塞 inject({ workbench: true })。
 *   3. 用 slots.inject(name, install) 等待槽位就绪，全程 try/catch，
 *      任何异常都不许冒泡（否则会拦下整个 web boot）。
 *
 * P2：面板走**长驻会话**（--input-format stream-json），
 * 派活时轮询 /state 拿 NDJSON 事件流做实时日志。
 */
;(() => {
  function makeFactory() {
    return (require) => {
      const module = { exports: {} }

      const React = (function () {
        try { return require('react') } catch { return globalThis.React }
      })()
      if (!React) return { inject: [], apply() {} }

      // 关键：createElement，不是 jsx
      const h = React.createElement
      const { useState, useEffect, useRef } = React

      const name = 'enslave-agy'
      const inject = ['slots']

      const C = {
        text: '#e6e6e6',
        dim: '#9a9a9a',
        accent: '#6ea8fe',
        bg: '#1b1b1f',
        panel: '#141417',
        border: '#33333a',
        green: '#7bd88f',
        yellow: '#e5c07b',
        red: '#ff8a8a',
        cyan: '#7fd3d3',
      }

      const API = '/__dsh-enslave-agy'

      /** 侧栏图标：线框小鱼。 */
      function PanelIcon(props) {
        const size = props && props.size ? props.size : 20
        const active = props && props.active
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { opacity: active ? 1 : 0.72 },
        },
          h('path', { d: 'M2.5 12c2.4-3.4 5.7-5.3 9.4-5.3 3.3 0 6.2 1.9 8.6 5.3-2.4 3.4-5.3 5.3-8.6 5.3-3.7 0-7-1.9-9.4-5.3Z' }),
          h('circle', { cx: '15.6', cy: '11.4', r: '0.9', fill: 'currentColor', stroke: 'none' }),
        )
      }

      function Row(label, value) {
        return h('div', { style: { display: 'flex', gap: '10px', padding: '4px 0' } },
          h('span', { style: { color: C.dim, minWidth: '76px' } }, label),
          h('span', { style: { color: C.text } }, value),
        )
      }

      /** 毫秒时间戳 → HH:MM:SS */
      function clockTime(ms) {
        try {
          const d = new Date(ms)
          const pad = (n) => String(n).padStart(2, '0')
          return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
        } catch {
          return '--:--:--'
        }
      }

      /** 把一条事件渲染成一行日志。 */
      function renderEvent(event) {
        const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }
        let color = C.dim
        let text = ''

        switch (event.type) {
          case 'prompt':
            color = C.accent
            text = '→ ' + event.text
            break
          case 'delta':
            color = C.text
            text = event.text
            break
          case 'tool':
            color = C.cyan
            text = '⚙ ' + event.tool + (event.text ? ' · ' + event.text : '')
            break
          case 'result':
            color = C.green
            text = '✓ turn 完成（' + (event.status || '?') + '）'
            break
          case 'exit':
            color = C.red
            text = '✕ 进程退出 code=' + event.code
            break
          case 'error':
            color = C.red
            text = event.text
            break
          case 'stderr':
          case 'noise':
            color = C.yellow
            text = event.text
            break
          case 'init':
            color = C.dim
            text = '· ' + (event.text || 'init')
            break
          default:
            text = event.text || ''
        }

        if (!text) return null
        return h('div', { key: event.seq, style: { ...mono, color, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '1px 0' } }, text)
      }

      function Panel() {
        const [prompt, setPrompt] = useState('Reply with exactly one word: PONG')
        const [running, setRunning] = useState(false)
        const [result, setResult] = useState(null)
        const [events, setEvents] = useState([])
        const [sessionStatus, setSessionStatus] = useState('idle')
        const [turns, setTurns] = useState(0)
        const [taskList, setTaskList] = useState([])
        const [models, setModels] = useState([])
        const [model, setModel] = useState('')
        const [history, setHistory] = useState([])
        const [expandedId, setExpandedId] = useState('')

        const timerRef = useRef(null)
        const seqRef = useRef(0)
        const boxRef = useRef(null)

        const poll = async () => {
          try {
            const response = await fetch(API + '/state?since=' + seqRef.current)
            const state = await response.json()
            setSessionStatus(state.status || 'idle')
            setTurns(state.turns || 0)
            if (state.seq > seqRef.current) {
              setEvents(previous => [...previous, ...(state.events || [])].slice(-120))
              seqRef.current = state.seq
            }
          } catch {
            /* 轮询失败静默忽略 */
          }
        }

        const refreshModels = async () => {
          try {
            const response = await fetch(API + '/models')
            const data = await response.json()
            setModels(Array.isArray(data.models) ? data.models : [])
            if (typeof data.current === 'string') setModel(data.current)
          } catch { /* 忽略 */ }
        }

        const changeModel = async (next) => {
          setModel(next)
          try {
            await fetch(API + '/model', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: next }),
            })
          } catch { /* 忽略 */ }
        }

        const refreshTasks = async () => {
          try {
            const response = await fetch(API + '/tasks')
            const data = await response.json()
            setTaskList(Array.isArray(data.tasks) ? data.tasks : [])
          } catch { /* 忽略 */ }
          try {
            const response = await fetch(API + '/history?count=30')
            const data = await response.json()
            setHistory(Array.isArray(data.items) ? data.items : [])
          } catch { /* 忽略 */ }
        }

        const cancelTask = async (id) => {
          try {
            await fetch(API + '/cancel', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id }),
            })
          } catch { /* 忽略 */ }
          refreshTasks()
        }

        useEffect(() => {
          refreshTasks()
          refreshModels()
          const timer = setInterval(refreshTasks, 2000)
          return () => clearInterval(timer)
        }, [])

        const startPolling = () => {
          if (timerRef.current) return
          timerRef.current = setInterval(poll, 700)
        }

        const stopPolling = () => {
          if (timerRef.current) {
            clearInterval(timerRef.current)
            timerRef.current = null
          }
        }

        useEffect(() => {
          return () => stopPolling()
        }, [])

        useEffect(() => {
          if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
        }, [events])

        const send = async () => {
          const text = String(prompt || '').trim()
          if (!text || running) return
          setRunning(true)
          setResult(null)
          setEvents([])
          seqRef.current = 0
          const startedAt = Date.now()
          startPolling()
          try {
            const response = await fetch(API + '/run', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ prompt: text }),
            })
            const data = await response.json()
            setResult({ ...data, wallSeconds: Math.round((Date.now() - startedAt) / 100) / 10 })
          } catch (error) {
            setResult({ ok: false, error: String(error && error.message ? error.message : error) })
          } finally {
            await poll()
            setRunning(false)
            stopPolling()
          }
        }

        const reset = async () => {
          if (running) return
          try {
            await fetch(API + '/reset', { method: 'POST' })
          } catch {}
          setEvents([])
          seqRef.current = 0
          setResult(null)
          setTurns(0)
          setSessionStatus('idle')
        }

        const statusTone = sessionStatus === 'running' ? C.accent
          : sessionStatus === 'dead' ? C.red
          : C.dim

        const warnOnly = result && result.ok && result.warning
        const partial = result && !result.ok && result.partial
        const resultTone = !result ? C.dim
          : result.ok ? (warnOnly ? C.yellow : C.green)
          : (partial ? C.yellow : C.red)

        return h('div', {
          style: {
            padding: '20px 24px',
            color: C.text,
            fontSize: '13px',
            lineHeight: 1.65,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            maxWidth: '760px',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '12px' } },
            h('div', { style: { fontSize: '18px', fontWeight: 600 } }, '哈基米go work！'),
            h('div', { style: { color: statusTone, fontSize: '12px' } },
              '会话 ' + sessionStatus + ' · ' + turns + ' 轮'),
          ),
          h('div', { style: { color: C.dim, marginBottom: '16px' } },
            '长驻 agy 会话 · 冷启动只付一次，之后每个 turn 只付模型时间'),

          h('div', {
            style: {
              border: '1px solid ' + C.border,
              borderRadius: '8px',
              padding: '10px 14px',
              background: C.panel,
              marginBottom: '16px',
            },
          },
            Row('provider', h('code', null, 'agy')),
            Row('模式', '常驻（stream-json）'),
            Row('agy', h('code', null, '~/.local/bin/agy')),
            Row('权限', '自动放行'),
          ),

          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' },
          },
            h('span', { style: { color: C.dim, minWidth: '76px' } }, '模型'),
            h('select', {
              value: model,
              onChange: event => changeModel(event.target.value),
              style: {
                padding: '5px 8px',
                borderRadius: '6px',
                border: '1px solid ' + C.border,
                background: C.panel,
                color: C.text,
                fontSize: '12.5px',
                minWidth: '240px',
              },
            },
              h('option', { value: '' }, 'agy 默认'),
              ...models.map(item => h('option', { key: item.id, value: item.id }, item.label)),
            ),
            h('span', { style: { color: C.dim, fontSize: '11.5px' } },
              models.length === 0 ? '（加载中…）' : '共 ' + models.length + ' 个可用'),
          ),

          taskList.length
            ? h('div', {
              style: {
                marginBottom: '16px',
                border: '1px solid ' + C.border,
                borderRadius: '8px',
                padding: '10px 12px',
                background: C.panel,
              },
            },
              h('div', { style: { color: C.accent, fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
                '运行中 ' + taskList.length + ' 个 agy 任务'),
              ...taskList.map(task => h('div', {
                key: task.id,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '4px 0',
                  fontSize: '12px',
                },
              },
                h('span', { style: { color: C.dim, fontFamily: 'ui-monospace, Menlo, monospace' } },
                  task.id.slice(0, 8)),
                h('span', {
                  style: {
                    flex: '1 1 auto',
                    color: C.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                  title: task.prompt,
                }, task.prompt),
                h('span', { style: { color: C.dim, flex: '0 0 auto' } }, task.runningSeconds + 's'),
                h('button', {
                  onClick: () => cancelTask(task.id),
                  style: {
                    flex: '0 0 auto',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: '1px solid #6b3030',
                    background: 'transparent',
                    color: C.red,
                    fontSize: '11px',
                    cursor: 'pointer',
                  },
                }, '停止'),
              )),
            )
            : null,

          history.length
            ? h('div', {
              style: {
                marginBottom: '16px',
                border: '1px solid ' + C.border,
                borderRadius: '8px',
                padding: '10px 12px',
                background: C.panel,
              },
            },
              h('div', { style: { color: C.dim, fontSize: '12px', marginBottom: '4px' } },
                '历史 · ' + history.length + ' 条（点一行看详情）'),
              ...history.slice(0, 20).map(item => {
                const open = expandedId === item.id
                const tone = item.status === 'completed'
                  ? C.green
                  : (item.status === 'aborted' ? C.yellow : C.red)
                return h('div', { key: item.id, style: { fontSize: '12px' } },
                  h('div', {
                    onClick: () => setExpandedId(open ? '' : item.id),
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '3px 0',
                      cursor: 'pointer',
                    },
                  },
                    h('span', { style: { color: tone, flex: '0 0 auto' } }, '●'),
                    h('span', {
                      style: { color: C.dim, flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11.5px' },
                    }, clockTime(item.finishedAt)),
                    h('span', {
                      style: {
                        flex: '1 1 auto',
                        color: C.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                      title: item.prompt,
                    }, item.prompt),
                    h('span', { style: { color: C.dim, flex: '0 0 auto', fontSize: '11.5px' } },
                      item.durationSeconds + 's'),
                  ),
                  open
                    ? h('div', {
                      style: {
                        margin: '2px 0 8px 16px',
                        paddingLeft: '8px',
                        borderLeft: '2px solid ' + C.border,
                        color: C.dim,
                        fontSize: '11.5px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      },
                    },
                      h('div', null, 'cwd: ' + item.cwd),
                      h('div', null, 'model: ' + (item.model || '(agy 默认)')),
                      h('div', null, 'status: ' + item.status + ' · ' + item.durationSeconds + 's'),
                      item.diagnostic
                        ? h('div', { style: { color: C.red, marginTop: '4px' } }, item.diagnostic)
                        : null,
                      item.outputPreview
                        ? h('div', { style: { color: C.text, marginTop: '4px' } }, item.outputPreview)
                        : null,
                    )
                    : null,
                )
              }),
            )
            : null,

          h('textarea', {
            value: prompt,
            onChange: event => setPrompt(event.target.value),
            rows: 3,
            spellCheck: false,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              borderRadius: '6px',
              border: '1px solid ' + C.border,
              background: C.panel,
              color: C.text,
              fontSize: '13px',
              fontFamily: 'inherit',
              resize: 'vertical',
            },
          }),

          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px' } },
            h('button', {
              onClick: send,
              disabled: running,
              style: {
                padding: '7px 16px',
                borderRadius: '6px',
                border: 'none',
                background: running ? '#3a4a66' : '#2f6feb',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 600,
                cursor: running ? 'default' : 'pointer',
              },
            }, running ? '派活中…' : '派活给 agy'),
            h('button', {
              onClick: reset,
              disabled: running,
              style: {
                padding: '7px 14px',
                borderRadius: '6px',
                border: '1px solid ' + C.border,
                background: 'transparent',
                color: C.dim,
                fontSize: '13px',
                cursor: running ? 'default' : 'pointer',
              },
            }, '重置会话'),
            running
              ? h('span', { style: { color: C.dim, fontSize: '12px' } }, '实时日志见下方')
              : null,
          ),

          events.length
            ? h('div', {
              ref: boxRef,
              style: {
                marginTop: '14px',
                maxHeight: '260px',
                overflowY: 'auto',
                border: '1px solid ' + C.border,
                borderRadius: '8px',
                padding: '10px 12px',
                background: C.panel,
              },
            }, events.map(renderEvent))
            : null,

          result
            ? h('div', {
              style: {
                marginTop: '14px',
                border: '1px solid ' + resultTone,
                borderRadius: '8px',
                padding: '12px 14px',
                background: C.panel,
              },
            },
              h('div', { style: { marginBottom: '6px', color: resultTone, fontWeight: 600 } },
                !result.ok ? (partial ? '部分成功' : '失败')
                  : warnOnly ? '成功（agy 内部重试过）'
                  : '成功',
                result.wallSeconds !== undefined ? ' · 往返 ' + result.wallSeconds + 's' : '',
                result.usage && result.usage.total_tokens !== undefined ? ' · ' + result.usage.total_tokens + ' tokens' : '',
                result.durationSeconds !== undefined
                  ? h('span', { style: { color: C.dim, fontWeight: 400 } }, '（会话累计 ' + result.durationSeconds + 's）')
                  : null,
              ),
              result.output
                ? h('pre', {
                  style: {
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: C.text,
                    fontSize: '12.5px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  },
                }, String(result.output))
                : null,
              result.warning
                ? h('div', { style: { marginTop: '8px', color: C.yellow, fontSize: '12px', whiteSpace: 'pre-wrap' } },
                  String(result.warning))
                : null,
              (result.diagnostic || result.error)
                ? h('div', { style: { marginTop: '8px', color: C.red, fontSize: '12px', whiteSpace: 'pre-wrap' } },
                  String(result.diagnostic || result.error))
                : null,
            )
            : null,

          h('div', { style: { marginTop: '18px', color: C.dim, fontSize: '12px' } },
            'P2：长驻会话 + 实时日志。「重置会话」会清空上下文并重新冷启动。'),
        )
      }

      /** 注册包装：等槽位就绪 + 吞掉一切异常。 */
      function install(ctx, key, options, component) {
        const register = () => {
          try {
            ctx.slots.register(options, component)
          } catch (error) {
            console.warn(`[enslave-agy] 注册 ${key} 失败（不影响启动）:`, error)
          }
        }
        try {
          if (typeof ctx.slots.inject === 'function') ctx.slots.inject(key, register)
          else register()
        } catch (error) {
          console.warn(`[enslave-agy] 等待槽位 ${key} 失败:`, error)
          try { register() } catch {}
        }
      }

      function apply(ctx) {
        install(ctx, 'sidebar.panellist',
          { name: 'sidebar.panellist', id: 'enslave-agy', order: 60, label: () => '哈基米go work！' },
          PanelIcon)

        install(ctx, 'main',
          { name: 'main', key: 'enslave-agy' },
          Panel)
      }

      module.exports = { apply, inject, name }
      return module.exports
    }
  }

  window.__ModuleLoader__.load({ id: 'dsh-enslave-agy', factory: makeFactory() })
})()
