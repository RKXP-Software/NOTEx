// Controlador do NOTEx: cadernos, documentos abertos, grade de painéis, sessão e atalhos.

import { bindPinch, bindViewport } from './ui/viewport'
import { showNovidades, showNovidadesIfNew } from './ui/novidades'
import { SearchPanel } from './ui/search-panel'
import { termIndex } from './glossary'
import { showTermCard } from './ui/term-card'
import type { RevealTarget } from './editors/reveal'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { listen } from '@tauri-apps/api/event'
import { api, errorMessage, EVENT_FILES, LOCKED, QUICK_NOTEBOOK_ID, type FilesChanged, type Notebook, type TreeEntry } from './api'
import { Doc } from './doc'
import {
  addTab,
  allGroups,
  findGroup,
  flatten,
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
import { baseName, countWords, dirName, docKind, firstLineDone, isWithin, quickNoteTitle, rebase, samePath, stem, titleFromText, txtToMarkdown } from './naming'
import { Theme, parseThemePref, type ThemePref } from './theme'
import { hasDesktopFs, isMobile } from './platform'
import { choose, confirm, pickIcon, prompt, promptPassword, promptTerm, showMenu, toast, type MenuEntry } from './ui/dialogs'
import { authenticateDevice } from './ui/device-auth'
import { Sidebar } from './ui/sidebar'
import { editLink, Toolbar } from './ui/toolbar'
import { Workspace } from './ui/workspace'
import { popLayer, pushLayer } from './ui/back'
import { SyncUi } from './ui/sync-panel'
import { VisualEditor } from './editors/visual-editor'

const SESSION_KEY = 'session'
const BASE_FONT_PX = 15
const ZOOM_STEPS = [50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300]

interface Session {
  version: 1
  layout: LayoutNode
  focused: string
  sidebar: { visible: boolean; width: number; expanded: string[] }
  raw: string[]
  autoName: string[]
  theme: ThemePref
  zoom: number
}

export class App {
  private notebooks: Notebook[] = []
  private trees = new Map<string, TreeEntry[]>()
  private readonly docs = new Map<string, Doc>()
  private layout: LayoutNode = newGroup('g1')
  private focused = 'g1'
  private sidebarVisible = true
  private sidebarWidth = 260
  private zoom = 100
  private sessionTimer: number | undefined
  private statusQueued = false
  private restoring = false

  private readonly theme: Theme
  private readonly sidebar: Sidebar
  private readonly search: SearchPanel
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
    this.toolbar = new Toolbar(document.getElementById('toolbar')!, hasDesktopFs, {
      toggleSidebar: () => this.toggleSidebar(),
      newQuickNote: () => void this.newQuickNote(),
      openFile: () => void this.openFileDialog(),
      toggleRaw: () => this.toggleRaw(),
      splitRight: () => this.splitActive('right'),
      splitDown: () => this.splitActive('bottom'),
      toggleTheme: () => {
        this.theme.toggle()
        this.scheduleSession()
      },
      defineTerm: () => void this.defineTerm()
    })
    this.sidebar = new Sidebar(this.el.sidebar, hasDesktopFs, {
      open: (path, opts) => {
        if (isMobile) this.setSidebar(false)
        void this.openPath(path, { side: opts?.side && !isMobile ? 'right' : undefined })
      },
      newNote: (dir, ext) => void this.newNoteIn(dir, ext),
      newFolder: (parent) => void this.newFolder(parent),
      rename: (path) => void this.renamePath(path),
      trash: (path, isDir) => void this.trashPath(path, isDir),
      move: (path, dest) => void this.movePath(path, dest),
      newNotebook: () => void this.newNotebook(),
      addExistingFolder: () => void this.addExistingFolder(),
      renameNotebook: (nb) => void this.renameNotebook(nb),
      removeNotebook: (nb) => void this.removeNotebook(nb),
      moveNotebook: (nb) => void this.moveNotebook(nb),
      chooseRoot: () => void this.chooseRoot(),
      chooseIcon: (path, current, isNotebook) => void this.chooseIcon(path, current, isNotebook),
      convert: (path) => void this.convertNote(path),
      reveal: (path) => void revealItemInDir(path).catch((e) => toast(errorMessage(e), 'error')),
      expandedChanged: () => this.scheduleSession(),
      openSearch: (tab) => this.openSearch(tab),
      unlockNotebooks: () => void this.unlockNotebooks(),
      lockNotebooks: () => void this.lockNotebooks(),
      makePrivate: (nb) => void this.makePrivate(nb),
      makePublic: (nb) => void this.makePublic(nb)
    })
    this.search = new SearchPanel(this.el.sidebar, {
      openAt: (path, target) => void this.openAt(path, target),
      notebooks: () => this.notebooks,
      activeNotebookId: () => this.activeNotebook()?.id ?? null,
      selection: () => this.selectedText(),
      defineTerm: () => void this.defineTerm(),
      close: () => this.closeSearch()
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
            disabled: !hasDesktopFs,
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
    document.documentElement.classList.toggle('mobile', isMobile)
    await this.loadNotebooks()
    const session = await this.loadSession()
    this.theme.set(session?.theme ?? 'system')
    this.setZoom(session?.zoom ?? 100)
    if (session) {
      this.sidebarVisible = session.sidebar.visible
      this.sidebarWidth = session.sidebar.width
      session.sidebar.expanded.forEach((k) => this.sidebar.expanded.add(k))
      await this.restoreLayout(session)
    } else {
      this.sidebar.expanded.add(`nb:${QUICK_NOTEBOOK_ID}`)
    }
    // Celular: a barra lateral é uma gaveta; abre sozinha só se não houver nota aberta.
    if (isMobile) this.sidebarVisible = this.docs.size === 0
    this.applySidebar()
    this.sidebar.setData(this.notebooks, this.trees)
    this.render()
    if (!isMobile) this.activeDoc()?.editor.focus()

    this.bindSidebarResizer()
    this.bindZoom()
    this.bindTermClicks()
    this.scheduleTerms(0)
    bindViewport()
    bindPinch(this.el.workspace, (d) => this.zoomStep(d))
    const v = document.getElementById('st-version')
    if (v) {
      v.textContent = `v${__APP_VERSION__}`
      v.addEventListener('click', () => void showNovidades(__APP_VERSION__))
    }
    showNovidadesIfNew(__APP_VERSION__)
    document.addEventListener('keydown', (e) => this.onKey(e), true)
    window.addEventListener('focus', () => void this.checkExternalChanges())
    // Ao fechar: grava tudo antes (o Tauri espera o handler terminar).
    await getCurrentWindow().onCloseRequested(async () => {
      await this.flushAll()
    })
    window.addEventListener('blur', () => void this.saveAll())
    // Android pode encerrar o app em segundo plano sem aviso: grava ao sair da tela.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return
      void this.flushAll()
      // Celular: os cadernos privados trancam ao sair do app.
      if (isMobile && this.notebooks.some((n) => n.private && !n.locked)) void this.lockNotebooks()
    })
    if (isMobile) this.bindDrawer()

    // Sincronização: indicador/painel e notas alteradas por outro aparelho.
    await new SyncUi(document.getElementById('st-sync')!).init()
    await listen<FilesChanged>(EVENT_FILES, (e) => void this.onFilesChanged(e.payload))
  }

  /** A sincronização gravou ou apagou arquivos: atualiza abas abertas e a barra lateral. */
  private async onFilesChanged(ev: FilesChanged): Promise<void> {
    this.search.refresh()
    this.scheduleTerms()
    for (const path of ev.removed) {
      const doc = this.findDoc(path)
      // Com edição não salva, mantém aberta: ao salvar, a nota volta a existir.
      if (!doc || doc.dirty) continue
      this.docs.delete(doc.path)
      this.layout = removeTab(this.layout, doc.path)
      doc.destroy()
    }
    if (!findGroup(this.layout, this.focused)) this.focused = allGroups(this.layout)[0]!.id
    for (const path of ev.changed) {
      await this.findDoc(path)?.reloadIfChanged().catch(() => undefined)
    }
    await this.reloadNotebooks()
    this.render()
  }

  /** Rótulo das cópias de conflito: "PC 2026-10-12 06h20" / "celular …". */
  private conflictLabel(): string {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${isMobile ? 'celular' : 'PC'} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`
  }

  /** Gaveta no celular: fundo escurecido fecha; o botão Voltar do Android também. */
  private bindDrawer(): void {
    const backdrop = document.createElement('div')
    backdrop.id = 'drawer-backdrop'
    backdrop.addEventListener('click', () => this.setSidebar(false))
    this.el.app.appendChild(backdrop)
    // Abriu sem nota (gaveta já aberta no início): registra para o Voltar fechar.
    if (this.sidebarVisible) pushLayer('drawer', () => this.setSidebar(false, true))
  }

  /** Abre/fecha a barra lateral. No celular, a gaveta é uma camada do botão Voltar. */
  private setSidebar(visible: boolean, fromBack = false): void {
    if (visible === this.sidebarVisible) return
    this.sidebarVisible = visible
    if (isMobile) {
      if (visible) pushLayer('drawer', () => this.setSidebar(false, true))
      else if (!fromBack) popLayer('drawer')
    }
    this.applySidebar()
    this.scheduleSession()
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
        zoom: Number(s.zoom) || 100
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
      zoom: this.zoom
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
      this.scheduleTerms()
      if (doc.autoName && firstLineDone(doc.text())) await this.applyAutoName(doc)
    },
    conflict: async (doc: Doc, text: string) => {
      // A nota mudou no disco (outro aparelho) com edição local pendente: a local vira uma cópia.
      try {
        const copy = await api.createNote(dirName(doc.path), `${stem(doc.path)} (conflito ${this.conflictLabel()})`, doc.kind)
        await api.writeNote(copy, text, doc.format)
        await this.refreshTrees()
        toast(`"${stem(doc.path)}" mudou em outro aparelho. Sua versão foi salva como "${stem(copy)}".`)
      } catch (e) {
        toast(`Conflito ao salvar "${stem(doc.path)}": ${errorMessage(e)}`, 'error')
      }
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
        if (errorMessage(e) === LOCKED) {
          if (await this.unlockNotebooks()) return this.openPath(path, opts)
          return undefined
        }
        toast(errorMessage(e), 'error')
        return undefined
      }
      this.docs.set(doc.path, doc)
    }
    const tab = doc.path
    if (opts.side && !isMobile) {
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
      void doc.refreshMtime()
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
    const name = await prompt('Nome do novo caderno', '', 'Continuar')
    if (name === null) return
    try {
      const { root } = await api.getRoot()
      const where = !hasDesktopFs ? 0 : await choose('Onde salvar o caderno?', `"${name}" será uma pasta com as suas notas.`, [
        { label: 'Na pasta padrão', detail: root },
        { label: 'Escolher outra pasta…', detail: 'O caderno é criado como subpasta da pasta escolhida.' }
      ])
      if (where === null) return
      let parent: string | null = null
      if (where === 1) {
        const dir = await openDialog({ directory: true, title: 'Escolha onde criar o caderno' })
        if (typeof dir !== 'string') return
        parent = dir
      }
      const nb = await api.createNotebook(name, parent)
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
      await this.settle(nb.path)
      const renamed = await api.renameNotebook(nb.id, name)
      if (!samePath(renamed.path, nb.path)) this.applyMove(nb.path, renamed.path)
      nb.name = renamed.name
      nb.path = renamed.path
      await this.refreshTrees()
      this.scheduleSession()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async removeNotebook(nb: Notebook): Promise<void> {
    const pick = await choose(`Excluir o caderno "${nb.name}"?`, 'Ele também será removido dos outros aparelhos sincronizados.', [
      { label: 'Só tirar da lista', detail: `Os arquivos continuam em: ${nb.path}` },
      { label: 'Apagar a pasta também', detail: hasDesktopFs ? 'A pasta vai para a Lixeira do Windows.' : 'A pasta vai para a lixeira do app.' }
    ])
    if (pick === null) return
    try {
      await this.settle(nb.path)
      for (const doc of [...this.docs.values()]) {
        if (isWithin(nb.path, doc.path)) await this.closeTab(doc.path)
      }
      await api.removeNotebook(nb.id, pick === 1)
      this.notebooks = this.notebooks.filter((n) => n.id !== nb.id)
      await this.refreshTrees()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  // ---- Cadernos privados ----

  /** Fecha (salvando) as abas de um caderno. */
  private async closeTabsIn(nb: Notebook): Promise<void> {
    await this.settle(nb.path)
    for (const doc of [...this.docs.values()]) {
      if (isWithin(nb.path, doc.path)) await this.closeTab(doc.path)
    }
  }

  /**
   * Abre os cadernos privados. Celular: primeiro o PIN/digital do aparelho; depois a senha guardada
   * ou a senha mestra digitada. Devolve true se abriu.
   */
  private async unlockNotebooks(): Promise<boolean> {
    try {
      const auth = isMobile ? await authenticateDevice('Abrir os cadernos privados') : 'unavailable'
      if (auth === 'cancelled') return false
      let status = await api.vaultStatus()
      if (!status.unlocked && status.remembered && auth === 'ok') {
        status = await api.vaultUnlockRemembered().catch(() => status)
      }
      let message = 'Digite a senha mestra dos cadernos privados.'
      while (!status.unlocked) {
        const r = await promptPassword('Cadernos privados', {
          message,
          remember: isMobile && auth === 'ok',
          okLabel: 'Desbloquear'
        })
        if (!r) return false
        try {
          status = await api.vaultUnlock(r.password, r.remember)
        } catch (e) {
          // Senha errada: pergunta de novo, com o aviso, em vez de fechar o diálogo.
          message = `${errorMessage(e)} Tente de novo.`
        }
      }
      await this.reloadNotebooks()
      this.search.refresh()
      this.scheduleTerms(0)
      return true
    } catch (e) {
      toast(errorMessage(e), 'error')
      return false
    }
  }

  /** Tranca tudo: grava e fecha as abas privadas, esquece a senha e as chaves da memória. */
  private async lockNotebooks(): Promise<void> {
    try {
      for (const nb of this.notebooks.filter((n) => n.private && !n.locked)) await this.closeTabsIn(nb)
      await this.saveSession()
      await api.vaultLock()
      await this.reloadNotebooks()
      this.search.refresh()
      this.scheduleTerms(0)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async makePrivate(nb: Notebook): Promise<void> {
    const first = !this.notebooks.some((n) => n.private)
    const r = await promptPassword(`Tornar "${nb.name}" privado`, {
      message: first
        ? 'As notas serão cifradas, também no Google Drive e nos outros aparelhos. Esta é a senha mestra de todos os cadernos privados. Sem ela não há como recuperar o conteúdo.'
        : 'Use a mesma senha mestra dos outros cadernos privados.',
      confirm: first,
      okLabel: 'Tornar privado'
    })
    if (!r) return
    try {
      await this.closeTabsIn(nb)
      await api.vaultMakePrivate(nb.id, r.password)
      await this.reloadNotebooks()
      this.search.refresh()
      toast(`"${nb.name}" agora é privado.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async makePublic(nb: Notebook): Promise<void> {
    const ok = await confirm(
      `Remover a privacidade de "${nb.name}"?`,
      'As notas voltam a ficar em texto comum, legíveis por qualquer programa e no Google Drive.',
      'Remover',
      true
    )
    if (!ok) return
    try {
      await this.closeTabsIn(nb)
      await api.vaultMakePublic(nb.id)
      await this.reloadNotebooks()
      this.search.refresh()
      toast(`"${nb.name}" não é mais privado.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async reloadNotebooks(): Promise<void> {
    this.notebooks = await api.getNotebooks().catch(() => this.notebooks)
    await this.refreshTrees()
  }

  private async moveNotebook(nb: Notebook): Promise<void> {
    const dir = await openDialog({ directory: true, title: `Mover "${nb.name}" para dentro de…` })
    if (typeof dir !== 'string') return
    try {
      await this.settle(nb.path)
      const moved = await api.moveNotebook(nb.id, dir)
      if (samePath(moved.path, nb.path)) return
      this.applyMove(nb.path, moved.path)
      await this.reloadNotebooks()
      this.scheduleSession()
      toast(`Caderno movido para ${moved.path}`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  /** Pasta onde novos cadernos são criados (padrão: Documentos\NOTEx). */
  private async chooseRoot(): Promise<void> {
    try {
      const { root, defaultRoot } = await api.getRoot()
      const custom = !samePath(root, defaultRoot)
      const options = [{ label: 'Escolher outra pasta…', detail: `Atual: ${root}` }]
      if (custom) options.push({ label: 'Voltar à pasta de fábrica', detail: defaultRoot })
      const pick = await choose(
        'Pasta padrão dos cadernos',
        'Novos cadernos serão criados aqui. Cadernos existentes não mudam de lugar (use "Mover caderno para outra pasta…").',
        options
      )
      if (pick === null) return
      let next: string | null = null
      if (pick === 0) {
        const dir = await openDialog({ directory: true, title: 'Pasta padrão dos cadernos', defaultPath: root })
        if (typeof dir !== 'string') return
        next = dir
      }
      const r = await api.setRoot(next)
      toast(`Pasta padrão: ${r.root}`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async chooseIcon(path: string, current: string | undefined, isNotebook: boolean): Promise<void> {
    const icon = await pickIcon(isNotebook ? 'Ícone do caderno' : 'Ícone da pasta', current)
    if (icon === null) return
    try {
      await api.setIcon(path, icon === '' ? null : icon)
      await this.reloadNotebooks()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  /** Converte .md ↔ .txt (troca a extensão; .txt → .md preserva quebras de linha e recuos). */
  private async convertNote(path: string): Promise<void> {
    const to = docKind(path) === 'md' ? 'txt' : 'md'
    const ok = await confirm(
      `Converter para .${to}`,
      to === 'txt'
        ? 'A nota vira texto puro. A formatação fica escrita como Markdown (ex.: **negrito**, - item) e pode ser convertida de volta.'
        : 'A nota passa a ter edição visual. Quebras de linha e recuos são preservados.',
      'Converter'
    )
    if (!ok) return
    try {
      await this.settle(path)
      const doc = this.findDoc(path)
      const current = doc ? { text: doc.text(), format: doc.format } : await api.readNote(path)
      const text = to === 'md' ? txtToMarkdown(current.text) : current.text
      const newPath = await api.renameEntry(path, `${stem(path)}.${to}`)
      if (text !== current.text || doc) await api.writeNote(newPath, text, current.format)
      if (doc) {
        // Recria o documento com o editor do novo tipo, no mesmo lugar da grade.
        const raw = doc.raw
        this.docs.delete(doc.path)
        doc.destroy()
        const fresh = await Doc.open(newPath, { dark: this.theme.dark, raw: raw && to === 'md' }, this.docHooks)
        this.docs.set(newPath, fresh)
        this.layout = renameTab(this.layout, path, newPath)
      }
      await this.refreshTrees()
      this.render()
      this.findDoc(newPath)?.editor.focus()
      toast(`Convertido: ${baseName(newPath)}`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  async openFileDialog(): Promise<void> {
    if (!hasDesktopFs) return
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
      ...(isMobile
        ? []
        : ([
            { label: 'Dividir à direita', action: () => this.split(tab, groupId, 'right') },
            { label: 'Dividir abaixo', action: () => this.split(tab, groupId, 'bottom') },
            'sep'
          ] as MenuEntry[])),
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
      {
        label: doc?.kind === 'txt' ? 'Converter para .md' : 'Converter para .txt',
        disabled: !nb,
        action: () => void this.convertNote(tab)
      },
      { label: 'Mostrar na barra lateral', disabled: !nb, action: () => nb && this.revealInSidebar(nb, tab) },
      ...(hasDesktopFs
        ? [{ label: 'Mostrar no Explorer', action: () => void revealItemInDir(tab).catch(() => undefined) }]
        : [])
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

  private termsTimer: number | undefined

  /** Relê os termos do glossário (depois de salvar, sincronizar ou trancar/destrancar). */
  private scheduleTerms(delay = 1500): void {
    window.clearTimeout(this.termsTimer)
    this.termsTimer = window.setTimeout(() => {
      api.listTerms().then((t) => termIndex.set(t)).catch(() => undefined)
    }, delay)
  }

  /** Clique numa palavra destacada: mostra a definição. */
  private bindTermClicks(): void {
    this.el.workspace.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.term-hit')
      const key = el?.dataset.term
      if (!el || !key) return
      const defs = termIndex.active()?.definitions(key) ?? []
      showTermCard(el.getBoundingClientRect(), defs, (t) => void this.openAt(t.path, { line: t.line, query: t.term, occurrence: 0 }))
    })
  }

  /** Texto selecionado na nota ativa, numa linha só (vazio se a seleção for grande demais). */
  private selectedText(): string {
    const t = (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim()
    return t.length <= 80 ? t : ''
  }

  private activeNotebook(): Notebook | undefined {
    const doc = this.activeDoc()
    return (doc && this.notebooks.find((n) => isWithin(n.path, doc.path))) ?? this.quickNotebook()
  }

  private openSearch(tab: 'search' | 'glossary'): void {
    const prefill = tab === 'search' ? this.selectedText() : ''
    this.setSidebar(true)
    this.el.sidebar.classList.add('searching')
    this.search.show(tab, prefill)
  }

  private closeSearch(): void {
    this.el.sidebar.classList.remove('searching')
  }

  /** Abre a nota e leva o editor até o trecho encontrado. */
  private async openAt(path: string, target: RevealTarget): Promise<void> {
    if (isMobile) this.setSidebar(false)
    const doc = await this.openPath(path)
    doc?.editor.reveal(target)
  }

  /** Pede termo e definição e grava no Glossário.md do caderno da nota ativa. */
  private async defineTerm(): Promise<void> {
    const nb = this.activeNotebook()
    if (!nb) return
    const r = await promptTerm({
      term: this.selectedText(),
      notebooks: this.notebooks.filter((n) => !n.locked),
      notebookId: nb.id
    })
    if (!r) return
    try {
      const path = await api.defineTerm(r.notebookId, r.term, r.definition)
      await this.refreshTrees()
      await this.findDoc(path)?.reloadIfChanged().catch(() => undefined)
      this.search.refresh()
      this.scheduleTerms(0)
      const where = this.notebooks.find((n) => n.id === r.notebookId)?.name ?? nb.name
      toast(`Termo salvo em ${where} › Glossário.`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private toggleSidebar(): void {
    this.setSidebar(!this.sidebarVisible)
  }

  private applySidebar(): void {
    this.el.app.classList.toggle('no-sidebar', !this.sidebarVisible)
    this.el.app.classList.toggle('drawer-open', isMobile && this.sidebarVisible)
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

  /** Zoom do texto das notas (50% a 300%), aplicado ao tamanho da fonte dos editores. */
  private setZoom(percent: number): void {
    this.zoom = Math.min(ZOOM_STEPS.at(-1)!, Math.max(ZOOM_STEPS[0]!, Math.round(percent)))
    document.documentElement.style.setProperty('--editor-font-size', `${(BASE_FONT_PX * this.zoom) / 100}px`)
    const label = document.getElementById('zoom-reset')
    if (label) label.textContent = `${this.zoom}%`
    for (const d of this.docs.values()) d.editor.remeasure()
  }

  /** Próximo nível de zoom para cima (+1) ou para baixo (-1); 0 volta a 100%. */
  zoomStep(dir: 1 | -1 | 0): void {
    if (dir === 0) this.setZoom(100)
    else if (dir > 0) this.setZoom(ZOOM_STEPS.find((z) => z > this.zoom) ?? this.zoom)
    else this.setZoom([...ZOOM_STEPS].reverse().find((z) => z < this.zoom) ?? this.zoom)
    this.scheduleSession()
  }

  private bindZoom(): void {
    document.getElementById('zoom-in')!.addEventListener('click', () => this.zoomStep(1))
    document.getElementById('zoom-out')!.addEventListener('click', () => this.zoomStep(-1))
    document.getElementById('zoom-reset')!.addEventListener('click', () => this.zoomStep(0))
    // Ctrl + roda do mouse sobre as notas.
    this.el.workspace.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return
        e.preventDefault()
        this.zoomStep(e.deltaY < 0 ? 1 : -1)
      },
      { passive: false }
    )
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
    if (ctrl && e.shiftKey && key === 'f') return run(() => this.openSearch('search'))
    if (ctrl && e.shiftKey && key === 'g') return run(() => this.openSearch('glossary'))
    if (ctrl && e.shiftKey && key === 'd') return run(() => void this.defineTerm())
    if (ctrl && e.shiftKey && key === 'e') return run(() => this.toggleSidebar())
    if (ctrl && e.shiftKey && key === 't') return run(() => (this.theme.toggle(), this.scheduleSession()))
    if (ctrl && e.shiftKey && key === 'm') return run(() => this.toggleRaw())
    // Zoom: "+" no teclado ABNT exige Shift, então Shift é aceito; numérico também.
    if (ctrl && !e.altKey && (key === '+' || key === '=' || e.code === 'NumpadAdd')) return run(() => this.zoomStep(1))
    if (ctrl && !e.altKey && (key === '-' || key === '_' || e.code === 'NumpadSubtract')) return run(() => this.zoomStep(-1))
    if (ctrl && !e.shiftKey && !e.altKey && (key === '0' || e.code === 'Numpad0')) return run(() => this.zoomStep(0))
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
    if (isMobile && this.layout.type !== 'group') {
      this.layout = flatten(this.layout, this.focused)
      this.focused = this.layout.id
    }
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
