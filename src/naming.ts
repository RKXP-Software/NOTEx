// Nomes de notas e caminhos (funções puras).

/** Nome provisório de uma nota rápida: "Nota 2026-10-12 14h05". */
export function quickNoteTitle(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Nota ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}h${p(date.getMinutes())}`
}

/**
 * Título derivado da primeira linha não vazia do texto, sem marcação Markdown
 * (#, listas, checklists, citação, ênfase, links). Vazio se não houver texto.
 */
export function titleFromText(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`|\*|_)/g, '')
    .replace(/\\(.)/g, '$1')
    .trim()
    .slice(0, 60)
    .trim()
}

/** true quando a primeira linha já foi "concluída" (há texto depois dela). */
export function firstLineDone(text: string): boolean {
  const trimmed = text.replace(/^\s*\n/, '')
  const nl = trimmed.indexOf('\n')
  return nl > 0 && trimmed.slice(0, nl).trim() !== ''
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : path
}

export function extension(path: string): string {
  const name = baseName(path)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** Nome sem extensão (para exibir nas abas). */
export function stem(path: string): string {
  const name = baseName(path)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

export type DocKind = 'md' | 'txt'

export function docKind(path: string): DocKind {
  const ext = extension(path)
  return ext === 'md' || ext === 'markdown' ? 'md' : 'txt'
}

/** Comparação de caminhos tolerante a barras e maiúsculas (Windows). */
export function samePath(a: string, b: string): boolean {
  const n = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(a) === n(b)
}

/** true se `path` está dentro de `root` (ou é ele). */
export function isWithin(root: string, path: string): boolean {
  const n = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const r = n(root)
  const p = n(path)
  return p === r || p.startsWith(r + '/')
}

/** Substitui o prefixo `from` por `to` em `path` (após renomear/mover uma pasta). */
export function rebase(path: string, from: string, to: string): string {
  if (!isWithin(from, path)) return path
  return to + path.slice(from.replace(/[\\/]+$/, '').length)
}

/** Conta palavras (sequências de letras/números, inclusive acentuadas). */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}
