import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreSource } from '../server/core/source.ts'
import { CoreProviderRetries, LOGIN_GRACE } from '../server/core/provider-retries.ts'
import { CoreTasks } from '../server/core/tasks.ts'
import type { CoreAgent, CoreSpace } from '../server/core/model.ts'
import type { CoreTask } from '../server/core/tasks.ts'
import type { CoreTerminal } from '../server/core/protocol.ts'
import type { LogEvent } from '../server/common/readers/types.ts'

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'shep-provider-')), source = new CoreSource({ home, socket: '/unused', binary: 'hc', session: 'test', port: 0 })
  try { await run(setup(source)) } finally { source.stop(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) }
}
function setup(source: CoreSource) {
  const space = { id: 'p:machine:app', name: 'app', machine: 'machine', folder: '/repo', base: 'main', prefix: 'APP', mode: 'regular', added: 1 } as CoreSpace
  const task = { id: 'APP-1', name: 'Task', place: space.id, machine: space.machine, chat: 'APP-1/Agent', workflow: 'working', kind: 'claude', branch: 'work/one', base: 'main', age: 'now', launchAttempt: 'attempt' } as CoreTask
  const agent = { chat: task.chat, space: space.id, machine: space.machine, role: 'task', kind: 'claude', launch: 'launch', grant: 'grant', state: 'idle', started: 1, hook: '/unused' } as CoreAgent
  source.store.set('space', space.id, space); source.store.set('task', task.id, task); source.store.set('agent', agent.chat, agent)
  source.connected = () => true; source.machineConnected = () => true
  source.agents.terminal = () => ({ address: 't1', state: 'live' } as CoreTerminal)
  let turn: ReturnType<typeof source.logs.providerTurn> = { complete: true, cut: { kind: 'error', id: 'cut-1', at: 2, text: 'API Error: 529 Overloaded', status: 529 } }
  source.logs.providerTurn = () => turn
  const sent: { id: string; text: string }[] = []
  source.saveAndDeliver = (_chat, id, text, save) => { save(); sent.push({ id, text }) }
  let backups = 0
  source.tasks.providerFallback = async () => { backups++; return false }
  return { source, agent, task, space, sent, turn: (value: typeof turn) => { turn = value }, backups: () => backups }
}

test('native provider cutoffs retry at 1/2/4/8 minutes once each across a controller restart, then need the human', () => fixture(async f => {
  let retries = f.source.providerRetries, now = 1000
  for (const [index, minutes] of [1, 2, 4, 8].entries()) {
    f.turn({ complete: true, cut: { kind: 'error', id: `cut-${index + 1}`, at: now, text: 'API Error: 529 Overloaded', status: 529 } })
    await retries.tick(now)
    expect(retries.get(f.agent)?.due).toBe(now + minutes * 60_000)
    await retries.tick(now + minutes * 60_000 - 1)
    expect(f.sent).toHaveLength(index)
    retries = new CoreProviderRetries(f.source)
    await retries.tick(now + minutes * 60_000)
    await retries.tick(now + minutes * 60_000 + 1)
    expect(f.sent).toHaveLength(index + 1)
    now += minutes * 60_000 + 100
  }
  f.turn({ complete: true, cut: { kind: 'error', id: 'cut-5', at: now, text: 'overloaded', status: 529 } })
  await retries.tick(now); await retries.tick(now + 1)
  expect(retries.get(f.agent)).toMatchObject({ over: true, tries: 5, reason: 'Provider overloaded, still after 5 tries' })
  expect(f.backups()).toBe(1)
  expect(f.source.logs.messages(f.agent.chat).filter(m => m.card)).toHaveLength(1)
}))

test('an explicit message resets retries without immediately rediscovering the same old cutoff', () => fixture(async f => {
  await f.source.providerRetries.tick(1000)
  f.source.providerRetries.clear(f.agent.chat)
  await f.source.providerRetries.tick(100_000)
  expect(f.sent).toHaveLength(0)
  expect(f.source.providerRetries.get(f.agent)).toBeUndefined()
  f.turn({ complete: true, cut: { kind: 'error', id: 'fresh', at: 100_001, text: 'rate limited', status: 429 } })
  await f.source.providerRetries.tick(100_001)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ tries: 1, due: 160_001 })
}))

test('incomplete logs, background work, paused tasks, reviewers, replaced launches and unknown machine identity never get a retry', () => fixture(async f => {
  f.turn({ complete: false }); await f.source.providerRetries.tick(0)
  expect(f.source.providerRetries.get(f.agent)).toBeUndefined()
  f.turn({ complete: true, cut: { kind: 'error', id: 'cut', at: 2, text: 'overloaded' } })
  f.task.workflow = 'todo'; f.source.store.set('task', f.task.id, f.task)
  await f.source.providerRetries.tick(1000)
  expect(f.source.providerRetries.get(f.agent)).toBeUndefined()
  f.task.workflow = 'working'; f.source.store.set('task', f.task.id, f.task)
  f.agent.pid = 10; f.source.store.set('agent', f.agent.chat, f.agent)
  await f.source.providerRetries.tick(1000)
  expect(f.source.providerRetries.get(f.agent)).toBeUndefined()
  delete f.agent.pid; f.source.store.set('agent', f.agent.chat, f.agent)
  await f.source.providerRetries.tick(1000)
  expect(f.source.providerRetries.get({ ...f.agent, launch: 'replacement' })).toBeUndefined()
}))

test('lasting failures ask immediately and an ended successful turn clears the retry record', () => fixture(async f => {
  f.turn({ complete: true, cut: { kind: 'error', id: 'auth', at: 2, text: 'Signed out', status: 401 } })
  await f.source.providerRetries.tick(1)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ over: true, reason: 'Signed out' })
  expect(f.sent).toHaveLength(0); expect(f.backups()).toBe(1)
  f.turn({ complete: true }); await f.source.providerRetries.tick(2)
  expect(f.source.providerRetries.get(f.agent)).toBeUndefined()
}))

test('backup records one-shot intent before replacing the old agent and preserves handover across capacity holds', () => fixture(async f => {
  const { CoreTasks } = await import('../server/core/tasks.ts')
  f.source.tasks.providerFallback = CoreTasks.prototype.providerFallback.bind(f.source.tasks)
  f.task.folder = '/work/one'; f.task.repo = '/repo'; f.source.store.set('task', f.task.id, f.task)
  const commands: string[][] = []
  f.source.tasks.git.run = async (_where, args) => { commands.push(args); return args[0] === 'log' ? 'abc123 Existing commit' : ' M unfinished.txt' }
  f.source.logs.outgoing(f.agent.chat, { id: 'human', who: 'you', text: 'Keep unfinished work', at: 1 })
  const internals = f.source.tasks as unknown as { finishForRestart(agent: CoreAgent): Promise<void>; launchNow(task: CoreTask, message?: string): Promise<void> }
  let finishes = 0
  internals.finishForRestart = async () => {
    finishes++
    expect(f.source.tasks.get(f.task.id)?.providerTakeover).toMatchObject({ state: 'starting', from: 'claude', to: 'codex', launch: f.agent.launch })
  }
  internals.launchNow = async (task, message) => {
    expect(message).toContain('Existing commit'); expect(message).toContain('unfinished.txt'); expect(message).toContain('Keep unfinished work')
    task.workflow = 'queued'; task.capacity = 'Machine load'; task.providerTakeover!.state = 'queued'
    f.source.store.set('task', task.id, task)
  }
  expect(await f.source.tasks.providerFallback(f.task.id, f.agent.launch, 'Out of allowance')).toBe(true)
  const saved = f.source.tasks.get(f.task.id)!
  expect(saved.providerTakeover).toMatchObject({ state: 'queued', to: 'codex' })
  expect(saved.providerTakeover?.handover).toContain('unfinished.txt')
  expect(saved.branch).toBe('work/one'); expect(saved.folder).toBe('/work/one')
  expect(f.source.logs.messages(f.agent.chat).some(message => message.card?.text.includes('took over'))).toBe(false)
  expect(await f.source.tasks.providerFallback(f.task.id, f.agent.launch, 'Out of allowance')).toBe(false)
  expect(finishes).toBe(1); expect(commands.map(args => args[0])).toEqual(['log', 'status'])
}))

test('contained tasks never switch provider automatically and interrupted takeover needs an explicit restart', () => fixture(async f => {
  const { CoreTasks } = await import('../server/core/tasks.ts')
  f.source.tasks.providerFallback = CoreTasks.prototype.providerFallback.bind(f.source.tasks)
  f.task.pilot = 'contained'; f.source.store.set('task', f.task.id, f.task)
  expect(await f.source.tasks.providerFallback(f.task.id, f.agent.launch, 'Signed out')).toBe(false)
  delete f.task.pilot
  f.task.providerTakeover = { from: 'claude', to: 'codex', launch: f.agent.launch, at: 10, why: 'Signed out', state: 'starting', handover: 'Existing work' }
  f.source.store.set('task', f.task.id, f.task)
  f.source.tasks.recoverProviderFallbacks()
  expect(f.source.tasks.get(f.task.id)?.startError).toContain('interrupted')
  expect(f.source.tasks.get(f.task.id)?.providerTakeover?.state).toBe('failed')
  expect(await f.source.tasks.providerFallback(f.task.id, f.agent.launch, 'Signed out')).toBe(false)
}))


test('native blocked provider failure can hand over, but blocked or incomplete work without an ended error cannot', () => fixture(async f => {
  f.source.agents.terminal = () => ({ address: 't1', state: 'live', status: { app: 'claude-code', state: 'blocked' } } as CoreTerminal)
  f.turn({ complete: false })
  await f.source.providerRetries.tick(1)
  expect(f.backups()).toBe(0)
  f.turn({ complete: true })
  await f.source.providerRetries.tick(2)
  expect(f.backups()).toBe(0)
  f.turn({ complete: true, cut: { kind: 'error', id: 'native-auth-failed', at: 3, text: 'Invalid API key', code: 'authentication_failed', status: 401 } })
  await f.source.providerRetries.tick(3)
  expect(f.backups()).toBe(1)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ over: true, reason: 'Signed out' })
  await f.source.providerRetries.tick(4)
  expect(f.backups()).toBe(1)
}))

async function onAntigravity(f: ReturnType<typeof setup>, login = { value: 'a' }) {
  f.source.settings.set('task.fallback', 'Antigravity')
  f.source.providerLogin.mark = async () => login.value
  f.source.providerLogin.available = async () => false
  return login
}
const LIMIT = { kind: 'error' as const, id: 'limit-1', at: 2, text: "You've hit your session limit · resets 5pm", code: 'rate_limit', status: 429 }

test('with Antigravity as the backup, a limit that clears during its grace period stays on the same agent', () => fixture(async f => {
  await onAntigravity(f)
  f.turn({ complete: true, cut: LIMIT })
  await f.source.providerRetries.tick(1000)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ reason: 'Out of allowance until 5pm', rounds: 1, due: 1000 + LOGIN_GRACE })
  expect(f.source.providerRetries.get(f.agent)?.over).toBeUndefined()
  await f.source.providerRetries.tick(1000 + LOGIN_GRACE - 1)
  expect(f.sent).toHaveLength(0)
  await f.source.providerRetries.tick(1000 + LOGIN_GRACE)
  expect(f.sent).toHaveLength(1)
  f.turn({ complete: true })
  await f.source.providerRetries.tick(1000 + LOGIN_GRACE + 1)
  expect(f.source.providerRetries.get(f.agent)).toBeUndefined()
  expect(f.backups()).toBe(0)
}))

test('a changed login is tried at once and no plugin is needed to notice it', () => fixture(async f => {
  const login = await onAntigravity(f)
  f.turn({ complete: true, cut: LIMIT })
  await f.source.providerRetries.tick(1000)
  login.value = 'b'
  await f.source.providerRetries.tick(2000)
  expect(f.sent).toHaveLength(1)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ swapped: true, login: 'b' })
  expect(f.backups()).toBe(0)
}))

test('it takes over only after a retry failed and a further grace period brought no new login', () => fixture(async f => {
  await onAntigravity(f)
  f.turn({ complete: true, cut: LIMIT })
  await f.source.providerRetries.tick(1000)
  await f.source.providerRetries.tick(1000 + LOGIN_GRACE)
  expect(f.sent).toHaveLength(1); expect(f.backups()).toBe(0)
  f.turn({ complete: true, cut: { ...LIMIT, id: 'limit-2' } })
  const later = 1000 + LOGIN_GRACE + 1
  await f.source.providerRetries.tick(later)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ rounds: 2, due: later + LOGIN_GRACE })
  expect(f.backups()).toBe(0)
  await f.source.providerRetries.tick(later + LOGIN_GRACE)
  expect(f.backups()).toBe(1)
  expect(f.sent).toHaveLength(1)
  await f.source.providerRetries.tick(later + LOGIN_GRACE + 1)
  expect(f.backups()).toBe(1)
}))

test('a new login that is also out gets its own grace period, a bounded number of times', () => fixture(async f => {
  const login = await onAntigravity(f)
  let now = 1000
  for (const round of [1, 2, 3, 4]) {
    f.turn({ complete: true, cut: { ...LIMIT, id: `limit-${round}` } })
    await f.source.providerRetries.tick(now)
    login.value = `login-${round}`
    now += 1000
    await f.source.providerRetries.tick(now)
    expect(f.sent).toHaveLength(round)
    expect(f.backups()).toBe(0)
    now += 1000
  }
  f.turn({ complete: true, cut: { ...LIMIT, id: 'limit-5' } })
  await f.source.providerRetries.tick(now)
  login.value = 'login-5'
  await f.source.providerRetries.tick(now + 1000)
  expect(f.sent).toHaveLength(4)
  expect(f.backups()).toBe(1)
}))

test('a retry that never comes back ends the grace period', () => fixture(async f => {
  await onAntigravity(f)
  f.turn({ complete: true, cut: LIMIT })
  await f.source.providerRetries.tick(1000)
  await f.source.providerRetries.tick(1000 + LOGIN_GRACE)
  const sentAt = 1000 + LOGIN_GRACE
  await f.source.providerRetries.tick(sentAt + 5 * 60_000 - 1)
  expect(f.backups()).toBe(0)
  await f.source.providerRetries.tick(sentAt + 5 * 60_000 + 1)
  expect(f.backups()).toBe(1)
}))

test('Antigravity is not spent on errors that are not an outage, and other backups behave as before', () => fixture(async f => {
  await onAntigravity(f)
  f.turn({ complete: true, cut: { kind: 'error', id: 'context', at: 2, text: 'context window exceeded', code: 'context_window_exceeded' } })
  await f.source.providerRetries.tick(1000)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ over: true, reason: 'Context window full' })
  expect(f.backups()).toBe(0)
  expect(f.source.logs.messages(f.agent.chat).some(message => message.card?.text.includes('Context window full'))).toBe(true)
  f.source.settings.set('task.fallback', 'Codex')
  f.turn({ complete: true, cut: { ...LIMIT, id: 'other' } })
  await f.source.providerRetries.tick(2000)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ over: true, reason: 'Out of allowance until 5pm' })
  expect(f.source.providerRetries.get(f.agent)?.rounds).toBeUndefined()
  expect(f.backups()).toBe(1)
}))

test('contained tasks get no grace period and no takeover', () => fixture(async f => {
  await onAntigravity(f)
  f.agent.pilot = { run: 'run', home: '/h', captures: '/c' }; f.source.store.set('agent', f.agent.chat, f.agent)
  f.turn({ complete: true, cut: LIMIT })
  await f.source.providerRetries.tick(1000)
  expect(f.source.providerRetries.get(f.agent)).toMatchObject({ over: true })
  expect(f.source.providerRetries.get(f.agent)?.rounds).toBeUndefined()
  expect(f.backups()).toBe(0)
}))

/** The real takeover and return, with only the process, git and machine calls standing in. */
function handOver(f: ReturnType<typeof setup>) {
  f.task.folder = '/work/one'; f.task.repo = '/repo'; f.task.review = { on: false, kind: 'claude', rounds: 1, mustFix: 'major' }; f.task.model = 'claude-opus-5-5'; f.task.effort = 'high'
  f.agent.session = 'claude-session'
  f.source.store.set('task', f.task.id, f.task); f.source.store.set('agent', f.agent.chat, f.agent)
  f.source.tasks.providerFallback = CoreTasks.prototype.providerFallback.bind(f.source.tasks)
  f.source.tasks.git.run = async (_where, args) => args[0] === 'log' ? 'abc123 Work so far' : ' M unfinished.txt'
  f.source.tasks.git.ensureWorktree = async () => false
  let live = f.agent.launch
  f.source.agents.terminal = agent => ({ address: 't1', state: agent.launch === live ? 'live' : 'finished' } as CoreTerminal)
  const launches: { kind: string; prompt: string; model?: string; session?: string; resume?: boolean }[] = []
  f.source.agents.launch = (async (space: CoreSpace, chat: string, kind: CoreAgent['kind'], prompt: string, options: { model?: string; session?: string; resume?: boolean; role?: string } = {}) => {
    if (options.role !== 'task') return { chat, space: space.id, machine: space.machine, role: 'coordinator', kind, launch: 'coordinator', grant: 'g', state: 'idle', started: 1, hook: '/unused' } as CoreAgent
    live = `launch-${launches.length + 2}`
    launches.push({ kind, prompt, model: options.model, session: options.session, resume: options.resume })
    const record = { ...f.agent, kind, launch: live, model: options.model, session: options.session, state: 'idle' } as CoreAgent
    f.source.store.set('agent', chat, record)
    return record
  }) as typeof f.source.agents.launch
  const internals = f.source.tasks as unknown as { finishForRestart(agent: CoreAgent): Promise<void>; label(task: CoreTask): Promise<void>; seedIncludes(task: CoreTask): Promise<void> }
  internals.finishForRestart = async () => { live = '' }
  internals.label = async () => {}
  f.source.core.call = (async (method: string, params: { argv?: string[] }) => {
    if (method === 'machine.exec' && params.argv?.[0] === 'agy') return { stdout: Buffer.from('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-5-5-low\tClaude\n').toString('base64'), stderr: '', code: 0, timed_out: false, truncated: false }
    throw new Error(`unexpected ${method}`)
  }) as typeof f.source.core.call
  return { launches, agent: () => f.source.agents.get(f.agent.chat)! }
}
const cards = (f: ReturnType<typeof setup>) => f.source.logs.messages(f.agent.chat).filter(message => message.card).map(message => message.card!.text)

test('Antigravity takes over on Gemini only and hands back at the end of a turn, resuming the same session', () => fixture(async f => {
  await onAntigravity(f)
  const run = handOver(f), start = f.agent.launch
  expect(await f.source.tasks.providerFallback(f.task.id, start, 'Out of allowance until 5pm')).toBe(true)
  expect(run.launches[0]).toMatchObject({ kind: 'agy', model: 'gemini-3.8-flash-low' })
  expect(run.launches[0].prompt).toContain('unfinished.txt')
  let saved = f.source.tasks.get(f.task.id)!
  expect(saved).toMatchObject({ kind: 'agy', model: 'gemini-3.8-flash-low', branch: 'work/one', folder: '/work/one' })
  expect(saved.providerTakeover).toMatchObject({ state: 'started', from: 'claude', to: 'agy', count: 1, back: { model: 'claude-opus-5-5', effort: 'high', session: 'claude-session' } })
  expect(cards(f).at(-1)).toContain('Antigravity took over from Claude Code')

  // Nothing is handed back while Claude can't, nor mid-turn once it can.
  f.source.providerLogin.available = async () => true
  f.turn({ complete: false })
  const at = saved.providerTakeover!.at
  await f.source.providerReturns.tick(at + 1)
  await f.source.providerReturns.tick(at + 6 * 60_000)
  expect(run.launches).toHaveLength(1)
  f.turn({ complete: true })
  await f.source.providerReturns.tick(at + 6 * 60_000 + 1)
  expect(run.launches[1]).toMatchObject({ kind: 'claude', model: 'claude-opus-5-5', session: 'claude-session', resume: true })
  expect(run.launches[1].prompt).toContain('Work so far')
  saved = f.source.tasks.get(f.task.id)!
  expect(saved).toMatchObject({ kind: 'claude', model: 'claude-opus-5-5', effort: 'high', branch: 'work/one', folder: '/work/one' })
  expect(saved.providerTakeover).toMatchObject({ state: 'returned' })
  expect(cards(f).at(-1)).toContain('Claude Code is back and took over from Antigravity')
  await f.source.providerReturns.tick(at + 6 * 60_000 + 2)
  expect(run.launches).toHaveLength(2)
}))

test('no loop: a task that returned goes to Antigravity again only after real work, and only so many times', () => fixture(async f => {
  await onAntigravity(f)
  const run = handOver(f)
  f.source.providerLogin.available = async () => true
  for (const round of [1, 2, 3]) {
    expect(await f.source.tasks.providerFallback(f.task.id, run.agent().launch, 'Out of allowance')).toBe(true)
    const at = f.source.tasks.get(f.task.id)!.providerTakeover!.at
    f.source.store.delete('provider-return', `${f.task.id}:${at}`)
    f.turn({ complete: true })
    await f.source.providerReturns.tick(at + 6 * 60_000)
    expect(f.source.tasks.get(f.task.id)).toMatchObject({ kind: 'claude' })
    // Straight back out, with no good turn since: the human's, not Antigravity's.
    if (round < 3) expect(await f.source.tasks.providerFallback(f.task.id, run.agent().launch, 'Out of allowance')).toBe(false)
    f.source.tasks.providerProved(run.agent())
  }
  expect(await f.source.tasks.providerFallback(f.task.id, run.agent().launch, 'Out of allowance')).toBe(false)
  expect(run.launches.filter(launch => launch.kind === 'agy')).toHaveLength(3)
}))

test('if Antigravity is missing, the task keeps its agent and needs the human; if it runs out too, it never loops', () => fixture(async f => {
  await onAntigravity(f)
  const run = handOver(f)
  f.source.core.call = (async () => { throw new Error('agy: command not found') }) as typeof f.source.core.call
  await expect(f.source.tasks.providerFallback(f.task.id, f.agent.launch, 'Out of allowance')).rejects.toThrow('not installed or not signed in')
  expect(run.launches).toHaveLength(0)
  expect(f.source.tasks.get(f.task.id)).toMatchObject({ kind: 'claude' })
  expect(f.source.tasks.get(f.task.id)?.providerTakeover).toBeUndefined()

  // On Antigravity, its own limit gets no grace period and nothing to fall back on.
  const handed = handOver(f)
  expect(await f.source.tasks.providerFallback(f.task.id, f.agent.launch, 'Out of allowance')).toBe(true)
  f.turn({ complete: true, cut: { kind: 'error', id: 'gemini-out', at: Date.now(), text: 'RESOURCE_EXHAUSTED: Quota exhausted' } })
  const retries = new CoreProviderRetries(f.source)
  await retries.tick(Date.now())
  expect(retries.get(handed.agent())).toMatchObject({ over: true, reason: 'Out of allowance' })
  expect(retries.get(handed.agent())?.rounds).toBeUndefined()
  expect(handed.launches.filter(launch => launch.kind === 'agy')).toHaveLength(1)
  expect(cards(f).at(-1)).toContain('Cut off by its provider: Out of allowance')
}))

test('an approved Antigravity command answers its own prompt once, and only that prompt', () => fixture(async f => {
  const agent = { ...f.agent, kind: 'agy' } as CoreAgent
  f.source.store.set('agent', agent.chat, agent)
  let status: CoreTerminal['status'] = { state: 'working', app: 'antigravity' }
  f.source.agents.terminal = () => ({ address: 't1', state: 'live', status } as CoreTerminal)
  const keys: unknown[] = []
  f.source.core.call = (async (_method: string, params: { keys?: unknown }) => { keys.push(params.keys); return {} }) as typeof f.source.core.call
  f.source.agyApprovals.approved(agent, { BypassSandbox: true, CommandLine: 'git push origin main' }, 1000)
  await f.source.agyApprovals.tick(1001)
  status = { state: 'blocked', kind: 'permission', msg: 'Approve RunCommand: rm -rf /' }
  await f.source.agyApprovals.tick(1002)
  expect(keys).toEqual([])
  status = { state: 'blocked', kind: 'permission', msg: 'Approve RunCommand: git push origin main' }
  await f.source.agyApprovals.tick(1003)
  expect(keys).toEqual([['enter']])
  await f.source.agyApprovals.tick(1004)
  expect(keys).toEqual([['enter']])
  // Too late: the human answers its Terminal.
  f.source.agyApprovals.approved(agent, { CommandLine: 'git push origin main' }, 2000)
  await f.source.agyApprovals.tick(2000 + 60_001)
  expect(keys).toEqual([['enter']])
  // Other agents never get keys.
  f.source.agyApprovals.approved(f.agent, { CommandLine: 'git push origin main' }, 3000)
  expect(f.source.store.all('agy-approved')).toEqual([])
}))
