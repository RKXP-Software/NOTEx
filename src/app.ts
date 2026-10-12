// Controlador do NOTEx: cadernos, documentos abertos, grade de painéis, sessão e atalhos.

import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { api, errorMessage, QUICK_NOTEBOOK_ID, type Notebook, type TreeEntry } from './api'
import { Doc } from './doc'
import {
  addTab,
  allGroups,
  findGroup,
  groupOfTab,
  newGroup,
  parseLayout,
  removeTab,
  renameTab,
  resize,
  setActive,
  splitWithTab,
  type LayoutNode,
  type Side
} from './layout'
import { baseName, countWords, firstLineDone, isWithin, quickNoteTitle, rebase, samePath, stem, titleFromText } from './naming'
import { Theme, parseThemePref, type ThemePref } from './theme'
import { confirm, prompt, showMenu, toast } from './ui/dialogs'
import { Sidebar } from './ui/sidebar'
import { editLink, Toolbar } from './ui/toolbar'
import { Workspace } from './ui/workspace'
import { VisualEditor } from './editors/visual-editor'

const SESSION_KEY = 'session'
const MIN_FONT = 11
const MAX_FONT = 28

interface Session {
  version: 1
  layout: LayoutNode
  focused: string
  sidebar: { visible: boolean; width: number; expanded: string[] }
  raw: string[]
  autoName: string[]
  theme: ThemePref
  fontSize: number
}

export class App {
  private notebooks: Notebook[] = []
  private trees = new Map<string, TreeEntry[]>()
  private readonly docs = new Map<string, Doc>()
  private layout: LayoutNode = newGroup('g1')
  private focused = 'g1'
  private sidebarVisible = true
  private sidebarWidth = 260
  private fontSize = 15
  private sessionTimer: number | undefined
  private statusQueued = false
  private restoring = false

  private readonly theme: Theme
  private readonly sidebar: Sidebar
  private readonly workspace: Workspace
  private readonly toolbar: Toolbar
  private readonly el = {
    app: document.getElementById('app')!,
    sidebar: document.getElementById('sidebar')!,
    sidebarResizer: document.getElementById('sidebar-resizer')!,
    workspace: document.getElementById('workspace')!,
    path: document.getElementById('st-path')!,
    status: document.getElementById('st-status')!,
    words: document.getElementById('st-words')!,
    pos: document.getElementById('st-pos')!,
    kind: document.getElementById('st-kind')!,
    enc: document.getElementById('st-enc')!
  }

  constructor() {
    this.theme = new Theme((dark) => {
      for (const d of this.docs.values()) d.setDark(dark)
    })
    this.toolbar = new Toolbar(document.getElementById('toolbar')!, {
      toggleSidebar: () => this.toggleSidebar(),
      newQuickNote: () => void this.newQuickNote(),
      openFile: () => void this.openFileDialog(),
      toggleRaw: () => this.toggleRaw(),
      splitRight: () => this.splitActive('right'),
      splitDown: () => this.splitActive('bottom'),
      toggleTheme: () => {
        this.theme.toggle()
        this.scheduleSession()
      }
    })
    this.sidebar = new Sidebar(this.el.sidebar, {
      open: (path, opts) => void this.openPath(path, { side: opts?.side ? 'right' : undefined }),
      newNote: (dir, ext) => void this.newNoteIn(dir, ext),
      newFolder: (parent) => void this.newFolder(parent),
      rename: (path) => void this.renamePath(path),
      trash: (path, isDir) => void this.trashPath(path, isDir),
      move: (path, dest) => void this.movePath(path, dest),
      newNotebook: () => void this.newNotebook(),
      addExistingFolder: () => void this.addExistingFolder(),
      renameNotebook: (nb) => void this.renameNotebook(nb),
      removeNotebook: (nb) => void this.removeNotebook(nb),
      reveal: (path) => void revealItemInDir(path).catch((e) => toast(errorMessage(e), 'error')),
      expandedChanged: () => this.scheduleSession()
    })
    this.workspace = new Workspace(this.el.workspace, {
      activate: (g, tab) => this.activate(g, tab),
      close: (tab) => void this.closeTab(tab),
      moveTab: (tab, g, index) => {
        this.layout = addTab(this.layout, g, tab, index)
        this.focused = g
        this.render()
      },
      splitTab: (tab, g, side) => {
        const id = this.newGroupId()
        this.layout = splitWithTab(this.layout, tab, g, side, id)
        this.focused = findGroup(this.layout, id) ? id : g
        this.render()
      },
      openFile: (path, g, side, index) => void this.openPath(path, { group: g, side: side ?? undefined, index }),
      resize: (path, sizes) => {
        this.layout = resize(this.layout, path, sizes)
        this.render()
      },
      tabMenu: (tab, g, x, y) => this.tabMenu(tab, g, x, y),
      groupMenu: (g, x, y) =>
        showMenu(x, y, [
          {
            label: 'Nova nota rápida',
            shortcut: 'Ctrl+N',
            action: () => {
              this.focused = g
              void this.newQuickNote()
            }
          },
          {
            label: 'Abrir arquivo…',
            shortcut: 'Ctrl+O',
            action: () => {
              this.focused = g
              void this.openFileDialog()
            }
          }
        ])
    })
  }

  // ---- Inicialização ----

  async init(): Promise<void> {
    await this.loadNotebooks()
    const session = await this.loadSession()
    this.theme.set(session?.theme ?? 'system')
    this.setFontSize(session?.fontSize ?? 15)
    if (session) {
      this.sidebarVisible = session.sidebar.visible
      this.sidebarWidth = session.sidebar.width
      session.sidebar.expanded.forEach((k) => this.sidebar.expanded.add(k))
      await this.restoreLayout(session)
    } else {
      this.sidebar.expanded.add(`nb:${QUICK_NOTEBOOK_ID}`)
    }
    this.applySidebar()
    this.sidebar.setData(this.notebooks, this.trees)
    this.render()
    this.activeDoc()?.editor.focus()

    this.bindSidebarResizer()
    document.addEventListener('keydown', (e) => this.onKey(e), true)
    window.addEventListener('focus', () => void this.checkExternalChanges())
    // Ao fechar: grava tudo antes (o Tauri espera o handler terminar).
    await getCurrentWindow().onCloseRequested(async () => {
      await this.flushAll()
    })
    window.addEventListener('blur', () => void this.saveAll())
  }

  private async loadNotebooks(): Promise<void> {
    try {
      this.notebooks = await api.getNotebooks()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
    await this.refreshTrees()
  }

  private async refreshTrees(): Promise<void> {
    const entries = await Promise.all(
      this.notebooks.map(async (nb) => [nb.id, await api.listTree(nb.id).catch(() => [] as TreeEntry[])] as const)
    )
    this.trees = new Map(entries)
    this.sidebar.setData(this.notebooks, this.trees)
  }

  private async loadSession(): Promise<Session | null> {
    try {
      const raw = await api.loadState(SESSION_KEY)
      if (!raw) return null
      const s = JSON.parse(raw) as Partial<Session>
      const layout = parseLayout(s.layout)
      if (!layout) return null
      return {
        version: 1,
        layout,
        focused: typeof s.focused === 'string' ? s.focused : allGroups(layout)[0]!.id,
        sidebar: {
          visible: s.sidebar?.visible !== false,
          width: Math.min(600, Math.max(160, Number(s.sidebar?.width) || 260)),
          expanded: Array.isArray(s.sidebar?.expanded) ? s.sidebar.expanded.filter((k) => typeof k === 'string') : []
        },
        raw: Array.isArray(s.raw) ? s.raw : [],
        autoName: Array.isArray(s.autoName) ? s.autoName : [],
        theme: parseThemePref(s.theme),
        fontSize: Number(s.fontSize) || 15
      }
    } catch {
      return null
    }
  }

  /** Reabre as abas da sessão; arquivos que sumiram são descartados. */
  private async restoreLayout(s: Session): Promise<void> {
    this.restoring = true
    this.layout = s.layout
    const tabs = allGroups(s.layout).flatMap((g) => g.tabs)
    const opened = await Promise.all(
      tabs.map(async (path) => {
        try {
          const doc = await Doc.open(
            path,
            { dark: this.theme.dark, raw: s.raw.includes(path), autoName: s.autoName.includes(path) },
            this.docHooks
          )
          return [path, doc] as const
        } catch {
          return [path, null] as const
        }
      })
    )
    for (const [path, doc] of opened) {
      if (doc) this.docs.set(path, doc)
      else this.layout = removeTab(this.layout, path)
    }
    this.focused = findGroup(this.layout, s.focused) ? s.focused : allGroups(this.layout)[0]!.id
    this.restoring = false
  }

  private sessionData(): Session {
    const docs = [...this.docs.values()]
    return {
      version: 1,
      layout: this.layout,
      focused: this.focused,
      sidebar: { visible: this.sidebarVisible, width: this.sidebarWidth, expanded: [...this.sidebar.expanded] },
      raw: docs.filter((d) => d.raw).map((d) => d.path),
      autoName: docs.filter((d) => d.autoName).map((d) => d.path),
      theme: this.theme.pref,
      fontSize: this.fontSize
    }
  }

  private scheduleSession(): void {
    if (this.restoring) return
    window.clearTimeout(this.sessionTimer)
    this.sessionTimer = window.setTimeout(() => void this.saveSession(), 400)
  }

  private async saveSession(): Promise<void> {
    window.clearTimeout(this.sessionTimer)
    await api.saveState(SESSION_KEY, JSON.stringify(this.sessionData())).catch(() => undefined)
  }

  private async saveAll(): Promise<void> {
    await Promise.all([...this.docs.values()].map((d) => d.save()))
  }

  private async flushAll(): Promise<void> {
    await this.saveAll()
    await this.saveSession()
  }

  // ---- Documentos ----

  private readonly docHooks = {
    changed: (doc: Doc) => {
      this.updateTab(doc)
      if (doc === this.activeDoc()) this.queueStatus()
    },
    selection: (doc: Doc) => {
      if (doc === this.activeDoc()) this.queueStatus()
    },
    saved: async (doc: Doc) => {
      if (doc.autoName && firstLineDone(doc.text())) await this.applyAutoName(doc)
    }
  }

  private activeDoc(): Doc | undefined {
    const g = findGroup(this.layout, this.focused)
    return g?.active ? this.docs.get(g.active) : undefined
  }

  private findDoc(path: string): Doc | undefined {
    for (const [p, d] of this.docs) if (samePath(p, path)) return d
    return undefined
  }

  private newGroupId(): string {
    const ids = new Set(allGroups(this.layout).map((g) => g.id))
    let n = ids.size + 1
    while (ids.has(`g${n}`)) n++
    return `g${n}`
  }

  /**
   * Abre (ou foca) um arquivo. `group` + `index` posicionam a aba; `side` cria nova divisão
   * ao lado do grupo (padrão: o grupo em foco).
   */
  async openPath(
    path: string,
    opts: { group?: string; side?: Side; index?: number; autoName?: boolean; focus?: boolean } = {}
  ): Promise<Doc | undefined> {
    const existing = this.findDoc(path)
    const target = opts.group ?? this.focused
    let doc = existing
    if (!doc) {
      try {
        doc = await Doc.open(path, { dark: this.theme.dark, autoName: opts.autoName }, this.docHooks)
      } catch (e) {
        toast(errorMessage(e), 'error')
        return undefined
      }
      this.docs.set(doc.path, doc)
    }
    const tab = doc.path
    if (opts.side) {
      if (!groupOfTab(this.layout, tab)) this.layout = addTab(this.layout, target, tab)
      const id = this.newGroupId()
      this.layout = splitWithTab(this.layout, tab, target, opts.side, id)
      this.focused = groupOfTab(this.layout, tab)!.id
    } else if (existing && opts.group === undefined) {
      const g = groupOfTab(this.layout, tab)!
      this.layout = setActive(this.layout, g.id, tab)
      this.focused = g.id
    } else {
      this.layout = addTab(this.layout, target, tab, opts.index)
      this.focused = target
    }
    this.render()
    if (opts.focus !== false) doc.editor.focus()
    return doc
  }

  private activate(groupId: string, tab: string): void {
    const g = findGroup(this.layout, groupId)
    if (this.focused === groupId && g?.active === tab) return
    this.layout = setActive(this.layout, groupId, tab)
    this.focused = groupId
    this.render()
    this.docs.get(tab)?.editor.focus()
  }

  async closeTab(path: string): Promise<void> {
    const doc = this.docs.get(path)
    if (doc) {
      await doc.save()
      if (doc.status === 'error') {
        const ok = await confirm('Não foi possível salvar', `${doc.error}\n\nFechar mesmo assim e perder as alterações?`, 'Fechar', true)
        if (!ok) return
      }
      if (doc.autoName) {
        if (doc.text().trim() === '') {
          await api.removeIfEmpty(doc.path).catch(() => false)
          void this.refreshTrees()
        } else {
          await this.applyAutoName(doc)
        }
      }
      this.docs.delete(doc.path)
      this.layout = removeTab(this.layout, doc.path)
      doc.destroy()
    } else {
      this.layout = removeTab(this.layout, path)
    }
    if (!findGroup(this.layout, this.focused)) this.focused = allGroups(this.layout)[0]!.id
    this.render()
    this.activeDoc()?.editor.focus()
  }

  // ---- Notas, pastas e cadernos ----

  private quickNotebook(): Notebook | undefined {
    return this.notebooks.find((n) => n.id === QUICK_NOTEBOOK_ID)
  }

  async newQuickNote(): Promise<void> {
    const nb = this.quickNotebook()
    if (!nb) return
    try {
      const path = await api.createNote(nb.path, quickNoteTitle(), 'md')
      await this.refreshTrees()
      await this.openPath(path, { autoName: true })
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async newNoteIn(dir: string, ext: 'md' | 'txt'): Promise<void> {
    const name = await prompt(ext === 'md' ? 'Nome da nova nota' : 'Nome da nova nota de texto', '', 'Criar')
    if (name === null) return
    try {
      const path = await api.createNote(dir, name, ext)
      const nb = this.notebooks.find((n) => isWithin(n.path, path))
      await this.refreshTrees()
      if (nb) this.sidebar.revealPath(nb, path)
      await this.openPath(path)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async newFolder(parent: string): Promise<void> {
    const name = await prompt('Nome da nova pasta', '', 'Criar')
    if (name === null) return
    try {
      const path = await api.createFolder(parent, name)
      this.sidebar.expanded.add(path)
      await this.refreshTrees()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  /** Renomeia a nota rápida pela primeira linha do texto. */
  private async applyAutoName(doc: Doc): Promise<void> {
    const title = titleFromText(doc.text())
    doc.autoName = false
    this.scheduleSession()
    if (!title || title === stem(doc.path)) return
    try {
      const newPath = await api.renameEntry(doc.path, title)
      this.applyMove(doc.path, newPath)
      await this.refreshTrees()
    } catch {
      // Mantém o nome provisório; não é um erro para o usuário.
    }
  }

  /** Atualiza documentos/abas após renomear ou mover `from` (arquivo ou pasta) para `to`. */
  private applyMove(from: string, to: string): void {
    for (const doc of [...this.docs.values()]) {
      if (!isWithin(from, doc.path)) continue
      const old = doc.path
      const next = rebase(old, from, to)
      this.docs.delete(old)
      doc.path = next
      this.docs.set(next, doc)
      this.layout = renameTab(this.layout, old, next)
      doc.refreshKind()
    }
    this.sidebar.expanded.forEach((k) => {
      if (!k.startsWith('nb:') && isWithin(from, k)) {
        this.sidebar.expanded.delete(k)
        this.sidebar.expanded.add(rebase(k, from, to))
      }
    })
    this.render()
  }

  /** Grava (e espera) os documentos abertos dentro de `path` antes de renomear/mover/apagar. */
  private async settle(path: string): Promise<void> {
    await Promise.all([...this.docs.values()].filter((d) => isWithin(path, d.path)).map((d) => d.save()))
  }

  async renamePath(path: string): Promise<void> {
    const name = await prompt('Novo nome', baseName(path), 'Renomear')
    if (name === null || name === baseName(path)) return
    try {
      await this.settle(path)
      const newPath = await api.renameEntry(path, name)
      const doc = this.findDoc(path)
      if (doc) doc.autoName = false
      this.applyMove(path, newPath)
      await this.refreshTrees()
      this.scheduleSession()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async movePath(path: string, destDir: string): Promise<void> {
    try {
      await this.settle(path)
      const newPath = await api.moveEntry(path, destDir)
      if (samePath(newPath, path)) return
      this.applyMove(path, newPath)
      this.sidebar.expanded.add(destDir)
      await this.refreshTrees()
      this.scheduleSession()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async trashPath(path: string, isDir: boolean): Promise<void> {
    const ok = await confirm(
      isDir ? 'Apagar pasta' : 'Apagar nota',
      `"${baseName(path)}" será movida para a pasta .lixeira do caderno.`,
      'Apagar',
      true
    )
    if (!ok) return
    try {
      await this.settle(path)
      for (const doc of [...this.docs.values()]) {
        if (!isWithin(path, doc.path)) continue
        this.docs.delete(doc.path)
        this.layout = removeTab(this.layout, doc.path)
        doc.destroy()
      }
      await api.trashEntry(path)
      if (!findGroup(this.layout, this.focused)) this.focused = allGroups(this.layout)[0]!.id
      await this.refreshTrees()
      this.render()
      toast('Movido para a lixeira do caderno.')
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async newNotebook(): Promise<void> {
    const name = await prompt('Nome do novo caderno', '', 'Criar')
    if (name === null) return
    try {
      const nb = await api.createNotebook(name)
      this.notebooks.push(nb)
      this.sidebar.expanded.add(`nb:${nb.id}`)
      await this.refreshTrees()
      this.scheduleSession()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async addExistingFolder(): Promise<void> {
    const dir = await openDialog({ directory: true, title: 'Escolha a pasta do caderno' })
    if (typeof dir !== 'string') return
    try {
      const nb = await api.addNotebook(dir)
      this.notebooks.push(nb)
      this.sidebar.expanded.add(`nb:${nb.id}`)
      await this.refreshTrees()
      this.scheduleSession()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async renameNotebook(nb: Notebook): Promise<void> {
    const name = await prompt('Nome do caderno', nb.name, 'Renomear')
    if (name === null) return
    try {
      await api.renameNotebook(nb.id, name)
      nb.name = name
      this.sidebar.setData(this.notebooks, this.trees)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async removeNotebook(nb: Notebook): Promise<void> {
    const ok = await confirm(
      'Remover caderno da lista',
      `"${nb.name}" sai da barra lateral. Os arquivos continuam em:\n${nb.path}`,
      'Remover'
    )
    if (!ok) return
    try {
      await this.settle(nb.path)
      for (const doc of [...this.docs.values()]) {
        if (isWithin(nb.path, doc.path)) await this.closeTab(doc.path)
      }
      await api.removeNotebook(nb.id)
      this.notebooks = this.notebooks.filter((n) => n.id !== nb.id)
      await this.refreshTrees()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async openFileDialog(): Promise<void> {
    const picked = await openDialog({
      multiple: true,
      title: 'Abrir notas',
      filters: [{ name: 'Notas', extensions: ['md', 'txt', 'markdown'] }]
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    for (const path of paths) {
      try {
        if (!this.notebooks.some((n) => isWithin(n.path, path))) await api.openExternal(path)
        await this.openPath(path)
      } catch (e) {
        toast(errorMessage(e), 'error')
      }
    }
  }

  /** Arquivos alterados fora do app (outro editor, sincronização) são recarregados ao voltar à janela. */
  private async checkExternalChanges(): Promise<void> {
    let missing = 0
    for (const doc of this.docs.values()) {
      const r = await doc.reloadIfChanged().catch(() => 'unchanged' as const)
      if (r === 'missing') missing++
    }
    if (missing) toast(`${missing} nota(s) aberta(s) não existe(m) mais no disco.`, 'error')
    await this.refreshTrees()
  }

  // ---- Ações de aba e editor ----

  private tabMenu(tab: string, groupId: string, x: number, y: number): void {
    const doc = this.docs.get(tab)
    const g = findGroup(this.layout, groupId)
    const nb = this.notebooks.find((n) => isWithin(n.path, tab))
    showMenu(x, y, [
      { label: 'Fechar', shortcut: 'Ctrl+W', action: () => void this.closeTab(tab) },
      {
        label: 'Fechar as outras',
        disabled: (g?.tabs.length ?? 0) < 2,
        action: () => void (async () => {
          for (const t of g?.tabs ?? []) if (t !== tab) await this.closeTab(t)
        })()
      },
      'sep',
      { label: 'Dividir à direita', action: () => this.split(tab, groupId, 'right') },
      { label: 'Dividir abaixo', action: () => this.split(tab, groupId, 'bottom') },
      'sep',
      { label: 'Renomear…', shortcut: 'F2', disabled: !nb, action: () => void this.renamePath(tab) },
      {
        label: doc?.raw ? 'Editor visual' : 'Markdown cru',
        shortcut: 'Ctrl+Shift+M',
        disabled: doc?.kind !== 'md',
        action: () => {
          doc?.setRaw(!doc.raw)
          this.render()
          this.scheduleSession()
        }
      },
      { label: 'Mostrar na barra lateral', disabled: !nb, action: () => nb && this.revealInSidebar(nb, tab) },
      { label: 'Mostrar no Explorer', action: () => void revealItemInDir(tab).catch(() => undefined) }
    ])
  }

  private revealInSidebar(nb: Notebook, path: string): void {
    if (!this.sidebarVisible) this.toggleSidebar()
    this.sidebar.revealPath(nb, path)
  }

  private split(tab: string, groupId: string, side: Side): void {
    const g = findGroup(this.layout, groupId)
    if (!g) return
    if (g.tabs.length === 1) {
      toast('Abra outra aba neste painel para dividir, ou arraste uma aba para a borda de um painel.')
      return
    }
    const id = this.newGroupId()
    this.layout = splitWithTab(this.layout, tab, groupId, side, id)
    if (findGroup(this.layout, id)) this.focused = id
    this.render()
    this.activeDoc()?.editor.focus()
  }

  private splitActive(side: Side): void {
    const g = findGroup(this.layout, this.focused)
    if (!g?.active) return
    this.split(g.active, g.id, side)
  }

  private toggleRaw(): void {
    const doc = this.activeDoc()
    if (!doc || doc.kind !== 'md') return
    doc.setRaw(!doc.raw)
    this.render()
    doc.editor.focus()
    this.scheduleSession()
  }

  private toggleSidebar(): void {
    this.sidebarVisible = !this.sidebarVisible
    this.applySidebar()
    this.scheduleSession()
  }

  private applySidebar(): void {
    this.el.app.classList.toggle('no-sidebar', !this.sidebarVisible)
    this.el.app.style.setProperty('--sidebar-width', `${this.sidebarWidth}px`)
  }

  private bindSidebarResizer(): void {
    const r = this.el.sidebarResizer
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      r.setPointerCapture(e.pointerId)
      document.body.classList.add('resizing-col')
      const move = (ev: PointerEvent): void => {
        this.sidebarWidth = Math.min(600, Math.max(160, ev.clientX))
        this.applySidebar()
      }
      const up = (): void => {
        r.removeEventListener('pointermove', move)
        r.removeEventListener('pointerup', up)
        document.body.classList.remove('resizing-col')
        this.scheduleSession()
      }
      r.addEventListener('pointermove', move)
      r.addEventListener('pointerup', up)
    })
  }

  private setFontSize(px: number): void {
    this.fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(px)))
    document.documentElement.style.setProperty('--editor-font-size', `${this.fontSize}px`)
  }

  private cycleTab(dir: 1 | -1): void {
    const g = findGroup(this.layout, this.focused)
    if (!g || g.tabs.length < 2 || !g.active) return
    const i = g.tabs.indexOf(g.active)
    this.activate(g.id, g.tabs[(i + dir + g.tabs.length) % g.tabs.length]!)
  }

  private focusGroup(dir: 1 | -1): void {
    const groups = allGroups(this.layout)
    const i = groups.findIndex((g) => g.id === this.focused)
    const next = groups[(i + dir + groups.length) % groups.length]
    if (next?.active) this.activate(next.id, next.active)
  }

  private onKey(e: KeyboardEvent): void {
    if (document.querySelector('.modal-overlay')) return
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const run = (f: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      f()
    }
    if (ctrl && !e.shiftKey && !e.altKey && key === 'n') return run(() => void this.newQuickNote())
    if (ctrl && !e.shiftKey && key === 'o') return run(() => void this.openFileDialog())
    if (ctrl && !e.shiftKey && key === 's') return run(() => void this.saveAll().then(() => toast('Salvo.')))
    if (ctrl && !e.shiftKey && (key === 'w' || key === 'f4')) {
      const g = findGroup(this.layout, this.focused)
      return run(() => g?.active && void this.closeTab(g.active))
    }
    if (ctrl && key === 'tab') return run(() => this.cycleTab(e.shiftKey ? -1 : 1))
    if (ctrl && !e.shiftKey && key === 'pagedown') return run(() => this.cycleTab(1))
    if (ctrl && !e.shiftKey && key === 'pageup') return run(() => this.cycleTab(-1))
    if (ctrl && e.altKey && (key === 'arrowright' || key === 'arrowleft'))
      return run(() => this.focusGroup(key === 'arrowright' ? 1 : -1))
    if (ctrl && (e.code === 'Backslash' || e.code === 'IntlBackslash' || key === '\\'))
      return run(() => this.splitActive(e.shiftKey ? 'bottom' : 'right'))
    if (ctrl && e.shiftKey && key === 'e') return run(() => this.toggleSidebar())
    if (ctrl && e.shiftKey && key === 't') return run(() => (this.theme.toggle(), this.scheduleSession()))
    if (ctrl && e.shiftKey && key === 'm') return run(() => this.toggleRaw())
    if (ctrl && !e.shiftKey && (key === '=' || key === '+'))
      return run(() => (this.setFontSize(this.fontSize + 1), this.scheduleSession()))
    if (ctrl && !e.shiftKey && key === '-') return run(() => (this.setFontSize(this.fontSize - 1), this.scheduleSession()))
    if (ctrl && !e.shiftKey && key === '0') return run(() => (this.setFontSize(15), this.scheduleSession()))
    if (key === 'f2' && !ctrl) {
      const doc = this.activeDoc()
      if (doc && this.notebooks.some((n) => isWithin(n.path, doc.path))) return run(() => void this.renamePath(doc.path))
    }
    if (ctrl && !e.shiftKey && key === 'k') {
      const doc = this.activeDoc()
      if (doc?.editor instanceof VisualEditor) return run(() => void editLink((doc.editor as VisualEditor).editor))
    }
  }

  // ---- Renderização ----

  private render(): void {
    this.workspace.render(this.layout, this.docs, this.focused)
    this.updateChrome()
    this.scheduleSession()
  }

  private updateTab(doc: Doc): void {
    const tab = this.el.workspace.querySelector<HTMLElement>(`.tab[data-tab="${CSS.escape(doc.path)}"]`)
    if (!tab) return
    tab.classList.toggle('dirty', doc.dirty)
    tab.classList.toggle('error', doc.status === 'error')
  }

  private queueStatus(): void {
    if (this.statusQueued) return
    this.statusQueued = true
    requestAnimationFrame(() => {
      this.statusQueued = false
      this.updateChrome()
    })
  }

  /** Barra de status, título da janela, barra de formatação e destaque na barra lateral. */
  private updateChrome(): void {
    const doc = this.activeDoc()
    const visual = doc?.editor instanceof VisualEditor ? doc.editor.editor : null
    this.toolbar.update({ editor: visual, canRaw: doc?.kind === 'md', raw: !!doc?.raw })
    this.sidebar.setActive(doc?.path ?? null)
    const title = doc ? `${stem(doc.path)} — NOTEx` : 'NOTEx'
    if (document.title !== title) {
      document.title = title
      void getCurrentWindow().setTitle(title).catch(() => undefined)
    }
    if (!doc) {
      for (const k of ['path', 'status', 'words', 'pos', 'kind', 'enc'] as const) this.el[k].textContent = ''
      return
    }
    this.el.path.textContent = doc.path
    this.el.path.title = doc.path
    const labels = { saved: 'Salvo', dirty: 'Não salvo', saving: 'Salvando…', error: 'Erro ao salvar' }
    this.el.status.textContent = labels[doc.status]
    this.el.status.title = doc.error
    this.el.status.className = `st-${doc.status}`
    const words = countWords(doc.editor.plainText())
    this.el.words.textContent = `${words} ${words === 1 ? 'palavra' : 'palavras'}`
    this.el.pos.textContent = doc.editor.position()
    this.el.kind.textContent = doc.kind === 'txt' ? 'Texto' : doc.raw ? 'Markdown (cru)' : 'Markdown'
    this.el.enc.textContent = `${doc.format.encoding === 'utf-8' ? 'UTF-8' : 'Windows-1252'}${doc.format.bom ? ' BOM' : ''} · ${doc.format.eol.toUpperCase()}`
  }
}
