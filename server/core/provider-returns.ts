import type { CoreSource } from './source.ts'
import type { CoreAgent } from './model.ts'
import type { CoreTask } from './tasks.ts'

const FIRST = 5 * 60_000, MOST = 60 * 60_000, START = 3 * 60_000

interface ProviderReturn { task: string; at: number; next: number; wait: number; login?: string; ready?: number; quiet?: boolean }
/**
 * Hands a task back from Antigravity once the agent it took over from can go on: at the end of a turn, in the same
 * worktree and branch. Only a task on Antigravity is ever looked at; the check itself is one tiny request to the other
 * CLI, less and less often, or at once when its login changes. Runs for as long as the takeover does, including once
 * Antigravity has run out too, which is when it matters most.
 */
export class CoreProviderReturns {
  private running = false
  constructor(private source: CoreSource) {}
  private safe(task: CoreTask, agent: CoreAgent) {
    return task.workflow === 'working' && !task.archived && !this.source.tasks.busy(task.id) && this.source.machineConnected(agent.machine) &&
      !this.source.openPermissions(agent).length && !this.source.questions.open(agent.chat).length && !this.source.secrets.open(agent.chat).length &&
      (this.source.logs.providerTurn(agent).complete || this.source.agents.terminal(agent)?.state === 'finished')
  }
  async tick(now = Date.now()) {
    if (this.running || this.source.quiescing || !this.source.connected()) return
    this.running = true
    try {
      for (const task of this.source.tasks.all()) {
        const takeover = task.providerTakeover, agent = takeover && this.source.agents.get(task.chat)
        if (!takeover || !agent || takeover.to !== 'agy' || takeover.state !== 'started' || agent.kind !== 'agy' || task.pilot || task.archived || ['merged', 'closed'].includes(task.workflow) || !this.source.machineConnected(agent.machine)) continue
        const key = `${task.id}:${takeover.at}`
        let row = this.source.store.get<ProviderReturn>('provider-return', key)
        if (!row) row = { task: task.id, at: takeover.at, next: now + FIRST, wait: FIRST, login: await this.source.providerLogin.mark(agent.machine, takeover.from) }
        // It never said it started: a login screen or a crash, with nothing in the chat to show for it.
        if (agent.state === 'starting' && now - agent.started > START && !row.quiet) {
          row.quiet = true
          await this.source.tasks.providerStalled(task.id, agent.launch)
        }
        if (!row.ready) {
          const login = await this.source.providerLogin.mark(agent.machine, takeover.from)
          if (login && login !== row.login) { row.login = login; row.next = now }
          if (now >= row.next) {
            if (await this.source.providerLogin.available(agent.machine, takeover.from)) row.ready = now
            else { row.wait = Math.min(row.wait * 2, MOST); row.next = now + row.wait }
          }
        }
        this.source.store.set('provider-return', key, row)
        if (row.ready && this.safe(task, agent)) await this.source.tasks.providerReturn(task.id, agent.launch)
      }
    } finally { this.running = false }
  }
}
