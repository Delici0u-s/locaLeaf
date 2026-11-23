import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raceCompiles } from '../../extension/src/page/race'

const after = <T>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms))
const failAfter = (ms: number, msg: string) => new Promise<never>((_, j) => setTimeout(() => j(new Error(msg)), ms))

test('local done within the head start: the server is never asked', async () => {
  let asked = false
  const w = await raceCompiles(after(5, 'L'), () => { asked = true; return after(1, 'S') }, 50)
  assert.deepEqual(w, { from: 'local', value: 'L' })
  assert.equal(asked, false)
})

test('local fails within the head start: its error, no server', async () => {
  let asked = false
  await assert.rejects(raceCompiles(failAfter(5, 'boom'), () => { asked = true; return after(1, 'S') }, 50), /boom/)
  assert.equal(asked, false)
})

test('slow local: the server starts after the head start and wins', async () => {
  const w = await raceCompiles(after(200, 'L'), () => after(10, 'S'), 20)
  assert.deepEqual(w, { from: 'server', value: 'S' })
})

test('local still wins if it finishes before the server', async () => {
  const w = await raceCompiles(after(40, 'L'), () => after(500, 'S'), 10)
  assert.deepEqual(w, { from: 'local', value: 'L' })
})

test('one side failing hands the win to the other', async () => {
  assert.deepEqual(await raceCompiles(failAfter(30, 'local broke'), () => after(80, 'S'), 10), { from: 'server', value: 'S' })
  assert.deepEqual(await raceCompiles(after(80, 'L'), () => failAfter(5, 'server broke'), 10), { from: 'local', value: 'L' })
  assert.deepEqual(await raceCompiles(after(80, 'L'), () => { throw new Error('sync throw') }, 10), { from: 'local', value: 'L' })
})

test('both failing throws the local error', async () => {
  await assert.rejects(raceCompiles(failAfter(30, 'local broke'), () => failAfter(5, 'server broke'), 10), /local broke/)
  await assert.rejects(raceCompiles(failAfter(30, 'local broke'), () => failAfter(60, 'server broke'), 10), /local broke/)
})

test('head start 0 starts the server at once', async () => {
  let asked = false
  await raceCompiles(after(20, 'L'), () => { asked = true; return after(100, 'S') }, 0)
  assert.equal(asked, true)
})
