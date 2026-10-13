// Acesso tipado aos comandos do núcleo Rust (src-tauri/src/lib.rs).

import { invoke } from '@tauri-apps/api/core'

export interface Notebook {
  id: string
  name: string
  path: string
  icon?: string
  /** Caderno privado: o conteúdo das notas fica cifrado. */
  private?: boolean
  /** Privado e ainda trancado neste aparelho. */
  locked?: boolean
}

export interface VaultStatus {
  /** Há senha mestra na sessão (cadernos privados abertos). */
  unlocked: boolean
  /** Este aparelho guarda a senha (só no celular). */
  remembered: boolean
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

/** Trecho encontrado pela busca global. `line` 0 = o nome da nota. */
export interface Hit {
  notebookId: string
  notebookName: string
  path: string
  rel: string
  line: number
  occurrence: number
  before: string
  hit: string
  after: string
}

/** Termo definido numa nota (`**Termo**: definição` ou `Termo:: definição`). */
export interface Term {
  term: string
  definition: string
  notebookId: string
  notebookName: string
  path: string
  line: number
}

export const api = {
  getNotebooks: () => invoke<Notebook[]>('get_notebooks'),
  createNotebook: (name: string, parent: string | null = null) => invoke<Notebook>('create_notebook', { name, parent }),
  moveNotebook: (id: string, destParent: string) => invoke<Notebook>('move_notebook', { id, destParent }),
  getRoot: () => invoke<RootSettings>('get_root'),
  setRoot: (path: string | null) => invoke<RootSettings>('set_root', { path }),
  setIcon: (path: string, icon: string | null) => invoke<void>('set_icon', { path, icon }),
  addNotebook: (path: string) => invoke<Notebook>('add_notebook', { path }),
  renameNotebook: (id: string, name: string) => invoke<Notebook>('rename_notebook', { id, name }),
  removeNotebook: (id: string, deleteFiles = false) => invoke<void>('remove_notebook', { id, deleteFiles }),
  vaultStatus: () => invoke<VaultStatus>('vault_status'),
  vaultUnlock: (password: string, remember = false) => invoke<VaultStatus>('vault_unlock', { password, remember }),
  vaultUnlockRemembered: () => invoke<VaultStatus>('vault_unlock_remembered'),
  vaultLock: () => invoke<VaultStatus>('vault_lock'),
  vaultForget: () => invoke<VaultStatus>('vault_forget'),
  vaultMakePrivate: (id: string, password: string) => invoke<void>('vault_make_private', { id, password }),
  vaultMakePublic: (id: string) => invoke<void>('vault_make_public', { id }),
  searchNotes: (query: string, notebook: string | null = null) => invoke<Hit[]>('search_notes', { query, notebook }),
  listTerms: () => invoke<Term[]>('list_terms'),
  defineTerm: (notebook: string, term: string, definition: string) => invoke<string>('define_term', { notebook, term, definition }),
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
/** Erro de leitura/gravação em caderno privado trancado. */
export const LOCKED = 'BLOQUEADO'

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

export interface DriveStatus {
  configured: boolean
  connected: boolean
  email: string | null
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error'
  lastSync: number | null
  message: string
  conflicts: number
}

export const EVENT_DRIVE_STATUS = 'notex://drive-status'

export const driveApi = {
  status: () => invoke<DriveStatus>('drive_status'),
  /** Abre o navegador para o login no Google (só no PC). Devolve o e-mail. */
  connect: () => invoke<string>('drive_connect'),
  /** Cancela a espera do login (o navegador pode ser fechado). */
  cancelConnect: () => invoke<void>('drive_connect_cancel'),
  disconnect: () => invoke<void>('drive_disconnect'),
  syncNow: () => invoke<void>('drive_sync_now')
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
