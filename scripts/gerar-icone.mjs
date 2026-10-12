// Ícone do app: rasteriza icons-src/icon.svg (resvg, sem depender de fontes do sistema) em
// icons-src/icon.png (1024 px) e gera todos os tamanhos (Windows + Android) com `tauri icon`.
// Uso: npm run icon            → gera a partir de icons-src/icon.svg
//      npm run icon -- previa  → prancha de comparação das opcao-*.svg em icons-src/previa.png
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const dir = fileURLToPath(new URL('../icons-src/', import.meta.url))
const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

if (process.argv[2] === 'previa') {
  // Cada opção em 256 px e, ao lado, em 32 px e 16 px (tamanhos da barra de tarefas/aba).
  const opcoes = readdirSync(dir).filter((f) => /^opcao-.*\.svg$/.test(f)).sort()
  const cel = 300
  const imgs = opcoes
    .map((f, i) => {
      const svg = readFileSync(dir + f, 'utf8')
      const b64 = (s) => png(svg, s).toString('base64')
      const x = i * cel
      return `
      <image x="${x + 22}" y="20" width="256" height="256" href="data:image/png;base64,${b64(256)}"/>
      <image x="${x + 22}" y="296" width="32" height="32" href="data:image/png;base64,${b64(32)}"/>
      <image x="${x + 66}" y="304" width="16" height="16" href="data:image/png;base64,${b64(16)}"/>
      <text x="${x + 150}" y="318" font-size="22" font-family="sans-serif" fill="#333" text-anchor="middle">${f.replace('.svg', '').replace('opcao-', 'Opção ').toUpperCase()}</text>`
    })
    .join('')
  const prancha = `<svg xmlns="http://www.w3.org/2000/svg" width="${opcoes.length * cel}" height="345"><rect width="100%" height="100%" fill="#f3f4f6"/>${imgs}</svg>`
  writeFileSync(dir + 'previa.png', png(prancha, opcoes.length * cel))
  console.log(`Prévia: ${dir}previa.png (${opcoes.join(', ')})`)
} else {
  writeFileSync(dir + 'icon.png', png(readFileSync(dir + 'icon.svg'), 1024))
  execSync(`npx tauri icon "${dir}icon.png"`, { stdio: 'inherit' })
}
