// Editor de texto (CodeMirror 6): .txt puro e o modo "Markdown cru" das notas .md.
// Adaptado do editor do MDR.

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import type { EditorEvents, NoteEditor } from './types'

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

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '12px 0' },
  '&.cm-focused': { outline: 'none' }
})

export class TextEditor implements NoteEditor {
  readonly kind = 'text' as const
  readonly dom: HTMLElement
  readonly view: EditorView
  private readonly themeSlot = new Compartment()
  private dark: boolean
  private silent = false

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
      EditorState.tabSize.of(4),
      baseTheme,
      this.themeSlot.of(this.dark ? darkTheme : lightTheme),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !this.silent) events.onChange()
        if (u.docChanged || u.selectionSet) events.onSelection()
      })
    ]
    if (opts.markdown) extensions.push(markdown())
    this.view = new EditorView({ parent: this.dom, state: EditorState.create({ doc: text, extensions }) })
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

  setDark(dark: boolean): void {
    if (dark === this.dark) return
    this.dark = dark
    this.view.dispatch({ effects: this.themeSlot.reconfigure(dark ? darkTheme : lightTheme) })
  }

  position(): string {
    const head = this.view.state.selection.main.head
    const line = this.view.state.doc.lineAt(head)
    return `Ln ${line.number}, Col ${head - line.from + 1}`
  }

  destroy(): void {
    this.view.destroy()
  }
}
