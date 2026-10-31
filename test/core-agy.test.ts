import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreStore } from '../server/core/store.ts'
import { CoreSettings, backupKindOf, kindOf } from '../server/core/settings.ts'
import { AgyReader, agyErrorCode, agyUserText } from '../server/common/readers/agy.ts'
import { CoreRemotes } from '../server/core/remote.ts'
import { agyHookFolders, agyOwnCommand, agyRealPath, agySessionSettings, agyToolCheck } from '../helper/core-agy-policy.ts'
import { outputFromLine } from '../server/activity.ts'
import { agyPromptWords } from '../server/core/agy-approvals.ts'
import { isGemini, parseAgy, TABLE } from '../shared/models.ts'
import { providerError, providerOutage } from '../server/common/provider-error.ts'
import type { CoreFiles } from '../server/core/files.ts'
import type { CoreSpace } from '../server/core/model.ts'

function settingsFixture(run: (settings: CoreSettings) => void) {
  const home = mkdtempSync(join(tmpdir(), 'shep-agy-')), store = new CoreStore(home)
  const spaces = [{ id: 'p:box:one', machine: 'box', name: 'one' }] as CoreSpace[]
  try { run(new CoreSettings(store, {} as CoreFiles, () => spaces, id => id, () => {})) }
  finally { store.close(); rmSync(home, { recursive: true, force: true }) }
}

test('Antigravity is offered and accepted only as the Backup agent', () => settingsFixture(settings => {
  const agents = settings.sections().find(section => section.level === 'all' && section.name === 'Agents')!
  const row = (key: string) => agents.rows.find(item => item.key === key)!
  expect(row('task.fallback').options).toEqual(['off', 'Claude Code', 'Codex', 'Antigravity'])
  for (const key of ['task.agent', 'coordinator.agent']) expect(row(key).options).toEqual(['Claude Code', 'Codex'])
  settings.set('task.fallback', 'antigravity')
  expect(settings.get('task.fallback')).toBe('Antigravity')
  for (const key of ['task.agent', 'coordinator.agent', 'reviewer.agent', 'autopilot.agent']) expect(() => settings.set(key, 'Antigravity')).toThrow('Choose Claude Code or Codex')
  expect(() => settings.checkedAgent('all', { kind: 'agy' })).toThrow('Choose Claude Code or Codex')
  expect(kindOf('agy')).toBeUndefined()
  expect(kindOf('Antigravity')).toBeUndefined()
  expect(backupKindOf('agy')).toBe('agy')
  expect(settings.clis('all').map(cli => cli.kind)).toEqual(['claude', 'codex'])
}))

test('Backup runs on a cheap Gemini Flash by default and never selects another vendor', () => settingsFixture(settings => {
  settings.set('task.fallback', 'Antigravity')
  expect(settings.agent('backup', 'all')).toEqual({ kind: 'agy', model: 'gemini-3.8-flash-low', effort: undefined })
  expect(() => settings.set('backup.model', 'claude-opus-5-5-low')).toThrow('Choose a model offered by this agent')
  expect(() => settings.set('backup.model', 'gpt-oss-120b-medium')).toThrow('Choose a model offered by this agent')
  settings.set('backup.model', 'Gemini 3.8 Flash (Medium)')
  expect(settings.agent('backup', 'all').model).toBe('gemini-3.8-flash-medium')
  expect(settings.launch('task', 'all').kind).toBe('claude')
}))

test('agy models keeps only Gemini and defaults to its lowest Flash', () => {
  const listed = parseAgy('gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n')!
  expect(listed.models.map(model => model.id)).toEqual(['gemini-4-argon-medium', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low'])
  expect(listed.default).toBe('gemini-3.8-flash-low')
  expect(listed.models.every(model => model.efforts.length === 0)).toBe(true)
  expect(parseAgy('Fetching available models...\n')).toBeUndefined()
  expect(TABLE.agy.models.every(model => isGemini(model.id))).toBe(true)
  for (const id of ['claude-opus-5-5-low', 'gpt-oss-120b-medium', '', undefined]) expect(isGemini(id)).toBe(false)
})

const FILE = '/home/me/.gemini/antigravity-cli/brain/conv-1/.system_generated/logs/transcript_full.jsonl'
const read = (reader: AgyReader, lines: object[]) => reader.parse(lines.map((line, offset) => ({ text: JSON.stringify(line), offset })), FILE)
const USER = { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-31T13:41:43Z', content: '<USER_REQUEST>\nhello <go>you</go>\nsecond "line"\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>' }

test('the Antigravity reader gives the chat exactly what was typed, replies, steps and turn ends', () => {
  expect(agyUserText(USER.content)).toBe('hello <go>you</go>\nsecond "line"')
  const events = read(new AgyReader(), [USER,
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-31T13:41:44Z', input_tokens: 10, cache_read_tokens: 5, output_tokens: 2, thinking: 'hidden', tool_calls: [{ name: 'run_command', args: { CommandLine: '"git status"' } }, { name: 'read_file', args: { Path: '"/w/a.ts"' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-31T13:41:45Z', content: 'output' },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'ERROR', error: 'denied', created_at: '2026-10-31T13:41:45Z' },
    { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-31T13:41:46Z', output_tokens: 1, content: 'All done.' },
  ])
  expect(events.map(event => event.kind)).toEqual(['session', 'turn-start', 'user', 'usage', 'step', 'step', 'step-end', 'step-end', 'usage', 'agent', 'turn-end'])
  expect(events.find(event => event.kind === 'user')).toMatchObject({ id: 'agy-conv-1-0', text: 'hello <go>you</go>\nsecond "line"' })
  expect(events.find(event => event.kind === 'session')).toMatchObject({ sessionId: 'conv-1' })
  expect(events.find(event => event.kind === 'agent')).toMatchObject({ id: 'agy-conv-1-4', text: 'All done.' })
  const ends = events.filter(event => event.kind === 'step-end')
  expect(ends.map(event => (event as { failed?: boolean }).failed)).toEqual([undefined, true])
  // No end of turn while tool calls are all it has said yet.
  expect(read(new AgyReader(), [USER, { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-31T13:41:44Z', tool_calls: [{ name: 'run_command', args: {} }] }]).some(event => event.kind === 'turn-end')).toBe(false)
  // Whole-second timestamps keep their order, and two conversations never share an id.
  const times = events.filter(event => event.kind === 'turn-start' || event.kind === 'agent').map(event => event.at)
  expect(times[0]).toBeLessThan(times[1])
  const other = new AgyReader().parse([{ text: JSON.stringify(USER), offset: 0 }], FILE.replace('conv-1', 'conv-2'))
  expect(other.find(event => event.kind === 'user')?.id).toBe('agy-conv-2-0')
})

test('a cut-off Antigravity turn reaches the provider logic as an ended error, classified as out of allowance', () => {
  const events = read(new AgyReader(), [USER, { step_index: 1, source: 'SYSTEM_SDK', type: 'ERROR_MESSAGE', status: 'DONE', created_at: '2026-10-31T13:41:44Z', error: 'RESOURCE_EXHAUSTED: Quota exhausted for this model' }])
  expect(events.slice(-2).map(event => event.kind)).toEqual(['error', 'turn-end'])
  const error = events.find(event => event.kind === 'error') as { text: string }
  expect(providerError(error.text, (error as { code?: string }).code)).toEqual({ passing: false, reason: 'Out of allowance' })
  // Only Antigravity's own words read this way, and a short limit it already retried still passes.
  expect(providerError('stream error: resource exhausted')).toEqual({ passing: true, reason: 'Connection dropped' })
  expect(agyErrorCode('RESOURCE_EXHAUSTED: 429 too many requests per minute')).toBeUndefined()
  expect(agyErrorCode('You have exhausted your capacity')).toBe('usage_limit_exceeded')
  expect(providerOutage('Out of allowance until 5pm')).toBe(true)
  expect(providerOutage('Signed out')).toBe(true)
  expect(providerOutage('Provider overloaded, still after 5 tries')).toBe(true)
  for (const reason of ['Context window full', 'Provider refused it', 'Provider error', 'Model not available']) expect(providerOutage(reason)).toBe(false)
})

test('a re-read log gives the same ids, so nothing is shown twice', () => {
  const reader = new AgyReader(), first = read(reader, [USER]).map(event => event.id)
  reader.reset(FILE)
  expect(read(reader, [USER]).map(event => event.id)).toEqual(first)
})

const WORK = { folders: ['/work/task'], command: '/app/bin/shepherdr' }
const run = (CommandLine: string, more: object = {}) => agyToolCheck({ name: 'run_command', args: { CommandLine, ...more } }, WORK)

test('its own Shepherdr commands reach their core outside the sandbox; nothing else is approved without the human', () => {
  for (const line of ['shepherdr status X-1 "Writing tests" --done 40 --left 5m', 'shepherdr status mac/X-1 "a"', '/app/bin/shepherdr ready X-1 --summary "Done" --facts "x"', 'shepherdr ask "Rerun?" --choice "Yes"', 'shepherdr agent merge X-1', 'shepherdr secret list', 'shepherdr ask "Rerun CI on main & deploy?" --choice "Yes"', 'shepherdr ready X-1 --summary "Add login (OAuth)"', 'shepherdr ready X-1 --summary "a < b; c | d"', "shepherdr ask 'What about $HOME and `this`?'"])
    expect(run(line)).toEqual({ action: 'allow', overwrite: { BypassSandbox: true } })
  // Would run something else, or is the human's lifecycle command: it stays in the sandbox like any other command.
  for (const line of ['shepherdr status', 'shepherdr status ', 'shepherdr stop', 'shepherdr start', 'shepherdr secret run KEY -- rm -rf /', 'shepherdr secret env KEY --file .env', 'shepherdr status X-1 "a" && rm -rf /', 'shepherdr status X-1 "$(rm -rf /)"', 'shepherdr status X-1 `id`', 'shepherdr ask "a\nb"', 'shepherdr ask "a" ; rm x', 'shepherdr ask "open', '/other/bin/shepherdr ready X-1', 'shepherdrx ready', 'PATH=/tmp shepherdr ready X-1'])
    expect(run(line)).toEqual({ action: 'pass' })
  expect(run('git status')).toEqual({ action: 'pass' })
  // Leaving the sandbox is always a card, its own command included when it isn't plainly its own.
  expect(run('git push', { BypassSandbox: true })).toEqual({ action: 'ask' })
  expect(run('git push', { BypassSandbox: '"true"' })).toEqual({ action: 'ask' })
  expect(run('shepherdr secret run KEY -- sh', { BypassSandbox: true })).toEqual({ action: 'ask' })
})

test('the hook and the session rule agree on every command, so none stops on a screen nobody sees', () => {
  const settings = agySessionSettings({ worktree: '/w', workspace: '/x', gitDir: '/g', worktreeGitDir: '/g/w', sessions: '/s', command: '/app/bin/shepherdr', trustWorktree: true, hooks: [] })
  const rule = new RegExp(settings.permissions.allow[0].slice('command(regex:'.length, -1))
  expect(rule.source).toBe(new RegExp(agyOwnCommand('/app/bin/shepherdr')).source)
  for (const line of ['shepherdr ask "Rerun CI on main & deploy?"', 'shepherdr ready X --summary "Add login (OAuth)"', 'shepherdr ask "a < b"', 'shepherdr ask "a\nb"', 'shepherdr stop', 'shepherdr ask "$(id)"', 'shepherdr status X "ok"'])
    expect(run(line).action === 'allow').toBe(rule.test(line))
})

test('tools outside the worktree become cards and tools that spend or ask out of sight are refused', () => {
  const tool = (name: string, args: object = {}) => agyToolCheck({ name, args }, WORK)
  expect(tool('read_file', { Path: '/work/task/a.ts' })).toEqual({ action: 'pass' })
  expect(tool('read_file', { Path: '"/work/task/a.ts"' })).toEqual({ action: 'pass' })
  expect(tool('write_to_file', { TargetFile: 'src/a.ts' })).toEqual({ action: 'pass' })
  expect(tool('read_file', { Path: '/home/me/.ssh/id_rsa' })).toEqual({ action: 'ask' })
  expect(tool('write_file', { Path: '/w_agy/grant/.agents/hooks.json' })).toEqual({ action: 'ask' })
  // Inside the worktree, but acted on outside the sandbox: its own hooks, git's pointer, what the next agent loads.
  for (const path of ['.agents/hooks.json', '/work/task/.agents/hooks.json', '_agent/hooks.json', '.git', '/work/task/.claude/settings.local.json', '.codex/config.toml', '.mcp.json', 'a/../.agents/x']) expect(tool('write_to_file', { TargetFile: path })).toEqual({ action: 'ask' })
  for (const path of ['docs/.agents/note.md', '.gitignore', '.github/x.yml', 'src/.claude-notes']) expect(tool('write_to_file', { TargetFile: path })).toEqual({ action: 'pass' })
  expect(tool('read_file', { Path: '/work/task/.agents/hooks.json' })).toEqual({ action: 'pass' })
  expect(tool('write_file', { Path: '/work/task/../../etc/x' })).toEqual({ action: 'ask' })
  expect(tool('write_file', { Path: '/work/taskother/x' })).toEqual({ action: 'ask' })
  expect(tool('read_file')).toEqual({ action: 'ask' })
  expect(tool('read_url_content', { Url: 'https://example.test' })).toEqual({ action: 'ask' })
  expect(tool('mcp_something')).toEqual({ action: 'ask' })
  for (const name of ['invoke_subagent', 'browser_subagent', 'ask_question']) expect(tool(name).action).toBe('deny')
  expect(tool('command_status')).toEqual({ action: 'pass' })
  // Its own notes are fine; a repository's own hooks folder is not; a link is judged by where it leads.
  const notes = { folders: ['/work/task', '/brain/conv'], command: WORK.command }
  expect(agyToolCheck({ name: 'write_file', args: { Path: '/brain/conv/plan.md' } }, notes)).toEqual({ action: 'pass' })
  const hooks = { ...WORK, hooks: agyHookFolders('/work/task', '.husky/_\n') }
  expect(hooks.hooks).toEqual(['/work/task/.husky/_', '/work/task/.husky'])
  expect(agyToolCheck({ name: 'write_file', args: { Path: '.husky/pre-push' } }, hooks)).toEqual({ action: 'ask' })
  expect(agyToolCheck({ name: 'read_file', args: { Path: '.husky/pre-push' } }, hooks)).toEqual({ action: 'pass' })
  expect(agyToolCheck({ name: 'write_file', args: { Path: 'src/a.ts' } }, hooks)).toEqual({ action: 'pass' })
  const linked = { ...WORK, real: (path: string) => path.replace('/work/task/x', '/work/task/.claude') }
  expect(agyToolCheck({ name: 'write_file', args: { Path: '/work/task/x/settings.json' } }, linked)).toEqual({ action: 'ask' })
  const away = { ...WORK, real: (path: string) => path.replace('/work/task/y', '/etc') }
  expect(agyToolCheck({ name: 'read_file', args: { Path: '/work/task/y/hosts' } }, away)).toEqual({ action: 'ask' })
})

test('a configured hooks folder is only as protected as what it is', () => {
  expect(agyHookFolders('/w', '')).toEqual([])
  expect(agyHookFolders('/w', '.githooks\n')).toEqual(['/w/.githooks'])
  expect(agyHookFolders('/w', '/opt/hooks')).toEqual(['/opt/hooks'])
})

test('what the human approved is named by the start of its first line', () => {
  expect(agyPromptWords({ BypassSandbox: true, CommandLine: 'git push origin main\nand more' })).toBe('git push origin main')
  expect(agyPromptWords({ Path: '/etc/hosts' })).toBe('/etc/hosts')
  expect(agyPromptWords({ DirectoryPath: '/etc' })).toBe('/etc')
  expect(agyPromptWords({ CommandLine: '"git push"' })).toBe('git push')
  expect(agyPromptWords({ CommandLine: 'x'.repeat(80) })).toHaveLength(40)
  expect(agyPromptWords({})).toBe('')
  expect(agyPromptWords(null)).toBe('')
})

test('session settings stay in the sandbox with credits off, and protect what runs outside it', () => {
  const input = { worktree: '/w/task', workspace: '/w_agy/grant', gitDir: '/repo/.git', worktreeGitDir: '/repo/.git/worktrees/task', sessions: '/app/sessions', command: '/app.1/bin/shepherdr', trustWorktree: true, hooks: ['/w/task/.husky'] }
  const settings = agySessionSettings(input)
  expect(settings).toMatchObject({ trustedWorkspaces: ['/w/task', '/w_agy/grant'], enableTerminalSandbox: true, toolPermission: 'proceed-in-sandbox', useG1Credits: false })
  expect(settings).not.toHaveProperty('dangerouslySkipPermissions')
  // A repository shipping its own hooks stays for the human to trust.
  expect(agySessionSettings({ ...input, trustWorktree: false }).trustedWorkspaces).toEqual(['/w_agy/grant'])
  expect(settings.permissions.allow.slice(1)).toEqual(['read_file(/repo/.git)', 'write_file(/repo/.git/objects)', 'write_file(/repo/.git/refs)', 'write_file(/repo/.git/logs)', 'write_file(/repo/.git/packed-refs)', 'write_file(/repo/.git/worktrees/task)'])
  for (const rule of ['write_file(/w_agy/grant)', 'read_file(/app/sessions)', 'write_file(/repo/.git/hooks)', 'write_file(/repo/.git/config)', 'write_file(/repo/.git/worktrees/task/commondir)', 'write_file(/repo/.git/worktrees/task/gitdir)', 'write_file(/repo/.git/worktrees/task/config.worktree)', 'write_file(/w/task/.git)', 'write_file(/w/task/.agents)', 'write_file(/w/task/.claude)', 'write_file(/w/task/.mcp.json)', 'write_file(/w/task/.husky)']) expect(settings.permissions.deny).toContain(rule)
  const own = new RegExp(settings.permissions.allow[0].slice('command(regex:'.length, -1))
  for (const line of ['shepherdr status X-1 "Hi" --done 4', '/app.1/bin/shepherdr ready X --summary "ok"', 'shepherdr secret list', 'shepherdr agent merge X']) expect(own.test(line)).toBe(true)
  for (const line of ['shepherdr status', 'shepherdr stop', 'shepherdr start', 'shepherdr secret run K -- sh', 'shepherdr secret env K', 'shepherdr ask "a" && rm -rf /', 'shepherdr ask "$(id)"', '/appx1/bin/shepherdr ready X']) expect(own.test(line)).toBe(false)
})

test('Antigravity launch files are allowed on a remote machine, beside its worktrees, and nowhere else', async () => {
  const runs: string[][] = []
  const remotes = new CoreRemotes({ exec: async (_machine: string, argv: string[]) => { runs.push(argv); return Buffer.from('') } } as unknown as CoreFiles, 'install', () => ({}))
  const runtime = { root: '/home/me/shepherdr-agents/install/digest', bun: '/bun' } as Parameters<typeof remotes.privateFile>[1]
  await remotes.privateFile('box', runtime, '/home/me/shepherdr-agents/install/worktrees_agy/grant/settings.json', '{}')
  await remotes.privateFile('box', runtime, '/home/me/shepherdr-agents/install/digest/sessions/grant.settings.json', '{}')
  expect(runs).toHaveLength(2)
  await expect(remotes.privateFile('box', runtime, '/home/me/elsewhere/settings.json', '{}')).rejects.toThrow('outside its runtime')
})

test('protected names count in any case, and a link is followed to where it leads even if nothing is there yet', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'shep-agy-link-'))), work = join(home, 'work')
  try {
    mkdirSync(join(work, 'src'), { recursive: true }); writeFileSync(join(work, 'src/a.ts'), '')
    symlinkSync('.mcp.json', join(work, 'note.md'))
    symlinkSync(join(home, 'away.txt'), join(work, 'out.md'))
    symlinkSync('../.claude', join(work, 'src/dir'))
    expect(agyRealPath(join(work, 'note.md'))).toBe(join(work, '.mcp.json'))
    expect(agyRealPath(join(work, 'src/dir/settings.json'))).toBe(join(work, '.claude/settings.json'))
    expect(agyRealPath(join(work, 'src/new.ts'))).toBe(join(work, 'src/new.ts'))
    const here = { folders: [work], command: WORK.command, real: (path: string) => agyRealPath(path) }
    const write = (Path: string) => agyToolCheck({ name: 'write_file', args: { Path } }, here)
    for (const path of ['note.md', 'out.md', 'src/dir/settings.json', '.CLAUDE/settings.local.json', '.MCP.JSON', '.CODEX/config.toml', '.AGENTS/hooks.json', '.Git']) expect(write(path)).toEqual({ action: 'ask' })
    for (const path of ['src/a.ts', 'src/new.ts']) expect(write(path)).toEqual({ action: 'pass' })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a step during a takeover shows its output', () => {
  expect(outputFromLine(JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Command output' }), 'any')).toBe('Command output')
  expect(outputFromLine(JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'ERROR', error: 'denied' }), 'any')).toBe('denied')
})
