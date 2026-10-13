// Editor de texto (CodeMirror 6): .txt puro e o modo "Markdown cru" das notas .md.
// Adaptado do editor do MDR.

import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { Compartment, EditorState, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, syntaxTree } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import type { EditorEvents, NoteEditor } from './types'
import { flash, type RevealTarget } from './reveal'
import { findFolded } from '../fold'
import { termIndex } from '../glossary'

// Tema claro coerente com as variáveis CSS do app (o escuro usa oneDark).
const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg)', color: 'var(--fg)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-subtle)', color: 'var(--fg-muted)', borderRight: '1px solid var(--border)' },
    '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' }
  },
  { dark: false }
)

// oneDark com o fundo do app, para o editor de texto não destoar do visual.
const darkTheme: Extension = [
  oneDark,
  EditorView.theme(
    {
      '&': { backgroundColor: 'var(--bg)' },
      '.cm-gutters': { backgroundColor: 'var(--bg-subtle)', borderRight: '1px solid var(--border)' },
      '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' }
    },
    { dark: true }
  )
]

/** Tamanho atual da fonte das notas (variável CSS controlada pelo zoom). */
function editorFontSize(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size').trim() || '15px'
}

// Fonte num tema próprio: reconfigurar o tema faz o CodeMirror remedir as linhas (só mudar o CSS não).
const fontTheme = (size: string): Extension => EditorView.theme({ '&': { fontSize: size } })

const baseTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0' },
  '&.cm-focused': { outline: 'none' }
})

/** Avisa o plugin de termos que a lista de termos (ou o liga/desliga) mudou. */
const termsChanged = StateEffect.define<null>()

/** Sublinha as palavras que são termos do glossário (fora de código). */
const termHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(termsChanged)))) {
        this.decorations = this.build(u.view)
      }
    }
    build(view: EditorView): DecorationSet {
      const matcher = termIndex.active()
      const b = new RangeSetBuilder<Decoration>()
      if (!matcher) return b.finish()
      const doc = view.state.doc
      const tree = syntaxTree(view.state)
      let next = 0
      for (const r of view.visibleRanges) {
        let pos = Math.max(r.from, next)
        while (pos <= r.to) {
          const line = doc.lineAt(pos)
          for (const h of matcher.find(line.text)) {
            let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(line.from + h.from, 1)
            let code = false
            for (; node; node = node.parent) if (/Code/.test(node.name)) code = true
            if (!code) {
              b.add(line.from + h.from, line.from + h.to, Decoration.mark({ class: 'term-hit', attributes: { 'data-term': h.key } }))
            }
          }
          next = line.to + 1
          pos = next
        }
      }
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)

export class TextEditor implements NoteEditor {
  readonly kind = 'text' as const
  readonly dom: HTMLElement
  readonly view: EditorView
  private readonly themeSlot = new Compartment()
  private readonly fontSlot = new Compartment()
  private dark: boolean
  private silent = false
  private readonly offTerms: () => void

  constructor(text: string, events: EditorEvents, opts: { markdown: boolean; dark: boolean }) {
    this.dark = opts.dark
    this.dom = document.createElement('div')
    this.dom.className = 'text-editor'
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.lineWrapping,
      termHighlight,
      EditorState.tabSize.of(4),
      baseTheme,
      this.fontSlot.of(fontTheme(editorFontSize())),
      this.themeSlot.of(this.dark ? darkTheme : lightTheme),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !this.silent) events.onChange()
        if (u.docChanged || u.selectionSet) events.onSelection()
      })
    ]
    if (opts.markdown) extensions.push(markdown())
    this.view = new EditorView({ parent: this.dom, state: EditorState.create({ doc: text, extensions }) })
    this.offTerms = termIndex.subscribe(() => this.view.dispatch({ effects: termsChanged.of(null) }))
  }

  getText(): string {
    return this.view.state.doc.toString()
  }

  plainText(): string {
    return this.getText()
  }

  setText(text: string): void {
    this.silent = true
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } })
    } finally {
      this.silent = false
    }
  }

  focus(): void {
    this.view.focus()
  }

  reveal(t: RevealTarget): void {
    if (t.line < 1) return
    const doc = this.view.state.doc
    const line = doc.line(Math.min(t.line, doc.lines))
    const hit = findFolded(line.text, t.query)
    const [from, to] = hit ? [line.from + hit[0], line.from + hit[1]] : [line.from, line.from]
    this.view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    if (to > from) window.setTimeout(() => flash(this.view.domAtPos(from), this.view.domAtPos(to)), 50)
  }

  setDark(dark: boolean): void {
    if (dark === this.dark) return
    this.dark = dark
    this.view.dispatch({ effects: this.themeSlot.reconfigure(dark ? darkTheme : lightTheme) })
  }

  remeasure(): void {
    // O CodeMirror guarda a altura das linhas; sem isso a numeração fica desalinhada após o zoom.
    this.view.dispatch({ effects: this.fontSlot.reconfigure(fontTheme(editorFontSize())) })
  }

  position(): string {
    const head = this.view.state.selection.main.head
    const line = this.view.state.doc.lineAt(head)
    return `Ln ${line.number}, Col ${head - line.from + 1}`
  }

  destroy(): void {
    this.offTerms()
    this.view.destroy()
  }
}
