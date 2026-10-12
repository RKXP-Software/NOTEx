// Barra lateral: cadernos e árvore de pastas/notas, com menus de contexto e arrastar para mover.

import { QUICK_NOTEBOOK_ID, type Notebook, type TreeEntry } from '../api'
import { samePath } from '../naming'
import { showMenu, type MenuEntry } from './dialogs'
import { FILE_MIME } from './workspace'

const ENTRY_MIME = 'application/x-notex-entry'

export interface SidebarActions {
  open(path: string, opts?: { side?: boolean }): void
  newNote(dir: string, ext: 'md' | 'txt'): void
  newFolder(parent: string): void
  rename(path: string): void
  trash(path: string, isDir: boolean): void
  move(path: string, destDir: string): void
  newNotebook(): void
  addExistingFolder(): void
  renameNotebook(nb: Notebook): void
  removeNotebook(nb: Notebook): void
  moveNotebook(nb: Notebook): void
  chooseRoot(): void
  /** Escolher ícone de pasta (`isNotebook` = raiz do caderno). */
  chooseIcon(path: string, current: string | undefined, isNotebook: boolean): void
  convert(path: string): void
  reveal(path: string): void
  /** Estado de expansão mudou (salvar na sessão). */
  expandedChanged(): void
}

export class Sidebar {
  /** Chaves expandidas: id de caderno ("nb:<id>") ou caminho de pasta. */
  readonly expanded = new Set<string>()
  private notebooks: Notebook[] = []
  private trees = new Map<string, TreeEntry[]>()
  private activePath: string | null = null
  private readonly list: HTMLElement

  /** desktop: mostra ações que dependem do disco do PC (escolher pastas, Explorer). */
  constructor(
    root: HTMLElement,
    private readonly desktop: boolean,
    private readonly actions: SidebarActions
  ) {
    root.replaceChildren()
    const head = document.createElement('div')
    head.className = 'sidebar-head'
    head.innerHTML = '<span>Cadernos</span>'
    const add = document.createElement('button')
    add.className = 'icon-btn'
    add.title = 'Novo caderno'
    add.setAttribute('aria-label', 'Novo caderno')
    add.textContent = '+'
    add.addEventListener('click', (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      showMenu(r.left, r.bottom + 2, [
        { label: 'Novo caderno…', action: () => actions.newNotebook() },
        ...(desktop
          ? ([
              { label: 'Adicionar pasta existente…', action: () => actions.addExistingFolder() },
              'sep',
              { label: 'Pasta padrão dos cadernos…', action: () => actions.chooseRoot() }
            ] as MenuEntry[])
          : [])
      ])
    })
    head.appendChild(add)
    this.list = document.createElement('div')
    this.list.className = 'tree'
    this.list.setAttribute('role', 'tree')
    root.append(head, this.list)
  }

  /** Itens de menu só para desktop. */
  private desk(items: MenuEntry[]): MenuEntry[] {
    return this.desktop ? items : []
  }

  setData(notebooks: Notebook[], trees: Map<string, TreeEntry[]>): void {
    this.notebooks = notebooks
    this.trees = trees
    this.render()
  }

  setActive(path: string | null): void {
    this.activePath = path
    this.list.querySelectorAll('.node.active').forEach((n) => n.classList.remove('active'))
    if (!path) return
    for (const n of this.list.querySelectorAll<HTMLElement>('.node[data-path]')) {
      if (samePath(n.dataset.path!, path)) n.classList.add('active')
    }
  }

  /** Expande o caderno e as pastas até o caminho e destaca a nota. */
  revealPath(nb: Notebook, path: string): void {
    this.expanded.add(`nb:${nb.id}`)
    let dir = path
    while (true) {
      const i = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      if (i <= nb.path.length) break
      dir = dir.slice(0, i)
      this.expanded.add(dir)
    }
    this.render()
    this.setActive(path)
    this.list.querySelector('.node.active')?.scrollIntoView({ block: 'nearest' })
  }

  private render(): void {
    const scroll = this.list.scrollTop
    this.list.replaceChildren(...this.notebooks.map((nb) => this.notebookNode(nb)))
    this.list.scrollTop = scroll
    this.setActive(this.activePath)
  }

  private toggle(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key)
    else this.expanded.add(key)
    this.render()
    this.actions.expandedChanged()
  }

  private notebookNode(nb: Notebook): HTMLElement {
    const key = `nb:${nb.id}`
    const open = this.expanded.has(key)
    const wrap = document.createElement('div')
    const row = this.row({
      label: nb.name,
      depth: 0,
      icon: nb.icon ?? (nb.id === QUICK_NOTEBOOK_ID ? '⚡' : '📓'),
      twisty: open ? '▾' : '▸',
      cls: 'notebook',
      title: nb.path
    })
    row.addEventListener('click', () => this.toggle(key))
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, this.notebookMenu(nb))
    })
    this.dropTarget(row, nb.path)
    wrap.appendChild(row)
    if (open) {
      const kids = this.trees.get(nb.id) ?? []
      if (kids.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'tree-empty'
        empty.style.paddingLeft = '34px'
        empty.textContent = 'Vazio'
        wrap.appendChild(empty)
      }
      for (const e of kids) wrap.appendChild(this.entryNode(e, 1))
    }
    return wrap
  }

  private notebookMenu(nb: Notebook): MenuEntry[] {
    const quick = nb.id === QUICK_NOTEBOOK_ID
    return [
      { label: 'Nova nota', action: () => this.actions.newNote(nb.path, 'md') },
      { label: 'Nova nota de texto (.txt)', action: () => this.actions.newNote(nb.path, 'txt') },
      { label: 'Nova pasta…', action: () => this.actions.newFolder(nb.path) },
      'sep',
      { label: 'Renomear caderno…', action: () => this.actions.renameNotebook(nb) },
      { label: 'Escolher ícone…', action: () => this.actions.chooseIcon(nb.path, nb.icon, true) },
      ...this.desk([
        { label: 'Mover caderno para outra pasta…', action: () => this.actions.moveNotebook(nb) },
        { label: 'Abrir pasta no Explorer', action: () => this.actions.reveal(nb.path) }
      ]),
      { label: 'Remover da lista', disabled: quick, action: () => this.actions.removeNotebook(nb) }
    ]
  }

  private entryNode(e: TreeEntry, depth: number): HTMLElement {
    if (!e.isDir) {
      const row = this.row({ label: e.name, depth, icon: e.name.toLowerCase().endsWith('.txt') ? '≡' : '¶', cls: 'file', title: e.path })
      row.dataset.path = e.path
      row.draggable = this.desktop
      row.addEventListener('click', () => this.actions.open(e.path))
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        showMenu(ev.clientX, ev.clientY, [
          { label: 'Abrir', action: () => this.actions.open(e.path) },
          ...this.desk([{ label: 'Abrir ao lado', action: () => this.actions.open(e.path, { side: true }) }]),
          'sep',
          { label: 'Renomear…', shortcut: 'F2', action: () => this.actions.rename(e.path) },
          {
            label: e.name.toLowerCase().endsWith('.txt') ? 'Converter para .md' : 'Converter para .txt',
            action: () => this.actions.convert(e.path)
          },
          ...this.desk([{ label: 'Mostrar no Explorer', action: () => this.actions.reveal(e.path) }]),
          { label: 'Apagar', danger: true, action: () => this.actions.trash(e.path, false) }
        ])
      })
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer!.setData(FILE_MIME, e.path)
        ev.dataTransfer!.setData(ENTRY_MIME, e.path)
        ev.dataTransfer!.effectAllowed = 'copyMove'
      })
      return row
    }
    const open = this.expanded.has(e.path)
    const wrap = document.createElement('div')
    const row = this.row({ label: e.name, depth, icon: e.icon ?? (open ? '📂' : '📁'), twisty: open ? '▾' : '▸', cls: 'folder', title: e.path })
    row.dataset.path = e.path
    row.draggable = this.desktop
    row.addEventListener('click', () => this.toggle(e.path))
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      showMenu(ev.clientX, ev.clientY, [
        { label: 'Nova nota', action: () => this.actions.newNote(e.path, 'md') },
        { label: 'Nova nota de texto (.txt)', action: () => this.actions.newNote(e.path, 'txt') },
        { label: 'Nova pasta…', action: () => this.actions.newFolder(e.path) },
        'sep',
        { label: 'Renomear…', action: () => this.actions.rename(e.path) },
        { label: 'Escolher ícone…', action: () => this.actions.chooseIcon(e.path, e.icon, false) },
        ...this.desk([{ label: 'Mostrar no Explorer', action: () => this.actions.reveal(e.path) }]),
        { label: 'Apagar pasta', danger: true, action: () => this.actions.trash(e.path, true) }
      ])
    })
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer!.setData(ENTRY_MIME, e.path)
      ev.dataTransfer!.effectAllowed = 'move'
    })
    this.dropTarget(row, e.path)
    wrap.appendChild(row)
    if (open) for (const c of e.children ?? []) wrap.appendChild(this.entryNode(c, depth + 1))
    return wrap
  }

  /** Soltar uma nota/pasta arrastada sobre esta linha a move para `dir`. */
  private dropTarget(row: HTMLElement, dir: string): void {
    row.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes(ENTRY_MIME)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'move'
      row.classList.add('drop-into')
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-into'))
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-into')
      const path = e.dataTransfer?.getData(ENTRY_MIME)
      if (!path) return
      e.preventDefault()
      this.actions.move(path, dir)
    })
  }

  private row(o: { label: string; depth: number; icon: string; twisty?: string; cls: string; title: string }): HTMLElement {
    const row = document.createElement('div')
    row.className = `node ${o.cls}`
    row.setAttribute('role', 'treeitem')
    row.title = o.title
    row.style.paddingLeft = `${6 + o.depth * 14}px`
    const tw = document.createElement('span')
    tw.className = 'twisty'
    tw.textContent = o.twisty ?? ''
    const ic = document.createElement('span')
    ic.className = 'node-icon'
    ic.textContent = o.icon
    const lb = document.createElement('span')
    lb.className = 'node-label'
    lb.textContent = o.label
    row.append(tw, ic, lb)
    return row
  }
}
