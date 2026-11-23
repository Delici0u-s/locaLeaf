// Racing a cold local compile against the server: the local compile gets a head start; if it isn't done by
// then, the server compiles too and whichever result arrives first is shown.

export interface Winner<T> {
  from: 'local' | 'server'
  value: T
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

const settle = <T>(p: Promise<T>): Promise<Outcome<T>> => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * `local` runs alone for `headStartMs`. If it settles in that time, its outcome is final and the server is
 * never asked. Otherwise `startServer()` runs too and the first success wins; if one side fails, the other's
 * outcome counts; if both fail, the local error is thrown (the caller's usual fallback handles it).
 */
export async function raceCompiles<T>(local: Promise<T>, startServer: () => Promise<T>, headStartMs: number, wait: (ms: number) => Promise<void> = sleep): Promise<Winner<T>> {
  const l = settle(local)
  const early = await Promise.race([l, wait(headStartMs).then(() => null)])
  if (early) {
    if (early.ok) return { from: 'local', value: early.value }
    throw early.error
  }
  let s: Promise<Outcome<T>>
  try {
    s = settle(startServer())
  } catch (error) {
    s = Promise.resolve({ ok: false, error })
  }
  const first = await Promise.race([l.then(o => ({ from: 'local' as const, o })), s.then(o => ({ from: 'server' as const, o }))])
  if (first.o.ok) return { from: first.from, value: first.o.value }
  const otherFrom = first.from === 'local' ? 'server' : 'local'
  const other = await (otherFrom === 'local' ? l : s)
  if (other.ok) return { from: otherFrom, value: other.value }
  throw first.from === 'local' ? first.o.error : (other as { error: unknown }).error
}
