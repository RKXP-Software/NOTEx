// Comparação sem acentos e sem diferença de maiúsculas (mesma regra da busca no núcleo em Rust).

/** Minúsculas, sem acentos; `map[i]` é o índice (em unidades UTF-16) do caractere original de `text[i]`. */
export function foldMap(s: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  let i = 0
  for (const ch of s) {
    for (const d of ch.normalize('NFD')) {
      if (/\p{M}/u.test(d)) continue
      for (const l of d.toLowerCase()) {
        for (let k = 0; k < l.length; k++) map.push(i)
        text += l
      }
    }
    i += ch.length
  }
  return { text, map }
}

export function fold(s: string): string {
  return foldMap(s).text
}

/** Posição [início, fim) de `query` dentro de `text`, ignorando acentos e maiúsculas. */
export function findFolded(text: string, query: string): [number, number] | null {
  const q = fold(query.trim())
  if (!q) return null
  const f = foldMap(text)
  const at = f.text.indexOf(q)
  if (at < 0) return null
  return [f.map[at]!, f.map[at + q.length - 1]! + 1]
}
