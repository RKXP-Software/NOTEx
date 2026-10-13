// Editor visual (WYSIWYG) para notas .md: TipTap/ProseMirror, gravando Markdown.

import { Editor, Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { EditorEvents, NoteEditor } from './types'
import { flash, type RevealTarget } from './reveal'
import { findFolded } from '../fold'
import { termIndex } from '../glossary'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

const SAFE_LINK = /^(https?:|mailto:)/i

/**
 * Recuo de parágrafo: espaços não separáveis. Espaços comuns no início da linha virariam
 * "bloco de código" no Markdown; os não separáveis sobrevivem a salvar e reabrir.
 */
export const INDENT = '    '
const LEADING_INDENT = /^ {1,4}/

/** Inícios (posição) dos blocos de texto tocados pela seleção. */
function blockStarts(e: Editor): number[] {
  const { from, to, empty, $from } = e.state.selection
  // Cursor sem seleção: só o bloco onde ele está (nodesBetween não visita nada num intervalo vazio).
  if (empty) return $from.parent.isTextblock ? [$from.start()] : []
  const starts: number[] = []
  e.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      starts.push(pos + 1)
      return false
    }
    return true
  })
  return starts
}

/**
 * Aumenta/diminui o recuo. Em listas, muda o nível do item; fora delas, acrescenta/remove o
 * recuo no início de cada parágrafo selecionado. `atCursor` (tecla Tab sem seleção) insere o
 * recuo onde está o cursor.
 */
export function indent(e: Editor, more: boolean, atCursor = false): void {
  const item = e.isActive('taskItem') ? 'taskItem' : e.isActive('listItem') ? 'listItem' : null
  if (item) {
    if (more) e.chain().focus().sinkListItem(item).run()
    else e.chain().focus().liftListItem(item).run()
    return
  }
  if (e.isActive('codeBlock')) {
    if (more) e.chain().focus().insertContent('    ').run()
    return
  }
  const { state } = e
  let tr = state.tr
  const { empty, $from } = state.selection
  // Recuo logo antes do cursor (ex.: Tab dado no meio da linha): Shift+Tab remove ele primeiro.
  const before = empty ? ($from.parent.textBetween(0, $from.parentOffset).match(/ {1,4}$/)?.[0].length ?? 0) : 0
  if (more && atCursor && empty) {
    tr = tr.insertText(INDENT, $from.pos)
  } else if (!more && before > 0 && $from.parentOffset > before) {
    tr = tr.delete($from.pos - before, $from.pos)
  } else {
    // De trás para frente, para as posições anteriores continuarem válidas.
    for (const start of blockStarts(e).reverse()) {
      if (more) {
        tr = tr.insertText(INDENT, start)
      } else {
        const n = state.doc.resolve(start).parent.textContent.match(LEADING_INDENT)?.[0].length ?? 0
        if (n) tr = tr.delete(start, start + n)
      }
    }
  }
  if (tr.docChanged) e.view.dispatch(tr)
  e.commands.focus()
}

/**
 * Tab/Shift+Tab sempre ficam no texto (nunca levam o foco para a barra de ferramentas).
 * Prioridade baixa: tabelas (próxima célula) e listas tratam a tecla antes.
 */
const IndentKeys = Extension.create({
  name: 'notexIndent',
  priority: 10,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        indent(this.editor, true, true)
        return true
      },
      'Shift-Tab': () => {
        indent(this.editor, false)
        return true
      }
    }
  }
})
const termsKey = new PluginKey<DecorationSet>('notex-terms')

/** Texto de um parágrafo com o mesmo tamanho do conteúdo (código e itens que não são texto viram "￼"). */
function blockText(node: PMNode): string {
  let text = ''
  node.forEach((child) => {
    if (child.isText) text += child.marks.some((m) => m.type.name === 'code') ? '￼'.repeat(child.nodeSize) : child.text
    else text += '￼'.repeat(child.nodeSize)
  })
  return text
}

function termDecorations(doc: PMNode): DecorationSet {
  const matcher = termIndex.active()
  if (!matcher) return DecorationSet.empty
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false
    if (!node.isTextblock) return true
    for (const h of matcher.find(blockText(node))) {
      decos.push(Decoration.inline(pos + 1 + h.from, pos + 1 + h.to, { class: 'term-hit', 'data-term': h.key }))
    }
    return false
  })
  return DecorationSet.create(doc, decos)
}

/** Sublinha as palavras que são termos do glossário. Recalcula quando o texto ou a lista de termos muda. */
const TermHighlight = Extension.create({
  name: 'termHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: termsKey,
        state: {
          init: (_, state) => termDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(termsKey) ? termDecorations(tr.doc) : old)
        },
        props: { decorations: (state) => termsKey.getState(state) }
      })
    ]
  }
})

export class VisualEditor implements NoteEditor {
  readonly kind = 'visual' as const
  readonly dom: HTMLElement
  readonly editor: Editor
  private silent = false
  private readonly offTerms: () => void

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
        IndentKeys,
        TermHighlight,
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
    this.offTerms = termIndex.subscribe(() => this.editor.view.dispatch(this.editor.state.tr.setMeta(termsKey, true)))
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

  setReadOnly(readOnly: boolean): void {
    this.editor.setEditable(!readOnly)
  }

  reveal(t: RevealTarget): void {
    if (t.line < 1) return
    // O Markdown tem uma linha por bloco; acha o bloco de mesma ordem entre os que têm o termo.
    const blocks: { pos: number; text: string; range: [number, number] }[] = []
    this.editor.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      const text = node.textBetween(0, node.content.size, '\n', '\ufffc')
      const range = findFolded(text, t.query)
      if (range) blocks.push({ pos, text, range })
      return false
    })
    const b = blocks[Math.min(t.occurrence, blocks.length - 1)]
    if (!b) return
    const from = b.pos + 1 + b.range[0]
    const to = b.pos + 1 + b.range[1]
    this.editor.chain().setTextSelection({ from, to }).scrollIntoView().run()
    // Depois do layout (o rolar acontece antes), para o destaque achar o texto já desenhado.
    window.setTimeout(() => flash(this.editor.view.domAtPos(from), this.editor.view.domAtPos(to)), 50)
  }

  setDark(): void {
    // Cores vêm das variáveis CSS do tema.
  }

  remeasure(): void {
    // O ProseMirror usa o layout do navegador direto; nada a remedir.
  }

  position(): string {
    const { from, to } = this.editor.state.selection
    return to > from ? `${this.editor.state.doc.textBetween(from, to, ' ').length} selecionados` : ''
  }

  destroy(): void {
    this.offTerms()
    this.editor.destroy()
  }
}
