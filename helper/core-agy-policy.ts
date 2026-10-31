// What happens to one Antigravity tool call in a task's session. Pure, so it can be tested without a CLI.
// `pass` lets through what its terminal sandbox already holds (ordinary commands) or what stays in its workspace. Anything
// that would make it prompt on a screen the human never sees becomes a card in the chat instead: never an auto-approval.
import { isAbsolute, relative, resolve } from 'node:path'

export type AgyCheck =
  | { action: 'pass' }
  | { action: 'allow'; overwrite?: Record<string, unknown> }
  | { action: 'deny'; reason: string }
  | { action: 'ask' }

/** Tools that read the workspace or manage the agent's own session. */
const WORKSPACE_TOOLS = new Set(['read_file', 'view_file', 'list_dir', 'grep_search', 'find_by_name', 'write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content'])
const OWN_TOOLS = new Set(['command_status', 'send_command_input', 'manage_task', 'task_boundary', 'notify_user'])
/** Spends allowance out of sight, or asks where the chat can't answer. */
const REFUSED: Record<string, string> = {
  invoke_subagent: 'A backup agent works alone, to spend little. Do this yourself.',
  browser_subagent: 'A backup agent works alone, to spend little. Do this yourself.',
  ask_question: 'The human only reads the chat. Ask with: shepherdr ask "..." --choice "..." and end your turn.',
}
/** Its own product commands: each is already checked against this launch's credential. Not `start`, `stop` or `secret run`. */
const OWN_COMMANDS = new Set(['ask', 'plan', 'ready', 'pr', 'checks', 'merge', 'review', 'todo', 'artifact', 'show', 'help', 'alert', 'models'])

/** The transcript format double-encodes string arguments; hooks may or may not. */
const text = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  if (!value.startsWith('"')) return value
  try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : value } catch { return value }
}

/** The words of one plain command, or nothing where a shell would do more than run it. */
export function plainWords(line: string): string[] | undefined {
  const words: string[] = []
  let word = '', open = false, quote = ''
  for (let index = 0; index < line.length; index++) {
    const c = line[index]
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue }
    if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '$' || c === '`') return undefined
      else if (c === '\\' && index + 1 < line.length) word += line[++index]
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; open = true; continue }
    if (c === ' ' || c === '\t') { if (open) { words.push(word); word = ''; open = false } continue }
    if (c === '\\' && index + 1 < line.length && line[index + 1] !== '\n') { word += line[++index]; open = true; continue }
    if (';|&<>$`()\n\r#*?~{}[]!='.includes(c)) return undefined
    word += c; open = true
  }
  if (quote) return undefined
  if (open) words.push(word)
  return words
}

function ownCommand(line: string, command: string) {
  const words = plainWords(line)
  if (!words?.length || (words[0] !== command && words[0] !== 'shepherdr')) return false
  const rest = words[1] === 'agent' ? words.slice(2) : words.slice(1)
  const sub = rest[0]
  if (sub === 'status') return rest.length > 1 // Bare `status` is the human's lifecycle command.
  if (sub === 'secret') return ['list', 'ask'].includes(rest[1] ?? '')
  return !!sub && OWN_COMMANDS.has(sub)
}

const WORD = '[^;&|`$<>()\\n]'
/** What this session may do without a prompt, on top of its sandbox and only for this session: its own plain product
 *  commands, and git's own folder so it can commit from a linked worktree, but not git's hooks or config, which run
 *  outside the sandbox later, nor the folder holding this launch's own hooks and settings. */
export function agySessionSettings(input: { worktree: string; workspace: string; gitDir: string; command: string }) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const words = [...OWN_COMMANDS, `status ${WORD}+`, 'secret list', `secret ask`].join('|')
  return {
    trustedWorkspaces: [input.worktree, input.workspace], enableTerminalSandbox: true, toolPermission: 'proceed-in-sandbox', artifactReviewPolicy: 'always-proceed', useG1Credits: false,
    permissions: {
      allow: [`command(regex:^(?:${escape(input.command)}|shepherdr) (?:agent )?(?:${words})(?: ${WORD}*)?$)`, `read_file(${input.gitDir})`, `write_file(${input.gitDir})`],
      deny: [`write_file(${input.workspace})`, `write_file(${input.gitDir}/hooks)`, `write_file(${input.gitDir}/config)`],
    },
  }
}

function inside(path: string, folders: string[]) {
  const full = isAbsolute(path) ? path : resolve(folders[0] ?? '/', path)
  return folders.some(folder => {
    const way = relative(folder, full)
    return way === '' || !way.startsWith('..') && !isAbsolute(way)
  })
}

export function agyToolCheck(tool: { name?: unknown; args?: unknown }, workspace: { folders: string[]; command: string }): AgyCheck {
  const name = typeof tool.name === 'string' ? tool.name : ''
  const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {}
  if (Object.hasOwn(REFUSED, name)) return { action: 'deny', reason: REFUSED[name] }
  if (OWN_TOOLS.has(name)) return { action: 'pass' }
  if (name === 'run_command') {
    const line = text(args.CommandLine)
    if (line && ownCommand(line, workspace.command)) return { action: 'allow', overwrite: { BypassSandbox: true } } // Its own core socket is outside the sandbox.
    // Inside the sandbox it runs as it is. Asking to leave the sandbox is for the human.
    const leaving = args.BypassSandbox === true || text(args.BypassSandbox) === 'true'
    return leaving ? { action: 'ask' } : { action: 'pass' }
  }
  if (WORKSPACE_TOOLS.has(name)) {
    const paths = ['Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath', 'SearchDirectory', 'File'].map(key => text(args[key])).filter(path => path !== undefined)
    return paths.length && paths.every(path => inside(path!, workspace.folders)) ? { action: 'pass' } : { action: 'ask' }
  }
  return { action: 'ask' }
}
