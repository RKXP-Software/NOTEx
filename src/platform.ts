// Plataforma: no celular a interface usa um painel só, gaveta lateral e alvos de toque maiores,
// e esconde o que depende do disco do PC (abrir arquivo avulso, escolher pastas, Explorer).

export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** Recursos de desktop (diálogos de pasta/arquivo com caminho real, Explorer). */
export const hasDesktopFs = !isMobile
