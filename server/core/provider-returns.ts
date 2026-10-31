import type { CoreSource } from './source.ts'
import type { CoreAgent } from './model.ts'
import type { CoreTask } from './tasks.ts'

const FIRST = 5 * 60_000, MOST = 60 * 60_000, START = 3 * 60_000

interface ProviderReturn { task: string; at: number; next: number; wait: number; login?: string; stalled?: boolean }
/**
 * Hands a task back from Antigravity once the agent it took over from can go on: at the end of a turn, in the same
 * worktree and branch. Only a task on Antigravity is ever looked at. Its check is one tiny request to the other CLI, made
 * only when the task could go back right then, less and less often, or as soon as that CLI's login changes. Runs for
 * as long as the takeover does, including once Antigravity has run out too, which is when it matters most.
 */
export class CoreProviderReturns {
  private running = false
  constructor(private source: CoreSource) {}
  private safe(task: CoreTask, agent: CoreAgent, row: ProviderReturn) {
    // A Ready task goes back too, or the human's next message would spend Gemini with Claude available. A full machine
    // would turn its restart into Queued, so that waits.
    const room = task.workflow === 'working' || task.workflow === 'ready' && !this.source.health?.room(task.machine, task.id)
    return room && !task.archived && !this.source.tasks.busy(task.id) &&
      !this.source.openPermissions(agent).length && !this.source.questions.open(agent.chat).length && !this.source.secrets.open(agent.chat).length &&
      (row.stalled || this.source.logs.providerTurn(agent).complete || this.source.agents.terminal(agent)?.state === 'finished')
  }
  async tick(now = Date.now()) {
    if (this.running || this.source.quiescing || !this.source.connected()) return
    this.running = true
    let failure: unknown
    try {
      for (const task of this.source.tasks.all()) {
        const takeover = task.providerTakeover, agent = takeover && this.source.agents.get(task.chat)
        if (!takeover || !agent || takeover.to !== 'agy' || takeover.state !== 'started' || agent.kind !== 'agy' || task.pilot || task.archived || ['merged', 'closed'].includes(task.workflow) || !this.source.machineConnected(agent.machine)) continue
        const key = `${task.id}:${takeover.at}`, login = await this.source.providerLogin.mark(agent.machine, takeover.from, now)
        const row = this.source.store.get<ProviderReturn>('provider-return', key) ?? { task: task.id, at: takeover.at, next: takeover.at + FIRST, wait: FIRST, login }
        if (login && login !== row.login) { row.login = login; row.next = now }
        try {
          // It never said it started: a login screen or a crash, with nothing in the chat to show for it.
          if (agent.state === 'starting' && now - agent.started > START && !row.stalled) { row.stalled = true; await this.source.tasks.providerStalled(task.id, agent.launch, true) }
          else if (row.stalled && agent.state !== 'starting') { row.stalled = false; await this.source.tasks.providerStalled(task.id, agent.launch, false) }
          if (now >= row.next && this.safe(task, agent, row)) {
            const model = takeover.back?.model ?? this.source.settings.catalog(takeover.from, task.place).default
            if (await this.source.providerLogin.available(agent.machine, takeover.from, model)) {
              // That took a while: a message may have started a new turn meanwhile, and the next tick asks again.
              const latest = this.source.tasks.get(task.id), running = this.source.agents.get(task.chat)
              if (latest && running?.launch === agent.launch && this.safe(latest, running, row)) await this.source.tasks.providerReturn(task.id, agent.launch)
            } else { row.wait = Math.min(row.wait * 2, MOST); row.next = now + row.wait }
          }
        } catch (error) { failure = error; row.wait = Math.min(row.wait * 2, MOST); row.next = now + row.wait } // One task's trouble keeps no other from going back.
        this.source.store.set('provider-return', key, row)
      }
    } finally { this.running = false }
    if (failure) throw failure
  }
}
