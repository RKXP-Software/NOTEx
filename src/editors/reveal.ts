// Mostrar um trecho encontrado (busca/glossário): rola até ele e o destaca por alguns segundos.

export interface RevealTarget {
  /** Linha do arquivo (1 = primeira); 0 = só abrir a nota. */
  line: number
  /** Texto buscado (sem acento/maiúsculas). */
  query: string
  /** Quantas linhas com o termo vieram antes na nota. */
  occurrence: number
}

let timer: number | undefined

/** Destaca o intervalo do DOM com a "Custom Highlight API" (funciona mesmo sem foco no editor). */
export function flash(from: { node: Node; offset: number }, to: { node: Node; offset: number }): void {
  const w = window as unknown as { Highlight?: new (...r: Range[]) => unknown }
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  if (!w.Highlight || !registry) return
  try {
    const r = document.createRange()
    r.setStart(from.node, from.offset)
    r.setEnd(to.node, to.offset)
    registry.set('notex-hit', new w.Highlight(r))
    window.clearTimeout(timer)
    timer = window.setTimeout(() => registry.delete('notex-hit'), 3500)
  } catch {
    // posição fora do texto: sem destaque
  }
}
