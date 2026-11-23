import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTextOp, decodeLine, historyOtText } from '../../extension/src/page/ot'

test('applies inserts and deletes in order', () => {
  assert.equal(applyTextOp('hello world', [{ p: 5, i: ',' }, { p: 7, d: 'world' }, { p: 7, i: 'there' }]), 'hello, there')
})

test('comments do not change the text', () => {
  assert.equal(applyTextOp('abc', [{ p: 1, c: 'b', t: 'id' }]), 'abc')
})

test('a delete that does not match throws (mirror then resyncs)', () => {
  assert.throws(() => applyTextOp('abc', [{ p: 0, d: 'x' }]))
})

test('decodes Overleaf binary-string lines as UTF-8', () => {
  const encoded = unescape(encodeURIComponent('Grüße – ∑ 𝔸'))
  assert.equal(decodeLine(encoded), 'Grüße – ∑ 𝔸')
})

test('history-ot text drops tracked deletions only', () => {
  const raw = { content: 'keep DEL keep INS', trackedChanges: [
    { range: { pos: 5, length: 4 }, tracking: { type: 'delete' } },
    { range: { pos: 14, length: 3 }, tracking: { type: 'insert' } },
  ] }
  assert.equal(historyOtText(raw), 'keep keep INS')
})
