// Contrato comum dos editores (visual e texto), usado pelas abas.

export interface EditorEvents {
  /** O usuário alterou o conteúdo (não dispara em setText). */
  onChange(): void
  /** Seleção/cursor mudou (atualiza barra de formatação e status). */
  onSelection(): void
}

export interface NoteEditor {
  readonly kind: 'visual' | 'text'
  readonly dom: HTMLElement
  getText(): string
  /** Texto sem marcação, para contar palavras (barato; chamado a cada tecla). */
  plainText(): string
  /** Substitui o conteúdo sem disparar onChange. */
  setText(text: string): void
  focus(): void
  setDark(dark: boolean): void
  /** Texto curto de posição para a barra de status (ex.: "Ln 3, Col 7"). */
  position(): string
  destroy(): void
}
