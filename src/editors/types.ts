// Contrato comum dos editores (visual e texto), usado pelas abas.

import type { RevealTarget } from './reveal'

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
  /** Somente leitura: o texto aparece e pode ser selecionado/copiado, mas não editado. */
  setReadOnly(readOnly: boolean): void
  /** Rola até o trecho encontrado pela busca e o destaca. */
  reveal(target: RevealTarget): void
  setDark(dark: boolean): void
  /** Remede o layout (após mudar o tamanho da fonte, ex.: zoom). */
  remeasure(): void
  /** Texto curto de posição para a barra de status (ex.: "Ln 3, Col 7"). */
  position(): string
  destroy(): void
}
