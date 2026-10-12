import { App } from './app'
import { toast } from './ui/dialogs'

// Sem menu de contexto do navegador fora dos editores e campos (os nossos menus cobrem o resto).
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement
  if (!t.closest('.visual-editor, .text-editor, input, textarea')) e.preventDefault()
})

// Arquivos soltos na janela não devem navegar para fora do app.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

async function start(): Promise<void> {
  // Fora do Tauri (navegador comum, só em desenvolvimento): backend simulado em memória.
  if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
    const { install } = await import('./dev/mock-backend')
    install()
  }
  await new App().init()
}

start().catch((err: unknown) => {
  console.error(err)
  toast(`Falha ao iniciar: ${String(err)}`, 'error')
})
