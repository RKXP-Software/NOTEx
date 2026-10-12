// Área de trabalho: desenha a grade de painéis (layout.ts) com barras de abas, divisores
// arrastáveis e arrastar-e-soltar de abas (entre painéis ou para criar nova divisão).
// Os editores não são recriados: o `host` de cada documento é reaproveitado entre renderizações.

import type { Group, LayoutNode, Side } from '../layout'
import { stem } from '../naming'
import type { Doc } from '../doc'

export const TAB_MIME = 'application/x-notex-tab'
export const FILE_MIME = 'application/x-notex-file'

export interface WorkspaceActions {
  activate(groupId: string, tab: string): void
  close(tab: string): void
  /** Move aba para o grupo (posição opcional). */
  moveTab(tab: string, groupId: string, index?: number): void
  /** Cria nova divisão ao lado do grupo com a aba. */
  splitTab(tab: string, groupId: string, side: Side): void
  /** Abre arquivo arrastado da barra lateral no grupo, ou numa nova divisão. */
  openFile(path: string, groupId: string, side: Side | null, index?: number): void
  resize(path: number[], sizes: number[]): void
  tabMenu(tab: string, groupId: string, x: number, y: number): void
  groupMenu(groupId: string, x: number, y: number): void
}

type DropZone = Side | 'center'

/** Zona de soltura dentro do conteúdo de um painel: bordas (22%) dividem, centro move. */
export function dropZone(rect: DOMRect, x: number, y: number): DropZone {
  const fx = (x - rect.left) / rect.width
  const fy = (y - rect.top) / rect.height
  const edge = 0.22
  const d: [DropZone, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy]
  ]
  const [side, dist] = d.reduce((a, b) => (b[1] < a[1] ? b : a))
  return dist < edge ? side : 'center'
}

function hasDragType(e: DragEvent, type: string): boolean {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes(type)
}

export class Workspace {
  /** Aba sendo arrastada (dataTransfer.getData não é legível durante dragover). */
  private draggingTab: string | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: WorkspaceActions
  ) {}

  render(layout: LayoutNode, docs: Map<string, Doc>, focusedGroup: string): void {
    // Tira os editores do DOM antes de limpar, para não destruí-los.
    for (const d of docs.values()) d.host.remove()
    this.root.replaceChildren(this.node(layout, [], docs, focusedGroup))
  }

  private node(n: LayoutNode, path: number[], docs: Map<string, Doc>, focused: string): HTMLElement {
    if (n.type === 'group') return this.group(n, docs, n.id === focused)
    const el = document.createElement('div')
    el.className = `split split-${n.dir}`
    n.children.forEach((child, i) => {
      if (i > 0) el.appendChild(this.divider(el, n.dir, path, i, n.sizes))
      const c = this.node(child, [...path, i], docs, focused)
      c.style.flex = `${n.sizes[i] ?? 1} 1 0`
      el.appendChild(c)
    })
    return el
  }

  private divider(container: HTMLElement, dir: 'row' | 'column', path: number[], index: number, sizes: number[]): HTMLElement {
    const d = document.createElement('div')
    d.className = `divider divider-${dir}`
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      d.setPointerCapture(e.pointerId)
      const rect = container.getBoundingClientRect()
      const total = dir === 'row' ? rect.width : rect.height
      const start = dir === 'row' ? e.clientX : e.clientY
      const a = sizes[index - 1]!
      const b = sizes[index]!
      const min = Math.min(0.08, (a + b) / 2)
      const next = [...sizes]
      document.body.classList.add(dir === 'row' ? 'resizing-col' : 'resizing-row')
      const move = (ev: PointerEvent): void => {
        const delta = ((dir === 'row' ? ev.clientX : ev.clientY) - start) / total
        const na = Math.max(min, Math.min(a + b - min, a + delta))
        next[index - 1] = na
        next[index] = a + b - na
        const kids = [...container.children].filter((c) => !c.classList.contains('divider')) as HTMLElement[]
        kids[index - 1]!.style.flex = `${next[index - 1]} 1 0`
        kids[index]!.style.flex = `${next[index]} 1 0`
      }
      const up = (): void => {
        d.removeEventListener('pointermove', move)
        d.removeEventListener('pointerup', up)
        document.body.classList.remove('resizing-col', 'resizing-row')
        this.actions.resize(path, next)
      }
      d.addEventListener('pointermove', move)
      d.addEventListener('pointerup', up)
    })
    // Duplo clique: divide igualmente os dois vizinhos.
    d.addEventListener('dblclick', () => {
      const next = [...sizes]
      const avg = (next[index - 1]! + next[index]!) / 2
      next[index - 1] = avg
      next[index] = avg
      this.actions.resize(path, next)
    })
    return d
  }

  private group(g: Group, docs: Map<string, Doc>, focused: boolean): HTMLElement {
    const el = document.createElement('section')
    el.className = 'group' + (focused ? ' focused' : '')
    el.dataset.group = g.id

    const bar = document.createElement('div')
    bar.className = 'tabbar'
    bar.setAttribute('role', 'tablist')
    g.tabs.forEach((tab) => bar.appendChild(this.tab(g, tab, docs.get(tab))))
    bar.addEventListener('contextmenu', (e) => {
      if (e.target !== bar) return
      e.preventDefault()
      this.actions.groupMenu(g.id, e.clientX, e.clientY)
    })
    this.tabbarDrop(bar, g)
    el.appendChild(bar)

    const content = document.createElement('div')
    content.className = 'group-content'
    const active = g.active ? docs.get(g.active) : undefined
    if (active) content.appendChild(active.host)
    else content.appendChild(this.emptyHint())
    content.addEventListener('mousedown', () => {
      if (g.active) this.actions.activate(g.id, g.active)
    })
    this.contentDrop(content, g)
    el.appendChild(content)
    return el
  }

  private emptyHint(): HTMLElement {
    const hint = document.createElement('div')
    hint.className = 'empty-hint'
    hint.innerHTML =
      '<p><kbd>Ctrl</kbd>+<kbd>N</kbd> nova nota rápida</p><p><kbd>Ctrl</kbd>+<kbd>O</kbd> abrir arquivo</p><p>ou escolha uma nota na barra lateral</p>'
    return hint
  }

  private tab(g: Group, path: string, doc: Doc | undefined): HTMLElement {
    const t = document.createElement('div')
    const active = g.active === path
    t.className = 'tab' + (active ? ' active' : '') + (doc?.dirty ? ' dirty' : '') + (doc?.status === 'error' ? ' error' : '')
    t.setAttribute('role', 'tab')
    t.setAttribute('aria-selected', String(active))
    t.title = path
    t.draggable = true
    t.dataset.tab = path

    const label = document.createElement('span')
    label.className = 'tab-label'
    label.textContent = stem(path)
    const kind = document.createElement('span')
    kind.className = 'tab-kind'
    kind.textContent = doc?.kind === 'txt' ? 'txt' : ''
    const close = document.createElement('button')
    close.className = 'tab-close'
    close.title = 'Fechar (Ctrl+W)'
    close.setAttribute('aria-label', 'Fechar aba')
    close.textContent = '×'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      this.actions.close(path)
    })
    t.append(label, kind, close)

    t.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault()
    })
    t.addEventListener('click', () => this.actions.activate(g.id, path))
    t.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.actions.close(path)
    })
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.actions.tabMenu(path, g.id, e.clientX, e.clientY)
    })
    t.addEventListener('dragstart', (e) => {
      this.draggingTab = path
      e.dataTransfer!.setData(TAB_MIME, path)
      e.dataTransfer!.effectAllowed = 'move'
      t.classList.add('dragging')
    })
    t.addEventListener('dragend', () => {
      this.draggingTab = null
      t.classList.remove('dragging')
      this.clearDropMarks()
    })
    return t
  }

  private clearDropMarks(): void {
    this.root.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'))
    this.root.querySelectorAll('.drop-overlay').forEach((n) => n.remove())
  }

  /** Índice de inserção na barra de abas conforme a posição do ponteiro. */
  private tabIndexAt(bar: HTMLElement, x: number): { index: number; el: HTMLElement | null; after: boolean } {
    const tabs = [...bar.querySelectorAll<HTMLElement>('.tab')]
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i]!.getBoundingClientRect()
      if (x < r.left + r.width / 2) return { index: i, el: tabs[i]!, after: false }
    }
    return { index: tabs.length, el: tabs[tabs.length - 1] ?? null, after: true }
  }

  private tabbarDrop(bar: HTMLElement, g: Group): void {
    bar.addEventListener('dragover', (e) => {
      if (!hasDragType(e, TAB_MIME) && !hasDragType(e, FILE_MIME)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = hasDragType(e, TAB_MIME) ? 'move' : 'copy'
      this.clearDropMarks()
      const { el, after } = this.tabIndexAt(bar, e.clientX)
      el?.classList.add(after ? 'drop-after' : 'drop-before')
    })
    bar.addEventListener('dragleave', (e) => {
      if (!bar.contains(e.relatedTarget as Node)) this.clearDropMarks()
    })
    bar.addEventListener('drop', (e) => {
      e.preventDefault()
      this.clearDropMarks()
      let { index } = this.tabIndexAt(bar, e.clientX)
      const tab = e.dataTransfer!.getData(TAB_MIME)
      const file = e.dataTransfer!.getData(FILE_MIME)
      if (tab) {
        // Reordenando no mesmo grupo: compensa a remoção da posição original.
        const from = g.tabs.indexOf(tab)
        if (from >= 0 && from < index) index--
        this.actions.moveTab(tab, g.id, index)
      } else if (file) {
        this.actions.openFile(file, g.id, null, index)
      }
    })
  }

  /**
   * Soltura no conteúdo do painel. Os ouvintes ficam na fase de captura para que o editor
   * (ProseMirror/CodeMirror) não receba o arraste e insira o caminho como texto.
   */
  private contentDrop(content: HTMLElement, g: Group): void {
    let overlay: HTMLElement | null = null
    const show = (zone: DropZone): void => {
      if (!overlay) {
        overlay = document.createElement('div')
        overlay.className = 'drop-overlay'
        content.appendChild(overlay)
      }
      overlay.dataset.zone = zone
    }
    const hide = (): void => {
      overlay?.remove()
      overlay = null
    }
    content.addEventListener('dragover', (e) => {
      const isTab = hasDragType(e, TAB_MIME)
      if (!isTab && !hasDragType(e, FILE_MIME)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer!.dropEffect = isTab ? 'move' : 'copy'
      let zone = dropZone(content.getBoundingClientRect(), e.clientX, e.clientY)
      // Soltar a única aba do painel nas bordas dele mesmo não faz sentido.
      if (isTab && this.draggingTab && g.tabs.length === 1 && g.tabs[0] === this.draggingTab) zone = 'center'
      show(zone)
    }, true)
    content.addEventListener('dragleave', (e) => {
      if (!content.contains(e.relatedTarget as Node)) hide()
    })
    content.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const zone = (overlay?.dataset.zone as DropZone | undefined) ?? 'center'
      hide()
      const tab = e.dataTransfer!.getData(TAB_MIME)
      const file = e.dataTransfer!.getData(FILE_MIME)
      if (tab) {
        if (zone === 'center') this.actions.moveTab(tab, g.id)
        else this.actions.splitTab(tab, g.id, zone)
      } else if (file) {
        this.actions.openFile(file, g.id, zone === 'center' ? null : zone)
      }
    }, true)
  }
}
