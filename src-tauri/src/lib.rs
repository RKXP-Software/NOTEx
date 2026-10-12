// Núcleo do NOTEx: comandos chamados pela interface (invoke). Os erros voltam como mensagens
// em português, prontas para exibir.

mod notebooks;
mod textfile;

use notebooks::{Config, Notebook, TreeEntry};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State};
use textfile::{Encoding, TextFormat};

struct AppState {
    config: Mutex<Config>,
    config_file: PathBuf,
    state_dir: PathBuf,
    /// Pasta onde ficam os cadernos criados pelo NOTEx.
    root: PathBuf,
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
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

// ---- Cadernos ----

#[tauri::command]
fn get_notebooks(state: State<AppState>) -> CmdResult<Vec<Notebook>> {
    state.with_config(|c| Ok(c.notebooks.clone()), false)
}

fn new_notebook_id() -> String {
    let ms = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("nb{ms:x}")
}

/// Recusa cadernos aninhados (um dentro do outro), que confundiriam a validação e a sincronização.
fn check_not_nested(cfg: &Config, path: &Path) -> CmdResult<()> {
    if cfg.notebooks.iter().any(|n| notebooks::is_within(&n.path, path) || notebooks::is_within(path, &n.path)) {
        return Err("Essa pasta já faz parte de um caderno (ou contém um).".into());
    }
    Ok(())
}

#[tauri::command]
fn create_notebook(state: State<AppState>, name: String) -> CmdResult<Notebook> {
    let stem = notebooks::sanitize_name(&name);
    if stem.is_empty() {
        return Err("Nome de caderno inválido.".into());
    }
    state.with_config(
        |cfg| {
            let path = notebooks::unique_path(&state.root, &stem, "", None);
            check_not_nested(cfg, &path)?;
            fs::create_dir_all(&path).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
            let nb = Notebook { id: new_notebook_id(), name: name.trim().to_string(), path };
            cfg.notebooks.push(nb.clone());
            Ok(nb)
        },
        true,
    )
}

/// Registra uma pasta existente (escolhida pelo usuário) como caderno.
#[tauri::command]
fn add_notebook(state: State<AppState>, path: PathBuf) -> CmdResult<Notebook> {
    if !path.is_absolute() || !path.is_dir() {
        return Err("Pasta inválida.".into());
    }
    state.with_config(
        |cfg| {
            check_not_nested(cfg, &path)?;
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Caderno".into());
            let nb = Notebook { id: new_notebook_id(), name, path };
            cfg.notebooks.push(nb.clone());
            Ok(nb)
        },
        true,
    )
}

#[tauri::command]
fn rename_notebook(state: State<AppState>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Nome inválido.".into());
    }
    state.with_config(
        |cfg| {
            let nb = cfg.notebooks.iter_mut().find(|n| n.id == id).ok_or("Caderno não encontrado.")?;
            nb.name = name;
            Ok(())
        },
        true,
    )
}

/// Tira o caderno da lista. Os arquivos continuam na pasta.
#[tauri::command]
fn remove_notebook(state: State<AppState>, id: String) -> CmdResult<()> {
    if id == notebooks::QUICK_NOTEBOOK_ID {
        return Err("O caderno Rápidas não pode ser removido.".into());
    }
    state.with_config(
        |cfg| {
            cfg.notebooks.retain(|n| n.id != id);
            Ok(())
        },
        true,
    )
}

#[tauri::command]
fn list_tree(state: State<AppState>, id: String) -> CmdResult<Vec<TreeEntry>> {
    let root = state.with_config(|c| Ok(c.notebook(&id)?.path.clone()), false)?;
    fs::create_dir_all(&root).map_err(|e| format!("Pasta do caderno inacessível: {e}"))?;
    notebooks::list_tree(&root).map_err(|e| format!("Não foi possível listar o caderno: {e}"))
}

// ---- Notas e pastas ----

#[tauri::command]
fn create_note(state: State<AppState>, dir: PathBuf, title: String, ext: String) -> CmdResult<PathBuf> {
    state.with_config(|c| c.check_in_notebook(&dir).map(|_| ()), false)?;
    notebooks::create_note(&dir, &title, &ext)
}

#[tauri::command]
fn create_folder(state: State<AppState>, parent: PathBuf, name: String) -> CmdResult<PathBuf> {
    state.with_config(|c| c.check_in_notebook(&parent).map(|_| ()), false)?;
    notebooks::create_folder(&parent, &name)
}

#[tauri::command]
fn rename_entry(state: State<AppState>, path: PathBuf, name: String) -> CmdResult<PathBuf> {
    state.with_config(
        |c| {
            let nb = c.check_in_notebook(&path)?;
            if notebooks::same_path(&nb.path, &path) {
                return Err("Use \"Renomear caderno\" para a pasta raiz.".into());
            }
            Ok(())
        },
        false,
    )?;
    notebooks::rename_entry(&path, &name)
}

#[tauri::command]
fn move_entry(state: State<AppState>, path: PathBuf, dest_dir: PathBuf) -> CmdResult<PathBuf> {
    state.with_config(
        |c| {
            let nb = c.check_in_notebook(&path)?;
            if notebooks::same_path(&nb.path, &path) {
                return Err("Não é possível mover a pasta raiz do caderno.".into());
            }
            c.check_in_notebook(&dest_dir)?;
            Ok(())
        },
        false,
    )?;
    if !dest_dir.is_dir() {
        return Err("Destino inválido.".into());
    }
    notebooks::move_entry(&path, &dest_dir)
}

#[tauri::command]
fn trash_entry(state: State<AppState>, path: PathBuf) -> CmdResult<PathBuf> {
    let root = state.with_config(|c| Ok(c.check_in_notebook(&path)?.path.clone()), false)?;
    notebooks::trash_entry(&root, &path)
}

#[tauri::command]
fn remove_if_empty(state: State<AppState>, path: PathBuf) -> CmdResult<bool> {
    state.with_config(|c| c.check_in_notebook(&path).map(|_| ()), false)?;
    notebooks::remove_if_empty(&path)
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
    let d = textfile::read_file(&path).map_err(|e| format!("Não foi possível abrir {}: {e}", path.display()))?;
    Ok(NoteContent { text: d.text, format: d.format, mtime: mtime_ms(&path) })
}

#[derive(Serialize)]
struct WriteResult {
    format: TextFormat,
    mtime: Option<u64>,
}

/// Grava a nota no formato dado. Se o texto tiver caracteres que a Windows-1252 não representa,
/// grava em UTF-8 (o salvamento é automático, não dá para perguntar) e devolve o novo formato.
#[tauri::command]
fn write_note(state: State<AppState>, path: PathBuf, text: String, format: TextFormat) -> CmdResult<WriteResult> {
    state.with_config(|c| c.check_allowed(&path), false)?;
    let mut format = format;
    if textfile::find_unencodable(&text, format.encoding).is_some() {
        format = TextFormat { encoding: Encoding::Utf8, bom: false, ..format };
    }
    textfile::write_file(&path, &text, &format)?;
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
fn notebooks_root(state: State<AppState>) -> PathBuf {
    state.root.clone()
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

fn init_state(app: &AppHandle) -> Result<AppState, Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir()?;
    fs::create_dir_all(&config_dir)?;
    #[cfg(desktop)]
    let root = app.path().document_dir()?.join("NOTEx");
    #[cfg(mobile)]
    let root = app.path().app_data_dir()?.join("Cadernos");
    fs::create_dir_all(&root)?;

    let config_file = config_dir.join("config.json");
    let mut cfg: Config = fs::read(&config_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let state = AppState { config: Mutex::new(Config::default()), config_file, state_dir: config_dir, root };
    if cfg.ensure_quick(&state.root)? || !state.config_file.exists() {
        state.save(&cfg)?;
    }
    *state.config.lock().unwrap() = cfg;
    Ok(state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notebooks,
            create_notebook,
            add_notebook,
            rename_notebook,
            remove_notebook,
            list_tree,
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
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o NOTEx");
}
