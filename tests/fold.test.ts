import { describe, expect, it } from 'vitest'
import { findFolded, fold, foldMap } from '../src/fold'
import { parseChangelog } from '../src/changelog'

describe('fold', () => {
  it('ignora acentos e maiúsculas', () => {
    expect(fold('Ação É Útil')).toBe('acao e util')
    expect(fold('café')).toBe('cafe')
  })

  it('mapeia de volta ao texto original', () => {
    const f = foldMap('Ação')
    expect(f.text).toBe('acao')
    expect(f.map).toEqual([0, 1, 2, 3])
  })

  it('acha o trecho no texto original', () => {
    expect(findFolded('Foi a AÇÃO de ontem', 'acao')).toEqual([6, 10])
    expect(findFolded('nada', 'acao')).toBeNull()
    expect(findFolded('x', '  ')).toBeNull()
  })
})

describe('novidades', () => {
  it('separa versões e itens', () => {
    const r = parseChangelog('# T\n\n## 1.0\n- a\n- b\n\n## 0.9\n- c\n')
    expect(r).toEqual([
      { version: '1.0', items: ['a', 'b'] },
      { version: '0.9', items: ['c'] }
    ])
  })
})
