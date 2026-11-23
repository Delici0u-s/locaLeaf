import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDraft, bibtexKey, countErrors, DRAFT_PREFIX, hashBytes } from '../../extension/src/engine/latexmk'

test('bibtexKey is null without \\bibdata and changes with citations', () => {
  assert.equal(bibtexKey(['\\relax\n\\citation{a}\n']), null)
  const a = bibtexKey(['\\citation{a}\n\\bibdata{refs}\n\\bibstyle{plain}\n'])
  const b = bibtexKey(['\\citation{a}\n\\citation{b}\n\\bibdata{refs}\n\\bibstyle{plain}\n'])
  assert.ok(a && b && a !== b)
  assert.equal(bibtexKey(['\\citation{a}\n\\newlabel{x}{1}\n\\bibdata{refs}\n']), bibtexKey(['\\citation{a}\n\\newlabel{x}{2}\n\\bibdata{refs}\n']))
})

test('counts TeX error lines', () => {
  assert.equal(countErrors('ok\n! Undefined control sequence.\nl.4 ...\n! Missing $ inserted.\n'), 2)
})

test('draft mode prefixes the main file like CLSI', () => {
  const out = new TextDecoder().decode(applyDraft(new TextEncoder().encode('\\documentclass{article}'), true))
  assert.ok(out.startsWith(DRAFT_PREFIX))
  assert.equal(new TextDecoder().decode(applyDraft(new TextEncoder().encode('x'), false)), 'x')
})

test('hash differs for different content and length', () => {
  const e = new TextEncoder()
  assert.notEqual(hashBytes(e.encode('a')), hashBytes(e.encode('b')))
  assert.notEqual(hashBytes(e.encode('a')), hashBytes(e.encode('a\0')))
  assert.equal(hashBytes(e.encode('same')), hashBytes(e.encode('same')))
})

import { fontKey, missingFonts } from '../../extension/src/engine/latexmk'

test('reads fontspec "cannot be found" errors, including wrapped lines', () => {
  const log = [
    '! Package fontspec Error: ',
    '(fontspec)                The font "Source Sans 3 Light Italic" cannot be',
    '(fontspec)                found; this may be but usually is not a fontspec bug.',
    '! Package fontspec Error: ',
    '(fontspec)                The font "Roboto" cannot be found; this may',
    '(fontspec)                The font "Roboto" cannot be found; this may',
  ].join('\n')
  assert.deepEqual(missingFonts(log), ['Source Sans 3 Light Italic', 'Roboto'])
  assert.deepEqual(missingFonts('no problems'), [])
})

test('font keys match the index normalization', () => {
  assert.equal(fontKey('Source Sans 3 Light'), 'sourcesans3light')
  assert.equal(fontKey('TeX_Gyre-Termes'), 'texgyretermes')
})
