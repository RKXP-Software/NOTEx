// Sincronização na interface: indicador na barra de status e painel (parear, estado, aparelhos).
// No PC mostra o QR code e os celulares pareados; no celular lê o QR e mostra a conexão com o PC.

import { listen } from '@tauri-apps/api/event'
import { EVENT_DRIVE_STATUS, EVENT_SYNC_STATUS, driveApi, errorMessage, syncApi, type ClientStatus, type DriveStatus, type ServerStatus } from '../api'
import { isMobile } from '../platform'
import { confirm, panel, prompt, toast } from './dialogs'

const SEEN_ONLINE_MS = 60_000

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...kids)
  return e
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/** "agora", "há 3 min", "há 2 h", "em 12/10". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.round(s / 60)} min`
  if (s < 86_400) return `há ${Math.round(s / 3600)} h`
  return `em ${new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`
}

/** Nome do celular para o PC (modelo, pelo user agent do Android). */
export function deviceName(ua = navigator.userAgent): string {
  const m = /Android [\d.]+; ([^;)]+?)(?: Build[^;)]*)?\)/.exec(ua)
  const model = m?.[1]?.trim()
  return model && model !== 'K' ? model : 'Celular'
}

export class SyncUi {
  private client: ClientStatus | null = null
  private server: ServerStatus | null = null
  private drive: DriveStatus | null = null
  /** Login no Google em andamento (o painel se redesenha; o botão não pode voltar ao normal). */
  private connecting = false

  constructor(private readonly indicator: HTMLElement) {
    indicator.addEventListener('click', () => void this.open())
    indicator.setAttribute('role', 'button')
    indicator.tabIndex = 0
  }

  async init(): Promise<void> {
    this.drive = await driveApi.status().catch(() => null)
    await listen<DriveStatus>(EVENT_DRIVE_STATUS, (e) => {
      const before = this.drive
      this.drive = e.payload
      this.render()
      if (e.payload.state === 'idle' && e.payload.conflicts > 0 && before?.state === 'syncing') {
        toast(`Conflito: ${e.payload.conflicts} nota(s) editada(s) em dois aparelhos. A versão deste aparelho foi salva como cópia "(conflito …)".`)
      }
      if (before?.connected && !e.payload.connected && e.payload.message) toast(e.payload.message, 'error')
    })
    if (isMobile) {
      this.client = await syncApi.clientStatus().catch(() => null)
      await listen<ClientStatus>(EVENT_SYNC_STATUS, (e) => {
        const before = this.client
        this.client = e.payload
        this.render()
        if (e.payload.state === 'idle' && e.payload.conflicts > 0 && before?.state === 'syncing') {
          toast(`Conflito: ${e.payload.conflicts} nota(s) editada(s) nos dois aparelhos. A versão do celular foi salva como cópia "(conflito …)".`)
        }
      })
      await syncApi.setActive(document.visibilityState === 'visible')
      document.addEventListener('visibilitychange', () => {
        void syncApi.setActive(document.visibilityState === 'visible')
      })
    } else {
      await this.refreshServer()
      window.setInterval(() => void this.refreshServer(), 5000)
    }
    this.render()
  }

  private async refreshServer(): Promise<void> {
    this.server = await syncApi.serverStatus().catch(() => null)
    this.render()
  }

  /** Texto curto do indicador na barra de status. */
  private render(): void {
    const i = this.indicator
    i.className = 'sync-indicator'
    const d = this.drive
    if (d?.connected) {
      // Com o Drive ligado, ele é o caminho da sincronização (PC e celular).
      if (d.state === 'syncing') {
        i.textContent = '☁ Sincronizando…'
      } else if (d.state === 'idle') {
        i.textContent = d.lastSync ? `☁ Sincronizado ${time(d.lastSync)}` : '☁ Google Drive'
        i.classList.add('ok')
      } else {
        i.textContent = d.state === 'offline' ? '☁ Sem internet' : '☁ ⚠ Erro no Drive'
        i.classList.add('warn')
      }
      i.title = d.message || `Google Drive: ${d.email ?? ''}`
      return
    }
    if (isMobile) {
      const c = this.client
      if (!c || c.state === 'unpaired') {
        i.textContent = '⇅ Conectar ao PC'
        i.classList.add('off')
      } else if (c.state === 'syncing') {
        i.textContent = '⟳ Sincronizando…'
      } else if (c.state === 'idle') {
        i.textContent = c.lastSync ? `✓ Sincronizado ${time(c.lastSync)}` : '✓ Conectado'
        i.classList.add('ok')
      } else {
        i.textContent = '⚠ Sem conexão com o PC'
        i.classList.add('warn')
      }
      i.title = c?.message || (c?.serverName ? `PC: ${c.serverName}` : '')
      return
    }
    const s = this.server
    if (!s || !s.running) {
      i.textContent = '⚠ Sincronização desligada'
      i.classList.add('warn')
      i.title = s?.error ?? ''
      return
    }
    const online = s.devices.filter((d) => d.lastSeen && Date.now() - d.lastSeen < SEEN_ONLINE_MS)
    if (s.devices.length === 0) {
      i.textContent = '📱 Parear celular'
      i.classList.add('off')
    } else if (online.length > 0) {
      i.textContent = `📱 ${online.map((d) => d.name).join(', ')} conectado`
      i.classList.add('ok')
    } else {
      const last = Math.max(...s.devices.map((d) => d.lastSeen ?? 0))
      i.textContent = last ? `📱 Celular visto ${ago(last)}` : '📱 Celular pareado'
    }
    i.title = 'Sincronização com o celular'
  }

  async open(): Promise<void> {
    if (isMobile) await this.openClient()
    else await this.openServer()
  }

  // ---- PC ----

  private async openServer(): Promise<void> {
    await panel((box, close) => {
      box.append(el('h2', { textContent: 'Sincronização' }))
      const body = el('div', { className: 'sync-body' })
      box.append(body)
      let qr: { svg: string; ips: string[]; link: string } | null = null
      let pairedBefore = new Set<string>()
      let justPaired = ''

      const draw = (): void => {
        const s = this.server
        body.replaceChildren()
        body.append(this.driveSection(draw))
        body.append(el('h3', { textContent: 'Conexão direta com o celular' }))
        if (this.drive?.connected) {
          body.append(el('p', { className: 'muted', textContent: 'Com o Google Drive ligado, os celulares pareados recebem o acesso ao Drive e sincronizam por ele. Parear continua servindo para conectar um celular novo.' }))
        }
        if (!s?.running) {
          body.append(el('p', { className: 'sync-error', textContent: s?.error ?? 'Servidor de sincronização desligado.' }))
          return
        }
        body.append(
          el('p', { className: 'muted', textContent: `Este PC (${s.name}) aceita celulares pareados em: ${s.ips.map((ip) => `${ip}:${s.port}`).join(', ') || 'sem rede'}.` })
        )
        if (justPaired) body.append(el('p', { className: 'sync-ok', textContent: `✓ ${justPaired} pareado! A primeira sincronização começa em instantes.` }))
        if (qr) {
          const code = el('div', { className: 'qr' })
          // SVG gerado pelo próprio app (crate qrcode), sem conteúdo externo.
          code.innerHTML = qr.svg
          const link = qr.link
          const copy = el('button', { className: 'link-btn', textContent: 'Copiar código (para colar no celular)' })
          copy.addEventListener('click', () => {
            void navigator.clipboard.writeText(link).then(
              () => toast('Código copiado. No celular, use "Colar código".'),
              () => toast('Não foi possível copiar.', 'error')
            )
          })
          body.append(
            code,
            copy,
            el('ol', { className: 'steps' },
              el('li', { textContent: 'Abra o NOTEx no celular (no mesmo Wi-Fi deste PC, ou com o NordVPN Meshnet ligado nos dois).' }),
              el('li', { textContent: 'Toque em "⇅ Conectar ao PC" na barra de baixo.' }),
              el('li', { textContent: 'Toque em "Ler QR code" e aponte para este código.' })
            ),
            el('p', { className: 'muted', textContent: 'O código vale 10 minutos e serve para um celular. Na primeira vez o Windows pode pedir para liberar o NOTEx no firewall: permita em redes privadas.' })
          )
        }
        const list = el('div', { className: 'device-list' })
        if (s.devices.length === 0) list.append(el('p', { className: 'muted', textContent: 'Nenhum celular pareado ainda.' }))
        for (const d of s.devices) {
          const online = d.lastSeen && Date.now() - d.lastSeen < SEEN_ONLINE_MS
          const remove = el('button', { textContent: 'Remover' })
          remove.addEventListener('click', () => {
            void (async () => {
              if (!(await confirm('Remover celular', `"${d.name}" deixa de sincronizar com este PC. As notas continuam nos dois aparelhos.`, 'Remover', true))) return
              await syncApi.removeDevice(d.id)
              await this.refreshServer()
              draw()
            })()
          })
          list.append(
            el('div', { className: 'device' },
              el('span', { className: `dot ${online ? 'on' : ''}` }),
              el('div', { className: 'device-info' },
                el('strong', { textContent: d.name }),
                el('small', { textContent: online ? 'Conectado agora' : d.lastSeen ? `Visto ${ago(d.lastSeen)}` : 'Ainda não sincronizou desde que o PC abriu' })
              ),
              remove
            )
          )
        }
        body.append(el('h3', { textContent: 'Celulares pareados' }), list)
        const actions = el('div', { className: 'modal-buttons' })
        const pairBtn = el('button', { className: 'primary', textContent: qr ? 'Gerar outro código' : 'Parear novo celular' })
        pairBtn.addEventListener('click', () => {
          void (async () => {
            try {
              justPaired = ''
              pairedBefore = new Set(this.server?.devices.map((d) => d.id))
              qr = await syncApi.pairStart()
              draw()
            } catch (e) {
              toast(errorMessage(e), 'error')
            }
          })()
        })
        const closeBtn = el('button', { textContent: 'Fechar' })
        closeBtn.addEventListener('click', close)
        actions.append(closeBtn, pairBtn)
        body.append(actions)
      }

      draw()
      const timer = window.setInterval(() => {
        void this.refreshServer().then(() => {
          const added = this.server?.devices.find((d) => qr && !pairedBefore.has(d.id))
          if (added) {
            qr = null
            justPaired = added.name
          }
          draw()
        })
      }, 1500)
      return () => {
        window.clearInterval(timer)
        if (qr) void syncApi.pairCancel()
      }
    })
  }

  // ---- Celular ----

  private async openClient(): Promise<void> {
    await panel((box, close) => {
      box.append(el('h2', { textContent: 'Sincronização com o PC' }))
      const body = el('div', { className: 'sync-body' })
      box.append(body)

      const draw = (): void => {
        const c = this.client
        body.replaceChildren()
        const actions = el('div', { className: 'modal-buttons' })
        const closeBtn = el('button', { textContent: 'Fechar' })
        closeBtn.addEventListener('click', close)
        if (this.drive?.connected) {
          body.append(this.driveSection(draw))
          actions.append(closeBtn)
          body.append(actions)
          return
        }
        if (!c || c.state === 'unpaired') {
          body.append(
            el('p', { textContent: 'Conecte este celular ao NOTEx do seu PC para as notas ficarem iguais nos dois.' }),
            el('ol', { className: 'steps' },
              el('li', { textContent: 'No PC, clique em "📱 Parear celular" na barra de baixo e em "Parear novo celular".' }),
              el('li', { textContent: 'Aqui, toque em "Ler QR code" e aponte a câmera para o código.' })
            ),
            el('p', { className: 'muted', textContent: 'Os dois precisam estar no mesmo Wi-Fi.' })
          )
          const paste = el('button', { textContent: 'Colar código' })
          paste.addEventListener('click', () => void this.pairWithText(close))
          const scan = el('button', { className: 'primary', textContent: 'Ler QR code' })
          scan.addEventListener('click', () => void this.pairWithCamera(close))
          actions.append(closeBtn, paste, scan)
        } else {
          const states: Record<ClientStatus['state'], string> = {
            unpaired: '',
            idle: '✓ Sincronizado',
            syncing: '⟳ Sincronizando…',
            offline: '⚠ Sem conexão com o PC',
            error: '⚠ Erro na sincronização'
          }
          body.append(
            el('p', {}, 'PC: ', el('strong', { textContent: c.serverName ?? '—' })),
            el('p', { className: c.state === 'idle' ? 'sync-ok' : c.state === 'syncing' ? '' : 'sync-error', textContent: states[c.state] }),
            el('p', { className: 'muted', textContent: c.lastSync ? `Última sincronização: ${time(c.lastSync)} (${ago(c.lastSync)})` : 'Ainda não sincronizou.' })
          )
          if (c.message) body.append(el('p', { className: 'muted', textContent: c.message }))
          const unpair = el('button', { className: 'danger', textContent: 'Desconectar' })
          unpair.addEventListener('click', () => {
            void (async () => {
              if (!(await confirm('Desconectar do PC', 'O celular para de sincronizar. As notas continuam aqui e no PC.', 'Desconectar', true))) return
              await syncApi.unpair()
              this.client = await syncApi.clientStatus()
              this.render()
              draw()
            })()
          })
          const now = el('button', { className: 'primary', textContent: 'Sincronizar agora' })
          now.addEventListener('click', () => void syncApi.syncNow())
          actions.append(unpair, closeBtn, now)
        }
        body.append(actions)
      }

      draw()
      // Acompanha o estado enquanto o painel está aberto.
      const timer = window.setInterval(() => {
        void Promise.all([syncApi.clientStatus(), driveApi.status()]).then(([c, d]) => {
          this.client = c
          this.drive = d
          draw()
        })
      }, 1000)
      return () => window.clearInterval(timer)
    })
  }

  /** Bloco do Google Drive no painel (PC: conectar/desconectar; celular: estado). */
  private driveSection(redraw: () => void): HTMLElement {
    const d = this.drive
    const sec = el('div', { className: 'drive-section' })
    sec.append(el('h3', { textContent: '☁ Google Drive' }))
    if (!d?.configured) {
      sec.append(el('p', { className: 'muted', textContent: 'O Google Drive ainda não foi configurado neste build do NOTEx.' }))
      return sec
    }
    const row = el('div', { className: 'drive-actions' })
    if (d.connected) {
      const states: Record<DriveStatus['state'], string> = {
        off: '',
        idle: '✓ Sincronizado',
        syncing: '⟳ Sincronizando…',
        offline: '⚠ Sem internet',
        error: '⚠ Erro na sincronização'
      }
      sec.append(
        el('p', {}, 'Conta: ', el('strong', { textContent: d.email ?? '—' })),
        el('p', { className: d.state === 'idle' ? 'sync-ok' : d.state === 'syncing' ? '' : 'sync-error', textContent: states[d.state] }),
        el('p', { className: 'muted', textContent: d.lastSync ? `Última sincronização: ${time(d.lastSync)} (${ago(d.lastSync)}). Mudanças do outro aparelho chegam em até ~20 s.` : 'Primeira sincronização em andamento…' })
      )
      if (d.message) sec.append(el('p', { className: 'muted', textContent: d.message }))
      const now = el('button', { textContent: 'Sincronizar agora' })
      now.addEventListener('click', () => void driveApi.syncNow())
      const off = el('button', { className: 'danger', textContent: isMobile ? 'Parar de usar o Drive aqui' : 'Desconectar' })
      off.addEventListener('click', () => {
        void (async () => {
          const msg = isMobile
            ? 'Este celular volta a sincronizar direto com o PC. As notas continuam aqui e no Drive.'
            : 'O NOTEx deixa de usar o Google Drive neste PC e nos celulares. As notas continuam no PC, nos celulares e no Drive.'
          if (!(await confirm('Desconectar o Google Drive', msg, 'Desconectar', true))) return
          await driveApi.disconnect()
          this.drive = await driveApi.status()
          this.render()
          redraw()
        })()
      })
      row.append(off, now)
    } else if (isMobile) {
      sec.append(el('p', { className: 'muted', textContent: 'Conecte o Google Drive no NOTEx do PC: este celular pareado recebe o acesso sozinho na próxima sincronização.' }))
    } else {
      sec.append(el('p', { className: 'muted', textContent: 'Sincronize pelo Google Drive: funciona de qualquer lugar, mesmo com o PC desligado. As notas ficam na pasta NOTEx do seu Drive, e o NOTEx só acessa o que ele mesmo criou.' }))
      const connect = el('button', {
        className: 'primary',
        textContent: this.connecting ? 'Aguardando o login no navegador…' : 'Conectar Google Drive',
        disabled: this.connecting
      })
      connect.addEventListener('click', () => {
        void (async () => {
          this.connecting = true
          redraw()
          try {
            const email = await driveApi.connect()
            toast(`Google Drive conectado: ${email}. Enviando as notas…`)
            this.drive = await driveApi.status()
            this.render()
          } catch (e) {
            const msg = errorMessage(e)
            toast(msg, msg === 'Login cancelado.' ? 'info' : 'error')
          }
          this.connecting = false
          redraw()
        })()
      })
      if (this.connecting) {
        const cancel = el('button', { textContent: 'Cancelar' })
        cancel.addEventListener('click', () => void driveApi.cancelConnect())
        row.append(cancel)
      }
      row.append(connect)
    }
    sec.append(row)
    return sec
  }

  private async pairWith(link: string, close: () => void): Promise<void> {
    try {
      toast('Conectando ao PC…')
      const name = await syncApi.pair(link, deviceName())
      this.client = await syncApi.clientStatus()
      this.render()
      close()
      toast(`Conectado a ${name}. Sincronizando…`)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async pairWithCamera(close: () => void): Promise<void> {
    try {
      const scanner = await import('@tauri-apps/plugin-barcode-scanner')
      let perm = await scanner.checkPermissions()
      if (perm !== 'granted') perm = await scanner.requestPermissions()
      if (perm !== 'granted') {
        toast('Sem permissão da câmera. Use "Colar código" ou libere a câmera nas configurações do Android.', 'error')
        return
      }
      const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] })
      await this.pairWith(result.content, close)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  private async pairWithText(close: () => void): Promise<void> {
    const link = await prompt('Cole o código de pareamento (começa com notex1:)', '', 'Conectar')
    if (link) await this.pairWith(link, close)
  }
}
