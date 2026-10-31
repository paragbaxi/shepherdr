// What happens to one Antigravity tool call in a task's session. Pure, so it can be tested without a CLI.
// `pass` lets through what its terminal sandbox already holds (ordinary commands) or what stays in its workspace. Anything
// that would make it prompt on a screen the human never sees becomes a card in the chat instead: never an auto-approval.
import { isAbsolute, relative, resolve } from 'node:path'

export type AgyCheck =
  | { action: 'pass' }
  | { action: 'allow'; overwrite?: Record<string, unknown> }
  | { action: 'deny'; reason: string }
  | { action: 'ask' }

const READ_TOOLS = new Set(['read_file', 'view_file', 'list_dir', 'grep_search', 'find_by_name'])
const WRITE_TOOLS = new Set(['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content'])
/** Worktree files that something outside the sandbox acts on: this CLI's own customizations (hooks among them), git's
 *  pointer to its metadata, and the settings the agent it hands back to loads when it resumes here. */
export const AGY_CUSTOMIZATIONS = ['.agents', '.agent', '_agents', '_agent']
export const AGY_PROTECTED = [...AGY_CUSTOMIZATIONS, '.git', '.claude', '.codex', '.mcp.json']
/** Tools that manage the agent's own session. */
const OWN_TOOLS = new Set(['command_status', 'send_command_input', 'manage_task', 'task_boundary', 'notify_user'])
/** Spends allowance out of sight, or asks where the chat can't answer. */
const REFUSED: Record<string, string> = {
  invoke_subagent: 'A backup agent works alone, to spend little. Do this yourself.',
  browser_subagent: 'A backup agent works alone, to spend little. Do this yourself.',
  ask_question: 'The human only reads the chat. Ask with: shepherdr ask "..." --choice "..." and end your turn.',
}

/** The transcript format double-encodes string arguments; hooks may or may not. */
const text = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  if (!value.startsWith('"')) return value
  try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : value } catch { return value }
}

const UNQUOTED = '[^;&|`$<>()\\n\\r\\\\"\'#*?~{}\\[\\]!]', DOUBLE = '"[^"`$\\\\\\n\\r]*"', SINGLE = "'[^'\\n\\r]*'"
const WORDS = `(?:${UNQUOTED}|${DOUBLE}|${SINGLE})*`
/** Its own product commands, each already checked against this launch's credential, as one plain command a shell would
 *  just run: quoted words may say anything, but nothing can run anything else. Not `start`, `stop`, bare `status` or
 *  `secret run`. The one definition for both the hook and the session rule: if they disagreed, a command the hook let
 *  through would stop on a prompt on a screen nobody sees. */
export function agyOwnCommand(command: string) {
  const path = command.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const subs = ['ask', 'plan', 'ready', 'pr', 'checks', 'merge', 'review', 'todo', 'artifact', 'show', 'help', 'alert', 'models', 'status [\\w/.:-]+', 'secret list', 'secret ask'].join('|')
  return `^(?:${path}|shepherdr) (?:agent )?(?:${subs})(?: ${WORDS})?$`
}

/** What this session may do without a prompt, on top of its sandbox and only for this session: its own plain product
 *  commands, and just the parts of git's folder a commit from a linked worktree writes. Not git's hooks, config or the
 *  files saying where its metadata is, which programs outside the sandbox act on later; not this launch's own folder or
 *  the worktree files in AGY_PROTECTED; and not the folder of launch credentials. The worktree is only trusted when it
 *  ships none of this CLI's customizations: otherwise its own prompt lets the human decide. */
export function agySessionSettings(input: { worktree: string; workspace: string; gitDir: string; worktreeGitDir: string; sessions: string; command: string; trustWorktree: boolean; hooks: string[] }) {
  return {
    trustedWorkspaces: input.trustWorktree ? [input.worktree, input.workspace] : [input.workspace], enableTerminalSandbox: true, toolPermission: 'proceed-in-sandbox', artifactReviewPolicy: 'always-proceed', useG1Credits: false,
    permissions: {
      allow: [`command(regex:${agyOwnCommand(input.command)})`, `read_file(${input.gitDir})`,
        ...['objects', 'refs', 'logs', 'packed-refs'].map(name => `write_file(${input.gitDir}/${name})`), `write_file(${input.worktreeGitDir})`],
      deny: [`write_file(${input.workspace})`, `read_file(${input.sessions})`, `write_file(${input.gitDir}/hooks)`, `write_file(${input.gitDir}/config)`,
        ...['commondir', 'gitdir', 'config.worktree'].map(name => `write_file(${input.worktreeGitDir}/${name})`), ...AGY_PROTECTED.map(name => `write_file(${input.worktree}/${name})`),
        ...input.hooks.map(path => `write_file(${path})`)],
    },
  }
}

/** Where git would look for hooks when this repository sets its own `core.hooksPath` (husky, `.githooks`). Whatever runs
 *  there runs outside the sandbox on the next `shepherdr pr`, so it counts as protected. Husky's `_` calls the folder above. */
export function agyHookFolders(worktree: string, configured: string) {
  const value = configured.trim()
  if (!value) return []
  const full = isAbsolute(value) ? value : resolve(worktree, value)
  return full.endsWith('/_') ? [full, full.slice(0, -2)] : [full]
}

function under(path: string, folder: string) {
  const way = relative(folder, path)
  return way === '' || !way.startsWith('..') && !isAbsolute(way)
}

export function agyToolCheck(tool: { name?: unknown; args?: unknown }, workspace: { folders: string[]; command: string; hooks?: string[]; real?: (path: string) => string }): AgyCheck {
  const name = typeof tool.name === 'string' ? tool.name : ''
  const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {}
  if (Object.hasOwn(REFUSED, name)) return { action: 'deny', reason: REFUSED[name] }
  if (OWN_TOOLS.has(name)) return { action: 'pass' }
  if (name === 'run_command') {
    const line = text(args.CommandLine)
    if (line && new RegExp(agyOwnCommand(workspace.command)).test(line)) return { action: 'allow', overwrite: { BypassSandbox: true } } // Its own core socket is outside the sandbox.
    // Inside the sandbox it runs as it is. Asking to leave the sandbox is for the human.
    const leaving = args.BypassSandbox === true || text(args.BypassSandbox) === 'true'
    return leaving ? { action: 'ask' } : { action: 'pass' }
  }
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const real = workspace.real ?? (path => path)
    const [first] = workspace.folders
    const folders = workspace.folders.map(real)
    // A link in the worktree is judged by where it leads, not by what its path says.
    const places = ['Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath', 'SearchDirectory', 'File'].map(key => text(args[key])).filter((path): path is string => path !== undefined).map(path => real(isAbsolute(path) ? path : resolve(first ?? '/', path)))
    const shielded = (place: string) => folders.some(folder => under(place, folder) && AGY_PROTECTED.includes(relative(folder, place).split('/')[0])) || (workspace.hooks ?? []).map(real).some(folder => under(place, folder))
    const allowed = places.length && places.every(place => folders.some(folder => under(place, folder)) && !(WRITE_TOOLS.has(name) && shielded(place)))
    return allowed ? { action: 'pass' } : { action: 'ask' }
  }
  return { action: 'ask' }
}
