import type { CoreSource } from './source.ts'
import type { CoreAgent } from './model.ts'

interface Approved { chat: string; launch: string; words: string; until: number }
const WINDOW = 60_000

/** What Antigravity's own prompt will name for this tool call: the start of its first line, which its status keeps. */
export function agyPromptWords(input: unknown) {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const raw = ['CommandLine', 'Path', 'AbsolutePath', 'TargetFile', 'Url'].map(key => args[key]).find(value => typeof value === 'string') as string | undefined
  return raw?.split('\n')[0].trim().slice(0, 40) ?? ''
}

/**
 * Antigravity asks on its own screen for whatever leaves its sandbox, whatever its hook answered. The human has already
 * decided on a card by then, so this answers that one prompt with its first choice (once, nothing remembered). It goes
 * by the prompt it reports in its own status, never by reading its screen, and only if that prompt names what was approved.
 */
export class CoreAgyApprovals {
  constructor(private source: CoreSource) {}
  approved(agent: CoreAgent, input: unknown, now = Date.now()) {
    const words = agyPromptWords(input)
    if (agent.kind !== 'agy' || !words) return
    this.source.store.set('agy-approved', agent.chat, { chat: agent.chat, launch: agent.launch, words, until: now + WINDOW } satisfies Approved)
  }
  async tick(now = Date.now()) {
    for (const row of this.source.store.all<Approved>('agy-approved')) {
      const agent = this.source.agents.get(row.chat), terminal = agent?.launch === row.launch ? this.source.agents.terminal(agent) : undefined
      if (!agent || !terminal || terminal.state !== 'live' || now > row.until) { this.source.store.delete('agy-approved', row.chat); continue }
      const status = terminal.status
      if (status?.state !== 'blocked' || status.kind !== 'permission' || !status.msg?.includes(row.words)) continue
      this.source.store.delete('agy-approved', row.chat)
      await this.source.core.call('terminal.keys', { terminal: terminal.address, keys: ['enter'] })
    }
  }
}
