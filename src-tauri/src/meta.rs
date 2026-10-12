// Metadados de um caderno (ícones de pastas e do próprio caderno), num arquivo oculto
// `.notex.json` na raiz do caderno. Fica junto das notas para acompanhar a sincronização.

use crate::notebooks::is_within;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub const META_FILE: &str = ".notex.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    /// Caminho relativo à raiz (com "/") → ícone. "" é o próprio caderno.
    #[serde(default)]
    pub icons: BTreeMap<String, String>,
}

pub fn load(root: &Path) -> Meta {
    fs::read(root.join(META_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(root: &Path, meta: &Meta) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
    crate::textfile::write_atomic(&root.join(META_FILE), &json).map_err(|e| format!("Não foi possível salvar os ícones: {e}"))
}

/// Chave relativa ("pasta/sub") de `path` dentro de `root`; "" para a raiz.
pub fn rel_key(root: &Path, path: &Path) -> Option<String> {
    if !is_within(root, path) {
        return None;
    }
    let r = root.to_string_lossy().replace('\\', "/");
    let p = path.to_string_lossy().replace('\\', "/");
    Some(p[r.trim_end_matches('/').len()..].trim_start_matches('/').trim_end_matches('/').to_string())
}

/// Ícone válido: 1 a 8 caracteres visíveis (emoji ou símbolo).
pub fn valid_icon(icon: &str) -> bool {
    let n = icon.chars().count();
    (1..=8).contains(&n) && !icon.chars().any(|c| c.is_control() || c.is_whitespace())
}

pub fn set_icon(root: &Path, path: &Path, icon: Option<&str>) -> Result<(), String> {
    let key = rel_key(root, path).ok_or("Caminho fora do caderno.")?;
    let mut meta = load(root);
    match icon {
        Some(i) if valid_icon(i) => {
            meta.icons.insert(key, i.to_string());
        }
        Some(_) => return Err("Ícone inválido.".into()),
        None => {
            meta.icons.remove(&key);
        }
    }
    save(root, &meta)
}

fn under(key: &str, prefix: &str) -> bool {
    key == prefix || key.starts_with(&format!("{prefix}/"))
}

/// Após mover/renomear `from` (em `src_root`) para `to` (em `dst_root`), leva junto os ícones
/// de `from` e de tudo dentro dele. `dst_root` None = item foi para a lixeira (ícones descartados).
pub fn transfer(src_root: &Path, from: &Path, dst_root: Option<&Path>, to: &Path) -> Result<(), String> {
    let Some(from_key) = rel_key(src_root, from) else { return Ok(()) };
    if from_key.is_empty() {
        return Ok(());
    }
    let mut src = load(src_root);
    let moved: Vec<(String, String)> =
        src.icons.iter().filter(|(k, _)| under(k, &from_key)).map(|(k, v)| (k.clone(), v.clone())).collect();
    if moved.is_empty() {
        return Ok(());
    }
    for (k, _) in &moved {
        src.icons.remove(k);
    }
    match dst_root {
        Some(dst_root) => {
            let to_key = rel_key(dst_root, to).ok_or("Destino fora do caderno.")?;
            let rekeyed = moved.into_iter().map(|(k, v)| (format!("{to_key}{}", &k[from_key.len()..]), v));
            if crate::notebooks::same_path(src_root, dst_root) {
                src.icons.extend(rekeyed);
                return save(src_root, &src);
            }
            let mut dst = load(dst_root);
            dst.icons.extend(rekeyed);
            save(src_root, &src)?;
            save(dst_root, &dst)
        }
        None => save(src_root, &src),
    }
}

/// Preenche o ícone das pastas da árvore a partir dos metadados.
pub fn annotate(entries: &mut [crate::notebooks::TreeEntry], root: &Path, meta: &Meta) {
    for e in entries.iter_mut().filter(|e| e.is_dir) {
        e.icon = rel_key(root, &e.path).and_then(|k| meta.icons.get(&k).cloned());
        if let Some(children) = e.children.as_mut() {
            annotate(children, root, meta);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chaves_relativas() {
        let root = Path::new("C:/N/Cad");
        assert_eq!(rel_key(root, Path::new("C:/N/Cad")).as_deref(), Some(""));
        assert_eq!(rel_key(root, Path::new("C:/N/Cad/a/b")).as_deref(), Some("a/b"));
        assert_eq!(rel_key(root, Path::new("C:/N/Outro")), None);
    }

    #[test]
    fn define_remove_e_transfere_icones() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("A");
        let b = d.path().join("B");
        fs::create_dir_all(a.join("proj/sub")).unwrap();
        fs::create_dir_all(&b).unwrap();
        set_icon(&a, &a.join("proj"), Some("📚")).unwrap();
        set_icon(&a, &a.join("proj/sub"), Some("⭐")).unwrap();
        set_icon(&a, &a, Some("🏠")).unwrap();
        assert!(set_icon(&a, &a.join("x"), Some("com espaço")).is_err());

        // renomear dentro do mesmo caderno
        transfer(&a, &a.join("proj"), Some(&a), &a.join("projetos")).unwrap();
        let m = load(&a);
        assert_eq!(m.icons.get("projetos").map(String::as_str), Some("📚"));
        assert_eq!(m.icons.get("projetos/sub").map(String::as_str), Some("⭐"));
        assert!(!m.icons.contains_key("proj"));

        // mover para outro caderno
        transfer(&a, &a.join("projetos"), Some(&b), &b.join("p")).unwrap();
        assert_eq!(load(&b).icons.get("p/sub").map(String::as_str), Some("⭐"));
        assert_eq!(load(&a).icons.len(), 1); // só o do caderno

        set_icon(&a, &a, None).unwrap();
        assert!(load(&a).icons.is_empty());
    }
}
