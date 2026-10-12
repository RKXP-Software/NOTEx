// @vitest-environment jsdom
// O editor visual grava Markdown: abrir e salvar não pode perder conteúdo.

import { describe, expect, it } from 'vitest'
import { VisualEditor } from '../src/editors/visual-editor'

const noop = { onChange: () => undefined, onSelection: () => undefined }

function roundTrip(md: string): string {
  const ed = new VisualEditor(md, noop)
  const out = ed.getText()
  ed.destroy()
  return out
}

const SAMPLE = `# Título

Parágrafo com **negrito**, *itálico*, ~~tachado~~ e \`código\`.

## Listas

- item 1
- item 2
  - sub item

1. primeiro
2. segundo

- [ ] tarefa aberta
- [x] tarefa feita

> citação

\`\`\`js
const x = 1
\`\`\`

---

[link](https://example.com) e imagem ![alt](img/foto.png)

| A | B |
| --- | --- |
| 1 | 2 |
`

describe('round-trip Markdown do editor visual', () => {
  it('preserva todo o conteúdo do exemplo', () => {
    const out = roundTrip(SAMPLE)
    for (const piece of [
      '# Título',
      '**negrito**',
      'itálico',
      '~~tachado~~',
      '`código`',
      '## Listas',
      'item 1',
      'sub item',
      'primeiro',
      '[ ] tarefa aberta',
      '[x] tarefa feita',
      '> citação',
      '```js',
      'const x = 1',
      '[link](https://example.com)',
      '![alt](img/foto.png)',
      '| A',
      '| 1'
    ]) {
      expect(out, `faltou ${piece}\n---\n${out}`).toContain(piece)
    }
  })

  it('é estável: salvar duas vezes dá o mesmo texto', () => {
    const once = roundTrip(SAMPLE)
    expect(roundTrip(once)).toBe(once)
  })

  it('texto simples volta igual', () => {
    expect(roundTrip('Uma linha.\n\nOutra linha.').trim()).toBe('Uma linha.\n\nOutra linha.')
  })
})
