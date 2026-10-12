// Documento aberto: arquivo em disco + editor + salvamento automático.

import { api, CONFLICT, type TextFormat } from './api'
import { docKind, type DocKind } from './naming'
import { TextEditor } from './editors/text-editor'
import { VisualEditor } from './editors/visual-editor'
import type { NoteEditor } from './editors/types'

/** Espera após a última tecla antes de gravar. */
export const AUTOSAVE_DELAY_MS = 700

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

export interface DocHooks {
  /** Status/nome mudou (atualiza aba e barra de status). */
  changed(doc: Doc): void
  /** Cursor/seleção mudou. */
  selection(doc: Doc): void
  /** Depois de cada gravação bem-sucedida (renomeação automática de notas rápidas). */
  saved(doc: Doc): void | Promise<void>
  /**
   * O arquivo mudou no disco enquanto havia edição local não salva (outro aparelho, outro
   * programa). `text` é a versão local, que não pode se perder.
   */
  conflict(doc: Doc, text: string): Promise<void>
}

export class Doc {
  /** Elemento estável que a área de trabalho insere no painel; o editor vive dentro dele. */
  readonly host: HTMLElement
  editor!: NoteEditor
  status: SaveStatus = 'saved'
  error = ''
  /** Modo "Markdown cru" (só para .md). */
  raw = false
  /** Nota rápida ainda com nome provisório: será renomeada pela primeira linha. */
  autoName = false

  /** Texto (como o editor o serializa) que corresponde ao arquivo em disco. */
  private savedText = ''
  private timer: number | undefined
  private changeSeq = 0
  private pending: Promise<void> | null = null

  private constructor(
    public path: string,
    public format: TextFormat,
    public mtime: number | null,
    private dark: boolean,
    private readonly hooks: DocHooks
  ) {
    this.host = document.createElement('div')
    this.host.className = 'doc-host'
  }

  static async open(path: string, opts: { dark: boolean; raw?: boolean; autoName?: boolean }, hooks: DocHooks): Promise<Doc> {
    const content = await api.readNote(path)
    const doc = new Doc(path, content.format, content.mtime, opts.dark, hooks)
    doc.raw = !!opts.raw && docKind(path) === 'md'
    doc.autoName = !!opts.autoName
    doc.mountEditor(content.text)
    doc.savedText = doc.editor.getText()
    return doc
  }

  get kind(): DocKind {
    return docKind(this.path)
  }

  get dirty(): boolean {
    return this.status === 'dirty' || this.status === 'error'
  }

  private mountEditor(text: string): void {
    const events = {
      onChange: () => this.onChange(),
      onSelection: () => this.hooks.selection(this)
    }
    this.editor?.destroy()
    this.host.replaceChildren()
    this.editor =
      this.kind === 'md' && !this.raw
        ? new VisualEditor(text, events)
        : new TextEditor(text, events, { markdown: this.kind === 'md', dark: this.dark })
    this.host.appendChild(this.editor.dom)
  }

  /** Alterna editor visual ↔ Markdown cru, preservando o texto. */
  setRaw(raw: boolean): void {
    if (this.kind !== 'md' || raw === this.raw) return
    const text = this.editor.getText()
    this.raw = raw
    this.mountEditor(text)
    this.hooks.changed(this)
  }

  /** Recria o editor após mudança de tipo (ex.: renomear .txt para .md). */
  refreshKind(): void {
    if (this.kind !== 'md') this.raw = false
    const wantVisual = this.kind === 'md' && !this.raw
    if ((this.editor.kind === 'visual') !== wantVisual) this.mountEditor(this.editor.getText())
  }

  setDark(dark: boolean): void {
    this.dark = dark
    this.editor.setDark(dark)
  }

  private onChange(): void {
    this.changeSeq++
    if (this.status !== 'saving') this.setStatus('dirty')
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS)
  }

  private setStatus(s: SaveStatus, error = ''): void {
    this.status = s
    this.error = error
    this.hooks.changed(this)
  }

  /** Grava agora se houver alterações. Chamadas concorrentes são serializadas. */
  async save(): Promise<void> {
    window.clearTimeout(this.timer)
    while (this.pending) await this.pending
    if (!this.dirty) return
    const seq = this.changeSeq
    const text = this.editor.getText()
    // Nada mudou de fato (ex.: digitou e desfez): não regrava o arquivo.
    if (text === this.savedText) {
      this.setStatus('saved')
      return
    }
    this.setStatus('saving')
    this.pending = (async () => {
      try {
        const r = await api.writeNote(this.path, text, this.format, this.mtime)
        this.format = r.format
        this.mtime = r.mtime
        this.savedText = text
        this.setStatus(this.changeSeq === seq ? 'saved' : 'dirty')
        await this.hooks.saved(this)
      } catch (err) {
        if (err === CONFLICT) {
          // Recarrega a versão do disco; a local vai para uma cópia (feita pelo app).
          this.status = 'saved'
          await this.hooks.conflict(this, text)
          await this.forceReload()
        } else {
          this.setStatus('error', typeof err === 'string' ? err : 'Falha ao salvar.')
        }
      } finally {
        this.pending = null
      }
    })()
    await this.pending
    // Houve digitação durante a gravação: agenda a próxima.
    if (this.status === 'dirty') this.timer = window.setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS)
  }

  /** Recarrega do disco se o arquivo mudou fora do app e não há alterações locais. */
  async reloadIfChanged(): Promise<'reloaded' | 'missing' | 'unchanged'> {
    if (this.dirty || this.status === 'saving') return 'unchanged'
    const mtime = await api.noteMtime(this.path).catch(() => null)
    if (mtime === null) return 'missing'
    if (mtime === this.mtime) return 'unchanged'
    const content = await api.readNote(this.path)
    if (this.dirty) return 'unchanged'
    this.format = content.format
    this.mtime = content.mtime
    if (content.text !== this.editor.getText()) this.editor.setText(content.text)
    this.savedText = this.editor.getText()
    return 'reloaded'
  }

  /** Recarrega do disco descartando o que está no editor (após guardar a versão local numa cópia). */
  async forceReload(): Promise<void> {
    const content = await api.readNote(this.path)
    this.format = content.format
    this.mtime = content.mtime
    this.editor.setText(content.text)
    this.savedText = this.editor.getText()
    this.setStatus('saved')
  }

  /** Atualiza a data de modificação conhecida (após renomear/mover, que podem alterá-la). */
  async refreshMtime(): Promise<void> {
    this.mtime = await api.noteMtime(this.path).catch(() => this.mtime)
  }

  text(): string {
    return this.editor.getText()
  }

  destroy(): void {
    window.clearTimeout(this.timer)
    this.editor.destroy()
    this.host.remove()
  }
}
