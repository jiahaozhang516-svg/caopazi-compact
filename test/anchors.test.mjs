import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAnchors } from '../anchors.js'
import { appendAnchorsToSummary } from '../augment.js'

const messages = [
  { role: 'system', content: [{ type: 'text', text: 'you are a coding agent' }] },
  {
    role: 'user',
    content: [{ type: 'text', text: '帮我把自动压缩插件做出来，必须保留关键和重要对话。不要动核心文件。' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: '好的，我先看核心。' }] },
  {
    role: 'user',
    content: [{
      type: 'text',
      text: '下一步要跑 node --test；错误码是 CONTEXT_WINDOW_EXCEEDED；文件在 /storage/Users/currentUser/dsh/caopazi-compact/index.js',
    }],
  },
  {
    role: 'user',
    source: { kind: 'compact-checkpoint' },
    content: [{
      type: 'text',
      text: '<compacted-summary>\n## Primary Request and Intent\n- 做自动压缩插件\n## Pending Jobs\n- 跑测试\n## Critical Context\n- 阈值 70%\n[MUST-PRESERVE ANCHORS]\n### Paths, commands and error codes\n- /tmp/prior-anchor-path\n</compacted-summary>',
    }],
  },
]

test('extracts the original task, constraints, artifacts and prior checkpoint', () => {
  const text = buildAnchors(messages, { enabled: true, budgetTokens: 1500 })
  assert.match(text, /MUST-PRESERVE ANCHORS/)
  assert.match(text, /自动压缩插件/)
  assert.match(text, /不要动核心文件/)
  assert.match(text, /CONTEXT_WINDOW_EXCEEDED/)
  assert.match(text, /\/storage\/Users\/currentUser\/dsh\/caopazi-compact\/index\.js/)
  assert.match(text, /做自动压缩插件/)
  assert.match(text, /跑测试/)
  assert.match(text, /\/tmp\/prior-anchor-path/)
})

test('ignores injected user-role context when picking the original task', () => {
  const withContext = [
    {
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'Time sampled while preparing turn 2, step 62: 2026-11-13T12:35:46+08:00[Asia/Shanghai].' }],
    },
    ...messages,
  ]
  const text = buildAnchors(withContext, { enabled: true, budgetTokens: 1500 })
  const originalSection = text.split('### Original task')[1] ?? ''
  assert.match(originalSection, /自动压缩插件/)
  assert.doesNotMatch(text, /Time sampled/)
})

test('respects the token budget', () => {
  const text = buildAnchors(messages, { enabled: true, budgetTokens: 300 })
  assert.ok(text.length <= 900, `anchors too long: ${text.length}`)
})

test('can be turned off', () => {
  assert.equal(buildAnchors(messages, { enabled: false }), '')
  assert.equal(buildAnchors([], {}), '')
})

test('appends the anchor block to the summary blocks', () => {
  const summary = [{ type: 'text', text: 'model summary' }]
  const out = appendAnchorsToSummary(summary, 'MUST-PRESERVE ANCHORS')
  assert.equal(out.length, 2)
  assert.equal(summary.length, 1)
  assert.match(out[1].text, /MUST-PRESERVE/)
  assert.equal(out[1].type, 'text')
})

test('appending is a no-op without anchors', () => {
  const summary = [{ type: 'text', text: 'x' }]
  assert.equal(appendAnchorsToSummary(summary, ''), summary)
  assert.equal(appendAnchorsToSummary(undefined, 'x'), undefined)
})
