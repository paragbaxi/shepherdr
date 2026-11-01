import { describe, expect, test } from 'bun:test'
import { layout } from './layout.ts'
const { browser, world, url } = await layout()
describe.skipIf(!browser)('closed question history', () => {
  test('expired permission stays disabled and says Closed rather than claiming an answer was sent', async () => {
    const chat = world.chats['p:vm-str:~'], old = chat.messages
    chat.messages = [...old, { id: 'closed-card-proof', who: 'agent', at: Date.now(), question: { id: 'closed-proof', kind: 'Question', title: 'Use a tool?', choices: [{ label: 'Allow once' }, { label: 'Deny' }], to: 'Agent', sent: -1, said: 'Permission request expired', closed: 'Permission request expired' } }]
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    page.setDefaultTimeout(5000)
    try {
      await page.goto(url())
      const card = page.locator('[data-whole="closed-card-proof"]')
      await card.getByText('Closed', { exact: true }).waitFor()
      expect(await card.getByRole('button', { name: 'Allow once', exact: true }).isDisabled()).toBe(true)
      expect(await card.getByRole('button', { name: 'Deny', exact: true }).isDisabled()).toBe(true)
      expect(await card.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0)
      expect(await card.textContent()).not.toContain('Sent to')
      expect(await card.textContent()).toContain('Permission request expired')
    } finally { chat.messages = old; await page.close() }
  })
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]] as const) {
    test(`withdrawn question and secret cards say why, with nothing left to tap (${name})`, async () => {
      const chat = world.chats['p:vm-str:~'], old = chat.messages
      chat.messages = [...old,
        { id: 'withdrawn-question', who: 'agent', at: Date.now(), question: { id: 'withdrawn-q', kind: 'Question', title: 'Rerun CI?', choices: [{ label: 'Rerun it' }, { label: 'Leave it' }], to: 'Agent', sent: -1, said: 'Withdrawn: Answered in chat', closed: 'Withdrawn: Answered in chat' } },
        { id: 'withdrawn-secret', who: 'agent', at: Date.now(), secret: { id: 'withdrawn-s', name: 'DEMO_KEY', why: 'To deploy', levels: [{ id: 'all', label: 'Everywhere' }], closed: 'Withdrawn: Deploy is off' } },
      ]
      const page = await browser!.newPage({ viewport })
      page.setDefaultTimeout(5000)
      try {
        await page.goto(url())
        const question = page.locator('[data-whole="withdrawn-question"]')
        await question.getByText('Withdrawn: Answered in chat').waitFor()
        await question.getByText('Rerun CI?').waitFor()
        expect(await question.getByRole('button').count()).toBe(0)
        const secret = page.locator('[data-whole="withdrawn-secret"]')
        await secret.getByText('Withdrawn: Deploy is off').waitFor()
        expect(await secret.getByText('Closed', { exact: true }).count()).toBe(1)
        expect(await secret.locator('input').count()).toBe(0)
        expect(await secret.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0)
      } finally { chat.messages = old; await page.close() }
    })
  }
})
