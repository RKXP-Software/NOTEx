// Cartão com a definição de um termo, aberto ao clicar numa palavra destacada.

import type { Term } from '../api'
import { popLayer, pushLayer } from './back'

let current: { el: HTMLElement; off: () => void } | null = null

export function closeTermCard(fromBack = false): void {
  if (!current) return
  current.off()
  current.el.remove()
  current = null
  if (!fromBack) popLayer('term-card')
}

/** Mostra as definições `defs` junto de `anchor`. `open` abre a nota onde o termo foi definido. */
export function showTermCard(anchor: DOMRect, defs: Term[], open: (t: Term) => void): void {
  closeTermCard()
  if (!defs.length) return
  const card = document.createElement('div')
  card.className = 'term-card'
  card.setAttribute('role', 'dialog')
  for (const t of defs) {
    const item = document.createElement('div')
    item.className = 'term-card-item'
    item.append(Object.assign(document.createElement('strong'), { textContent: t.term }))
    item.append(Object.assign(document.createElement('div'), { className: 'term-card-def', textContent: t.definition }))
    const name = t.path.split(/[\\/]/).pop()!.replace(/\.(md|txt)$/i, '')
    const foot = document.createElement('div')
    foot.className = 'term-card-foot'
    foot.append(Object.assign(document.createElement('small'), { textContent: `${t.notebookName} · ${name}` }))
    const go = Object.assign(document.createElement('button'), { textContent: 'Abrir a nota' })
    go.addEventListener('click', () => {
      closeTermCard()
      open(t)
    })
    foot.append(go)
    item.append(foot)
    card.append(item)
  }
  document.body.append(card)

  // Abaixo da palavra; acima se não couber; sempre dentro da janela.
  const margin = 8
  const w = card.offsetWidth
  const h = card.offsetHeight
  const left = Math.min(Math.max(margin, anchor.left), window.innerWidth - w - margin)
  const below = anchor.bottom + 6
  const top = below + h + margin <= window.innerHeight ? below : Math.max(margin, anchor.top - h - 6)
  card.style.left = `${left}px`
  card.style.top = `${top}px`

  const onDown = (e: Event): void => {
    if (!card.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.term-hit')) closeTermCard()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeTermCard()
  }
  const onScroll = (): void => closeTermCard()
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  current = {
    el: card,
    off: () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }
  pushLayer('term-card', () => closeTermCard(true))
}
