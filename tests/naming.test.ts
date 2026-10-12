import { describe, expect, it } from 'vitest'
import { countWords, docKind, firstLineDone, isWithin, quickNoteTitle, rebase, samePath, stem, titleFromText } from '../src/naming'

describe('notas rápidas', () => {
  it('título provisório com data e hora', () => {
    expect(quickNoteTitle(new Date(2026, 9, 2, 8, 5))).toBe('Nota 2026-10-02 08h05')
  })

  it.each([
    ['# Reunião de segunda\n\ntexto', 'Reunião de segunda'],
    ['\n\n  Lista de **compras**  \n- pão', 'Lista de compras'],
    ['- [ ] Ligar para o banco\n', 'Ligar para o banco'],
    ['1. Primeiro passo\n', 'Primeiro passo'],
    ['> citação importante\n', 'citação importante'],
    ['Veja [o site](https://x.com) agora\n', 'Veja o site agora'],
    ['', '']
  ])('título a partir de %j', (text, title) => {
    expect(titleFromText(text)).toBe(title)
  })

  it('limita o título a 60 caracteres', () => {
    expect(titleFromText('a'.repeat(100)).length).toBe(60)
  })

  it('primeira linha concluída só quando há quebra após texto', () => {
    expect(firstLineDone('Título')).toBe(false)
    expect(firstLineDone('Título\n')).toBe(true)
    expect(firstLineDone('\nTítulo\nmais')).toBe(true)
    expect(firstLineDone('\n\n')).toBe(false)
  })
})

describe('caminhos', () => {
  it('compara ignorando barras e maiúsculas', () => {
    expect(samePath('C:\\Notas\\A.md', 'c:/notas/a.md')).toBe(true)
    expect(isWithin('C:\\Notas', 'C:\\Notas\\sub\\a.md')).toBe(true)
    expect(isWithin('C:\\Notas', 'C:\\Notas-2\\a.md')).toBe(false)
  })

  it('rebase após mover pasta', () => {
    expect(rebase('C:\\N\\pasta\\a.md', 'C:\\N\\pasta', 'C:\\N\\nova')).toBe('C:\\N\\nova\\a.md')
    expect(rebase('C:\\N\\outra\\a.md', 'C:\\N\\pasta', 'C:\\N\\nova')).toBe('C:\\N\\outra\\a.md')
  })

  it('tipo e nome exibido', () => {
    expect(docKind('a.MD')).toBe('md')
    expect(docKind('a.markdown')).toBe('md')
    expect(docKind('a.txt')).toBe('txt')
    expect(stem('C:\\x\\Minha nota.md')).toBe('Minha nota')
  })
})

describe('contagem de palavras', () => {
  it('conta palavras acentuadas e com hífen/apóstrofo', () => {
    expect(countWords('Olá, mundo! Guarda-chuva d’água 42')).toBe(5)
    expect(countWords('   ')).toBe(0)
  })
})
