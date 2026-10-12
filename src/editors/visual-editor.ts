// Editor visual (WYSIWYG) para notas .md: TipTap/ProseMirror, gravando Markdown.

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { EditorEvents, NoteEditor } from './types'

const SAFE_LINK = /^(https?:|mailto:)/i

export class VisualEditor implements NoteEditor {
  readonly kind = 'visual' as const
  readonly dom: HTMLElement
  readonly editor: Editor
  private silent = false

  constructor(text: string, events: EditorEvents) {
    this.dom = document.createElement('div')
    this.dom.className = 'visual-editor'
    this.editor = new Editor({
      element: this.dom,
      extensions: [
        StarterKit.configure({
          // Sublinhado não existe em Markdown; ficaria como HTML no arquivo.
          underline: false,
          link: { openOnClick: false, autolink: true, linkOnPaste: true, protocols: ['http', 'https', 'mailto'] }
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        // Imagens e tabelas precisam existir no editor para não se perderem ao salvar .md existentes.
        Image.configure({ inline: true }),
        TableKit.configure({ table: { resizable: false } }),
        Placeholder.configure({ placeholder: 'Escreva sua nota…' }),
        Markdown
      ],
      content: text,
      contentType: 'markdown',
      editorProps: {
        attributes: { class: 'prose', spellcheck: 'true' },
        // Ctrl+clique abre o link no navegador (clique simples só posiciona o cursor).
        handleClick: (_view, _pos, event) => {
          const a = (event.target as HTMLElement).closest('a')
          if (!a || !(event.ctrlKey || event.metaKey)) return false
          const href = a.getAttribute('href') ?? ''
          if (SAFE_LINK.test(href)) void openUrl(href)
          return true
        }
      },
      onUpdate: () => {
        if (!this.silent) events.onChange()
      },
      onSelectionUpdate: () => events.onSelection(),
      onTransaction: () => events.onSelection()
    })
    this.settle()
  }

  /**
   * Plugins como o TrailingNode ajustam o documento na primeira transação (ex.: parágrafo
   * vazio após uma citação no fim). Faz isso agora, em silêncio, para não parecer edição.
   */
  private settle(): void {
    this.silent = true
    try {
      this.editor.view.dispatch(this.editor.state.tr)
    } finally {
      this.silent = false
    }
  }

  getText(): string {
    return this.editor.getMarkdown()
  }

  plainText(): string {
    const doc = this.editor.state.doc
    return doc.textBetween(0, doc.content.size, '\n', ' ')
  }

  setText(text: string): void {
    this.silent = true
    try {
      this.editor.commands.setContent(text, { contentType: 'markdown', emitUpdate: false })
    } finally {
      this.silent = false
    }
    this.settle()
  }

  focus(): void {
    this.editor.commands.focus()
  }

  setDark(): void {
    // Cores vêm das variáveis CSS do tema.
  }

  position(): string {
    const { from, to } = this.editor.state.selection
    return to > from ? `${this.editor.state.doc.textBetween(from, to, ' ').length} selecionados` : ''
  }

  destroy(): void {
    this.editor.destroy()
  }
}
