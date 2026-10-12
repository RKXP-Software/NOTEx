// Barra de ferramentas: ações gerais + formatação (habilitada só no editor visual).

import type { Editor } from '@tiptap/core'
import { prompt } from './dialogs'
import { indent } from '../editors/visual-editor'

export interface ToolbarActions {
  toggleSidebar(): void
  newQuickNote(): void
  openFile(): void
  toggleRaw(): void
  splitRight(): void
  splitDown(): void
  toggleTheme(): void
}

interface FormatButton {
  id: string
  label: string
  title: string
  run: (e: Editor) => void
  active?: (e: Editor) => boolean
  cls?: string
}

const FORMAT: (FormatButton | 'sep')[] = [
  { id: 'bold', label: 'B', title: 'Negrito (Ctrl+B)', cls: 'fmt-bold', run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { id: 'italic', label: 'I', title: 'Itálico (Ctrl+I)', cls: 'fmt-italic', run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { id: 'strike', label: 'S', title: 'Tachado (Ctrl+Shift+S)', cls: 'fmt-strike', run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive('strike') },
  { id: 'code', label: '</>', title: 'Código (Ctrl+E)', run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive('code') },
  'sep',
  { id: 'h1', label: 'H1', title: 'Título 1 (Ctrl+Alt+1)', run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (e) => e.isActive('heading', { level: 1 }) },
  { id: 'h2', label: 'H2', title: 'Título 2 (Ctrl+Alt+2)', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
  { id: 'h3', label: 'H3', title: 'Título 3 (Ctrl+Alt+3)', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive('heading', { level: 3 }) },
  { id: 'p', label: '¶', title: 'Parágrafo normal (Ctrl+Alt+0)', run: (e) => e.chain().focus().setParagraph().run(), active: (e) => e.isActive('paragraph') },
  'sep',
  { id: 'ul', label: '•≡', title: 'Lista (Ctrl+Shift+8)', run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
  { id: 'ol', label: '1≡', title: 'Lista numerada (Ctrl+Shift+7)', run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { id: 'task', label: '☑', title: 'Lista de tarefas (Ctrl+Shift+9)', run: (e) => e.chain().focus().toggleTaskList().run(), active: (e) => e.isActive('taskList') },
  { id: 'indent', label: '→', title: 'Aumentar recuo (Tab)', run: (e) => indent(e, true) },
  { id: 'outdent', label: '←', title: 'Diminuir recuo (Shift+Tab)', run: (e) => indent(e, false) },
  'sep',
  { id: 'quote', label: '❝', title: 'Citação (Ctrl+Shift+B)', run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
  { id: 'codeblock', label: '{ }', title: 'Bloco de código (Ctrl+Alt+C)', run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive('codeBlock') },
  { id: 'hr', label: '―', title: 'Linha horizontal', run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: 'link', label: '🔗', title: 'Link (Ctrl+K)', run: (e) => void editLink(e), active: (e) => e.isActive('link') },
  'sep',
  { id: 'clear', label: 'T̸', title: 'Limpar formatação', run: (e) => e.chain().focus().unsetAllMarks().clearNodes().run() }
]


export async function editLink(e: Editor): Promise<void> {
  const current = (e.getAttributes('link').href as string | undefined) ?? ''
  const url = await prompt('Endereço do link (vazio remove)', current || 'https://')
  if (url === null) return
  const chain = e.chain().focus().extendMarkRange('link')
  if (url === '' || url === 'https://') chain.unsetLink().run()
  else chain.setLink({ href: /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}` }).run()
}

export class Toolbar {
  private readonly formatButtons = new Map<string, { btn: HTMLButtonElement; def: FormatButton }>()
  private readonly rawBtn: HTMLButtonElement
  private editor: Editor | null = null

  constructor(root: HTMLElement, actions: ToolbarActions) {
    root.replaceChildren()
    const btn = (label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.setAttribute('aria-label', title)
      if (cls) b.className = cls
      // Não rouba o foco do editor ao clicar.
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', onClick)
      root.appendChild(b)
      return b
    }
    const sep = (): void => {
      root.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
    }

    btn('☰', 'Mostrar/ocultar barra lateral (Ctrl+Shift+E)', actions.toggleSidebar, 'icon')
    btn('＋ Nota', 'Nova nota rápida (Ctrl+N)', actions.newQuickNote)
    btn('Abrir', 'Abrir arquivo .md/.txt (Ctrl+O)', actions.openFile)
    sep()
    for (const def of FORMAT) {
      if (def === 'sep') {
        sep()
        continue
      }
      const b = btn(def.label, def.title, () => this.editor && def.run(this.editor), `fmt ${def.cls ?? ''}`)
      this.formatButtons.set(def.id, { btn: b, def })
    }
    this.rawBtn = btn('MD', 'Alternar editor visual / Markdown cru (Ctrl+Shift+M)', actions.toggleRaw, 'fmt-raw')
    root.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }))
    btn('⫴', 'Dividir à direita (Ctrl+\\)', actions.splitRight, 'icon')
    btn('⊟', 'Dividir abaixo (Ctrl+Shift+\\)', actions.splitDown, 'icon')
    btn('◐', 'Alternar tema claro/escuro (Ctrl+Shift+T)', actions.toggleTheme, 'icon')
  }

  /** Atualiza o estado conforme o editor ativo (visual, texto/.md cru ou nenhum). */
  update(state: { editor: Editor | null; canRaw: boolean; raw: boolean }): void {
    this.editor = state.editor
    for (const { btn, def } of this.formatButtons.values()) {
      btn.disabled = !state.editor
      btn.classList.toggle('active', !!state.editor && !!def.active?.(state.editor))
    }
    this.rawBtn.disabled = !state.canRaw
    this.rawBtn.classList.toggle('active', state.raw)
  }
}
