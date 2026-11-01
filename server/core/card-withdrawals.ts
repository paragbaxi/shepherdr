import { askTag, WITHDRAWN } from '../../shared/alerts.ts'
import type { Need } from '../../shared/types.ts'
import { age } from '../common/age.ts'
import { tag } from '../common/chatlines.ts'
import { Refusal } from './client.ts'
import type { CoreAgent } from './model.ts'
import type { CoreSource } from './source.ts'

const WHY_MAX = 200
const TITLE_SHOWN = 120
const LISTED = 200

type CardKind = 'Question' | 'Plan' | 'Permission' | 'Secret' | 'Merge' | 'Screen'

/** What each kind leaves behind: a withdrawal only ever leaves the thing undone. */
const ENDED: Partial<Record<CardKind, string>> = {
  Permission: 'It ended as denied: nothing was allowed.',
  Secret: 'No secret was saved.',
}
/** A merge is no question to carry on from: a ready report right away would only put the card straight back. */
const MERGE_ENDED = 'Nothing was merged or approved. Report ready again only when the human wants it merged: that asks them again.'

const plain = (words: string) => words.replaceAll('<', '\\u003c')
/** On one line and cut, its words as they are: `clip` drops markdown, and with it a name's underscores. */
const shown = (words: string) => { const line = words.replace(/\s+/g, ' ').trim(); return line.length > TITLE_SHOWN ? `${line.slice(0, TITLE_SHOWN - 1)}…` : line }

/**
 * An agent closing a card that no longer matters, so it stops counting. Every open card it can reach is one of
 * the needs the number counts, so the list and the number can't disagree. Contained agents never get here: the run's
 * policy offers them no card command.
 */
export class CoreCardWithdrawals {
  constructor(private source: CoreSource) {}
  /** Its own chat; a coordinator also its own space's tasks, and no further: not even a home space's overview. */
  private reaches(agent: CoreAgent, chat: string) {
    if (chat === agent.chat) return true
    const task = this.source.tasks.forChat(chat)
    return agent.role === 'coordinator' && !!task && task.place === agent.space && task.machine === agent.machine
  }
  private open(agent: CoreAgent) {
    return this.source.snapshot().needs.filter(need => need.id !== 'attention' && this.reaches(agent, need.chat))
  }
  private kind(need: Need): CardKind {
    if (need.secret) return 'Secret'
    if (this.source.store.get('screen-card', need.id)) return 'Screen'
    if (this.source.store.get('merge-question', need.id)) return 'Merge'
    const permission = this.source.store.get<{ native?: unknown }>('permission', need.id)
    if (permission && !permission.native) return 'Permission'
    return need.question?.kind === 'Plan' ? 'Plan' : 'Question'
  }
  private title(need: Need) { return shown(need.question?.title ?? `Secret: ${need.secret?.name}`) }
  list(agent: CoreAgent) {
    const open = this.open(agent)
    return {
      cards: open.slice(-LISTED).map(need => {
        const kind = this.kind(need)
        return { id: need.id, kind, title: this.title(need), age: need.at ? age(need.at) : 'unknown', chat: need.chat, ...(kind === 'Screen' ? { withdrawable: false } : {}) }
      }),
      total: open.length,
    }
  }
  async withdraw(agent: CoreAgent, id: string, why: string) {
    const reason = why.replace(/\s+/g, ' ').trim()
    if (!reason) throw new Refusal('Give a short reason: card withdraw ID --why "short reason"')
    if (reason.length > WHY_MAX) throw new Refusal(`Keep the reason to ${WHY_MAX} characters`)
    // One answer for closed, unknown and out of reach: this says nothing about another space's cards.
    const need = this.open(agent).find(item => item.id === id)
    if (!need) throw new Refusal('That card is not open within your reach. shepherdr card list shows the ones you can withdraw.')
    const kind = this.kind(need), closed = `${WITHDRAWN}${reason}`, title = this.title(need)
    // A CLI's own screen keeps its agent stuck whatever the card says, and the next look puts the card straight back.
    if (kind === 'Screen') throw new Refusal('This card is its CLI’s own screen: the agent stays stopped there until it is answered, so it cannot be withdrawn. Answer it in the Terminal, or stop or restart the agent.')
    if (kind === 'Merge') await this.source.tasks.withdrawMerge(id, closed)
    // Only a running agent can hear it, and only one that was waiting for it can have nothing left to do.
    const other = need.chat !== agent.chat, owner = this.source.agents.get(need.chat), told = other && !!owner && this.source.agents.terminal(owner)?.state === 'live'
    if (told) this.source.tasks.noteWithdrawn(need.chat)
    if (told) this.source.saveAndDeliver(need.chat, `card-withdrawn-${id}`, `<shepherdr>${tag('card-withdrawn', { card: plain(title), by: 'coordinator' }, `${plain(reason).replace(/\.$/, '')}. ${kind === 'Merge' ? MERGE_ENDED : `${ENDED[kind] ?? 'Nothing was answered or approved.'} Don't wait for it: carry on without it, and ask again only if you still need it.`}`)}</shepherdr>`, () => {}, true)
    let closing = 1
    if (kind === 'Secret') this.source.secrets.withdraw(id, closed)
    else if (kind !== 'Merge') {
      closing = this.source.withdrawPermission(id, closed)
      if (!closing) { this.source.questions.withdraw(id, closed); closing = 1 }
    }
    // The phone's alert shows the chat's newest card, so a newer one still open keeps its alert. A prompt's alert has its chat's tag, already cleared as it closed, and another card's may share the task's. Under this card's own tag the push closes nothing else and still brings the new count.
    const newer = this.source.snapshot().needs.some(item => item.chat === need.chat && item.id !== 'attention' && item.at > need.at)
    this.source.clearAlert(need.chat, closed, newer || this.source.store.get('permission', id) ? id : need.task ?? askTag(need.place))
    this.source.emit('snapshot')
    const form = closing > 1 ? ` and the rest of its form, ${closing} cards in all` : ''
    // Said here, where it's read just before the turn ends: a turn that just ends puts the task back on Needs you.
    const next = other ? '' : kind === 'Merge' ? `\n${MERGE_ENDED}` : agent.role === 'task' && this.source.tasks.forChat(need.chat)?.workflow === 'working' ? `\nNothing left to do in this task? Run shepherdr todo ${need.task}, then end your turn: a turn that just ends shows Needs you.` : ''
    return `Withdrew ${kind.toLowerCase()} card: ${title}${form}${next}${!other ? '' : told ? `\nIts agent in ${need.chat} is being told why.` : `\nIts agent in ${need.chat} isn't running, so it was not told.`}`
  }
}
