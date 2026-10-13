// Operações de arquivo dentro de um caderno, usadas dos dois lados da sincronização.

use super::proto::{Manifest, hash_bytes, is_synced_file, valid_rel_path};
use crate::meta::META_FILE;
use crate::notebooks::TRASH_DIR;
use std::fs;
use std::path::{Path, PathBuf};

/// Caminho absoluto de `rel` dentro de `root` (valida o relativo).
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !valid_rel_path(rel) {
        return Err(format!("Caminho inválido: {rel}"));
    }
    Ok(rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part)))
}

/// Manifesto do caderno: notas e `.notex.json` com seus hashes, e as pastas (sem ocultas/lixeira).
pub fn manifest(root: &Path) -> Manifest {
    let mut m = Manifest::default();
    walk(root, "", &mut m);
    m
}

fn walk(dir: &Path, prefix: &str, m: &mut Manifest) {
    let Ok(items) = fs::read_dir(dir) else { return };
    for item in items.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let Ok(ft) = item.file_type() else { continue };
        if ft.is_dir() {
            if name.starts_with('.') || name == TRASH_DIR {
                continue;
            }
            m.dirs.insert(rel.clone());
            walk(&item.path(), &rel, m);
        } else if ft.is_file() && (rel == META_FILE || rel == crate::vault::HEADER_FILE || (!name.starts_with('.') && is_synced_file(&rel))) {
            if let Ok(data) = fs::read(item.path()) {
                m.files.insert(rel, hash_bytes(&data));
            }
        }
    }
}

pub fn current_hash(root: &Path, rel: &str) -> Result<Option<String>, String> {
    let path = resolve(root, rel)?;
    match fs::read(&path) {
        Ok(data) => Ok(Some(hash_bytes(&data))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Não foi possível ler {rel}: {e}")),
    }
}

pub fn read(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let path = resolve(root, rel)?;
    fs::read(&path).map_err(|e| format!("Não foi possível ler {rel}: {e}"))
}

/// Grava atomicamente, criando as pastas que faltarem. Devolve o caminho absoluto.
pub fn write(root: &Path, rel: &str, data: &[u8]) -> Result<PathBuf, String> {
    let path = resolve(root, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
    }
    crate::textfile::write_atomic(&path, data).map_err(|e| format!("Não foi possível gravar {rel}: {e}"))?;
    Ok(path)
}

/// "Apaga" movendo para a lixeira do caderno. Devolve o caminho absoluto original.
pub fn trash(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = resolve(root, rel)?;
    if path.exists() {
        crate::notebooks::trash_entry(root, &path)?;
    }
    Ok(path)
}

pub fn mkdir(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    fs::create_dir_all(&path).map_err(|e| format!("Não foi possível criar a pasta {rel}: {e}"))
}

/// Remove a pasta só se estiver vazia (arquivos não sincronizados, como imagens, a mantêm).
pub fn rmdir_if_empty(root: &Path, rel: &str) -> Result<bool, String> {
    let path = resolve(root, rel)?;
    let empty = fs::read_dir(&path).is_ok_and(|mut it| it.next().is_none());
    if !empty {
        return Ok(false);
    }
    fs::remove_dir(&path).map(|_| true).map_err(|e| e.to_string())
}
