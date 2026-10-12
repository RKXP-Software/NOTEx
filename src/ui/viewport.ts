// Celular: com o teclado aberto o app ocupa só a área visível e a página não sai do lugar,
// para a barra de ferramentas ficar sempre no topo e utilizável.

import { isMobile } from '../platform'

export function bindViewport(): void {
  if (!isMobile) return
  const vv = window.visualViewport
  const apply = (): void => {
    const root = document.documentElement.style
    if (vv) {
      root.setProperty('--vv-height', `${vv.height}px`)
      root.setProperty('--vv-top', `${vv.offsetTop}px`)
    }
    // O WebView rola a página para mostrar o cursor; a rolagem útil é só a do editor.
    if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0)
  }
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('scroll', apply)
  apply()
}

/** Pinça com dois dedos dentro do editor: chama `onScale` com a razão entre as distâncias (ao soltar). */
export function bindPinch(area: HTMLElement, onStep: (dir: 1 | -1) => void): void {
  if (!isMobile) return
  const dist = (t: TouchList): number => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY)
  let start = 0
  let last = 1
  let on = false
  const inEditor = (e: TouchEvent): boolean => (e.target as HTMLElement | null)?.closest?.('.visual-editor, .text-editor') != null
  area.addEventListener(
    'touchstart',
    (e) => {
      on = e.touches.length === 2 && inEditor(e)
      if (on) {
        start = dist(e.touches)
        last = 1
      }
    },
    { passive: true }
  )
  area.addEventListener(
    'touchmove',
    (e) => {
      if (!on || e.touches.length !== 2) return
      e.preventDefault()
      const ratio = dist(e.touches) / start
      // Um nível de zoom a cada ~18% de variação da distância entre os dedos.
      if (ratio / last > 1.18) {
        onStep(1)
        last = ratio
      } else if (ratio / last < 1 / 1.18) {
        onStep(-1)
        last = ratio
      }
    },
    { passive: false }
  )
  area.addEventListener('touchend', () => (on = false), { passive: true })
  area.addEventListener('touchcancel', () => (on = false), { passive: true })
}
