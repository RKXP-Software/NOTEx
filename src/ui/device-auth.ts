// Autenticação do aparelho (PIN, padrão ou biometria do Android) antes de abrir cadernos privados.
// No computador não há essa etapa: vale a senha mestra.

import { isMobile } from '../platform'

export type DeviceAuth = 'ok' | 'cancelled' | 'unavailable'

/**
 * Pede o PIN/padrão/digital do aparelho. 'unavailable' = o aparelho não tem tela de bloqueio
 * configurada (ou não é celular): não dá para usar a senha guardada, só a digitada.
 */
export async function authenticateDevice(reason: string): Promise<DeviceAuth> {
  if (!isMobile) return 'unavailable'
  try {
    const { authenticate, checkStatus } = await import('@tauri-apps/plugin-biometric')
    const status = await checkStatus().catch(() => null)
    if (status && !status.isAvailable && status.errorCode === 'passcodeNotSet') return 'unavailable'
    await authenticate(reason, {
      allowDeviceCredential: true,
      title: 'NOTEx',
      subtitle: 'Cadernos privados',
      cancelTitle: 'Cancelar'
    })
    return 'ok'
  } catch (e) {
    const text = String((e as { message?: string })?.message ?? e).toLowerCase()
    // Sem tela de bloqueio ou sem recurso: não há o que perguntar.
    if (/not ?set|no(t)? (available|enrolled)|passcode|unavailable|not supported/.test(text)) return 'unavailable'
    return 'cancelled'
  }
}
