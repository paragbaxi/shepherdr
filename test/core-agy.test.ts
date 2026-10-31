import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreStore } from '../server/core/store.ts'
import { CoreSettings, backupKindOf, kindOf } from '../server/core/settings.ts'
import { AgyReader, agyUserText } from '../server/common/readers/agy.ts'
import { agyGrants, agySessionSettings, agyToolCheck, plainWords } from '../helper/core-agy-policy.ts'
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
  expect(providerError(error.text)).toEqual({ passing: false, reason: 'Out of allowance' })
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
  for (const line of ['shepherdr status X-1 "Writing tests" --done 40 --left 5m', '/app/bin/shepherdr ready X-1 --summary "Done" --facts "x"', 'shepherdr ask "Rerun?" --choice "Yes"', 'shepherdr agent merge X-1', 'shepherdr secret list'])
    expect(run(line)).toEqual({ action: 'allow', overwrite: { BypassSandbox: true } })
  // Would run something else, or is the human's lifecycle command: it stays in the sandbox like any other command.
  for (const line of ['shepherdr status', 'shepherdr stop', 'shepherdr start', 'shepherdr secret run KEY -- rm -rf /', 'shepherdr secret env KEY --file .env', 'shepherdr status X-1 "a" && rm -rf /', 'shepherdr status X-1 "$(rm -rf /)"', 'shepherdr status X-1 `id`', '/other/bin/shepherdr ready X-1', 'shepherdrx ready', 'PATH=/tmp shepherdr ready X-1'])
    expect(run(line)).toEqual({ action: 'pass' })
  expect(run('git status')).toEqual({ action: 'pass' })
  // Leaving the sandbox is always a card, its own command included when it isn't plainly its own.
  expect(run('git push', { BypassSandbox: true })).toEqual({ action: 'ask' })
  expect(run('git push', { BypassSandbox: '"true"' })).toEqual({ action: 'ask' })
  expect(run('shepherdr secret run KEY -- sh', { BypassSandbox: true })).toEqual({ action: 'ask' })
})

test('tools outside the worktree become cards and tools that spend or ask out of sight are refused', () => {
  const tool = (name: string, args: object = {}) => agyToolCheck({ name, args }, WORK)
  expect(tool('read_file', { Path: '/work/task/a.ts' })).toEqual({ action: 'pass' })
  expect(tool('read_file', { Path: '"/work/task/a.ts"' })).toEqual({ action: 'pass' })
  expect(tool('write_to_file', { TargetFile: 'src/a.ts' })).toEqual({ action: 'pass' })
  expect(tool('read_file', { Path: '/home/me/.ssh/id_rsa' })).toEqual({ action: 'ask' })
  expect(tool('write_file', { Path: '/w_agy/grant/.agents/hooks.json' })).toEqual({ action: 'ask' })
  expect(tool('write_file', { Path: '/work/task/../../etc/x' })).toEqual({ action: 'ask' })
  expect(tool('write_file', { Path: '/work/taskother/x' })).toEqual({ action: 'ask' })
  expect(tool('read_file')).toEqual({ action: 'ask' })
  expect(tool('read_url_content', { Url: 'https://example.test' })).toEqual({ action: 'ask' })
  expect(tool('mcp_something')).toEqual({ action: 'ask' })
  for (const name of ['invoke_subagent', 'browser_subagent', 'ask_question']) expect(tool(name).action).toBe('deny')
  expect(tool('command_status')).toEqual({ action: 'pass' })
})

test('an approved command gets a grant for exactly itself', () => {
  expect(agyGrants({ name: 'run_command', args: { CommandLine: 'git push' } })).toEqual(['command(git push)', 'unsandboxed(git push)'])
  expect(agyGrants({ name: 'read_file', args: { Path: '/etc/hosts' } })).toEqual(['read_file(/etc/hosts)'])
  expect(agyGrants({ name: 'write_file', args: { TargetFile: '"/x/y"' } })).toEqual(['write_file(/x/y)'])
  expect(agyGrants({ name: 'mcp_something', args: {} })).toEqual([])
})

test('session settings stay in the sandbox with credits off, and protect git hooks and its own hooks', () => {
  const settings = agySessionSettings({ worktree: '/w/task', workspace: '/w_agy/grant', gitDir: '/repo/.git', command: '/app.1/bin/shepherdr' })
  expect(settings).toMatchObject({ trustedWorkspaces: ['/w/task', '/w_agy/grant'], enableTerminalSandbox: true, toolPermission: 'proceed-in-sandbox', useG1Credits: false })
  expect(settings).not.toHaveProperty('dangerouslySkipPermissions')
  expect(settings.permissions.allow.slice(1)).toEqual(['read_file(/repo/.git)', 'write_file(/repo/.git)'])
  expect(settings.permissions.deny).toEqual(['write_file(/w_agy/grant)', 'write_file(/repo/.git/hooks)', 'write_file(/repo/.git/config)'])
  const own = new RegExp(settings.permissions.allow[0].slice('command(regex:'.length, -1))
  for (const line of ['shepherdr status X-1 "Hi" --done 4', '/app.1/bin/shepherdr ready X --summary "ok"', 'shepherdr secret list', 'shepherdr agent merge X']) expect(own.test(line)).toBe(true)
  for (const line of ['shepherdr status', 'shepherdr stop', 'shepherdr start', 'shepherdr secret run K -- sh', 'shepherdr secret env K', 'shepherdr ask "a" && rm -rf /', 'shepherdr ask "$(id)"', '/appx1/bin/shepherdr ready X']) expect(own.test(line)).toBe(false)
})

test('plain words only for a command a shell would just run', () => {
  expect(plainWords(`a 'b c' "d \\"e" f\\ g`)).toEqual(['a', 'b c', 'd "e', 'f g'])
  for (const line of ['a; b', 'a | b', 'a > b', 'a $(b)', 'a "$HOME"', 'a `b`', 'a\nb', 'A=1 b', 'a "open', 'a *']) expect(plainWords(line)).toBeUndefined()
})
