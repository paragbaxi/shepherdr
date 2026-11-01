// A card that no longer matters stops counting: every kind that adds to the number, who may withdraw it, and that it
// never counts as an answer.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { CoreSource } from '../server/core/source.ts'
import { CoreCommands } from '../server/core/commands.ts'
import { attentionCounts } from '../src/attention.ts'
import { pushPayload, waiting } from '../shared/alerts.ts'
import type { PermissionAnswer } from '../server/core/native-asks.ts'
import type { CoreAgent, CoreSpace } from '../server/core/model.ts'
import type { Grant, MailRequest } from '../server/core/mailbox.ts'
import type { Alert, Message, Question } from '../shared/types.ts'

const WORKER = 'EX-1/Agent'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'core-card-withdraw-'))
  const source = new CoreSource({ home, port: 17887, socket: '/unused', session: 'test', binary: 'hc' })
  const machine = source.localMachineId()
  const space = (id: string, extra = {}) => source.store.set('space', id, { id, name: id, machine, folder: `/${id}`, base: 'main', prefix: id.toUpperCase(), mode: 'regular', added: 1, ...extra } as CoreSpace)
  const agent = (chat: string, place: string, role: CoreAgent['role']) => source.store.set('agent', chat, { chat, space: place, machine, role, kind: 'claude', launch: `${chat}-launch`, grant: `${chat}-grant`, hook: '/unused', state: 'idle', started: 1 } as CoreAgent)
  const task = (id: string, place: string, extra = {}) => {
    agent(`${id}/Agent`, place, 'task')
    source.store.set('task', id, { id, localId: id, chat: `${id}/Agent`, place, machine, name: id, folder: '/unused', repo: '/unused', base: 'main', workflow: 'working', review: { on: false }, age: 'now', created: new Date().toISOString(), kind: 'claude', ...extra })
  }
  source.agents.terminal = (() => ({ state: 'live', address: 't' })) as unknown as typeof source.agents.terminal
  space('space'); space('other'); space('overview', { home: true })
  agent('space', 'space', 'coordinator'); agent('other', 'other', 'coordinator'); agent('overview', 'overview', 'coordinator')
  task('EX-1', 'space'); task('EX-2', 'space'); task('OT-1', 'other')
  agent('EX-1/Reviewer', 'space', 'reviewer')
  const grant = (chat: string) => { const own = source.agents.get(chat)!; return { id: own.grant, chat, machine: own.machine, session: own.launch } as Grant }
  const card = async (chat: string, ...args: string[]) => (await new CoreCommands(source).cli(source.agents.get(chat)!, grant(chat), ['card', ...args]))!.out
  const cards = async (chat: string) => JSON.parse(await card(chat, 'list')) as { total: number; cards: { id: string; kind: string; title: string; age: string; chat: string; withdrawable?: boolean }[] }
  const ask = (chat: string, title = 'Rerun CI?', at?: number) => {
    const id = source.questions.create(grant(chat), ['ask', title, '--choice', 'Yes', '--choice', 'No'])
    if (at) source.store.set(`message:${chat}`, id, { ...source.store.get<Message>(`message:${chat}`, id)!, at })
    return id
  }
  const permission = (chat: string, tool: string, input: unknown) => {
    const id = randomUUID(), own = source.agents.get(chat)!
    const reply = source.requestPermission(own, grant(chat), { args: { id, tool, input, at: Date.now() }, expires: Date.now() + 60_000 } as unknown as MailRequest, id) as Promise<PermissionAnswer>
    return { id, reply: Promise.resolve(reply) }
  }
  const shown = (chat: string, id: string) => source.chat(chat)!.messages.find(message => message.id === id)
  const count = () => waiting(source.snapshot()).count
  const answers = () => source.store.all<{ id: string }>('pending-send').filter(item => item.id.startsWith('answer-'))
  const lines = () => source.store.all<{ id: string; chat: string; text: string }>('pending-send').filter(item => item.id.startsWith('card-withdrawn-'))
  return { source, machine, grant, card, cards, ask, permission, shown, count, answers, lines, close() { source.stop(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) } }
}

test('the list says id, title, age and chat, a coordinator across its own tasks and never another space', async () => {
  const f = fixture()
  try {
    expect((await f.cards(WORKER)).cards).toEqual([])
    const long = f.ask(WORKER, `Use my_dir and \`x*y\`\non two lines ${'word '.repeat(60)}`)
    const row = (await f.cards(WORKER)).cards[0]
    expect(row.title).toStartWith('Use my_dir and `x*y` on two lines word')
    expect(row.title).toEndWith('…')
    expect(row.title.length).toBe(120)
    await f.card(WORKER, 'withdraw', long, '--why', 'Settled')
    const old = f.ask(WORKER, 'Rerun CI?', Date.now() - 3 * 3600_000), own = f.ask('space', 'Which branch?'), sibling = f.ask('EX-2/Agent', 'Keep it?'), far = f.ask('OT-1/Agent', 'Not yours?'), top = f.ask('other', 'Theirs?')
    const listed = await f.cards('space')
    expect(listed.total).toBe(3)
    expect(listed.cards[0]).toEqual({ id: old, kind: 'Question', title: 'Rerun CI?', age: '3h', chat: WORKER })
    expect(listed.cards.map(card => card.id).sort()).toEqual([old, own, sibling].sort())
    expect((await f.cards(WORKER)).cards.map(card => card.id)).toEqual([old])
    expect((await f.cards('other')).cards.map(card => card.id).sort()).toEqual([far, top].sort())
    // A main home's overview reads every space's tasks. It withdraws none of them.
    expect((await f.cards('overview')).cards).toEqual([])
  } finally { f.close() }
})

test('only its own chat, or a coordinator of its own space: all else is refused and leaves the card open', async () => {
  const f = fixture()
  try {
    const task = f.ask(WORKER), sibling = f.ask('EX-2/Agent'), far = f.ask('OT-1/Agent')
    const withdraw = (chat: string, id: string) => f.card(chat, 'withdraw', id, '--why', 'Settled')
    await expect(withdraw('EX-2/Agent', task)).rejects.toThrow('not open within your reach')
    await expect(withdraw(WORKER, sibling)).rejects.toThrow('not open within your reach')
    await expect(withdraw('space', far)).rejects.toThrow('not open within your reach')
    await expect(withdraw('overview', task)).rejects.toThrow('not open within your reach')
    await expect(withdraw('overview', far)).rejects.toThrow('not open within your reach')
    await expect(withdraw('EX-1/Reviewer', task)).rejects.toThrow('reports findings')
    await expect(f.card('EX-1/Reviewer', 'list')).rejects.toThrow('reports findings')
    // An unknown id gets the same words: nothing here says what another space has open.
    await expect(withdraw('space', 'no-such-card')).rejects.toThrow('not open within your reach')
    await expect(withdraw('space', 'attention')).rejects.toThrow('not open within your reach')
    expect(f.source.questions.open().map(row => row.id).sort()).toEqual([task, sibling, far].sort())
  } finally { f.close() }
})

test('a reason is required and short, and other spellings are refused', async () => {
  const f = fixture()
  try {
    const id = f.ask(WORKER)
    await expect(f.card(WORKER, 'withdraw', id)).rejects.toThrow('Give a short reason')
    await expect(f.card(WORKER, 'withdraw', id, '--why', '   ')).rejects.toThrow('Give a short reason')
    await expect(f.card(WORKER, 'withdraw', id, '--why', 'x'.repeat(201))).rejects.toThrow('200')
    await expect(f.card(WORKER, 'withdraw', '--why', 'Settled')).rejects.toThrow('Use card list')
    await expect(f.card(WORKER, 'withdraw', id, 'extra', '--why', 'Settled')).rejects.toThrow('Use card list')
    await expect(f.card(WORKER, 'nothing')).rejects.toThrow('Use card list')
    expect(f.source.questions.open()).toHaveLength(1)
  } finally { f.close() }
})

test('its own agent withdraws a question: the number drops, it stays closed in both chats, and a late tap does nothing', async () => {
  const f = fixture()
  try {
    const id = f.ask(WORKER), before = f.count(), place = attentionCounts(f.source.snapshot(), ['space']).need
    expect(await f.card(WORKER, 'withdraw', id, '--why', 'Answered in chat')).toContain('Rerun CI?')
    expect(f.count()).toBe(before - 1)
    expect(attentionCounts(f.source.snapshot(), ['space']).need).toBe(place - 1)
    expect(f.source.snapshot().asks[WORKER]).toBeUndefined()
    expect(await f.cards(WORKER)).toEqual({ cards: [], total: 0 })
    expect(f.shown(WORKER, id)?.question).toMatchObject({ sent: -1, closed: 'Withdrawn: Answered in chat' })
    const row = f.source.chat('space')!.messages.find(message => message.card?.ask)!.card!
    expect(row.text).toBe('No longer waiting')
    expect(row.ask).toMatchObject({ open: false })
    expect(row.ask!.questions![0].closed).toBe('Withdrawn: Answered in chat')
    // From a stale screen, or a phone's button.
    await expect(f.source.act({ type: 'answer', chat: WORKER, question: id, choice: 0 })).rejects.toThrow('This card has closed: Withdrawn: Answered in chat')
    await expect(f.source.act({ type: 'answer', chat: WORKER, question: id, choice: 0, fromAlert: true } as Parameters<typeof f.source.act>[0])).rejects.toThrow('This card has closed')
    expect(f.answers()).toEqual([])
    // Its agent did this itself: no line comes back to it.
    expect(f.lines()).toEqual([])
    await expect(f.card(WORKER, 'withdraw', id, '--why', 'Again')).rejects.toThrow('not open within your reach')
  } finally { f.close() }
})

test('a withdrawn plan is not approved', async () => {
  const f = fixture()
  try {
    const id = f.source.questions.create(f.grant(WORKER), ['plan', '--title', 'Ship it', '--step', 'Build', '--step', 'Ship'])
    expect((await f.cards(WORKER)).cards[0]).toMatchObject({ id, kind: 'Plan', title: 'Ship it' })
    await f.card(WORKER, 'withdraw', id, '--why', 'No longer planned')
    expect(f.shown(WORKER, id)?.question).toMatchObject({ kind: 'Plan', sent: -1, closed: 'Withdrawn: No longer planned' })
    expect(f.answers()).toEqual([])
    await expect(f.source.act({ type: 'answer', chat: WORKER, question: id, choice: 0 })).rejects.toThrow('This card has closed')
    expect(f.answers()).toEqual([])
  } finally { f.close() }
})

test('a coordinator withdraws a task agent’s card: that agent is told why, and a Needs you from that card goes at once', async () => {
  const f = fixture()
  try {
    const sent: string[] = []
    f.source.core.current.connected = true
    f.source.agents.terminal = (() => ({ state: 'live', address: 't', status: { state: 'idle' } })) as unknown as typeof f.source.agents.terminal
    f.source.agents.send = async (_chat, text) => { sent.push(text) }
    f.source.health.room = () => undefined
    // Its turn ended on the card, so with no card at all it would still read as waiting on the human.
    f.source.logs.waiting = () => true
    const view = () => f.source.tasks.view(f.source.tasks.get('EX-1')!).status
    const id = f.ask(WORKER, 'A "quoted" <title>?')
    expect(view()).toBe('need')
    const before = f.count()
    const out = await f.card('space', 'withdraw', id, '--why', 'The <human> settled it.')
    expect(out).toContain(`Its agent in ${WORKER} is being told why`)
    expect(view()).toBe('todo')
    expect(f.count()).toBe(before - 1)
    expect(f.source.snapshot().needs.filter(need => need.chat === WORKER)).toEqual([])
    const [line] = f.lines()
    expect(line.chat).toBe(WORKER)
    expect(line.text).toStartWith('<shepherdr><card-withdrawn ')
    expect(line.text).toContain('by="coordinator"')
    expect(line.text).toContain('The \\u003chuman> settled it. Nothing was answered or approved. Don\'t wait for it')
    expect(line.text).toEndWith('</card-withdrawn></shepherdr>')
    expect(line.text).not.toContain('<title')
    await Bun.sleep(1)
    expect(sent).toEqual([line.text])
    // It wakes, says it has stopped and ends its turn: that brings the number back to nobody.
    const says = (id: string, who: 'agent' | 'you', text: string) => f.source.post(WORKER, { id, who, text, at: Date.now() + 1000 })
    says('stopping', 'agent', 'Understood, the "Rerun CI?" card is gone and `Keep it?` too, so I am stopping here.')
    expect(view()).toBe('todo')
    expect(f.count()).toBe(before - 1)
    // Its last words ask the human something: that is a real wait.
    says('asking', 'agent', 'Should I stop here instead?')
    expect(view()).toBe('need')
    f.source.store.delete(`message:${WORKER}`, 'asking')
    expect(view()).toBe('todo')
    // Any work since ends as any other turn does, however quick.
    f.source.store.set(`event:${WORKER}`, 'step-one', { kind: 'step', id: 'step-one', at: Date.now() + 1000, step: 'run', tool: 'Bash' })
    expect(view()).toBe('need')
    f.source.store.delete(`event:${WORKER}`, 'step-one')
    expect(view()).toBe('todo')
    // A secret asked for since, even one already answered, ends it too.
    f.source.post(WORKER, { id: 'later-secret', who: 'agent', secret: { id: 'later-secret', name: 'LATER_KEY', levels: [] }, at: Date.now() + 1500 })
    expect(view()).toBe('need')
    f.source.store.delete(`message:${WORKER}`, 'later-secret')
    expect(view()).toBe('todo')
    // A new card asks again.
    f.ask(WORKER, 'One more?', Date.now() + 2000)
    expect(view()).toBe('need')
    f.source.questions.open(WORKER).forEach(row => f.source.store.delete('question', row.id))
    f.source.store.all<Message>(`message:${WORKER}`).filter(message => message.question?.title === 'One more?').forEach(message => f.source.store.delete(`message:${WORKER}`, message.id))
    expect(view()).toBe('todo')
    // And so do the human's next words.
    says('human', 'you', 'Actually, one more thing')
    expect(view()).toBe('need')
  } finally { f.close() }
})

test('an agent that withdraws its own card and then ends its turn needs the human as after any turn', async () => {
  const f = fixture()
  try {
    f.source.core.current.connected = true
    f.source.agents.terminal = (() => ({ state: 'live', address: 't', status: { state: 'idle' } })) as unknown as typeof f.source.agents.terminal
    f.source.logs.waiting = () => true
    const out = await f.card(WORKER, 'withdraw', f.ask(WORKER), '--why', 'Answered in chat')
    // What keeps it off Needs you is its own todo, which the command reminds it of as it goes.
    expect(out).toContain('Run shepherdr todo EX-1, then end your turn')
    expect(f.source.tasks.get('EX-1')?.cardWithdrawnAt).toBeUndefined()
    expect(f.source.tasks.view(f.source.tasks.get('EX-1')!).status).toBe('need')
  } finally { f.close() }
})

test('with another card still open the task still needs the human, and keeps its alert', async () => {
  const f = fixture()
  try {
    f.source.core.current.connected = true
    f.source.agents.terminal = (() => ({ state: 'live', address: 't', status: { state: 'idle' } })) as unknown as typeof f.source.agents.terminal
    f.source.logs.waiting = () => true
    const first = f.ask(WORKER, 'First?', 100), second = f.ask(WORKER, 'Second?', 200)
    await f.card('space', 'withdraw', first, '--why', 'Settled')
    expect(f.source.tasks.view(f.source.tasks.get('EX-1')!).status).toBe('need')
    expect(waiting(f.source.snapshot()).tags).toContain('EX-1')
    expect(f.source.snapshot().needs.filter(need => need.chat === WORKER).map(need => need.id)).toEqual([second])
  } finally { f.close() }
})

test('an agent that isn’t running is not said to be told', async () => {
  const f = fixture()
  try {
    f.source.agents.terminal = (() => ({ state: 'finished' })) as unknown as typeof f.source.agents.terminal
    const out = await f.card('space', 'withdraw', f.ask(WORKER), '--why', 'Settled')
    expect(out).toContain("isn't running, so it was not told")
    expect(f.lines()).toEqual([])
    expect(f.source.tasks.get('EX-1')?.cardWithdrawnAt).toBeUndefined()
  } finally { f.close() }
})

test('a coordinator saying which card it withdrew, by its question, is not asking one', async () => {
  const f = fixture()
  try {
    f.source.core.current.connected = true
    f.source.agents.terminal = (() => ({ state: 'live', address: 't', status: { state: 'idle' } })) as unknown as typeof f.source.agents.terminal
    const id = f.ask('space', 'Which branch?')
    expect(await f.card('space', 'withdraw', id, '--why', 'Settled')).not.toContain('shepherdr todo')
    f.source.post('space', { id: 'said', who: 'agent', text: 'I withdrew the "Which branch?" card.', at: Date.now() + 1000 })
    expect(f.source.snapshot().needs).toEqual([])
    f.source.post('space', { id: 'also', who: 'agent', text: 'Gone: "Which branch?", and `Keep it?` too.', at: Date.now() + 1500 })
    expect(f.source.snapshot().needs).toEqual([])
    // A question that ends its words is one being asked, quoted or not.
    f.source.post('space', { id: 'quoted', who: 'agent', text: 'Should the title be "Which branch?"', at: Date.now() + 2000 })
    expect(f.source.snapshot().needs).toMatchObject([{ id: 'attention', chat: 'space' }])
    f.source.post('space', { id: 'asked', who: 'agent', text: 'Which branch next?', at: Date.now() + 3000 })
    expect(f.source.snapshot().needs).toMatchObject([{ id: 'attention', chat: 'space' }])
  } finally { f.close() }
})

test('a line that never lands leaves the task off Needs you, and says nothing about a browser', async () => {
  const f = fixture()
  try {
    f.source.core.current.connected = true
    f.source.agents.terminal = (() => ({ state: 'live', address: 't', status: { state: 'idle' } })) as unknown as typeof f.source.agents.terminal
    f.source.agents.send = async () => { throw new Error('unreachable') }
    f.source.health.room = () => undefined
    f.source.logs.waiting = () => true
    const id = f.ask(WORKER)
    await f.card('space', 'withdraw', id, '--why', 'Settled')
    await Bun.sleep(1)
    expect(f.source.tasks.view(f.source.tasks.get('EX-1')!).status).toBe('todo')
    expect(f.source.store.get<{ state: string }>('pending-send', `card-withdrawn-${id}`)?.state).toBe('uncertain')
    expect(f.source.chat(WORKER)!.messages.some(message => message.text?.includes('Browser handoff'))).toBe(false)
  } finally { f.close() }
})

test('a withdrawn merge card merges nothing, and the task stays Ready until a fresh report asks again', async () => {
  const f = fixture(), head = 'a'.repeat(40)
  try {
    const task = f.source.tasks.get('EX-1')!, q: Question = { id: 'merge-one', title: 'Merge EX-1?', kind: 'Question', choices: [{ label: 'Merge' }, { label: 'Not yet' }], to: WORKER }
    Object.assign(task, { workflow: 'ready', readyHead: head, mergePolicy: 'ask', mergeQuestion: q.id })
    f.source.store.set('task', task.id, task); f.source.store.set('merge-question', q.id, { task: task.id, head })
    f.source.post(WORKER, { id: q.id, who: 'agent', question: q, at: 100 })
    f.source.tasks.git.head = async () => head
    expect((await f.cards('space')).cards.find(card => card.id === q.id)?.kind).toBe('Merge')
    const before = f.count()
    await f.card('space', 'withdraw', q.id, '--why', 'Holding this for now')
    expect(f.count()).toBe(before - 1)
    const after = f.source.tasks.get('EX-1')!
    expect(after.mergeQuestion).toBeUndefined()
    expect(after.approvedHead).toBeUndefined()
    expect(after.workflow).toBe('ready')
    expect(f.source.tasks.view(after).status).toBe('ready')
    expect(f.shown(WORKER, q.id)?.question).toMatchObject({ sent: -1, closed: 'Withdrawn: Holding this for now' })
    // A late Merge tap: refused, nothing approved, and merge itself still needs a yes.
    await expect(f.source.act({ type: 'answer', chat: WORKER, question: q.id, choice: 0 })).rejects.toThrow('This card has closed')
    expect(f.source.tasks.get('EX-1')!.approvedHead).toBeUndefined()
    await expect(f.source.tasks.merge(f.grant(WORKER), 'EX-1')).rejects.toThrow('must approve')
    expect(f.lines()[0].text).toContain('Nothing was merged or approved')
    expect(f.answers()).toEqual([])
  } finally { f.close() }
})

test('a withdrawn permission prompt ends as denied, says why, and stays denied when asked again', async () => {
  const f = fixture()
  try {
    const asked = f.permission(WORKER, 'Bash', { command: 'rm -rf build' })
    expect((await f.cards('space')).cards[0]).toMatchObject({ id: asked.id, kind: 'Permission', title: 'Run: rm -rf build', chat: WORKER })
    expect(f.source.snapshot().needs.some(need => need.id === asked.id)).toBe(true)
    await f.card('space', 'withdraw', asked.id, '--why', 'Not needed now')
    const reply = await asked.reply
    expect(reply.allow).toBe(false)
    // Without its own words the hook would tell the agent the human declined it. Nobody did.
    expect(reply.message).toContain('Withdrawn: Not needed now')
    expect(reply.message).toContain('Nothing was approved')
    expect(f.source.snapshot().needs.some(need => need.id === asked.id)).toBe(false)
    expect(f.source.store.get<{ allow: boolean; settled: boolean }>('permission', asked.id)).toMatchObject({ allow: false, settled: true })
    expect(f.source.store.get<CoreAgent>('agent', WORKER)?.permission).toBeUndefined()
    expect(f.shown(WORKER, `permission-${asked.id}`)?.question?.closed).toBe('Withdrawn: Not needed now')
    await expect(f.source.act({ type: 'answer', chat: WORKER, question: asked.id, choice: 0 })).rejects.toThrow('This card has closed: Withdrawn: Not needed now')
    expect(f.source.store.get<{ allow: boolean }>('permission', asked.id)?.allow).toBe(false)
    // The same call again, after a dropped reply, gets the same no.
    const again = await f.source.requestPermission(f.source.agents.get(WORKER)!, f.grant(WORKER), { args: { id: asked.id }, expires: Date.now() + 60_000 } as unknown as MailRequest, asked.id)
    expect(again).toMatchObject({ allow: false })
    expect(f.lines()[0].text).toContain('It ended as denied')
  } finally { f.close() }
})

test('Claude’s own plan and question cards end as denied: no plan approved and nothing chosen, even part way through a form', async () => {
  const f = fixture()
  try {
    const plan = f.permission(WORKER, 'ExitPlanMode', { plan: '# Ship it' })
    expect((await f.cards(WORKER)).cards[0]).toMatchObject({ id: plan.id, kind: 'Plan' })
    await f.card(WORKER, 'withdraw', plan.id, '--why', 'Not this plan')
    const planned = await plan.reply
    expect(planned.allow).toBe(false)
    expect(planned.updatedPermissions).toBeUndefined()
    expect(planned.message).toContain('Nothing was approved or chosen')

    const form = f.permission(WORKER, 'AskUserQuestion', { questions: [
      { question: 'Which fruit?', options: [{ label: 'Pear' }, { label: 'Plum' }] },
      { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    ] })
    const second = `${form.id}-1`
    expect((await f.cards(WORKER)).cards.map(card => [card.id, card.kind])).toEqual([[form.id, 'Question'], [second, 'Question']])
    await f.source.act({ type: 'answer', chat: WORKER, question: form.id, choice: 0 })
    await f.card(WORKER, 'withdraw', second, '--why', 'Answered in chat')
    const formed = await form.reply
    expect(formed.allow).toBe(false)
    expect(formed.updatedInput).toBeUndefined()
    expect(await f.cards(WORKER)).toEqual({ cards: [], total: 0 })
    // A form goes whole, and the command says so.
    const whole = f.permission(WORKER, 'AskUserQuestion', { questions: [
      { question: 'Which fruit?', options: [{ label: 'Pear' }, { label: 'Plum' }] },
      { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    ] })
    expect(await f.card(WORKER, 'withdraw', whole.id, '--why', 'Settled')).toContain('the rest of its form, 2 cards in all')
    expect((await whole.reply).allow).toBe(false)
  } finally { f.close() }
})

test('a withdrawn secret request saves nothing, keeps its closed card, and a late save from a stale box is refused', async () => {
  const f = fixture()
  try {
    const own = f.source.agents.get(WORKER)!
    await f.source.secrets.cli(own, ['secret', 'ask', 'DEMO_KEY', '--why', 'To deploy'])
    const id = f.source.secrets.open(WORKER)[0].id, before = f.count()
    expect((await f.cards('space')).cards[0]).toMatchObject({ id, kind: 'Secret', title: 'Secret: DEMO_KEY', chat: WORKER })
    await f.card('space', 'withdraw', id, '--why', 'Deploy is off')
    expect(f.count()).toBe(before - 1)
    expect(f.source.secrets.open(WORKER)).toEqual([])
    const message = f.shown(WORKER, id)
    expect(message?.secret).toMatchObject({ name: 'DEMO_KEY', closed: 'Withdrawn: Deploy is off' })
    expect(message?.secret?.saved).toBeUndefined()
    await expect(f.source.secrets.act({ type: 'secret', level: 'all', name: 'DEMO_KEY', value: 'synthetic-value', card: { chat: WORKER, id } })).rejects.toThrow('nothing was saved: Withdrawn: Deploy is off')
    expect(f.source.secrets.vault.visible(['all']).map(item => item.name)).not.toContain('DEMO_KEY')
    expect(f.lines()[0].text).toContain('No secret was saved')
    expect(f.source.store.all<{ id: string }>('pending-send').some(item => item.id.startsWith('secret-saved-'))).toBe(false)
  } finally { f.close() }
})

test('a CLI’s own screen is listed but left out: it can’t be made safe, for the agent stays stopped there', async () => {
  const f = fixture()
  try {
    f.source.agents.terminal = (() => ({ state: 'live', address: 't', status: { state: 'blocked' } })) as unknown as typeof f.source.agents.terminal
    const own = f.source.agents.get(WORKER)!
    f.source.store.set('agent', WORKER, { ...own, state: 'starting' })
    const question: Question = { id: 'screen-one', title: 'Claude Code is waiting on its screen', kind: 'Question', terminal: true, press: true, choices: [{ label: 'Yes' }], noNote: true, to: 'Claude Code' }
    f.source.store.set('screen-card', question.id, { id: question.id, chat: WORKER, launch: own.launch, screen: 's', all: 's', question, state: 'open', at: Date.now() })
    expect((await f.cards('space')).cards[0]).toMatchObject({ id: question.id, kind: 'Screen', withdrawable: false })
    await expect(f.card('space', 'withdraw', question.id, '--why', 'Settled')).rejects.toThrow('cannot be withdrawn')
    expect(f.source.screens.open(WORKER)).toHaveLength(1)
    expect(f.lines()).toEqual([])
  } finally { f.close() }
})

test('the phone’s alert goes with its card and takes the new count, unless a newer card is what it shows', async () => {
  const f = fixture()
  try {
    const alerts: Alert[] = []
    f.source.on('alert', alert => alerts.push(alert as Alert))
    const clears = () => alerts.filter(alert => alert.clear)
    const older = f.ask(WORKER, 'Older?', 100), newer = f.ask(WORKER, 'Newer?', 200)
    await f.card(WORKER, 'withdraw', older, '--why', 'Settled')
    // The newer card's alert stays: this push closes only its own tag, and still brings the new count.
    expect(clears()).toHaveLength(1)
    expect(clears()[0].tag).toBe(older)
    expect(pushPayload(clears()[0], waiting(f.source.snapshot())).badge).toBe(1)
    await f.card(WORKER, 'withdraw', newer, '--why', 'Settled too')
    expect(clears()).toHaveLength(2)
    const payload = pushPayload(clears()[1], waiting(f.source.snapshot()))
    expect(payload).toMatchObject({ clear: true, tag: 'EX-1', badge: 0 })
    expect(payload.open).not.toContain('EX-1')
    // A coordinator's own card goes by its own tag.
    alerts.length = 0
    await f.card('space', 'withdraw', f.ask('space', 'Mine?'), '--why', 'Settled')
    expect(clears()[0]).toMatchObject({ tag: 'ask:space' })
  } finally { f.close() }
})

test('a secret’s alert is tagged like any card’s, so a phone drops it once the card closes', async () => {
  const f = fixture()
  try {
    const alerts: Alert[] = []
    f.source.on('alert', alert => alerts.push(alert as Alert))
    await f.source.secrets.cli(f.source.agents.get(WORKER)!, ['secret', 'ask', 'DEMO_KEY', '--why', 'To deploy'])
    await f.source.secrets.cli(f.source.agents.get('space')!, ['secret', 'ask', 'OTHER_KEY', '--why', 'To deploy'])
    // A coordinator's chat also gets its plain new-message alert, which Notify decides on.
    expect(alerts.filter(alert => !alert.message).map(alert => alert.tag)).toEqual(['EX-1', 'ask:space'])
    expect(pushPayload(alerts[0], { count: 1, tags: ['EX-1'] }).waits).toBe(true)
  } finally { f.close() }
})

test('help lists it', async () => {
  const f = fixture()
  try {
    f.source.agents.terminal = (() => ({ state: 'live', address: 't' })) as unknown as typeof f.source.agents.terminal
    const help = await f.source['mail'](f.grant(WORKER), { action: 'cli', args: { args: ['help'] } } as unknown as MailRequest, 'help') as { out: string }
    expect(help.out).toContain('card list | card withdraw ID --why REASON')
  } finally { f.close() }
})
