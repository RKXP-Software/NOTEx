// Cadernos (pastas de notas) e operações de arquivo dentro deles. Sem dependência do Tauri,
// para ser testável com `cargo test`.
//
// Todo caminho vindo da interface é validado: precisa estar dentro de um caderno registrado
// ou ser um arquivo avulso aberto explicitamente pelo usuário (lista `external`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Extensões de nota reconhecidas na árvore e ao abrir.
pub const NOTE_EXTENSIONS: [&str; 3] = ["md", "txt", "markdown"];
/// Pasta (oculta) para onde vão as notas apagadas, dentro de cada caderno.
pub const TRASH_DIR: &str = ".lixeira";
pub const QUICK_NOTEBOOK_ID: &str = "rapidas";
pub const QUICK_NOTEBOOK_NAME: &str = "Rápidas";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub notebooks: Vec<Notebook>,
    /// Arquivos fora dos cadernos abertos pelo usuário (Abrir arquivo...).
    #[serde(default)]
    pub external: Vec<PathBuf>,
}

impl Config {
    /// Garante o caderno "Rápidas" em `root/Rápidas` (criando a pasta) e devolve se mudou algo.
    pub fn ensure_quick(&mut self, root: &Path) -> std::io::Result<bool> {
        if let Some(nb) = self.notebooks.iter().find(|n| n.id == QUICK_NOTEBOOK_ID) {
            fs::create_dir_all(&nb.path)?;
            return Ok(false);
        }
        let path = root.join(QUICK_NOTEBOOK_NAME);
        fs::create_dir_all(&path)?;
        self.notebooks.insert(
            0,
            Notebook { id: QUICK_NOTEBOOK_ID.into(), name: QUICK_NOTEBOOK_NAME.into(), path },
        );
        Ok(true)
    }

    pub fn notebook(&self, id: &str) -> Result<&Notebook, String> {
        self.notebooks.iter().find(|n| n.id == id).ok_or_else(|| "Caderno não encontrado.".to_string())
    }

    /// Caderno que contém o caminho, se houver.
    pub fn notebook_of(&self, path: &Path) -> Option<&Notebook> {
        self.notebooks.iter().find(|n| is_within(&n.path, path))
    }

    /// Valida um caminho vindo da interface: dentro de um caderno ou arquivo avulso autorizado.
    pub fn check_allowed(&self, path: &Path) -> Result<(), String> {
        if !path.is_absolute() || has_parent_refs(path) {
            return Err("Caminho inválido.".into());
        }
        if self.notebook_of(path).is_some() || self.external.iter().any(|e| same_path(e, path)) {
            Ok(())
        } else {
            Err("Caminho fora dos cadernos do NOTEx.".into())
        }
    }

    /// Valida que o caminho está dentro de algum caderno (operações de organização).
    pub fn check_in_notebook(&self, path: &Path) -> Result<&Notebook, String> {
        if !path.is_absolute() || has_parent_refs(path) {
            return Err("Caminho inválido.".into());
        }
        self.notebook_of(path).ok_or_else(|| "Caminho fora dos cadernos do NOTEx.".to_string())
    }

    pub fn add_external(&mut self, path: PathBuf) {
        if self.notebook_of(&path).is_none() && !self.external.iter().any(|e| same_path(e, &path)) {
            self.external.push(path);
        }
    }
}

fn has_parent_refs(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

fn norm(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) { s.to_lowercase() } else { s.to_string() }
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    norm(a) == norm(b)
}

/// true se `path` é `root` ou está dentro dele (comparação textual, sem `..`).
pub fn is_within(root: &Path, path: &Path) -> bool {
    let (r, p) = (norm(root), norm(path));
    p == r || p.starts_with(&format!("{r}/"))
}

pub fn is_note_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| NOTE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
}

// ---- Nomes ----

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
    "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Nome de arquivo/pasta válido no Windows e no Android: remove caracteres proibidos e de
/// controle, espaços/pontos nas pontas e nomes reservados; limita a 80 caracteres.
pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = collapsed.chars().take(80).collect();
    out = out.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if RESERVED.contains(&out.to_lowercase().as_str()) {
        out.push('_');
    }
    out
}

/// Caminho livre em `dir` para `stem.ext`: `stem.ext`, `stem (2).ext`, `stem (3).ext`...
/// `ext` vazio = pasta. `ignore` é um caminho que pode ser "reocupado" (renomear para si mesmo).
pub fn unique_path(dir: &Path, stem: &str, ext: &str, ignore: Option<&Path>) -> PathBuf {
    let make = |n: u32| {
        let s = if n == 1 { stem.to_string() } else { format!("{stem} ({n})") };
        dir.join(if ext.is_empty() { s } else { format!("{s}.{ext}") })
    };
    let mut n = 1;
    loop {
        let candidate = make(n);
        let taken = candidate.exists() && !ignore.is_some_and(|i| same_path(i, &candidate));
        if !taken {
            return candidate;
        }
        n += 1;
    }
}

fn split_name(path: &Path) -> (String, String) {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    (stem, ext)
}

// ---- Árvore ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeEntry>>,
}

/// Árvore de pastas e notas (.md/.txt), sem itens ocultos (iniciados por "."). Pastas primeiro,
/// depois arquivos, em ordem alfabética sem diferenciar maiúsculas.
pub fn list_tree(dir: &Path) -> std::io::Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = item.path();
        let ft = item.file_type()?;
        if ft.is_dir() {
            let children = list_tree(&path).unwrap_or_default();
            entries.push(TreeEntry { name, path, is_dir: true, children: Some(children) });
        } else if ft.is_file() && is_note_file(&path) {
            entries.push(TreeEntry { name, path, is_dir: false, children: None });
        }
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

// ---- Operações ----

/// Cria uma nota vazia em `dir` com nome `title.ext` (único). Devolve o caminho.
pub fn create_note(dir: &Path, title: &str, ext: &str) -> Result<PathBuf, String> {
    let stem = match sanitize_name(title) {
        s if s.is_empty() => "Nota".to_string(),
        s => s,
    };
    let ext = if NOTE_EXTENSIONS.contains(&ext) { ext } else { "md" };
    fs::create_dir_all(dir).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
    let path = unique_path(dir, &stem, ext, None);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Não foi possível criar a nota: {e}"))?;
    Ok(path)
}

pub fn create_folder(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let stem = sanitize_name(name);
    if stem.is_empty() {
        return Err("Nome de pasta inválido.".into());
    }
    let path = unique_path(parent, &stem, "", None);
    fs::create_dir_all(&path).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
    Ok(path)
}

/// Renomeia arquivo ou pasta. Para arquivos, mantém a extensão atual se `new_name` não trouxer
/// uma extensão de nota. Devolve o novo caminho.
pub fn rename_entry(path: &Path, new_name: &str) -> Result<PathBuf, String> {
    let dir = path.parent().ok_or("Caminho inválido.")?;
    let target = if path.is_dir() {
        let stem = sanitize_name(new_name);
        if stem.is_empty() {
            return Err("Nome inválido.".into());
        }
        unique_path(dir, &stem, "", Some(path))
    } else {
        let (_, old_ext) = split_name(path);
        let candidate = Path::new(new_name);
        let (stem, ext) = match candidate.extension().and_then(|e| e.to_str()) {
            Some(e) if NOTE_EXTENSIONS.contains(&e.to_lowercase().as_str()) => {
                (candidate.file_stem().unwrap_or_default().to_string_lossy().into_owned(), e.to_lowercase())
            }
            _ => (new_name.to_string(), old_ext),
        };
        let stem = sanitize_name(&stem);
        if stem.is_empty() {
            return Err("Nome inválido.".into());
        }
        unique_path(dir, &stem, &ext, Some(path))
    };
    if same_path(&target, path) && target.file_name() == path.file_name() {
        return Ok(path.to_path_buf());
    }
    fs::rename(path, &target).map_err(|e| format!("Não foi possível renomear: {e}"))?;
    Ok(target)
}

/// Move arquivo ou pasta para `dest_dir` (nome único lá). Recusa mover uma pasta para dentro dela mesma.
pub fn move_entry(path: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    if is_within(path, dest_dir) {
        return Err("Não é possível mover uma pasta para dentro dela mesma.".into());
    }
    if path.parent().is_some_and(|p| same_path(p, dest_dir)) {
        return Ok(path.to_path_buf());
    }
    let (stem, ext) = if path.is_dir() {
        (path.file_name().unwrap_or_default().to_string_lossy().into_owned(), String::new())
    } else {
        split_name(path)
    };
    let target = unique_path(dest_dir, &stem, &ext, None);
    move_path(path, &target)?;
    Ok(target)
}

/// rename, com cópia+remoção como alternativa entre volumes diferentes.
fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_recursive(from, to).map_err(|e| format!("Não foi possível mover: {e}"))?;
    let removed = if from.is_dir() { fs::remove_dir_all(from) } else { fs::remove_file(from) };
    removed.map_err(|e| format!("Copiado, mas não foi possível remover a origem: {e}"))
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for item in fs::read_dir(from)? {
            let item = item?;
            copy_recursive(&item.path(), &to.join(item.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// "Apaga" movendo para `<caderno>/.lixeira/`. Nada é removido de verdade.
pub fn trash_entry(notebook_root: &Path, path: &Path) -> Result<PathBuf, String> {
    if same_path(notebook_root, path) {
        return Err("Não é possível apagar a pasta raiz do caderno.".into());
    }
    let trash = notebook_root.join(TRASH_DIR);
    fs::create_dir_all(&trash).map_err(|e| format!("Não foi possível criar a lixeira: {e}"))?;
    move_entry(path, &trash)
}

/// Remove uma nota vazia (usado ao fechar uma nota rápida que ficou sem conteúdo).
pub fn remove_if_empty(path: &Path) -> Result<bool, String> {
    match fs::metadata(path) {
        Ok(m) if m.is_file() && m.len() == 0 => {
            fs::remove_file(path).map_err(|e| e.to_string())?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Config, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::default();
        cfg.ensure_quick(dir.path()).unwrap();
        let quick = cfg.notebook(QUICK_NOTEBOOK_ID).unwrap().path.clone();
        (dir, cfg, quick)
    }

    #[test]
    fn cria_caderno_rapidas_uma_vez() {
        let (dir, mut cfg, quick) = setup();
        assert!(quick.is_dir());
        assert!(!cfg.ensure_quick(dir.path()).unwrap());
        assert_eq!(cfg.notebooks.len(), 1);
    }

    #[test]
    fn sanitiza_nomes() {
        assert_eq!(sanitize_name("  a/b:c*d?  "), "a b c d");
        assert_eq!(sanitize_name("nota..."), "nota");
        assert_eq!(sanitize_name("CON"), "CON_");
        assert_eq!(sanitize_name("linha\ncom\tcontrole"), "linha com controle");
        assert_eq!(sanitize_name(&"x".repeat(200)).len(), 80);
    }

    #[test]
    fn cria_notas_com_nomes_unicos() {
        let (_d, _cfg, quick) = setup();
        let a = create_note(&quick, "Ideia", "md").unwrap();
        let b = create_note(&quick, "Ideia", "md").unwrap();
        let c = create_note(&quick, "", "txt").unwrap();
        assert_eq!(a.file_name().unwrap(), "Ideia.md");
        assert_eq!(b.file_name().unwrap(), "Ideia (2).md");
        assert_eq!(c.file_name().unwrap(), "Nota.txt");
    }

    #[test]
    fn renomeia_mantendo_ou_trocando_extensao() {
        let (_d, _cfg, quick) = setup();
        let a = create_note(&quick, "a", "txt").unwrap();
        let b = rename_entry(&a, "Lista de compras").unwrap();
        assert_eq!(b.file_name().unwrap(), "Lista de compras.txt");
        let c = rename_entry(&b, "Lista.md").unwrap();
        assert_eq!(c.file_name().unwrap(), "Lista.md");
        assert_eq!(rename_entry(&c, "Lista").unwrap(), c);
    }

    #[test]
    fn move_e_lixeira() {
        let (_d, cfg, quick) = setup();
        let folder = create_folder(&quick, "Projetos").unwrap();
        let note = create_note(&quick, "n", "md").unwrap();
        let moved = move_entry(&note, &folder).unwrap();
        assert_eq!(moved, folder.join("n.md"));
        assert!(move_entry(&folder, &folder.join("sub")).is_err());
        let trashed = trash_entry(&quick, &moved).unwrap();
        assert_eq!(trashed, quick.join(TRASH_DIR).join("n.md"));
        assert!(trash_entry(&quick, &quick).is_err());
        // a lixeira (oculta) não aparece na árvore
        let tree = list_tree(&quick).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "Projetos");
        assert!(cfg.check_in_notebook(&trashed).is_ok());
    }

    #[test]
    fn arvore_ordena_pastas_primeiro_e_ignora_outros_arquivos() {
        let (_d, _cfg, quick) = setup();
        create_note(&quick, "b", "md").unwrap();
        create_note(&quick, "A", "txt").unwrap();
        create_folder(&quick, "z").unwrap();
        fs::write(quick.join("foto.png"), b"x").unwrap();
        let names: Vec<_> = list_tree(&quick).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["z", "A.txt", "b.md"]);
    }

    #[test]
    fn valida_caminhos() {
        let (d, mut cfg, quick) = setup();
        assert!(cfg.check_allowed(&quick.join("x.md")).is_ok());
        assert!(cfg.check_allowed(&quick.join("..").join("fora.md")).is_err());
        let fora = d.path().join("fora.txt");
        assert!(cfg.check_allowed(&fora).is_err());
        cfg.add_external(fora.clone());
        assert!(cfg.check_allowed(&fora).is_ok());
        assert!(cfg.check_in_notebook(&fora).is_err());
        assert!(cfg.check_allowed(Path::new("relativo.md")).is_err());
        // prefixo de nome não conta como "dentro"
        let vizinho = PathBuf::from(format!("{}-outro", quick.display())).join("x.md");
        assert!(cfg.check_allowed(&vizinho).is_err());
    }

    #[test]
    fn remove_apenas_nota_vazia() {
        let (_d, _cfg, quick) = setup();
        let a = create_note(&quick, "a", "md").unwrap();
        let b = create_note(&quick, "b", "md").unwrap();
        fs::write(&b, "texto").unwrap();
        assert!(remove_if_empty(&a).unwrap());
        assert!(!remove_if_empty(&b).unwrap());
        assert!(!a.exists() && b.exists());
    }
}
