// Antigravity CLI's transcript: one JSON line per step, each numbered within its conversation. Tool results follow the
// planner step that asked for them, in the order it asked, with no id of their own.
import { words } from '../../../shared/activity.ts'
import { baseName, commandSay, short, type Said } from './steps.ts'
import type { LogEvent, Reader } from './types.ts'

type Json = any

/** Its timestamps are whole seconds: the step number keeps a second's events in order, as later code sorts by time. */
const timeOf = (line: Json) => (Date.parse(line.created_at ?? '') || 0) + (Number.isInteger(line.step_index) ? line.step_index % 1000 : 0)
/** Arguments are logged as JSON inside JSON. */
const value = (raw: unknown) => {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return raw }
}
/** What the human typed, without the metadata Antigravity puts around it. */
export function agyUserText(content: unknown) {
  if (typeof content !== 'string') return ''
  const open = '<USER_REQUEST>\n', close = '\n</USER_REQUEST>'
  const start = content.indexOf(open), end = content.lastIndexOf(close)
  return start === 0 && end >= 0 ? content.slice(open.length, end) : content
}

/** Its words for an allowance that is gone, said here so no other CLI's errors read differently. Limits per minute it
 *  has already retried itself pass by themselves too, so those stay as they are. */
export const agyErrorCode = (text: string) => /resource.?exhausted|exhausted your|quota/i.test(text) && !/per.?minute|rate.?limit/i.test(text) ? 'usage_limit_exceeded' : undefined

function agyStep(name: string, args: Json): Said {
  const path = String(value(args?.Path) ?? value(args?.AbsolutePath) ?? value(args?.TargetFile) ?? value(args?.File) ?? '')
  const file = path ? baseName(path) : ''
  switch (name) {
    case 'run_command': return commandSay(String(value(args?.CommandLine) ?? ''))
    case 'read_file': case 'view_file': return { step: 'read', ...words(file ? `Read ${file}` : 'Read a file', file, { detail: path }) }
    case 'write_file': case 'write_to_file': case 'edit_file': case 'replace_file_content': case 'multi_replace_file_content':
      return { step: 'edit', ...words(file ? `Edit ${file}` : 'Edit a file', file, { detail: path }) }
    case 'grep_search': case 'find_by_name': case 'list_dir':
      return { step: 'search', ...words(name === 'grep_search' ? 'Search the code' : name === 'list_dir' ? 'List files' : 'Look for files') }
    case 'read_url': case 'read_url_content': case 'search_web': case 'execute_url':
      return { step: 'web', ...words(name === 'search_web' ? `Search the web${args?.query ? ` for ${short(value(args.query), 60)}` : ''}` : 'Open a page') }
    default: return { step: 'other', ...words(`Use ${name || 'a tool'}`) }
  }
}

interface FileState { session: boolean; open: string[] }

export class AgyReader implements Reader {
  cli = 'agy'
  private files = new Map<string, FileState>()
  reset(file: string) { this.files.delete(file) }
  /** .../brain/<conversation>/.system_generated/logs/transcript_full.jsonl: step numbers repeat between conversations. */
  private conversation(file: string) { return /\/brain\/([^/]+)\//.exec(file)?.[1] ?? baseName(file) }
  parse(lines: { text: string; offset: number }[], file: string): LogEvent[] {
    const conversation = this.conversation(file)
    let state = this.files.get(file)
    if (!state) { state = { session: false, open: [] }; this.files.set(file, state) }
    const out: LogEvent[] = []
    for (const { text, offset } of lines) {
      let line: Json
      try { line = JSON.parse(text) } catch { continue }
      if (!line || typeof line !== 'object' || typeof line.type !== 'string') continue
      const at = timeOf(line), id = `agy-${conversation}-${line.step_index ?? `o${offset}`}`
      if (!state.session) { state.session = true; out.push({ kind: 'session', id: `session-${conversation}`, at, sessionId: conversation, file }) }
      const stopped = typeof line.error === 'string' && line.error
      if (line.type === 'USER_INPUT') {
        if (line.source !== 'USER_EXPLICIT') continue
        out.push({ kind: 'turn-start', id: `${id}-turn`, at }, { kind: 'user', id, at, text: agyUserText(line.content) })
      } else if (line.type === 'ERROR_MESSAGE' || line.type === 'PLANNER_RESPONSE' && line.status === 'ERROR') {
        out.push({ kind: 'error', id, at, text: stopped || 'Provider error', code: agyErrorCode(stopped || '') }, { kind: 'turn-end', id: `${id}-end`, at })
      } else if (line.type === 'PLANNER_RESPONSE') {
        if (line.status !== 'DONE') continue
        const tokens = [line.input_tokens, line.cache_read_tokens, line.output_tokens].reduce((sum: number, part: unknown) => sum + (Number.isSafeInteger(part) ? part as number : 0), 0)
        if (tokens) out.push({ kind: 'usage', id: `${id}-usage`, at, tokens })
        if (typeof line.content === 'string' && line.content.trim()) out.push({ kind: 'agent', id, at, text: line.content })
        const calls: Json[] = Array.isArray(line.tool_calls) ? line.tool_calls : []
        calls.forEach((call, index) => {
          const name = String(call?.name ?? ''), stepId = `${id}-${index}`
          const { step, ...said } = agyStep(name, call?.args)
          out.push({ kind: 'step', id: stepId, at, step, tool: name, ...said })
          state!.open.push(stepId)
        })
        if (!calls.length) out.push({ kind: 'turn-end', id: `${id}-end`, at })
      } else if (state.open.length && (line.status === 'DONE' || line.status === 'ERROR')) {
        out.push({ kind: 'step-end', id: state.open.shift()!, at, failed: line.status === 'ERROR' || undefined, out: { file, offset } })
      }
    }
    return out
  }
}
