// Acesso tipado aos comandos do núcleo Rust (src-tauri/src/lib.rs).

import { invoke } from '@tauri-apps/api/core'

export interface Notebook {
  id: string
  name: string
  path: string
}

export interface TreeEntry {
  name: string
  path: string
  isDir: boolean
  children?: TreeEntry[]
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
  createNotebook: (name: string) => invoke<Notebook>('create_notebook', { name }),
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
  writeNote: (path: string, text: string, format: TextFormat) =>
    invoke<WriteResult>('write_note', { path, text, format }),
  noteMtime: (path: string) => invoke<number | null>('note_mtime', { path }),
  openExternal: (path: string) => invoke<void>('open_external', { path }),
  notebooksRoot: () => invoke<string>('notebooks_root'),
  loadState: (key: string) => invoke<string | null>('load_state', { key }),
  saveState: (key: string, json: string) => invoke<void>('save_state', { key, json })
}

/** Mensagem de erro legível (os comandos devolvem strings em português). */
export function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return 'Erro inesperado.'
}
