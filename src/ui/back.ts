// Botão Voltar do Android: cada camada aberta (gaveta, menu, diálogo) empilha um estado no
// histórico; o Voltar fecha a camada de cima em vez de sair do app. No desktop não faz nada.

import { isMobile } from '../platform'

interface Layer {
  key: string
  close: () => void
}

const layers: Layer[] = []
/** Voltas no histórico disparadas por nós (camada fechada pela interface), a ignorar no popstate. */
let selfBacks = 0
/**
 * Entradas do histórico de camadas fechadas pela interface que ainda não foram desfeitas.
 * O history.back() é adiado: se outra camada abrir logo em seguida (item de menu que abre um
 * diálogo), ela reaproveita a entrada, evitando um back() e um pushState concorrentes.
 */
let pendingBacks = 0

window.addEventListener('popstate', () => {
  if (selfBacks > 0) {
    selfBacks--
    return
  }
  layers.pop()?.close()
})

/** Registra uma camada aberta. `close` é chamado se o usuário apertar Voltar. */
export function pushLayer(key: string, close: () => void): void {
  if (!isMobile) return
  layers.push({ key, close })
  if (pendingBacks > 0) pendingBacks--
  else history.pushState({ notexLayer: layers.length }, '')
}

/** A camada foi fechada pela interface (toque, botão): remove o estado correspondente. */
export function popLayer(key: string): void {
  if (!isMobile) return
  const i = layers.map((l) => l.key).lastIndexOf(key)
  if (i < 0) return
  layers.splice(i, 1)
  pendingBacks++
  setTimeout(() => {
    if (pendingBacks === 0) return
    pendingBacks--
    selfBacks++
    history.back()
  }, 0)
}
