// Lê o CHANGELOG.md (títulos "## versão" e itens "- texto").

export interface Release {
  version: string
  items: string[]
}

export function parseChangelog(text: string): Release[] {
  const out: Release[] = []
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) out.push({ version: h[1]!, items: [] })
    else if (out.length && /^[-*]\s+/.test(line)) out.at(-1)!.items.push(line.replace(/^[-*]\s+/, ''))
  }
  return out
}
