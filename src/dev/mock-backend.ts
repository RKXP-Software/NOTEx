// Backend simulado (sistema de arquivos em memória) para abrir a interface num navegador comum
// durante o desenvolvimento (`npm run dev` fora do Tauri). Não entra no build de produção.

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

type Args = Record<string, unknown>
const ROOT = 'C:\\Users\\voce\\Documents\\NOTEx'
const SEP = '\\'

const files = new Map<string, { text: string; mtime: number }>()
const dirs = new Set<string>()
const state = new Map<string, string>()
const notebooks: { id: string; name: string; path: string }[] = [{ id: 'rapidas', name: 'Rápidas', path: `${ROOT}${SEP}Rápidas` }]
const icons = new Map<string, string>()
let pairedMock = false

const parent = (p: string): string => p.slice(0, p.lastIndexOf(SEP))
const base = (p: string): string => p.slice(p.lastIndexOf(SEP) + 1)
const exists = (p: string): boolean => files.has(p) || dirs.has(p)
const within = (root: string, p: string): boolean => p === root || p.startsWith(root + SEP)

function mkdirp(p: string): void {
  while (p.length > ROOT.length - 1 && !dirs.has(p)) {
    dirs.add(p)
    p = parent(p)
  }
}

function unique(dir: string, stem: string, ext: string): string {
  for (let n = 1; ; n++) {
    const s = n === 1 ? stem : `${stem} (${n})`
    const p = `${dir}${SEP}${ext ? `${s}.${ext}` : s}`
    if (!exists(p)) return p
  }
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 80)
}

function moveAll(from: string, to: string): void {
  for (const [p, f] of [...files]) {
    if (within(from, p)) {
      files.delete(p)
      files.set(to + p.slice(from.length), f)
    }
  }
  for (const d of [...dirs]) {
    if (within(from, d)) {
      dirs.delete(d)
      dirs.add(to + d.slice(from.length))
    }
  }
}

function tree(dir: string): unknown[] {
  const kids = new Set<string>()
  for (const p of [...files.keys(), ...dirs]) if (parent(p) === dir && !base(p).startsWith('.')) kids.add(p)
  return [...kids]
    .map((p) => (dirs.has(p) ? { name: base(p), path: p, isDir: true, children: tree(p), icon: icons.get(p) } : { name: base(p), path: p, isDir: false }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }))
}

function seed(): void {
  const q = notebooks[0]!.path
  mkdirp(q)
  mkdirp(`${q}${SEP}Projetos`)
  const now = Date.now()
  files.set(`${q}${SEP}Boas-vindas.md`, {
    mtime: now,
    text: '# Boas-vindas ao NOTEx\n\nEsta é uma nota **Markdown** com edição *visual*.\n\n- [ ] Criar uma nota rápida com Ctrl+N\n- [x] Abrir o NOTEx\n\n> Arraste abas para as bordas para dividir em colunas e linhas.\n'
  })
  files.set(`${q}${SEP}Lista.txt`, { mtime: now, text: 'Texto puro\nlinha 2\nlinha 3\n' })
  files.set(`${q}${SEP}Projetos${SEP}Ideias.md`, { mtime: now, text: '## Ideias\n\n1. Glossário\n2. Sincronização\n' })
}

function handle(cmd: string, a: Args): unknown {
  const s = (k: string): string => String(a[k] ?? '')
  switch (cmd) {
    case 'get_notebooks':
      return notebooks.map((n) => ({ ...n, icon: icons.get(n.path) }))
    case 'get_root':
    case 'set_root':
      return { root: ROOT, defaultRoot: ROOT }
    case 'set_icon':
      if (a.icon) icons.set(s('path'), s('icon'))
      else icons.delete(s('path'))
      return null
    case 'move_notebook': {
      const nb = notebooks.find((n) => n.id === s('id'))!
      const target = unique(s('destParent'), base(nb.path), '')
      moveAll(nb.path, target)
      nb.path = target
      return nb
    }
    case 'notebooks_root':
      return ROOT
    case 'create_notebook': {
      const path = unique(a.parent ? s('parent') : ROOT, sanitize(s('name')), '')
      mkdirp(path)
      const nb = { id: `nb${Date.now().toString(16)}`, name: s('name'), path }
      notebooks.push(nb)
      return nb
    }
    case 'rename_notebook': {
      const nb = notebooks.find((n) => n.id === s('id'))
      if (nb) nb.name = s('name')
      return null
    }
    case 'remove_notebook':
      notebooks.splice(notebooks.findIndex((n) => n.id === s('id')), 1)
      return null
    case 'list_tree': {
      const nb = notebooks.find((n) => n.id === s('id'))
      return nb ? tree(nb.path) : []
    }
    case 'create_note': {
      const path = unique(s('dir'), sanitize(s('title')) || 'Nota', s('ext') || 'md')
      files.set(path, { text: '', mtime: Date.now() })
      return path
    }
    case 'create_folder': {
      const path = unique(s('parent'), sanitize(s('name')), '')
      mkdirp(path)
      return path
    }
    case 'rename_entry': {
      const path = s('path')
      const isDir = dirs.has(path)
      const m = /\.(md|txt|markdown)$/i.exec(s('name'))
      const oldExt = isDir ? '' : (/\.([^.]+)$/.exec(base(path))?.[1] ?? '')
      const ext = isDir ? '' : (m?.[1]?.toLowerCase() ?? oldExt)
      const stem = sanitize(m ? s('name').slice(0, -m[0].length) : s('name'))
      if (!stem) throw 'Nome inválido.'
      const target = `${parent(path)}${SEP}${ext ? `${stem}.${ext}` : stem}`
      if (target === path) return path
      if (exists(target)) throw 'Já existe um item com esse nome.'
      moveAll(path, target)
      return target
    }
    case 'move_entry':
    case 'trash_entry': {
      const path = s('path')
      const nb = notebooks.find((n) => within(n.path, path))!
      const dest = cmd === 'move_entry' ? s('destDir') : `${nb.path}${SEP}.lixeira`
      if (within(path, dest)) throw 'Não é possível mover uma pasta para dentro dela mesma.'
      mkdirp(dest)
      const m = /^(.*?)(?:\.([^.]+))?$/.exec(base(path))!
      const target = dirs.has(path) ? unique(dest, base(path), '') : unique(dest, m[1]!, m[2] ?? '')
      moveAll(path, target)
      return target
    }
    case 'remove_if_empty': {
      const f = files.get(s('path'))
      if (f && f.text === '') {
        files.delete(s('path'))
        return true
      }
      return false
    }
    case 'read_note': {
      const f = files.get(s('path'))
      if (!f) throw `Não foi possível abrir ${s('path')}`
      return { text: f.text, format: { encoding: 'utf-8', bom: false, eol: 'lf' }, mtime: f.mtime }
    }
    case 'write_note': {
      const mtime = Date.now()
      files.set(s('path'), { text: s('text'), mtime })
      return { format: a.format, mtime }
    }
    case 'note_mtime':
      return files.get(s('path'))?.mtime ?? null
    case 'open_external':
      return null
    case 'load_state':
      return state.get(s('key')) ?? null
    case 'save_state':
      state.set(s('key'), s('json'))
      return null
    case 'plugin:dialog|open':
      return null
    case 'sync_server_status':
      return {
        running: true,
        error: null,
        name: 'PC-DE-TESTE',
        port: 47800,
        ips: ['192.168.0.10'],
        devices: pairedMock ? [{ id: 'c1', name: 'moto g75 5G', lastSeen: Date.now() - 5000 }] : [],
        pairing: false
      }
    case 'sync_pair_start':
      // Simula o celular lendo o código 4 s depois.
      setTimeout(() => (pairedMock = true), 4000)
      return {
        link: 'notex1:exemplo',
        ips: ['192.168.0.10'],
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/><path d="M1 1h7v7H1zM13 1h7v7h-7zM1 13h7v7H1z" fill="#000"/></svg>'
      }
    case 'sync_client_status':
      return { state: 'unpaired', serverName: null, lastSync: null, message: '', conflicts: 0 }
    default:
      // Plugins de janela/eventos/opener: sem efeito no navegador.
      return null
  }
}

export function install(): void {
  seed()
  mockWindows('main')
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Args), { shouldMockEvents: true })
  // Acesso para inspeção nos testes manuais.
  ;(window as unknown as { __notexMock: unknown }).__notexMock = { files, dirs, state }
}
