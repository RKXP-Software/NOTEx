// Tema claro/escuro (adaptado do MDR): preferência 'system'|'light'|'dark'; aplica data-theme no <html>.

export type ThemePref = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

export function parseThemePref(v: unknown): ThemePref {
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

export function effectiveTheme(pref: ThemePref, systemDark: boolean): EffectiveTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

export class Theme {
  private readonly mq = window.matchMedia('(prefers-color-scheme: dark)')
  private _pref: ThemePref = 'system'

  constructor(private readonly onChange: (dark: boolean) => void) {
    this.mq.addEventListener('change', () => {
      if (this._pref === 'system') this.apply()
    })
  }

  get pref(): ThemePref {
    return this._pref
  }

  get dark(): boolean {
    return effectiveTheme(this._pref, this.mq.matches) === 'dark'
  }

  set(pref: ThemePref): void {
    this._pref = pref
    this.apply()
  }

  /** Alterna claro/escuro a partir do tema efetivo atual. */
  toggle(): void {
    this.set(this.dark ? 'light' : 'dark')
  }

  private apply(): void {
    const eff = this.dark ? 'dark' : 'light'
    document.documentElement.dataset.theme = eff
    document.documentElement.style.colorScheme = eff
    this.onChange(this.dark)
  }
}
