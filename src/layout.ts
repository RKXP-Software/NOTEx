// Grade de painéis: árvore de divisões (linha/coluna) cujas folhas são grupos de abas.
// Funções puras: recebem a raiz e devolvem uma nova raiz (sem mutar a original).
// Uma aba é identificada pelo caminho do arquivo; um arquivo fica aberto em uma aba só.

export interface Group {
  type: 'group'
  id: string
  tabs: string[]
  active: string | null
}

export interface Split {
  type: 'split'
  /** 'row' = filhos lado a lado (colunas); 'column' = empilhados (linhas). */
  dir: 'row' | 'column'
  children: LayoutNode[]
  /** Frações (somam 1), uma por filho. */
  sizes: number[]
}

export type LayoutNode = Group | Split
export type Side = 'left' | 'right' | 'top' | 'bottom'

export function newGroup(id: string, tabs: string[] = []): Group {
  return { type: 'group', id, tabs, active: tabs[0] ?? null }
}

export function allGroups(node: LayoutNode): Group[] {
  return node.type === 'group' ? [node] : node.children.flatMap(allGroups)
}

export function findGroup(root: LayoutNode, id: string): Group | undefined {
  return allGroups(root).find((g) => g.id === id)
}

export function groupOfTab(root: LayoutNode, tab: string): Group | undefined {
  return allGroups(root).find((g) => g.tabs.includes(tab))
}

/** Aplica `f` a cada grupo, devolvendo nova árvore. */
function mapGroups(node: LayoutNode, f: (g: Group) => Group): LayoutNode {
  if (node.type === 'group') return f(node)
  return { ...node, children: node.children.map((c) => mapGroups(c, f)) }
}

/** Aba vizinha a ativar quando `tab` sai do grupo (a da direita, senão a da esquerda). */
function neighborTab(g: Group, tab: string): string | null {
  const i = g.tabs.indexOf(tab)
  const rest = g.tabs.filter((t) => t !== tab)
  if (g.active !== tab) return g.active
  return rest[Math.min(i, rest.length - 1)] ?? null
}

function without(g: Group, tab: string): Group {
  if (!g.tabs.includes(tab)) return g
  return { ...g, tabs: g.tabs.filter((t) => t !== tab), active: neighborTab(g, tab) }
}

function withTab(g: Group, tab: string, index?: number): Group {
  const tabs = g.tabs.filter((t) => t !== tab)
  const at = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length))
  tabs.splice(at, 0, tab)
  return { ...g, tabs, active: tab }
}

/**
 * Remove grupos vazios (exceto se for o único), desfaz divisões com um filho só e funde
 * divisões aninhadas na mesma direção. Renormaliza os tamanhos.
 */
export function normalize(root: LayoutNode): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'group') return node.tabs.length > 0 ? node : null
    const kids: LayoutNode[] = []
    const sizes: number[] = []
    node.children.forEach((child, i) => {
      const n = walk(child)
      if (!n) return
      const size = node.sizes[i] ?? 1 / node.children.length
      if (n.type === 'split' && n.dir === node.dir) {
        n.children.forEach((c, j) => {
          kids.push(c)
          sizes.push(size * (n.sizes[j] ?? 1 / n.children.length))
        })
      } else {
        kids.push(n)
        sizes.push(size)
      }
    })
    if (kids.length === 0) return null
    if (kids.length === 1) return kids[0]!
    const total = sizes.reduce((a, b) => a + b, 0) || 1
    return { ...node, children: kids, sizes: sizes.map((s) => s / total) }
  }
  const result = walk(root)
  if (result) return result
  // Tudo vazio: mantém um grupo (o primeiro) como área de trabalho.
  const first = allGroups(root)[0]
  return newGroup(first?.id ?? 'g1')
}

export function setActive(root: LayoutNode, groupId: string, tab: string): LayoutNode {
  return mapGroups(root, (g) => (g.id === groupId && g.tabs.includes(tab) ? { ...g, active: tab } : g))
}

/** Abre `tab` no grupo (ou só ativa, se já estiver nele). Se estiver em outro grupo, move. */
export function addTab(root: LayoutNode, groupId: string, tab: string, index?: number): LayoutNode {
  const current = groupOfTab(root, tab)
  if (current?.id === groupId && index === undefined) return setActive(root, groupId, tab)
  const moved = mapGroups(root, (g) => (g.id === groupId ? withTab(g, tab, index) : without(g, tab)))
  return normalize(moved)
}

export function removeTab(root: LayoutNode, tab: string): LayoutNode {
  return normalize(mapGroups(root, (g) => without(g, tab)))
}

export function renameTab(root: LayoutNode, from: string, to: string): LayoutNode {
  return mapGroups(root, (g) =>
    g.tabs.includes(from)
      ? { ...g, tabs: g.tabs.map((t) => (t === from ? to : t)), active: g.active === from ? to : g.active }
      : g
  )
}

/**
 * Tira `tab` de onde estiver e cria um novo grupo `newId` com ela, ao lado (`side`) do grupo
 * `targetId`. Se o alvo é o próprio grupo da aba e ela é a única, não faz nada.
 */
export function splitWithTab(root: LayoutNode, tab: string, targetId: string, side: Side, newId: string): LayoutNode {
  const target = findGroup(root, targetId)
  if (!target) return root
  if (target.tabs.length === 1 && target.tabs[0] === tab) return root
  const dir: Split['dir'] = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'top'
  const fresh = newGroup(newId, [tab])

  const insert = (node: LayoutNode): LayoutNode => {
    if (node.type === 'group') {
      if (node.id !== targetId) return node
      const t = without(node, tab)
      return { type: 'split', dir, children: before ? [fresh, t] : [t, fresh], sizes: [0.5, 0.5] }
    }
    // Se o alvo é filho direto de uma divisão na mesma direção, insere ao lado em vez de aninhar.
    const idx = node.children.findIndex((c) => c.type === 'group' && c.id === targetId)
    if (idx >= 0 && node.dir === dir) {
      const children = node.children.map((c) => (c.type === 'group' && c.id === targetId ? without(c, tab) : c))
      const sizes = [...node.sizes]
      const half = (sizes[idx] ?? 1 / node.children.length) / 2
      sizes[idx] = half
      const at = before ? idx : idx + 1
      children.splice(at, 0, fresh)
      sizes.splice(at, 0, half)
      return { ...node, children, sizes }
    }
    return { ...node, children: node.children.map(insert) }
  }

  // Primeiro tira a aba dos outros grupos (o alvo é tratado em `insert`).
  const detached = mapGroups(root, (g) => (g.id === targetId ? g : without(g, tab)))
  return normalize(insert(detached))
}

/** Ajusta os tamanhos de uma divisão identificada pelo caminho de índices desde a raiz. */
export function resize(root: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (path.length === 0) {
    return root.type === 'split' ? { ...root, sizes } : root
  }
  if (root.type !== 'split') return root
  const [head, ...rest] = path
  return { ...root, children: root.children.map((c, i) => (i === head ? resize(c, rest, sizes) : c)) }
}

/** Valida uma árvore lida da sessão salva; null se inválida. */
export function parseLayout(value: unknown): LayoutNode | null {
  const v = value as Partial<LayoutNode> | null
  if (!v || typeof v !== 'object') return null
  if (v.type === 'group') {
    const g = v as Partial<Group>
    if (typeof g.id !== 'string' || !Array.isArray(g.tabs) || !g.tabs.every((t) => typeof t === 'string')) return null
    const active = typeof g.active === 'string' && g.tabs.includes(g.active) ? g.active : (g.tabs[0] ?? null)
    return { type: 'group', id: g.id, tabs: [...g.tabs], active }
  }
  if (v.type === 'split') {
    const s = v as Partial<Split>
    if ((s.dir !== 'row' && s.dir !== 'column') || !Array.isArray(s.children)) return null
    const children = s.children.map(parseLayout)
    if (children.some((c) => c === null) || children.length === 0) return null
    const sizes =
      Array.isArray(s.sizes) && s.sizes.length === children.length && s.sizes.every((n) => typeof n === 'number' && n > 0)
        ? s.sizes
        : children.map(() => 1 / children.length)
    return { type: 'split', dir: s.dir, children: children as LayoutNode[], sizes }
  }
  return null
}
