import { describe, expect, it } from 'vitest'
import type { Term } from '../src/api'
import { TermMatcher } from '../src/glossary'

const t = (term: string, definition = 'def'): Term => ({ term, definition, notebookId: 'a', notebookName: 'A', path: 'C:/A/g.md', line: 1 })

describe('TermMatcher', () => {
  const m = new TermMatcher([t('Ação'), t('PDF/X'), t('Padrão ISO'), t('Padrão'), t('x')])

  it('acha termos sem se importar com acento e maiúsculas', () => {
    const hits = m.find('A ACAO foi aprovada; veja a ação.')
    expect(hits.map((h) => [h.from, h.to])).toEqual([
      [2, 6],
      [28, 32]
    ])
    expect(m.definitions(hits[0]!.key)[0]!.term).toBe('Ação')
  })

  it('só marca palavra inteira', () => {
    expect(m.find('reação, ações, caração')).toEqual([])
    expect(m.find('(ação)')).toHaveLength(1)
  })

  it('termo maior ganha do menor e termos de uma letra são ignorados', () => {
    const hits = m.find('o Padrão ISO e o padrão x')
    expect(hits.map((h) => 'o Padrão ISO e o padrão x'.slice(h.from, h.to))).toEqual(['Padrão ISO', 'padrão'])
  })

  it('termo com símbolos', () => {
    expect(m.find('usar PDF/X na gráfica')).toHaveLength(1)
  })

  it('não marca a própria linha de definição', () => {
    expect(m.find('Ação: o que se faz')).toEqual([])
    expect(m.find('Ação:: o que se faz')).toEqual([])
    expect(m.find('  Ação: com recuo')).toEqual([])
    expect(m.find('veja Ação: aqui')).toHaveLength(1)
  })

  it('mesmo termo em dois cadernos devolve as duas definições', () => {
    const two = new TermMatcher([t('Nota', 'um'), { ...t('nota', 'dois'), notebookId: 'b' }])
    const h = two.find('uma nota')[0]!
    expect(two.definitions(h.key).map((d) => d.definition)).toEqual(['um', 'dois'])
  })

  it('sem termos não acha nada', () => {
    expect(new TermMatcher([]).find('qualquer coisa')).toEqual([])
  })
})
