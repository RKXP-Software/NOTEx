// Janela "Novidades": mostra o CHANGELOG.md embutido no app. Abre sozinha uma vez após atualizar.

import changelog from '../../CHANGELOG.md?raw'
import { parseChangelog } from '../changelog'
import { panel } from './dialogs'

const SEEN_KEY = 'notex.novidades.versao'

export function showNovidades(version: string): Promise<void> {
  const releases = parseChangelog(changelog)
  return panel((box, close) => {
    box.append(Object.assign(document.createElement('h2'), { textContent: `Novidades · v${version}` }))
    const body = document.createElement('div')
    body.className = 'news'
    for (const r of releases) {
      const sec = document.createElement('section')
      sec.append(Object.assign(document.createElement('h3'), { textContent: `Versão ${r.version}`, className: r.version === version ? 'current' : '' }))
      const ul = document.createElement('ul')
      for (const it of r.items) ul.append(Object.assign(document.createElement('li'), { textContent: it }))
      sec.append(ul)
      body.append(sec)
    }
    box.append(body)
    const row = document.createElement('div')
    row.className = 'modal-buttons'
    const ok = Object.assign(document.createElement('button'), { textContent: 'Fechar', className: 'primary' })
    ok.addEventListener('click', close)
    row.append(ok)
    box.append(row)
  })
}

/** Abre as novidades uma vez por versão (e na primeira abertura). */
export function showNovidadesIfNew(version: string): void {
  let seen: string | null = null
  try {
    seen = localStorage.getItem(SEEN_KEY)
  } catch {
    return
  }
  if (seen === version) return
  try {
    localStorage.setItem(SEEN_KEY, version)
  } catch {
    // sem armazenamento: não insiste
    return
  }
  void showNovidades(version)
}
