// Painel de busca e glossário: ocupa a barra lateral (no celular, a gaveta) no lugar dos cadernos.

import { api, type Hit, type Notebook, type Term } from '../api'
import { fold } from '../fold'
import type { RevealTarget } from '../editors/reveal'
import { termIndex } from '../glossary'

export interface SearchPanelActions {
  openAt(path: string, target: RevealTarget): void
  notebooks(): Notebook[]
  /** Caderno da nota ativa (para "Definir termo"). */
  activeNotebookId(): string | null
  /** Texto selecionado na nota ativa. */
  selection(): string
  defineTerm(): void
  /** Voltar à lista de cadernos. */
  close(): void
}

type Tab = 'search' | 'glossary'

const DEBOUNCE_MS = 160

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

export class SearchPanel {
  private tab: Tab = 'search'
  private readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly scope: HTMLSelectElement
  private readonly results: HTMLElement
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>()
  private readonly addBtn: HTMLButtonElement
  private readonly toggleRow: HTMLLabelElement
  private timer: number | undefined
  private seq = 0
  private terms: Term[] = []

  constructor(host: HTMLElement, private readonly actions: SearchPanelActions) {
    this.root = el('div', 'sb-search')
    const head = el('div', 'search-head')
    const back = el('button', 'icon-btn', '←')
    back.title = 'Voltar aos cadernos'
    back.setAttribute('aria-label', 'Voltar aos cadernos')
    back.addEventListener('click', () => actions.close())
    head.append(back)
    for (const [tab, label] of [['search', 'Buscar'], ['glossary', 'Glossário']] as const) {
      const b = el('button', 'search-tab', label)
      b.addEventListener('click', () => this.setTab(tab))
      this.tabButtons.set(tab, b)
      head.append(b)
    }
    this.addBtn = el('button', 'icon-btn', '＋')
    this.addBtn.title = 'Definir termo'
    this.addBtn.setAttribute('aria-label', 'Definir termo')
    this.addBtn.addEventListener('click', () => actions.defineTerm())
    head.append(el('span', 'spacer'), this.addBtn)

    this.input = el('input', 'search-input')
    this.input.type = 'search'
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.addEventListener('input', () => this.schedule())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (this.input.value) {
          this.input.value = ''
          this.schedule()
        } else actions.close()
      } else if (e.key === 'Enter') {
        this.root.querySelector<HTMLElement>('.hit, .term')?.click()
      }
    })
    this.scope = el('select', 'search-scope')
    this.scope.addEventListener('change', () => this.schedule(0))
    const bar = el('div', 'search-bar')
    bar.append(this.input, this.scope)
    this.toggleRow = el('label', 'modal-check')
    const toggle = el('input')
    toggle.type = 'checkbox'
    toggle.checked = termIndex.enabled
    toggle.addEventListener('change', () => termIndex.setEnabled(toggle.checked))
    this.toggleRow.append(toggle, ' Destacar os termos nas notas')
    bar.append(this.toggleRow)

    this.results = el('div', 'search-results')
    this.root.append(head, bar, this.results)
    host.append(this.root)
    this.setTab('search')
  }

  /** Abre o painel (na aba pedida), com o texto opcional já digitado. */
  show(tab: Tab, prefill = ''): void {
    this.fillScope()
    this.setTab(tab)
    if (prefill) this.input.value = prefill
    this.schedule(0)
    this.input.focus()
    this.input.select()
  }

  /** Os arquivos mudaram (sincronização, salvar): refaz a consulta se o painel está aberto. */
  refresh(): void {
    if (this.root.offsetParent) this.schedule(0)
  }

  private fillScope(): void {
    const current = this.scope.value
    this.scope.replaceChildren(new Option('Todos os cadernos', ''))
    for (const nb of this.actions.notebooks()) this.scope.append(new Option(nb.name, nb.id))
    this.scope.value = [...this.scope.options].some((o) => o.value === current) ? current : ''
  }

  private setTab(tab: Tab): void {
    this.tab = tab
    for (const [t, b] of this.tabButtons) b.classList.toggle('active', t === tab)
    this.input.placeholder = tab === 'search' ? 'Buscar em todas as notas…' : 'Filtrar termos…'
    this.addBtn.hidden = tab !== 'glossary'
    this.toggleRow.hidden = tab !== 'glossary'
    this.schedule(0)
  }

  private schedule(delay = DEBOUNCE_MS): void {
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.run(), delay)
  }

  private async run(): Promise<void> {
    const seq = ++this.seq
    const query = this.input.value.trim()
    const notebook = this.scope.value || null
    try {
      if (this.tab === 'search') {
        if (!query) return this.message('Digite para buscar em todos os cadernos. Ignora acentos e maiúsculas.')
        const hits = await api.searchNotes(query, notebook)
        if (seq === this.seq) this.renderHits(hits, query)
      } else {
        this.terms = await api.listTerms()
        if (seq === this.seq) this.renderTerms(query, notebook)
      }
    } catch (e) {
      if (seq === this.seq) this.message(String(e))
    }
  }

  private message(text: string): void {
    this.results.replaceChildren(el('div', 'search-empty', text))
  }

  private renderHits(hits: Hit[], query: string): void {
    if (!hits.length) return this.message(`Nada encontrado para "${query}".`)
    const frag = document.createDocumentFragment()
    let last = ''
    for (const h of hits) {
      if (h.path !== last) {
        last = h.path
        const title = el('div', 'hit-file')
        title.append(el('strong', '', h.rel.replace(/\.(md|txt)$/i, '')), el('small', '', ` · ${h.notebookName}`))
        frag.append(title)
      }
      const row = el('button', 'hit')
      row.append(el('span', 'hit-line', h.line ? String(h.line) : '↗'))
      const text = el('span', 'hit-text')
      text.append(h.before, el('mark', '', h.hit), h.after)
      row.append(text)
      row.addEventListener('click', () => this.actions.openAt(h.path, { line: h.line, query, occurrence: h.occurrence }))
      frag.append(row)
    }
    this.results.replaceChildren(frag)
  }

  private renderTerms(query: string, notebook: string | null): void {
    const q = fold(query)
    const list = this.terms.filter(
      (t) => (!notebook || t.notebookId === notebook) && (!q || fold(t.term).includes(q) || fold(t.definition).includes(q))
    )
    if (!list.length) {
      return this.message(
        this.terms.length
          ? 'Nenhum termo com esse filtro.'
          : 'Nenhum termo ainda. Escreva **Termo**: definição (ou Termo:: definição) em qualquer nota, ou toque em ＋.'
      )
    }
    const frag = document.createDocumentFragment()
    for (const t of list) {
      const row = el('button', 'term')
      row.append(el('strong', '', t.term), el('span', 'term-def', t.definition))
      const name = t.path.split(/[\\/]/).pop()!.replace(/\.(md|txt)$/i, '')
      row.append(el('small', '', `${t.notebookName} · ${name}`))
      row.addEventListener('click', () => this.actions.openAt(t.path, { line: t.line, query: t.term, occurrence: 0 }))
      frag.append(row)
    }
    this.results.replaceChildren(frag)
  }
}
