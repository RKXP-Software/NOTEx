// Termos do glossário dentro das notas: acha as palavras que são termos definidos, para os
// editores as destacarem e mostrarem a definição ao clicar.

import type { Term } from './api'
import { fold, foldMap } from './fold'

export interface TermHit {
  /** Posição [from, to) no texto original (unidades UTF-16). */
  from: number
  to: number
  /** Termo dobrado (sem acento/maiúsculas): chave para `definitions()`. */
  key: string
}

const MIN_TERM_CHARS = 2
const WORD = String.raw`\p{L}\p{N}_`

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

export class TermMatcher {
  private readonly byKey = new Map<string, Term[]>()
  private readonly re: RegExp | null

  constructor(terms: Term[]) {
    for (const t of terms) {
      const key = fold(t.term).replace(/\s+/g, ' ').trim()
      if ([...key].length < MIN_TERM_CHARS) continue
      const list = this.byKey.get(key)
      if (list) list.push(t)
      else this.byKey.set(key, [t])
    }
    // Termos maiores primeiro, para "padrão iso" ganhar de "padrão".
    const keys = [...this.byKey.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
    this.re = keys.length ? new RegExp(`(?<![${WORD}])(?:${keys.join('|')})(?![${WORD}])`, 'gu') : null
  }

  get size(): number {
    return this.byKey.size
  }

  /** Definições (de um ou mais cadernos) do termo de chave `key`. */
  definitions(key: string): Term[] {
    return this.byKey.get(key) ?? []
  }

  /**
   * Termos dentro de um trecho (um parágrafo ou linha). Não marca o termo no começo da linha
   * seguido de ":" (é a própria definição).
   */
  find(text: string): TermHit[] {
    if (!this.re || !text) return []
    const f = foldMap(text)
    const out: TermHit[] = []
    for (const m of f.text.matchAll(this.re)) {
      const start = m.index!
      const from = f.map[start]!
      const to = f.map[start + m[0].length - 1]! + 1
      const isDefinition = text.slice(0, from).trim() === '' && text.slice(to).startsWith(':')
      if (!isDefinition) out.push({ from, to, key: m[0] })
    }
    return out
  }
}

type Listener = () => void

/** Termos conhecidos (de todos os cadernos abertos) e se o destaque está ligado; os editores assinam. */
class TermIndex {
  private matcher: TermMatcher | null = null
  private on = readEnabled()
  private readonly listeners = new Set<Listener>()

  /** Matcher para os editores usarem agora (null = desligado ou sem termos). */
  active(): TermMatcher | null {
    return this.on ? this.matcher : null
  }

  get enabled(): boolean {
    return this.on
  }

  /** Substitui a lista de termos e avisa os editores. */
  set(terms: Term[]): void {
    this.matcher = terms.length ? new TermMatcher(terms) : null
    this.notify()
  }

  setEnabled(on: boolean): void {
    this.on = on
    try {
      localStorage.setItem(ENABLED_KEY, on ? '1' : '0')
    } catch {
      // sem armazenamento: vale só nesta sessão
    }
    this.notify()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }
}

const ENABLED_KEY = 'notex.termos.destacar'

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

export const termIndex = new TermIndex()
