// Núcleo do NOTEx: comandos chamados pela interface (invoke). Os erros voltam como mensagens
// em português, prontas para exibir.

mod index;
mod meta;
mod notebooks;
mod sync;
mod sync_app;
mod textfile;
mod vault;

use notebooks::{Config, Notebook, TreeEntry};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State};
use textfile::{Encoding, TextFormat};

struct AppState {
    /// Senha mestra e chaves dos cadernos privados (só na memória).
    vault: Mutex<vault::Vault>,
    /// Texto das notas em memória, para a busca global e o glossário.
    index: Mutex<index::Index>,
    config: Mutex<Config>,
    config_file: PathBuf,
    state_dir: PathBuf,
    /// Pasta padrão de fábrica para novos cadernos (Documentos\NOTEx no desktop).
    default_root: PathBuf,
    /// Sincronização: lado celular (cliente da conexão direta).
    client: sync_app::ClientRuntime,
    /// Sincronização pelo Google Drive (PC e celular).
    drive: sync_app::DriveRuntime,
    /// Sincronização: lado PC (servidor) e contador de mudanças que os celulares escutam.
    #[cfg(desktop)]
    server: sync_app::ServerState,
    #[cfg(desktop)]
    changes: std::sync::Arc<sync::http::Changes>,
}

/// Arquivos mudaram por ação do usuário: no PC acorda os celulares; no celular agenda a sincronização.
fn touched(app: &AppHandle) {
    if let Ok(mut idx) = app.state::<AppState>().index.lock() {
        idx.invalidate();
    }
    #[cfg(desktop)]
    {
        app.state::<AppState>().changes.bump();
        sync_app::request_drive_sync(app, std::time::Duration::from_secs(2));
    }
    #[cfg(mobile)]
    sync_app::request_sync(app, std::time::Duration::from_millis(1500));
}

type CmdResult<T> = Result<T, String>;

impl AppState {
    fn save(&self, cfg: &Config) -> CmdResult<()> {
        let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
        textfile::write_atomic(&self.config_file, &json).map_err(|e| format!("Não foi possível salvar a configuração: {e}"))
    }

    fn with_config<T>(&self, f: impl FnOnce(&mut Config) -> CmdResult<T>, persist: bool) -> CmdResult<T> {
        let mut cfg = self.config.lock().map_err(|_| "Estado interno inválido.".to_string())?;
        let out = f(&mut cfg)?;
        if persist {
            self.save(&cfg)?;
        }
        Ok(out)
    }

    /// Pasta onde novos cadernos são criados: a escolhida pelo usuário ou a de fábrica.
    fn root(&self, cfg: &Config) -> PathBuf {
        cfg.root.clone().unwrap_or_else(|| self.default_root.clone())
    }
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

// ---- Cadernos ----

/// Caderno como a interface o vê: configuração + ícone (dos metadados do caderno).
#[derive(Serialize)]
struct NotebookInfo {
    id: String,
    name: String,
    path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    /// Caderno privado (conteúdo cifrado).
    private: bool,
    /// Privado e ainda trancado neste aparelho.
    locked: bool,
}

fn info(nb: &Notebook) -> NotebookInfo {
    let private = vault::is_private(&nb.path);
    NotebookInfo {
        id: nb.id.clone(),
        name: nb.name.clone(),
        path: nb.path.clone(),
        icon: meta::load(&nb.path).icons.get("").cloned(),
        private,
        locked: private,
    }
}

#[tauri::command]
fn get_notebooks(state: State<AppState>) -> CmdResult<Vec<NotebookInfo>> {
    let mut list: Vec<NotebookInfo> = state.with_config(|c| Ok(c.notebooks.iter().map(info).collect()), false)?;
    let mut v = state.vault.lock().map_err(|_| "Estado interno inválido.".to_string())?;
    for n in list.iter_mut().filter(|n| n.private) {
        n.locked = v.key_for(&n.id, &n.path).is_none();
    }
    Ok(list)
}

fn new_notebook_id() -> String {
    let ms = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("nb{ms:x}")
}

/// Recusa cadernos aninhados (um dentro do outro), que confundiriam a validação e a sincronização.
/// `except` ignora um caderno (ao mover ele mesmo).
fn check_not_nested(cfg: &Config, path: &Path, except: Option<&str>) -> CmdResult<()> {
    let clash = cfg.notebooks.iter().filter(|n| Some(n.id.as_str()) != except).any(|n| {
        notebooks::is_within(&n.path, path) || notebooks::is_within(path, &n.path)
    });
    if clash {
        return Err("Essa pasta já faz parte de um caderno (ou contém um).".into());
    }
    Ok(())
}

/// Cria um caderno novo numa subpasta `name` de `parent` (ou da pasta padrão).
#[tauri::command]
fn create_notebook(app: AppHandle, state: State<AppState>, name: String, parent: Option<PathBuf>) -> CmdResult<NotebookInfo> {
    let stem = notebooks::sanitize_name(&name);
    if stem.is_empty() {
        return Err("Nome de caderno inválido.".into());
    }
    if let Some(p) = &parent {
        if !p.is_absolute() || !p.is_dir() {
            return Err("Pasta de destino inválida.".into());
        }
    }
    state.with_config(
        |cfg| {
            let base = parent.clone().unwrap_or_else(|| state.root(cfg));
            fs::create_dir_all(&base).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
            let path = notebooks::unique_path(&base, &stem, "", None);
            check_not_nested(cfg, &path, None)?;
            fs::create_dir_all(&path).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
            let nb = Notebook { id: new_notebook_id(), name: name.trim().to_string(), path };
            cfg.notebooks.push(nb.clone());
            Ok(info(&nb))
        },
        true,
    )
    .inspect(|_| touched(&app))
}

/// Registra uma pasta existente (escolhida pelo usuário) como caderno.
#[tauri::command]
fn add_notebook(state: State<AppState>, path: PathBuf) -> CmdResult<NotebookInfo> {
    if !path.is_absolute() || !path.is_dir() {
        return Err("Pasta inválida.".into());
    }
    state.with_config(
        |cfg| {
            check_not_nested(cfg, &path, None)?;
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Caderno".into());
            let nb = Notebook { id: new_notebook_id(), name, path };
            cfg.notebooks.push(nb.clone());
            Ok(info(&nb))
        },
        true,
    )
}

/// Move a pasta inteira do caderno para dentro de `dest_parent` (pode ser outro disco).
#[tauri::command]
fn move_notebook(state: State<AppState>, id: String, dest_parent: PathBuf) -> CmdResult<NotebookInfo> {
    if !dest_parent.is_absolute() || !dest_parent.is_dir() {
        return Err("Pasta de destino inválida.".into());
    }
    state.with_config(
        |cfg| {
            let old = cfg.notebook(&id)?.path.clone();
            if notebooks::is_within(&old, &dest_parent) {
                return Err("Não é possível mover o caderno para dentro dele mesmo.".into());
            }
            if old.parent().is_some_and(|p| notebooks::same_path(p, &dest_parent)) {
                return Ok(info(cfg.notebook(&id)?));
            }
            let name = old.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Caderno".into());
            let target = notebooks::unique_path(&dest_parent, &name, "", None);
            check_not_nested(cfg, &target, Some(&id))?;
            notebooks::move_path(&old, &target)?;
            let nb = cfg.notebooks.iter_mut().find(|n| n.id == id).ok_or("Caderno não encontrado.")?;
            nb.path = target;
            Ok(info(nb))
        },
        true,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootSettings {
    root: PathBuf,
    default_root: PathBuf,
}

#[tauri::command]
fn get_root(state: State<AppState>) -> CmdResult<RootSettings> {
    state.with_config(|c| Ok(RootSettings { root: state.root(c), default_root: state.default_root.clone() }), false)
}

/// Define a pasta padrão para novos cadernos (None volta para a de fábrica).
#[tauri::command]
fn set_root(state: State<AppState>, path: Option<PathBuf>) -> CmdResult<RootSettings> {
    if let Some(p) = &path {
        if !p.is_absolute() || !p.is_dir() {
            return Err("Pasta inválida.".into());
        }
    }
    state.with_config(
        |c| {
            c.root = path.filter(|p| !notebooks::same_path(p, &state.default_root));
            Ok(RootSettings { root: state.root(c), default_root: state.default_root.clone() })
        },
        true,
    )
}

/// Define (ou remove, com None) o ícone de uma pasta ou do próprio caderno.
#[tauri::command]
fn set_icon(app: AppHandle, state: State<AppState>, path: PathBuf, icon: Option<String>) -> CmdResult<()> {
    let root = state.with_config(|c| Ok(c.check_in_notebook(&path)?.path.clone()), false)?;
    if !path.is_dir() {
        return Err("Só pastas e cadernos têm ícone.".into());
    }
    meta::set_icon(&root, &path, icon.as_deref())?;
    touched(&app);
    Ok(())
}

/// Renomeia o caderno e a pasta dele no disco (nome único na mesma pasta-mãe).
fn rename_notebook_inner(state: &AppState, id: &str, name: &str) -> CmdResult<NotebookInfo> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Nome inválido.".into());
    }
    state.with_config(
        |cfg| {
            let old = cfg.notebook(id)?.path.clone();
            let mut target = old.clone();
            let stem = notebooks::sanitize_name(&name);
            // Rápidas mantém o nome da pasta; os demais seguem o nome do caderno.
            if id != notebooks::QUICK_NOTEBOOK_ID && !stem.is_empty() {
                let current = old.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if current != stem {
                    if let Some(parent) = old.parent() {
                        target = notebooks::unique_path(parent, &stem, "", Some(&old));
                    }
                }
            }
            if !notebooks::same_path(&old, &target) {
                check_not_nested(cfg, &target, Some(id))?;
                notebooks::move_path(&old, &target)?;
            }
            let nb = cfg.notebooks.iter_mut().find(|n| n.id == id).ok_or("Caderno não encontrado.")?;
            nb.name = name;
            nb.path = target;
            Ok(info(nb))
        },
        true,
    )
}

#[tauri::command]
fn rename_notebook(app: AppHandle, state: State<AppState>, id: String, name: String) -> CmdResult<NotebookInfo> {
    let out = rename_notebook_inner(&state, &id, &name)?;
    touched(&app);
    Ok(out)
}

/// Descarta uma pasta de caderno sem apagar de vez: Lixeira do Windows no PC; no celular (e se a
/// Lixeira falhar) vai para `Lixeira` na pasta de dados do app.
fn discard_dir(state_dir: &Path, path: &Path) {
    if !path.is_dir() {
        return;
    }
    #[cfg(desktop)]
    if trash::delete(path).is_ok() {
        return;
    }
    let bin = state_dir.join("Lixeira");
    if fs::create_dir_all(&bin).is_ok() {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Caderno".into());
        let _ = notebooks::move_path(path, &notebooks::unique_path(&bin, &name, "", None));
    }
}

/// Tira o caderno da lista; com `delete_files`, a pasta também sai do disco (para a Lixeira).
#[tauri::command]
fn remove_notebook(app: AppHandle, state: State<AppState>, id: String, delete_files: Option<bool>) -> CmdResult<()> {
    if id == notebooks::QUICK_NOTEBOOK_ID {
        return Err("O caderno Rápidas não pode ser removido.".into());
    }
    let path = state.with_config(
        |cfg| {
            let path = cfg.notebook(&id)?.path.clone();
            cfg.notebooks.retain(|n| n.id != id);
            Ok(path)
        },
        true,
    )?;
    if delete_files.unwrap_or(false) {
        discard_dir(&state.state_dir, &path);
    }
    touched(&app);
    Ok(())
}
#[tauri::command]
fn list_tree(state: State<AppState>, id: String) -> CmdResult<Vec<TreeEntry>> {
    let root = state.with_config(|c| Ok(c.notebook(&id)?.path.clone()), false)?;
    fs::create_dir_all(&root).map_err(|e| format!("Pasta do caderno inacessível: {e}"))?;
    let mut tree = notebooks::list_tree(&root).map_err(|e| format!("Não foi possível listar o caderno: {e}"))?;
    meta::annotate(&mut tree, &root, &meta::load(&root));
    Ok(tree)
}

// ---- Cadernos privados ----

/// Erro de leitura/gravação em caderno privado trancado (a interface pede a senha).
const LOCKED: &str = "BLOQUEADO";

fn vault_guard(state: &AppState) -> CmdResult<std::sync::MutexGuard<'_, vault::Vault>> {
    state.vault.lock().map_err(|_| "Estado interno inválido.".to_string())
}

/// (id, raiz) do caderno privado que contém `path`, se houver.
fn private_notebook(state: &AppState, path: &Path) -> Option<(String, PathBuf)> {
    state
        .with_config(|c| Ok(c.notebook_of(path).map(|n| (n.id.clone(), n.path.clone()))), false)
        .ok()
        .flatten()
        .filter(|(_, root)| vault::is_private(root))
}

/// Chave da nota: Ok(None) = caderno comum; Err(LOCKED) = privado e trancado.
fn note_key(state: &AppState, path: &Path) -> CmdResult<Option<vault::Key>> {
    let Some((id, root)) = private_notebook(state, path) else { return Ok(None) };
    vault_guard(state)?.key_for(&id, &root).map(Some).ok_or_else(|| LOCKED.to_string())
}

fn read_decoded(state: &AppState, path: &Path) -> CmdResult<textfile::Decoded> {
    let bytes = fs::read(path).map_err(|e| format!("Não foi possível abrir {}: {e}", path.display()))?;
    match (note_key(state, path)?, vault::is_encrypted(&bytes)) {
        (Some(key), true) => Ok(textfile::decode(&vault::decrypt(&key, &bytes)?)),
        (None, true) => Err("Esta nota é de um caderno privado e não pode ser aberta aqui.".into()),
        _ => Ok(textfile::decode(&bytes)),
    }
}

fn write_text(state: &AppState, path: &Path, text: &str, format: &TextFormat) -> CmdResult<()> {
    let Some(key) = note_key(state, path)? else {
        return textfile::write_file(path, text, format);
    };
    let data = vault::encrypt(&key, &textfile::encode(text, format)?);
    textfile::write_atomic(path, &data).map_err(|e| format!("Não foi possível salvar {}: {e}", path.display()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    /// Há senha mestra na sessão (cadernos privados abertos).
    unlocked: bool,
    /// Este aparelho guarda a senha (só no celular, atrás da autenticação do aparelho).
    remembered: bool,
}

fn remembered_file(state: &AppState) -> PathBuf {
    state.state_dir.join("vault.pw")
}

fn vault_status_of(state: &AppState) -> CmdResult<VaultStatus> {
    Ok(VaultStatus { unlocked: vault_guard(state)?.is_unlocked(), remembered: remembered_file(state).is_file() })
}

fn private_roots(state: &AppState) -> CmdResult<Vec<(String, PathBuf)>> {
    state.with_config(
        |c| Ok(c.notebooks.iter().filter(|n| vault::is_private(&n.path)).map(|n| (n.id.clone(), n.path.clone())).collect()),
        false,
    )
}

fn clear_index(state: &AppState) {
    if let Ok(mut idx) = state.index.lock() {
        idx.clear();
    }
}

#[tauri::command]
fn vault_status(state: State<AppState>) -> CmdResult<VaultStatus> {
    vault_status_of(&state)
}

/// Abre os cadernos privados com a senha mestra. Erro se nenhum caderno privado aceitar a senha.
#[tauri::command]
fn vault_unlock(state: State<AppState>, password: String, remember: Option<bool>) -> CmdResult<VaultStatus> {
    let roots = private_roots(&state)?;
    if roots.is_empty() {
        return Err("Não há cadernos privados neste aparelho.".into());
    }
    let mut opened = 0;
    {
        let mut v = vault_guard(&state)?;
        for (id, root) in &roots {
            if let Some(key) = vault::open(root, &password) {
                v.remember_key(id, key);
                opened += 1;
            }
        }
        if opened == 0 {
            return Err("Senha incorreta.".into());
        }
        v.set_password(password.clone());
    }
    if remember == Some(true) {
        textfile::write_atomic(&remembered_file(&state), password.as_bytes())
            .map_err(|e| format!("Não foi possível guardar a senha: {e}"))?;
    }
    vault_status_of(&state)
}

/// Abre com a senha guardada neste aparelho (a interface exige antes a autenticação do aparelho).
#[tauri::command]
fn vault_unlock_remembered(state: State<AppState>) -> CmdResult<VaultStatus> {
    let password = fs::read_to_string(remembered_file(&state)).map_err(|_| "Nenhuma senha guardada neste aparelho.".to_string())?;
    vault_unlock(state, password, Some(false))
}

#[tauri::command]
fn vault_lock(state: State<AppState>) -> CmdResult<VaultStatus> {
    vault_guard(&state)?.lock();
    clear_index(&state);
    vault_status_of(&state)
}

/// Esquece a senha guardada neste aparelho.
#[tauri::command]
fn vault_forget(state: State<AppState>) -> CmdResult<VaultStatus> {
    let _ = fs::remove_file(remembered_file(&state));
    vault_status_of(&state)
}

/// Torna o caderno privado: cifra as notas. Com outros cadernos privados, a senha tem de ser a mesma.
#[tauri::command]
fn vault_make_private(app: AppHandle, state: State<AppState>, id: String, password: String) -> CmdResult<()> {
    if password.chars().count() < 6 {
        return Err("Use uma senha com pelo menos 6 caracteres.".into());
    }
    let root = state.with_config(|c| Ok(c.notebook(&id)?.path.clone()), false)?;
    if vault::is_private(&root) {
        return Err("O caderno já é privado.".into());
    }
    let others: Vec<_> = private_roots(&state)?.into_iter().filter(|(i, _)| *i != id).collect();
    if let Some((_, other)) = others.first() {
        if vault::open(other, &password).is_none() {
            return Err("Use a mesma senha mestra dos outros cadernos privados.".into());
        }
    }
    let key = vault::create(&root, &password)?;
    if let Err(e) = vault::encrypt_all(&root, &key) {
        // Desfaz: decifra de volta o que já foi cifrado e remove o cabeçalho.
        let _ = vault::decrypt_all(&root, &key);
        return Err(e);
    }
    {
        let mut v = vault_guard(&state)?;
        v.remember_key(&id, key);
        if !v.is_unlocked() {
            v.set_password(password);
        }
    }
    clear_index(&state);
    touched(&app);
    Ok(())
}

/// Volta o caderno a ser comum (decifra as notas). Exige o caderno aberto.
#[tauri::command]
fn vault_make_public(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<()> {
    let root = state.with_config(|c| Ok(c.notebook(&id)?.path.clone()), false)?;
    if !vault::is_private(&root) {
        return Ok(());
    }
    let key = vault_guard(&state)?.key_for(&id, &root).ok_or_else(|| LOCKED.to_string())?;
    vault::decrypt_all(&root, &key)?;
    vault_guard(&state)?.forget_key(&id);
    clear_index(&state);
    touched(&app);
    Ok(())
}

// ---- Busca e glossário ----

fn notebook_refs(state: &AppState, only: Option<&str>) -> CmdResult<Vec<index::NotebookRef>> {
    let list: Vec<(String, String, PathBuf)> = state.with_config(
        |cfg| {
            Ok(cfg
                .notebooks
                .iter()
                .filter(|n| only.is_none_or(|id| id == n.id))
                .map(|n| (n.id.clone(), n.name.clone(), n.path.clone()))
                .collect())
        },
        false,
    )?;
    let mut v = vault_guard(state)?;
    Ok(list
        .into_iter()
        .map(|(id, name, path)| {
            let private = vault::is_private(&path);
            let key = if private { v.key_for(&id, &path) } else { None };
            index::NotebookRef { id, name, path, private, key }
        })
        .collect())
}

/// Busca o texto (sem acento nem maiúsculas) nas notas de todos os cadernos, ou só de um.
#[tauri::command]
fn search_notes(state: State<AppState>, query: String, notebook: Option<String>) -> CmdResult<Vec<index::Hit>> {
    let refs = notebook_refs(&state, notebook.as_deref())?;
    let mut idx = state.index.lock().map_err(|_| "Estado interno inválido.".to_string())?;
    Ok(idx.search(&refs, &query, None))
}

/// Termos definidos nas notas (`**Termo**: definição` ou `Termo:: definição`), em ordem alfabética.
#[tauri::command]
fn list_terms(state: State<AppState>) -> CmdResult<Vec<index::Term>> {
    let refs = notebook_refs(&state, None)?;
    let mut idx = state.index.lock().map_err(|_| "Estado interno inválido.".to_string())?;
    Ok(idx.terms(&refs))
}

const GLOSSARY_FILE: &str = "Glossário.md";

/// Acrescenta `**termo**: definição` ao `Glossário.md` do caderno (criado se não existir).
#[tauri::command]
fn define_term(app: AppHandle, state: State<AppState>, notebook: String, term: String, definition: String) -> CmdResult<PathBuf> {
    let term = term.split_whitespace().collect::<Vec<_>>().join(" ");
    let definition = definition.trim().to_string();
    if term.is_empty() || definition.is_empty() {
        return Err("Informe o termo e a definição.".into());
    }
    if term.contains("**") || term.chars().count() > 80 {
        return Err("Termo inválido (até 80 caracteres, sem **).".into());
    }
    let root = state.with_config(|c| Ok(c.notebook(&notebook)?.path.clone()), false)?;
    fs::create_dir_all(&root).map_err(|e| format!("Pasta do caderno inacessível: {e}"))?;
    let path = root.join(GLOSSARY_FILE);
    let line = index::term_entry(&term, &definition);
    let (text, format) = match read_decoded(&state, &path) {
        Ok(d) => {
            let mut t = d.text;
            if !t.is_empty() && !t.ends_with('\n') {
                t.push('\n');
            }
            t.push_str(&line);
            t.push('\n');
            (t, d.format)
        }
        Err(_) => (
            format!("# Glossário\n\n{line}\n"),
            TextFormat { encoding: Encoding::Utf8, bom: false, eol: textfile::Eol::Lf },
        ),
    };
    write_text(&state, &path, &text, &format)?;
    touched(&app);
    Ok(path)
}

// ---- Notas e pastas ----

#[tauri::command]
fn create_note(app: AppHandle, state: State<AppState>, dir: PathBuf, title: String, ext: String) -> CmdResult<PathBuf> {
    state.with_config(|c| c.check_in_notebook(&dir).map(|_| ()), false)?;
    note_key(&state, &dir)?;
    let path = notebooks::create_note(&dir, &title, &ext)?;
    touched(&app);
    Ok(path)
}

#[tauri::command]
fn create_folder(app: AppHandle, state: State<AppState>, parent: PathBuf, name: String) -> CmdResult<PathBuf> {
    state.with_config(|c| c.check_in_notebook(&parent).map(|_| ()), false)?;
    let path = notebooks::create_folder(&parent, &name)?;
    touched(&app);
    Ok(path)
}

#[tauri::command]
fn rename_entry(app: AppHandle, state: State<AppState>, path: PathBuf, name: String) -> CmdResult<PathBuf> {
    let root = state.with_config(
        |c| {
            let nb = c.check_in_notebook(&path)?;
            if notebooks::same_path(&nb.path, &path) {
                return Err("Use \"Renomear caderno\" para a pasta raiz.".into());
            }
            Ok(nb.path.clone())
        },
        false,
    )?;
    let target = notebooks::rename_entry(&path, &name)?;
    // Ícones não são essenciais: falha ao atualizá-los não desfaz a renomeação.
    let _ = meta::transfer(&root, &path, Some(&root), &target);
    touched(&app);
    Ok(target)
}

#[tauri::command]
fn move_entry(app: AppHandle, state: State<AppState>, path: PathBuf, dest_dir: PathBuf) -> CmdResult<PathBuf> {
    let (src_root, dst_root) = state.with_config(
        |c| {
            let nb = c.check_in_notebook(&path)?;
            if notebooks::same_path(&nb.path, &path) {
                return Err("Não é possível mover a pasta raiz do caderno.".into());
            }
            Ok((nb.path.clone(), c.check_in_notebook(&dest_dir)?.path.clone()))
        },
        false,
    )?;
    if !dest_dir.is_dir() {
        return Err("Destino inválido.".into());
    }
    if vault::is_private(&src_root) != vault::is_private(&dst_root) {
        return Err("Não é possível mover notas entre um caderno privado e um comum.".into());
    }
    note_key(&state, &path)?;
    let target = notebooks::move_entry(&path, &dest_dir)?;
    let _ = meta::transfer(&src_root, &path, Some(&dst_root), &target);
    touched(&app);
    Ok(target)
}

#[tauri::command]
fn trash_entry(app: AppHandle, state: State<AppState>, path: PathBuf) -> CmdResult<PathBuf> {
    let root = state.with_config(|c| Ok(c.check_in_notebook(&path)?.path.clone()), false)?;
    let target = notebooks::trash_entry(&root, &path)?;
    let _ = meta::transfer(&root, &path, None, &target);
    touched(&app);
    Ok(target)
}

#[tauri::command]
fn remove_if_empty(app: AppHandle, state: State<AppState>, path: PathBuf) -> CmdResult<bool> {
    state.with_config(|c| c.check_in_notebook(&path).map(|_| ()), false)?;
    let removed = notebooks::remove_if_empty(&path)?;
    touched(&app);
    Ok(removed)
}

#[derive(Serialize)]
struct NoteContent {
    text: String,
    format: TextFormat,
    mtime: Option<u64>,
}

#[tauri::command]
fn read_note(state: State<AppState>, path: PathBuf) -> CmdResult<NoteContent> {
    state.with_config(|c| c.check_allowed(&path), false)?;
    let d = read_decoded(&state, &path)?;
    Ok(NoteContent { text: d.text, format: d.format, mtime: mtime_ms(&path) })
}

#[derive(Serialize)]
struct WriteResult {
    format: TextFormat,
    mtime: Option<u64>,
}

/// Erro de `write_note` quando o arquivo mudou no disco desde a última leitura (sincronização ou
/// outro programa). A interface guarda o texto local numa cópia de conflito.
const CONFLICT: &str = "CONFLITO";

/// Grava a nota no formato dado. Se o texto tiver caracteres que a Windows-1252 não representa,
/// grava em UTF-8 (o salvamento é automático, não dá para perguntar) e devolve o novo formato.
/// `expected_mtime`: data de modificação que a interface conhece; se o arquivo mudou, recusa.
#[tauri::command]
fn write_note(
    app: AppHandle,
    state: State<AppState>,
    path: PathBuf,
    text: String,
    format: TextFormat,
    expected_mtime: Option<u64>,
) -> CmdResult<WriteResult> {
    state.with_config(|c| c.check_allowed(&path), false)?;
    if let (Some(expected), Some(current)) = (expected_mtime, mtime_ms(&path)) {
        if expected != current {
            return Err(CONFLICT.into());
        }
    }
    let mut format = format;
    if textfile::find_unencodable(&text, format.encoding).is_some() {
        format = TextFormat { encoding: Encoding::Utf8, bom: false, ..format };
    }
    write_text(&state, &path, &text, &format)?;
    touched(&app);
    Ok(WriteResult { format, mtime: mtime_ms(&path) })
}

#[tauri::command]
fn note_mtime(state: State<AppState>, path: PathBuf) -> CmdResult<Option<u64>> {
    state.with_config(|c| c.check_allowed(&path), false)?;
    Ok(mtime_ms(&path))
}

/// Autoriza um arquivo avulso escolhido pelo usuário (Abrir arquivo...).
#[tauri::command]
fn open_external(state: State<AppState>, path: PathBuf) -> CmdResult<()> {
    if !path.is_absolute() || !path.is_file() || !notebooks::is_note_file(&path) {
        return Err("Só é possível abrir arquivos .md e .txt.".into());
    }
    state.with_config(
        |c| {
            c.add_external(path);
            Ok(())
        },
        true,
    )
}

#[tauri::command]
fn notebooks_root(state: State<AppState>) -> CmdResult<PathBuf> {
    state.with_config(|c| Ok(state.root(c)), false)
}

// ---- Estado da interface (sessão, preferências) ----

fn state_file(state: &AppState, key: &str) -> CmdResult<PathBuf> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        return Err("Chave inválida.".into());
    }
    Ok(state.state_dir.join(format!("{key}.json")))
}

#[tauri::command]
fn load_state(state: State<AppState>, key: String) -> CmdResult<Option<String>> {
    let path = state_file(&state, &key)?;
    Ok(fs::read_to_string(path).ok())
}

#[tauri::command]
fn save_state(state: State<AppState>, key: String, json: String) -> CmdResult<()> {
    let path = state_file(&state, &key)?;
    textfile::write_atomic(&path, json.as_bytes()).map_err(|e| format!("Não foi possível salvar o estado: {e}"))
}

// ---- Inicialização ----

/// Instalado "para todos os usuários" (em Arquivos de Programas): configuração e cadernos
/// padrão compartilhados entre os usuários do PC. Devolve (pasta de configuração, cadernos).
#[cfg(windows)]
fn shared_install_dirs() -> Option<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let in_program_files = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var_os(v))
        .any(|pf| notebooks::is_within(Path::new(&pf), &exe));
    if !in_program_files {
        return None;
    }
    let program_data = PathBuf::from(std::env::var_os("ProgramData")?);
    let public = PathBuf::from(std::env::var_os("PUBLIC")?);
    Some((program_data.join("NOTEx"), public.join("Documents").join("NOTEx")))
}

/// Versão portátil: um arquivo `portable` ao lado do .exe faz o NOTEx guardar tudo na pasta
/// `Dados` (configuração e cadernos), sem tocar no perfil do usuário. Devolve a pasta `Dados`.
#[cfg(desktop)]
fn portable_dir() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    exe_dir.join("portable").exists().then(|| exe_dir.join("Dados"))
}

/// Pasta movida (pendrive em outra letra, outro PC): cadernos dentro de `Dados\Cadernos` são
/// religados à pasta atual.
#[cfg(desktop)]
fn rebase_portable(cfg: &mut Config, root: &Path) {
    for nb in &mut cfg.notebooks {
        if nb.path.exists() {
            continue;
        }
        let parts: Vec<_> = nb.path.components().collect();
        if let Some(i) = parts.iter().rposition(|c| c.as_os_str() == "Cadernos") {
            let rest: PathBuf = parts[i + 1..].iter().collect();
            if !rest.as_os_str().is_empty() {
                nb.path = root.join(rest);
            }
        }
    }
    if let Some(r) = &cfg.root {
        if !r.exists() && r.components().any(|c| c.as_os_str() == "Cadernos") {
            cfg.root = None;
        }
    }
}

fn init_state(app: &AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    #[cfg(windows)]
    let shared = shared_install_dirs();
    #[cfg(not(windows))]
    let shared: Option<(PathBuf, PathBuf)> = None;
    #[cfg(desktop)]
    let portable = portable_dir();
    #[cfg(not(desktop))]
    let portable: Option<PathBuf> = None;
    let config_dir = match (&portable, &shared) {
        (Some(dados), _) => dados.join("Config"),
        (None, Some((cfg, _))) => cfg.clone(),
        (None, None) => app.path().app_config_dir()?,
    };
    fs::create_dir_all(&config_dir)?;
    #[cfg(desktop)]
    let root = match (&portable, &shared) {
        (Some(dados), _) => dados.join("Cadernos"),
        (None, Some((_, docs))) => docs.clone(),
        (None, None) => app.path().document_dir()?.join("NOTEx"),
    };
    #[cfg(mobile)]
    let root = app.path().app_data_dir()?.join("Cadernos");
    fs::create_dir_all(&root)?;

    let config_file = config_dir.join("config.json");
    let mut cfg: Config = fs::read(&config_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    #[cfg(desktop)]
    if portable.is_some() {
        rebase_portable(&mut cfg, &root);
    }
    let state = AppState {
        index: Mutex::new(index::Index::default()),
        vault: Mutex::new(vault::Vault::default()),
        config: Mutex::new(Config::default()),
        config_file,
        client: sync_app::ClientRuntime::load(config_dir.join("sync-client.json")),
        drive: sync_app::DriveRuntime::load(config_dir.join("drive.json")),
        #[cfg(desktop)]
        server: sync_app::ServerState::load(config_dir.join("sync-server.json")),
        #[cfg(desktop)]
        changes: Default::default(),
        state_dir: config_dir,
        default_root: root,
    };
    // Pasta padrão escolhida que sumiu (pendrive, disco removido): volta para a de fábrica.
    if cfg.root.as_ref().is_some_and(|r| !r.is_dir()) {
        cfg.root = None;
    }
    let quick_root = state.root(&cfg);
    if cfg.ensure_quick(&quick_root)? || !state.config_file.exists() {
        state.save(&cfg)?;
    }
    *state.config.lock().unwrap() = cfg;
    Ok(state)
}

// Comandos de servidor de sincronização só existem no PC.
#[cfg(desktop)]
macro_rules! handlers {
    ($($cmd:path),* $(,)?) => {
        tauri::generate_handler![
            $($cmd,)*
            sync_app::sync_server_status,
            sync_app::sync_pair_start,
            sync_app::sync_pair_cancel,
            sync_app::sync_remove_device,
        ]
    };
}
#[cfg(mobile)]
macro_rules! handlers {
    ($($cmd:path),* $(,)?) => {
        tauri::generate_handler![$($cmd),*]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Portátil: os dados do WebView (tema, cache) também ficam na pasta Dados.
    #[cfg(desktop)]
    if let Some(dados) = portable_dir() {
        // SAFETY: executado no início do programa, antes de qualquer outra thread.
        unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dados.join("WebView")) };
    }
    let builder = tauri::Builder::default();
    // Precisa ser o primeiro plugin: uma segunda abertura só foca a janela que já existe.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_biometric::init());
    builder
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            // PC: servidor de sincronização sempre ligado. Celular: rotina que sincroniza com o app aberto.
            #[cfg(desktop)]
            sync_app::start_server(app.handle().clone());
            #[cfg(mobile)]
            sync_app::start_client_loop(app.handle().clone());
            sync_app::start_drive_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(handlers!(
            get_notebooks,
            create_notebook,
            add_notebook,
            rename_notebook,
            remove_notebook,
            move_notebook,
            get_root,
            set_root,
            set_icon,
            list_tree,
            vault_status,
            vault_unlock,
            vault_unlock_remembered,
            vault_lock,
            vault_forget,
            vault_make_private,
            vault_make_public,
            search_notes,
            list_terms,
            define_term,
            create_note,
            create_folder,
            rename_entry,
            move_entry,
            trash_entry,
            remove_if_empty,
            read_note,
            write_note,
            note_mtime,
            open_external,
            notebooks_root,
            load_state,
            save_state,
            sync_app::sync_client_status,
            sync_app::sync_pair,
            sync_app::sync_unpair,
            sync_app::sync_now,
            sync_app::sync_set_active,
            sync_app::drive_status,
            sync_app::drive_connect,
            sync_app::drive_connect_cancel,
            sync_app::drive_disconnect,
            sync_app::drive_sync_now,
        ))
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o NOTEx");
}

#[cfg(all(test, desktop))]
mod portable_tests {
    use super::*;

    #[test]
    fn pasta_portatil_movida_religa_os_cadernos() {
        let novo = tempfile::tempdir().unwrap();
        let root = novo.path().join("Dados").join("Cadernos");
        fs::create_dir_all(root.join("Trabalho")).unwrap();
        let mut cfg = Config::default();
        let velho = PathBuf::from("E:").join("antigo").join("NOTEx-Portatil").join("Dados").join("Cadernos");
        cfg.notebooks.push(notebooks::Notebook { id: "t".into(), name: "Trabalho".into(), path: velho.join("Trabalho") });
        cfg.root = Some(velho);
        rebase_portable(&mut cfg, &root);
        assert_eq!(cfg.notebooks[0].path, root.join("Trabalho"));
        assert_eq!(cfg.root, None);
    }
}
