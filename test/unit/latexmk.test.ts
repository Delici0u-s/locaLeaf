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

import { missingFiles, missingPackages } from '../../extension/src/engine/latexmk'

test('reads missing-file errors from a TeX log', () => {
  const log = [
    "! LaTeX Error: File `kaobook.cls' not found.",
    "! I can't find file `chapterz/intro'.",
    '! Font \\T1/abc/m/n/10=abcr8t at 10.0pt not loadable: Metric (TFM) file not found.',
  ].join('\n')
  assert.deepEqual(missingFiles(log), ['kaobook.cls', 'chapterz/intro', 'abcr8t.tfm'])
})

test('a missing package is not a mistyped project file', () => {
  const sources = ['main.tex', 'chapters/intro.tex', 'mystyle.sty']
  assert.deepEqual(missingPackages(['kaobook.cls', 'chapterz/intro', 'mystyle.sty', 'abcr8t.tfm'], sources), ['kaobook.cls', 'abcr8t.tfm'])
})

import { needsShellEscape } from '../../extension/src/engine/latexmk'

test('shell escape is only reported when it caused errors', () => {
  const minted = 'Package shellesc Warning: Shell escape disabled on input line 73.\n! Package minted Error: Cannot highlight code (minted executable is unavailable\n'
  assert.equal(needsShellEscape(minted), true)
  assert.equal(needsShellEscape('Package shellesc Warning: Shell escape disabled on input line 73.\nno errors here\n'), false)
})

test('an ordinary error is not a shell-escape problem', () => {
  const header = 'This is pdfTeX, Version 3.141592653-2.6-1.40.28 (TeX Live 2026)\n restricted \\write18 enabled.\n'
  assert.equal(needsShellEscape(`${header}! Undefined control sequence.\nl.12 \\foo\n`), false)
  assert.equal(needsShellEscape(`${header}! Emergency stop.\n<*> main.tex\n\n*** (job aborted, no legal \\end found)\n`), false)
  // a shell-escape warning elsewhere doesn't make a typo a shell-escape problem
  assert.equal(needsShellEscape(`${header}Package shellesc Warning: Shell escape disabled on input line 3.\n! Undefined control sequence.\nl.12 \\foo\n`), false)
})

test('shell-escape errors are recognised', () => {
  assert.equal(needsShellEscape('! Package minted Error: You must invoke LaTeX with the -shell-escape flag.\n\nSee the minted package documentation for explanation.\n'), true)
  assert.equal(needsShellEscape("! Package svg Error: You didn't enable `shell escape' (or `write18')\n(svg)                so it wasn't possible to launch the Inkscape export\n"), true)
})
