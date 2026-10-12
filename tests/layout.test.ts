import { describe, expect, it } from 'vitest'
import {
  addTab,
  allGroups,
  flatten,
  groupOfTab,
  newGroup,
  normalize,
  parseLayout,
  removeTab,
  renameTab,
  resize,
  splitWithTab,
  type LayoutNode,
  type Split
} from '../src/layout'

const tabsOf = (root: LayoutNode): string[][] => allGroups(root).map((g) => g.tabs)

describe('abas', () => {
  it('adiciona, ativa e não duplica', () => {
    let l: LayoutNode = newGroup('g1')
    l = addTab(l, 'g1', 'a')
    l = addTab(l, 'g1', 'b')
    l = addTab(l, 'g1', 'a')
    expect(tabsOf(l)).toEqual([['a', 'b']])
    expect(l.type === 'group' && l.active).toBe('a')
  })

  it('reordena com índice', () => {
    let l: LayoutNode = newGroup('g1', ['a', 'b', 'c'])
    l = addTab(l, 'g1', 'c', 0)
    expect(tabsOf(l)).toEqual([['c', 'a', 'b']])
  })

  it('ao fechar a aba ativa, ativa a vizinha da direita (ou esquerda)', () => {
    let l: LayoutNode = { ...newGroup('g1', ['a', 'b', 'c']), active: 'b' }
    l = removeTab(l, 'b')
    expect(l.type === 'group' && l.active).toBe('c')
    l = removeTab(l, 'c')
    expect(l.type === 'group' && l.active).toBe('a')
  })

  it('fechar a última aba mantém um grupo vazio', () => {
    const l = removeTab(newGroup('g1', ['a']), 'a')
    expect(l).toEqual({ type: 'group', id: 'g1', tabs: [], active: null })
  })

  it('renomeia aba preservando a ativa', () => {
    const l = renameTab({ ...newGroup('g1', ['a', 'b']), active: 'a' }, 'a', 'x')
    expect(l).toMatchObject({ tabs: ['x', 'b'], active: 'x' })
  })
})

describe('divisões', () => {
  it('divide à direita criando colunas', () => {
    const l = splitWithTab(newGroup('g1', ['a', 'b']), 'b', 'g1', 'right', 'g2') as Split
    expect(l.type).toBe('split')
    expect(l.dir).toBe('row')
    expect(tabsOf(l)).toEqual([['a'], ['b']])
    expect(l.sizes).toEqual([0.5, 0.5])
  })

  it('divide à esquerda e acima na ordem certa', () => {
    const left = splitWithTab(newGroup('g1', ['a', 'b']), 'b', 'g1', 'left', 'g2')
    expect(tabsOf(left)).toEqual([['b'], ['a']])
    const top = splitWithTab(newGroup('g1', ['a', 'b']), 'b', 'g1', 'top', 'g2') as Split
    expect(top.dir).toBe('column')
    expect(tabsOf(top)).toEqual([['b'], ['a']])
  })

  it('terceira coluna entra ao lado, sem aninhar', () => {
    let l: LayoutNode = newGroup('g1', ['a', 'b', 'c'])
    l = splitWithTab(l, 'b', 'g1', 'right', 'g2')
    l = splitWithTab(l, 'c', 'g2', 'right', 'g3')
    expect(l.type === 'split' && l.children.length).toBe(3)
    expect(tabsOf(l)).toEqual([['a'], ['b'], ['c']])
    const sizes = (l as Split).sizes
    expect(sizes.reduce((a, b) => a + b)).toBeCloseTo(1)
    expect(sizes).toEqual([0.5, 0.25, 0.25])
  })

  it('grade: coluna dividida em linhas', () => {
    let l: LayoutNode = newGroup('g1', ['a', 'b', 'c'])
    l = splitWithTab(l, 'b', 'g1', 'right', 'g2')
    l = splitWithTab(l, 'c', 'g2', 'bottom', 'g3')
    const root = l as Split
    expect(root.dir).toBe('row')
    const right = root.children[1] as Split
    expect(right.dir).toBe('column')
    expect(tabsOf(right)).toEqual([['b'], ['c']])
  })

  it('arrastar a única aba de um painel para outro remove o painel vazio', () => {
    let l: LayoutNode = newGroup('g1', ['a', 'b'])
    l = splitWithTab(l, 'b', 'g1', 'right', 'g2')
    l = addTab(l, 'g1', 'b')
    expect(l.type).toBe('group')
    expect(tabsOf(l)).toEqual([['a', 'b']])
  })

  it('dividir com a única aba do próprio painel não faz nada', () => {
    const l = newGroup('g1', ['a'])
    expect(splitWithTab(l, 'a', 'g1', 'right', 'g2')).toBe(l)
  })

  it('mover aba de outro painel para a borda de um terceiro', () => {
    let l: LayoutNode = newGroup('g1', ['a', 'b', 'c'])
    l = splitWithTab(l, 'b', 'g1', 'right', 'g2') // [a,c] | [b]
    l = splitWithTab(l, 'c', 'g2', 'bottom', 'g3') // [a] | ([b] / [c])
    l = splitWithTab(l, 'c', 'g1', 'top', 'g4') // ([c] / [a]) | [b]
    expect(tabsOf(l)).toEqual([['c'], ['a'], ['b']])
    expect(groupOfTab(l, 'c')!.id).toBe('g4')
  })

  it('redimensiona por caminho de índices', () => {
    let l: LayoutNode = newGroup('g1', ['a', 'b'])
    l = splitWithTab(l, 'b', 'g1', 'right', 'g2')
    l = resize(l, [], [0.3, 0.7])
    expect((l as Split).sizes).toEqual([0.3, 0.7])
  })
})

describe('flatten (celular)', () => {
  it('junta a grade num grupo, mantendo o foco', () => {
    let l: LayoutNode = newGroup('g1', ['a', 'b', 'c'])
    l = splitWithTab(l, 'b', 'g1', 'right', 'g2')
    l = splitWithTab(l, 'c', 'g2', 'bottom', 'g3')
    const f = flatten(l, 'g3')
    expect(f).toEqual({ type: 'group', id: 'g3', tabs: ['a', 'b', 'c'], active: 'c' })
  })

  it('grupo único fica igual', () => {
    const g = { ...newGroup('g1', ['a', 'b']), active: 'b' }
    expect(flatten(g, 'g1')).toEqual(g)
  })
})

describe('normalize', () => {
  it('funde divisões aninhadas na mesma direção', () => {
    const l: LayoutNode = {
      type: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        newGroup('g1', ['a']),
        { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [newGroup('g2', ['b']), newGroup('g3', ['c'])] }
      ]
    }
    const n = normalize(l) as Split
    expect(n.children.length).toBe(3)
    expect(n.sizes).toEqual([0.5, 0.25, 0.25])
  })
})

describe('parseLayout (sessão salva)', () => {
  it('aceita árvore válida e corrige ativa/tamanhos', () => {
    const l = parseLayout({
      type: 'split',
      dir: 'row',
      sizes: [1],
      children: [
        { type: 'group', id: 'g1', tabs: ['a'], active: 'zzz' },
        { type: 'group', id: 'g2', tabs: ['b'], active: 'b' }
      ]
    }) as Split
    expect(l.sizes).toEqual([0.5, 0.5])
    expect(allGroups(l)[0]!.active).toBe('a')
  })

  it('recusa lixo', () => {
    expect(parseLayout(null)).toBeNull()
    expect(parseLayout({ type: 'group', id: 1, tabs: [] })).toBeNull()
    expect(parseLayout({ type: 'split', dir: 'diagonal', children: [] })).toBeNull()
    expect(parseLayout({ type: 'split', dir: 'row', children: [] })).toBeNull()
  })
})
