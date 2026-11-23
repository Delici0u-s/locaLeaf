import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { editPosition, parseSyncTex, projectPath, viewPositions } from '../../extension/src/page/synctex-parse'

// Real output of the engine for test/e2e/projects/basic (projectRoot /home/web_user/olr/t).
const ROOT_DIR = '/home/web_user/olr/t'
const data = parseSyncTex(readFileSync(join(import.meta.dirname, '../fixtures/basic.synctex'), 'utf8'))
const tagsFor = (file: string) => [...data.inputs].filter(([, p]) => projectPath(p, '', ROOT_DIR) === file).map(([t]) => t)

test('maps recorded paths to project paths', () => {
  assert.equal(projectPath('/home/web_user/olr/t/./main.tex', '', ROOT_DIR), 'main.tex')
  assert.equal(projectPath('/home/web_user/olr/t/./chapters/second.tex', '', ROOT_DIR), 'chapters/second.tex')
  assert.equal(projectPath('./part.tex', 'doc', ROOT_DIR), 'doc/part.tex')
  assert.equal(projectPath('../shared/x.tex', 'doc', ROOT_DIR), 'shared/x.tex')
  assert.equal(projectPath('/texlive/texmf-dist/tex/latex/base/article.cls', '', ROOT_DIR), null)
})

test('forward search finds the line box of a paragraph line', () => {
  const pos = viewPositions(data, tagsFor('main.tex'), 7)
  assert.ok(pos.length >= 1)
  const p = pos[0]
  assert.equal(p.page, 1)
  // article text block starts ~133.8 bp from the left; the line sits a bit under 300 bp from the top
  assert.ok(p.h > 120 && p.h < 150, `h=${p.h}`)
  assert.ok(p.v > 280 && p.v < 310, `v=${p.v}`)
  assert.ok(p.width > 300 && p.height > 5)
})

test('forward search in an \\input file', () => {
  assert.ok(viewPositions(data, tagsFor('chapters/second.tex'), 2).length >= 1)
})

test('reverse search returns the source line under a point', () => {
  const p = viewPositions(data, tagsFor('main.tex'), 7)[0]
  const hit = editPosition(data, p.page, p.h + 60, p.v - 3)
  assert.ok(hit)
  assert.equal(projectPath(data.inputs.get(hit.tag)!, '', ROOT_DIR), 'main.tex')
  assert.equal(hit.line, 7)
})
