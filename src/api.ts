// Acesso tipado aos comandos do núcleo Rust (src-tauri/src/lib.rs).

import { invoke } from '@tauri-apps/api/core'

export interface Notebook {
  id: string
  name: string
  path: string
  icon?: string
}

export interface RootSettings {
  root: string
  defaultRoot: string
}

export interface TreeEntry {
  name: string
  path: string
  isDir: boolean
  children?: TreeEntry[]
  icon?: string
}

export interface TextFormat {
  encoding: 'utf-8' | 'windows-1252'
  bom: boolean
  eol: 'lf' | 'crlf'
}

export const DEFAULT_FORMAT: TextFormat = { encoding: 'utf-8', bom: false, eol: 'lf' }

export interface NoteContent {
  text: string
  format: TextFormat
  mtime: number | null
}

export interface WriteResult {
  format: TextFormat
  mtime: number | null
}

export const QUICK_NOTEBOOK_ID = 'rapidas'

export const api = {
  getNotebooks: () => invoke<Notebook[]>('get_notebooks'),
  createNotebook: (name: string, parent: string | null = null) => invoke<Notebook>('create_notebook', { name, parent }),
  moveNotebook: (id: string, destParent: string) => invoke<Notebook>('move_notebook', { id, destParent }),
  getRoot: () => invoke<RootSettings>('get_root'),
  setRoot: (path: string | null) => invoke<RootSettings>('set_root', { path }),
  setIcon: (path: string, icon: string | null) => invoke<void>('set_icon', { path, icon }),
  addNotebook: (path: string) => invoke<Notebook>('add_notebook', { path }),
  renameNotebook: (id: string, name: string) => invoke<void>('rename_notebook', { id, name }),
  removeNotebook: (id: string) => invoke<void>('remove_notebook', { id }),
  listTree: (id: string) => invoke<TreeEntry[]>('list_tree', { id }),
  createNote: (dir: string, title: string, ext: 'md' | 'txt') => invoke<string>('create_note', { dir, title, ext }),
  createFolder: (parent: string, name: string) => invoke<string>('create_folder', { parent, name }),
  renameEntry: (path: string, name: string) => invoke<string>('rename_entry', { path, name }),
  moveEntry: (path: string, destDir: string) => invoke<string>('move_entry', { path, destDir }),
  trashEntry: (path: string) => invoke<string>('trash_entry', { path }),
  removeIfEmpty: (path: string) => invoke<boolean>('remove_if_empty', { path }),
  readNote: (path: string) => invoke<NoteContent>('read_note', { path }),
  /** `expectedMtime`: se o arquivo mudou no disco desde então, falha com CONFLICT. */
  writeNote: (path: string, text: string, format: TextFormat, expectedMtime: number | null = null) =>
    invoke<WriteResult>('write_note', { path, text, format, expectedMtime }),
  noteMtime: (path: string) => invoke<number | null>('note_mtime', { path }),
  openExternal: (path: string) => invoke<void>('open_external', { path }),
  notebooksRoot: () => invoke<string>('notebooks_root'),
  loadState: (key: string) => invoke<string | null>('load_state', { key }),
  saveState: (key: string, json: string) => invoke<void>('save_state', { key, json })
}

/** Erro de writeNote: o arquivo mudou no disco (sincronização ou outro programa). */
export const CONFLICT = 'CONFLITO'

// ---- Sincronização ----

export interface ClientStatus {
  state: 'unpaired' | 'idle' | 'syncing' | 'offline' | 'error'
  serverName: string | null
  lastSync: number | null
  message: string
  conflicts: number
}

export interface ServerStatus {
  running: boolean
  error: string | null
  name: string
  port: number
  ips: string[]
  devices: { id: string; name: string; lastSeen: number | null }[]
  pairing: boolean
}

export interface PairCode {
  link: string
  svg: string
  ips: string[]
}

export interface FilesChanged {
  changed: string[]
  removed: string[]
}

export const EVENT_FILES = 'notex://files-changed'
export const EVENT_SYNC_STATUS = 'notex://sync-status'

export const syncApi = {
  // Celular
  clientStatus: () => invoke<ClientStatus>('sync_client_status'),
  pair: (link: string, deviceName: string) => invoke<string>('sync_pair', { link, deviceName }),
  unpair: () => invoke<void>('sync_unpair'),
  syncNow: () => invoke<void>('sync_now'),
  setActive: (active: boolean) =>
    invoke<void>('sync_set_active', { active, tzOffsetMin: -new Date().getTimezoneOffset() }),
  // PC
  serverStatus: () => invoke<ServerStatus>('sync_server_status'),
  pairStart: () => invoke<PairCode>('sync_pair_start'),
  pairCancel: () => invoke<void>('sync_pair_cancel'),
  removeDevice: (id: string) => invoke<void>('sync_remove_device', { id })
}

/** Mensagem de erro legível (os comandos devolvem strings em português). */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return 'Erro inesperado.'
}
