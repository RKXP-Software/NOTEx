// Diálogos leves (pergunta de texto, confirmação), menu de contexto e avisos rápidos.

import { popLayer, pushLayer } from './back'

export interface MenuItem {
  label: string
  action?: () => void
  shortcut?: string
  disabled?: boolean
  danger?: boolean
}
export type MenuEntry = MenuItem | 'sep'

let openMenu: HTMLElement | null = null

/** Fecha o menu aberto. `fromBack`: fechado pelo botão Voltar (o histórico já voltou). */
export function closeMenu(fromBack = false): void {
  if (!openMenu) return
  openMenu.remove()
  openMenu = null
  if (!fromBack) popLayer('menu')
}

/** Mostra um menu de contexto na posição do evento (ajustado para caber na janela). */
export function showMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.setAttribute('role', 'menu')
  for (const entry of entries) {
    if (entry === 'sep') {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }))
      continue
    }
    const item = document.createElement('button')
    item.className = 'menu-item' + (entry.danger ? ' danger' : '')
    item.setAttribute('role', 'menuitem')
    item.disabled = !!entry.disabled
    item.append(Object.assign(document.createElement('span'), { textContent: entry.label }))
    if (entry.shortcut) item.append(Object.assign(document.createElement('kbd'), { textContent: entry.shortcut }))
    item.addEventListener('click', () => {
      closeMenu()
      entry.action?.()
    })
    menu.appendChild(item)
  }
  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
  openMenu = menu
  pushLayer('menu', () => closeMenu(true))
  ;(menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus()
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu()
})
document.addEventListener('keydown', (e) => {
  if (!openMenu) return
  if (e.key === 'Escape') {
    closeMenu()
    e.stopPropagation()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = [...openMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
    e.preventDefault()
  }
})
window.addEventListener('blur', () => closeMenu())

function modal(build: (box: HTMLElement, close: (v: unknown) => void) => void): Promise<unknown> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const box = document.createElement('div')
    box.className = 'modal'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    overlay.appendChild(box)
    let closed = false
    const close = (v: unknown, fromBack = false): void => {
      if (closed) return
      closed = true
      overlay.remove()
      if (!fromBack) popLayer('modal')
      prevFocus?.focus()
      resolve(v)
    }
    pushLayer('modal', () => close(null, true))
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null)
    })
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(null)
      }
    })
    build(box, close)
    document.body.appendChild(overlay)
    ;(box.querySelector('input, button.primary') as HTMLElement | null)?.focus()
  })
}

function buttons(box: HTMLElement, items: { label: string; primary?: boolean; danger?: boolean; onClick: () => void }[]): void {
  const row = document.createElement('div')
  row.className = 'modal-buttons'
  for (const it of items) {
    const b = document.createElement('button')
    b.textContent = it.label
    if (it.primary) b.classList.add('primary')
    if (it.danger) b.classList.add('danger')
    b.addEventListener('click', it.onClick)
    row.appendChild(b)
  }
  box.appendChild(row)
}

/** Pede um texto. Devolve null se cancelado. Seleciona o nome sem extensão por padrão. */
export async function prompt(title: string, initial = '', okLabel = 'OK'): Promise<string | null> {
  const v = await modal((box, close) => {
    box.append(Object.assign(document.createElement('h2'), { textContent: title }))
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    input.spellcheck = false
    box.appendChild(input)
    const ok = (): void => close(input.value.trim() || null)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok()
    })
    buttons(box, [
      { label: 'Cancelar', onClick: () => close(null) },
      { label: okLabel, primary: true, onClick: ok }
    ])
    queueMicrotask(() => {
      const dot = initial.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : initial.length)
    })
  })
  return typeof v === 'string' ? v : null
}

export async function confirm(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  const v = await modal((box, close) => {
    box.append(Object.assign(document.createElement('h2'), { textContent: title }))
    box.append(Object.assign(document.createElement('p'), { textContent: message }))
    buttons(box, [
      { label: 'Cancelar', onClick: () => close(false) },
      { label: okLabel, primary: true, danger, onClick: () => close(true) }
    ])
  })
  return v === true
}

/** Pergunta com várias opções (uma por linha). Devolve o índice escolhido ou null se cancelado. */
export async function choose(
  title: string,
  message: string,
  options: { label: string; detail?: string }[]
): Promise<number | null> {
  const v = await modal((box, close) => {
    box.append(Object.assign(document.createElement('h2'), { textContent: title }))
    if (message) box.append(Object.assign(document.createElement('p'), { textContent: message }))
    const list = document.createElement('div')
    list.className = 'choice-list'
    options.forEach((o, i) => {
      const b = document.createElement('button')
      b.className = 'choice' + (i === 0 ? ' primary' : '')
      b.append(Object.assign(document.createElement('strong'), { textContent: o.label }))
      if (o.detail) b.append(Object.assign(document.createElement('small'), { textContent: o.detail }))
      b.addEventListener('click', () => close(i))
      list.appendChild(b)
    })
    box.appendChild(list)
    buttons(box, [{ label: 'Cancelar', onClick: () => close(null) }])
  })
  return typeof v === 'number' ? v : null
}

/** Ícones sugeridos para pastas e cadernos. */
export const ICONS = [
  '📁', '📂', '📓', '📒', '📔', '📕', '📗', '📘', '📙', '📚', '📖', '📝', '✏️', '📌', '📎', '🗂️',
  '🗃️', '💼', '🏠', '🏢', '🎓', '💡', '⭐', '⚡', '🔥', '❤️', '💙', '💚', '💛', '💜', '✅', '📅',
  '⏰', '🛒', '💰', '📈', '📊', '🧪', '💻', '📱', '🎮', '🎵', '🎨', '📷', '✈️', '🚗', '🌱', '🍳',
  '🏋️', '⚽', '🐾', '🔒', '🔑', '⚙️', '🛠️', '🧠', '❓', '❗', '🎯', '🚀', '🌎', '☕'
]

/**
 * Seletor de ícone. Devolve o ícone escolhido, '' para voltar ao ícone padrão, ou null se cancelado.
 */
export async function pickIcon(title: string, current: string | undefined): Promise<string | null> {
  const v = await modal((box, close) => {
    box.classList.add('icon-modal')
    box.append(Object.assign(document.createElement('h2'), { textContent: title }))
    const grid = document.createElement('div')
    grid.className = 'icon-grid'
    for (const icon of ICONS) {
      const b = document.createElement('button')
      b.className = 'icon-choice' + (icon === current ? ' selected' : '')
      b.textContent = icon
      b.title = icon
      b.addEventListener('click', () => close(icon))
      grid.appendChild(b)
    }
    box.appendChild(grid)
    // Qualquer outro emoji pode ser colado (Win + . abre o painel de emojis do Windows).
    const row = document.createElement('div')
    row.className = 'icon-custom'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Outro: cole um emoji (Win + .)'
    input.maxLength = 8
    input.value = current && !ICONS.includes(current) ? current : ''
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) close(input.value.trim())
    })
    row.appendChild(input)
    box.appendChild(row)
    buttons(box, [
      { label: 'Ícone padrão', onClick: () => close('') },
      { label: 'Cancelar', onClick: () => close(null) },
      { label: 'Usar', primary: true, onClick: () => close(input.value.trim() || null) }
    ])
    queueMicrotask(() => (grid.querySelector('.selected, button') as HTMLElement | null)?.focus())
  })
  return typeof v === 'string' ? v : null
}

let toastTimer: number | undefined

/** Aviso rápido no rodapé (erros e confirmações de ações). */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.setAttribute('role', 'status')
    document.body.appendChild(el)
  }
  el.textContent = message
  el.className = `show ${kind}`
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 6000 : 2500)
}
