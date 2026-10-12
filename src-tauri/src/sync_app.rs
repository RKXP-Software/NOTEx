// Integração da sincronização com o app: cadernos do aparelho como lado da sincronização,
// servidor e pareamento no PC, rotina automática no celular e comandos para a interface.

use crate::sync::client::{ClientConfig, HttpRemote, OFFLINE, ServerInfo, parse_link};
use crate::sync::drive::DriveRemote;
use crate::sync::engine::{self, Options, Remote};
use crate::sync::google::{self, GoogleDrive};
use crate::sync::proto::{NotebookInfo, Request, Response, new_id};
use crate::sync::Host;
use crate::{AppState, CmdResult, notebooks};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT_FILES: &str = "notex://files-changed";
pub const EVENT_STATUS: &str = "notex://sync-status";

/// Os cadernos deste aparelho, vistos pela sincronização.
#[derive(Clone)]
pub struct AppHost {
    pub app: AppHandle,
}

#[derive(Clone, Serialize)]
struct FilesChanged {
    changed: Vec<PathBuf>,
    removed: Vec<PathBuf>,
}

impl Host for AppHost {
    fn notebooks(&self) -> Vec<(NotebookInfo, PathBuf)> {
        let state = self.app.state::<AppState>();
        let cfg = state.config.lock().unwrap();
        cfg.notebooks.iter().map(|n| (NotebookInfo { id: n.id.clone(), name: n.name.clone() }, n.path.clone())).collect()
    }

    fn create_notebook(&self, id: &str, name: &str) -> Result<PathBuf, String> {
        let state = self.app.state::<AppState>();
        state.with_config(
            |cfg| {
                if let Some(nb) = cfg.notebooks.iter().find(|n| n.id == id) {
                    fs::create_dir_all(&nb.path).map_err(|e| e.to_string())?;
                    return Ok(nb.path.clone());
                }
                let stem = match notebooks::sanitize_name(name) {
                    s if s.is_empty() => "Caderno".to_string(),
                    s => s,
                };
                let path = notebooks::unique_path(&state.root(cfg), &stem, "", None);
                crate::check_not_nested(cfg, &path, None)?;
                fs::create_dir_all(&path).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
                cfg.notebooks.push(notebooks::Notebook { id: id.into(), name: name.into(), path: path.clone() });
                Ok(path)
            },
            true,
        )
    }

    fn forget_notebook(&self, id: &str) {
        if id == notebooks::QUICK_NOTEBOOK_ID {
            return;
        }
        let state = self.app.state::<AppState>();
        let _ = state.with_config(
            |cfg| {
                cfg.notebooks.retain(|n| n.id != id);
                Ok(())
            },
            true,
        );
    }

    fn changed(&self, changed: Vec<PathBuf>, removed: Vec<PathBuf>) {
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        let _ = self.app.emit(EVENT_FILES, FilesChanged { changed, removed });
        // No PC, avisa os outros celulares que algo mudou.
        #[cfg(desktop)]
        self.app.state::<AppState>().changes.bump();
    }
}

/// Data/hora local "2026-10-12 06h20" (sem dependências: `tz_offset_min` vem da interface).
pub fn local_label(epoch_ms: u64, tz_offset_min: i32) -> String {
    let secs = (epoch_ms / 1000) as i64 + i64::from(tz_offset_min) * 60;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Algoritmo de Howard Hinnant (dias desde 1970-01-01 → data civil).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}h{:02}", rem / 3600, (rem % 3600) / 60)
}

// =====================================================================================
// Celular (cliente)
// =====================================================================================

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    /// "unpaired" | "idle" | "syncing" | "offline" | "error"
    pub state: String,
    pub server_name: Option<String>,
    pub last_sync: Option<u64>,
    pub message: String,
    pub conflicts: usize,
}

pub struct ClientRuntime {
    cfg: Mutex<ClientConfig>,
    file: PathBuf,
    /// Uma sincronização por vez.
    running: Mutex<()>,
    /// App em primeiro plano (só sincroniza com ele aberto).
    active: AtomicBool,
    tz_offset_min: AtomicI32,
    status: Mutex<ClientStatus>,
    /// Sincronização agendada (debounce depois de gravações locais).
    scheduled: Mutex<Option<Instant>>,
}

impl ClientRuntime {
    pub fn load(file: PathBuf) -> Self {
        let mut cfg: ClientConfig = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if cfg.device_id.is_empty() {
            cfg.device_id = new_id();
        }
        let status = ClientStatus {
            state: if cfg.server.is_some() { "idle" } else { "unpaired" }.into(),
            server_name: cfg.server.as_ref().map(|s| s.name.clone()),
            ..Default::default()
        };
        Self {
            cfg: Mutex::new(cfg),
            file,
            running: Mutex::new(()),
            active: AtomicBool::new(false),
            tz_offset_min: AtomicI32::new(0),
            status: Mutex::new(status),
            scheduled: Mutex::new(None),
        }
    }

    fn save(&self, cfg: &ClientConfig) {
        if let Ok(json) = serde_json::to_vec_pretty(cfg) {
            let _ = crate::textfile::write_atomic(&self.file, &json);
        }
    }

    fn paired(&self) -> bool {
        self.cfg.lock().map(|c| c.server.is_some()).unwrap_or(false)
    }
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut ClientStatus)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut st = state.client.status.lock().unwrap();
        f(&mut st);
        st.clone()
    };
    let _ = app.emit(EVENT_STATUS, snapshot);
}

/// Faz uma sincronização completa agora (bloqueia até terminar; uma por vez).
fn run_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let rt = &state.client;
    let _guard = rt.running.lock().unwrap();
    // Com o Google Drive ativo, a sincronização é só pelo Drive.
    if state.drive.connected() {
        return;
    }
    let (info, device_id, device_name, mut base) = {
        let cfg = rt.cfg.lock().unwrap();
        match &cfg.server {
            Some(s) => (s.clone(), cfg.device_id.clone(), cfg.device_name.clone(), cfg.base.clone()),
            None => return,
        }
    };
    set_status(app, |s| {
        s.state = "syncing".into();
        s.message.clear();
    });
    let host = AppHost { app: app.clone() };
    let mut remote = match HttpRemote::new(info, device_id, false) {
        Ok(r) => r,
        Err(e) => return set_status(app, |s| (s.state, s.message) = ("error".into(), e)),
    };
    // O PC conectou o Google Drive? Então o celular recebe o acesso e passa a usar só o Drive.
    if let Ok(Response::DriveCredentials { refresh_token: Some(token), email }) = remote.call(Request::DriveCredentials) {
        adopt_drive(app, token, email);
        set_status(app, |s| {
            s.state = "idle".into();
            s.message = "Sincronizando pelo Google Drive.".into();
        });
        request_drive_sync(app, Duration::from_millis(50));
        return;
    }
    let label = format!(
        "{} {}",
        if device_name.is_empty() { "celular" } else { &device_name },
        local_label(crate::sync::proto::now_ms(), rt.tz_offset_min.load(Ordering::Relaxed))
    );
    let result = engine::sync_all(&host, &mut remote, &mut base, &Options { conflict_label: label });
    {
        // Guarda a base mesmo em erro: reflete o que já foi feito.
        let mut cfg = rt.cfg.lock().unwrap();
        if cfg.server.as_ref().map(|s| &s.id) == Some(&remote.info.id) {
            cfg.base = base;
            if remote.addrs_changed {
                cfg.server = Some(remote.info.clone());
            }
            rt.save(&cfg);
        }
    }
    match result {
        Ok(out) => set_status(app, |s| {
            s.state = "idle".into();
            s.last_sync = Some(crate::sync::proto::now_ms());
            s.conflicts = out.conflicts.len();
            s.message.clear();
        }),
        Err(e) => set_status(app, |s| {
            s.state = if e == OFFLINE { "offline" } else { "error" }.into();
            s.message = e;
        }),
    }
}

/// Agenda `run` para daqui a `delay`; chamadas seguidas adiam a mesma execução (agrupa gravações).
fn schedule(app: &AppHandle, slot: fn(&AppState) -> &Mutex<Option<Instant>>, delay: Duration, run: fn(&AppHandle)) {
    let state = app.state::<AppState>();
    let mut sched = slot(&state).lock().unwrap();
    let first = sched.is_none();
    *sched = Some(Instant::now() + delay);
    drop(sched);
    if !first {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            let state = app.state::<AppState>();
            let due = *slot(&state).lock().unwrap();
            match due {
                Some(t) if t > Instant::now() => std::thread::sleep(t - Instant::now()),
                Some(_) => {
                    *slot(&state).lock().unwrap() = None;
                    run(&app);
                    return;
                }
                None => return,
            }
        }
    });
}

/// Agenda uma sincronização logo após mudanças locais: pelo Drive se conectado, senão direto com o PC.
pub fn request_sync(app: &AppHandle, delay: Duration) {
    let state = app.state::<AppState>();
    if state.drive.connected() {
        return request_drive_sync(app, delay);
    }
    if state.client.paired() {
        schedule(app, |s| &s.client.scheduled, delay, run_sync);
    }
}

/// Rotina do celular: com o app aberto, sincroniza e fica "escutando" mudanças no PC.
#[cfg_attr(desktop, allow(dead_code))]
pub fn start_client_loop(app: AppHandle) {
    std::thread::Builder::new()
        .name("notex-sync-client".into())
        .spawn(move || {
            let mut since = u64::MAX;
            let mut backoff = 2u64;
            loop {
                let state = app.state::<AppState>();
                let rt = &state.client;
                if !rt.active.load(Ordering::Relaxed) || !rt.paired() || state.drive.connected() {
                    since = u64::MAX;
                    std::thread::sleep(Duration::from_millis(700));
                    continue;
                }
                if since == u64::MAX {
                    // Acabou de abrir (ou reconectar): sincroniza já.
                    run_sync(&app);
                }
                let (info, device_id) = {
                    let cfg = rt.cfg.lock().unwrap();
                    match &cfg.server {
                        Some(s) => (s.clone(), cfg.device_id.clone()),
                        None => continue,
                    }
                };
                let waited = HttpRemote::new(info, device_id, false).and_then(|mut r| r.call(Request::Wait { since }));
                match waited {
                    Ok(Response::Changes { counter }) => {
                        backoff = 2;
                        if since != u64::MAX && counter > since {
                            run_sync(&app);
                        }
                        since = counter;
                    }
                    Ok(_) | Err(_) => {
                        if rt.status.lock().unwrap().state != "offline" && since != u64::MAX {
                            set_status(&app, |s| (s.state, s.message) = ("offline".into(), OFFLINE.into()));
                        }
                        since = u64::MAX;
                        std::thread::sleep(Duration::from_secs(backoff));
                        backoff = (backoff * 2).min(30);
                    }
                }
            }
        })
        .expect("thread de sincronização");
}

#[tauri::command]
pub fn sync_client_status(state: State<AppState>) -> ClientStatus {
    state.client.status.lock().unwrap().clone()
}

/// Pareia com o PC a partir do conteúdo do QR code.
#[tauri::command]
pub async fn sync_pair(app: AppHandle, link: String, device_name: String) -> CmdResult<String> {
    let info = parse_link(&link)?;
    let device_id = app.state::<AppState>().client.cfg.lock().unwrap().device_id.clone();
    let name = device_name.trim().chars().take(60).collect::<String>();
    let mut remote = HttpRemote::new(info.clone(), device_id.clone(), true)?;
    let pair_name = name.clone();
    let resp = tauri::async_runtime::spawn_blocking(move || {
        let r = remote.call(Request::Pair { device_id, device_name: pair_name });
        (r, remote)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (resp, remote) = resp;
    match resp? {
        Response::Paired { server_id, server_name } => {
            let state = app.state::<AppState>();
            let mut cfg = state.client.cfg.lock().unwrap();
            let mut server = remote.info.clone();
            server.id = server_id;
            server.name = server_name.clone();
            // Outro PC: começa uma base nova.
            if cfg.server.as_ref().map(|s| &s.id) != Some(&server.id) {
                cfg.base = Default::default();
            }
            cfg.server = Some(server);
            cfg.device_name = name;
            state.client.save(&cfg);
            drop(cfg);
            set_status(&app, |s| {
                s.state = "idle".into();
                s.server_name = Some(server_name.clone());
                s.message.clear();
            });
            request_sync(&app, Duration::from_millis(100));
            Ok(server_name)
        }
        Response::Error { message } => Err(message),
        other => Err(format!("Resposta inesperada do PC: {other:?}")),
    }
}

#[tauri::command]
pub fn sync_unpair(app: AppHandle) {
    let state = app.state::<AppState>();
    let mut cfg = state.client.cfg.lock().unwrap();
    cfg.server = None;
    cfg.base = Default::default();
    state.client.save(&cfg);
    drop(cfg);
    set_status(&app, |s| *s = ClientStatus { state: "unpaired".into(), ..Default::default() });
}

#[tauri::command]
pub fn sync_now(app: AppHandle) {
    request_sync(&app, Duration::from_millis(50));
}

/// A interface avisa quando o app vai para primeiro/segundo plano (e o fuso, para os nomes de conflito).
#[tauri::command]
pub fn sync_set_active(app: AppHandle, active: bool, tz_offset_min: i32) {
    let state = app.state::<AppState>();
    state.client.tz_offset_min.store(tz_offset_min, Ordering::Relaxed);
    let was = state.client.active.swap(active, Ordering::Relaxed);
    // Voltou para o app: busca mudanças do Drive já (a conexão direta tem a própria rotina).
    if active && !was {
        request_drive_sync(&app, Duration::from_millis(100));
    }
}

// =====================================================================================
// Google Drive (PC e celular)
// =====================================================================================
//
// Com o Drive conectado, PC e celular sincronizam só com ele (o "ponto de encontro"). O login
// acontece no PC; o celular pareado recebe o acesso pelo canal cifrado (Request::DriveCredentials).

pub const EVENT_DRIVE: &str = "notex://drive-status";
/// Intervalo para buscar mudanças do outro aparelho no Drive (com o app aberto).
const DRIVE_POLL: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DriveConfig {
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    base: engine::SyncBase,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatus {
    /// O build tem o cliente OAuth (google.secret.json) embutido.
    pub configured: bool,
    pub connected: bool,
    pub email: Option<String>,
    /// "off" | "idle" | "syncing" | "offline" | "error"
    pub state: String,
    pub last_sync: Option<u64>,
    pub message: String,
    pub conflicts: usize,
}

pub struct DriveRuntime {
    cfg: Mutex<DriveConfig>,
    file: PathBuf,
    running: Mutex<()>,
    scheduled: Mutex<Option<Instant>>,
    status: Mutex<DriveStatus>,
    /// Conexão reaproveitada entre sincronizações (token de acesso e pasta NOTEx em cache).
    remote: Mutex<Option<DriveRemote<GoogleDrive>>>,
    /// Pedido de cancelar o login em andamento.
    cancel_login: AtomicBool,
}

impl DriveRuntime {
    pub fn load(file: PathBuf) -> Self {
        let cfg: DriveConfig = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let connected = cfg.refresh_token.is_some();
        let status = DriveStatus {
            configured: google::client().is_some(),
            connected,
            email: cfg.email.clone(),
            state: if connected { "idle" } else { "off" }.into(),
            ..Default::default()
        };
        Self {
            cfg: Mutex::new(cfg),
            file,
            running: Mutex::new(()),
            scheduled: Mutex::new(None),
            status: Mutex::new(status),
            remote: Mutex::new(None),
            cancel_login: AtomicBool::new(false),
        }
    }

    pub fn connected(&self) -> bool {
        self.cfg.lock().map(|c| c.refresh_token.is_some()).unwrap_or(false)
    }

    /// Refresh token e e-mail (para repassar ao celular pareado).
    pub fn credentials(&self) -> (Option<String>, Option<String>) {
        let c = self.cfg.lock().unwrap();
        (c.refresh_token.clone(), c.email.clone())
    }

    fn save(&self, cfg: &DriveConfig) {
        if let Ok(json) = serde_json::to_vec_pretty(cfg) {
            let _ = crate::textfile::write_atomic(&self.file, &json);
        }
    }
}

fn set_drive_status(app: &AppHandle, f: impl FnOnce(&mut DriveStatus)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut st = state.drive.status.lock().unwrap();
        f(&mut st);
        st.clone()
    };
    let _ = app.emit(EVENT_DRIVE, snapshot);
}

/// Passa a usar o Drive com este acesso (login no PC ou recebido do PC).
fn adopt_drive(app: &AppHandle, token: String, email: Option<String>) {
    let state = app.state::<AppState>();
    {
        let mut cfg = state.drive.cfg.lock().unwrap();
        if cfg.refresh_token.as_ref() == Some(&token) {
            return;
        }
        cfg.refresh_token = Some(token);
        cfg.email = email.clone();
        cfg.base = Default::default();
        state.drive.save(&cfg);
    }
    *state.drive.remote.lock().unwrap() = None;
    set_drive_status(app, |s| {
        s.connected = true;
        s.email = email;
        s.state = "idle".into();
        s.message.clear();
    });
}

fn forget_drive(app: &AppHandle, message: String) -> Option<String> {
    let state = app.state::<AppState>();
    let token = {
        let mut cfg = state.drive.cfg.lock().unwrap();
        let t = cfg.refresh_token.take();
        cfg.email = None;
        cfg.base = Default::default();
        state.drive.save(&cfg);
        t
    };
    *state.drive.remote.lock().unwrap() = None;
    set_drive_status(app, |s| {
        s.connected = false;
        s.email = None;
        s.state = "off".into();
        s.message = message;
    });
    token
}

fn run_drive_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let rt = &state.drive;
    let _guard = rt.running.lock().unwrap();
    let (token, mut base) = {
        let cfg = rt.cfg.lock().unwrap();
        match &cfg.refresh_token {
            Some(t) => (t.clone(), cfg.base.clone()),
            None => return,
        }
    };
    let Some(client) = google::client() else {
        return set_drive_status(app, |s| (s.state, s.message) = ("error".into(), "Este build do NOTEx não tem o Google Drive configurado.".into()));
    };
    set_drive_status(app, |s| {
        s.state = "syncing".into();
        s.message.clear();
    });
    let mut guard = rt.remote.lock().unwrap();
    let remote = guard.get_or_insert_with(|| DriveRemote::new(GoogleDrive::new(client, token.clone())));
    remote.reset();
    let who = if cfg!(mobile) {
        let name = state.client.cfg.lock().unwrap().device_name.clone();
        if name.is_empty() { "celular".to_string() } else { name }
    } else {
        "PC".to_string()
    };
    let label = format!("{who} {}", local_label(crate::sync::proto::now_ms(), state.client.tz_offset_min.load(Ordering::Relaxed)));
    let host = AppHost { app: app.clone() };
    let result = engine::sync_all(&host, remote, &mut base, &Options { conflict_label: label });
    drop(guard);
    {
        let mut cfg = rt.cfg.lock().unwrap();
        if cfg.refresh_token.as_ref() == Some(&token) {
            cfg.base = base;
            rt.save(&cfg);
        }
    }
    match result {
        Ok(out) => set_drive_status(app, |s| {
            s.state = "idle".into();
            s.last_sync = Some(crate::sync::proto::now_ms());
            s.conflicts = out.conflicts.len();
            s.message.clear();
        }),
        Err(e) if e == google::REVOKED => {
            // No celular, volta para a conexão direta com o PC (que pode repassar um acesso novo).
            forget_drive(app, e);
        }
        Err(e) => set_drive_status(app, |s| {
            s.state = if e.starts_with("Sem conexão") { "offline" } else { "error" }.into();
            s.message = e;
        }),
    }
}

/// Agenda uma sincronização com o Drive (agrupa gravações seguidas).
pub fn request_drive_sync(app: &AppHandle, delay: Duration) {
    if app.state::<AppState>().drive.connected() {
        schedule(app, |s| &s.drive.scheduled, delay, run_drive_sync);
    }
}

/// Busca mudanças no Drive periodicamente (no celular, só com o app aberto).
pub fn start_drive_loop(app: AppHandle) {
    request_drive_sync(&app, Duration::from_secs(1));
    std::thread::Builder::new()
        .name("notex-drive".into())
        .spawn(move || {
            loop {
                std::thread::sleep(DRIVE_POLL);
                let state = app.state::<AppState>();
                let active = cfg!(desktop) || state.client.active.load(Ordering::Relaxed);
                if active && state.drive.connected() {
                    run_drive_sync(&app);
                }
            }
        })
        .expect("thread do Google Drive");
}

#[tauri::command]
pub fn drive_status(state: State<AppState>) -> DriveStatus {
    state.drive.status.lock().unwrap().clone()
}

/// Login no Google pelo navegador (só no PC). Devolve o e-mail da conta.
#[tauri::command]
pub async fn drive_connect(app: AppHandle) -> CmdResult<String> {
    if cfg!(mobile) {
        return Err("Conecte o Google Drive no NOTEx do PC; o celular pareado recebe o acesso sozinho.".into());
    }
    let client = google::client().ok_or("Este build do NOTEx não tem o Google Drive configurado.")?;
    let opener_app = app.clone();
    app.state::<AppState>().drive.cancel_login.store(false, Ordering::Relaxed);
    let (token, email) = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        let token = google::authorize(
            &client,
            |url| opener_app.opener().open_url(url, None::<&str>).map_err(|e| format!("Não foi possível abrir o navegador: {e}")),
            || opener_app.state::<AppState>().drive.cancel_login.load(Ordering::Relaxed),
        )?;
        let email = GoogleDrive::new(client, token.clone()).user_email()?;
        Ok::<_, String>((token, email))
    })
    .await
    .map_err(|e| e.to_string())??;
    adopt_drive(&app, token, Some(email.clone()));
    request_drive_sync(&app, Duration::from_millis(50));
    Ok(email)
}

/// Cancela a espera do login no navegador.
#[tauri::command]
pub fn drive_connect_cancel(state: State<AppState>) {
    state.drive.cancel_login.store(true, Ordering::Relaxed);
}

/// Desconecta. No PC também revoga o acesso no Google (vale para o celular também).
#[tauri::command]
pub fn drive_disconnect(app: AppHandle) {
    if let Some(token) = forget_drive(&app, String::new()) {
        if cfg!(desktop) {
            std::thread::spawn(move || google::revoke(&token));
        }
    }
}

#[tauri::command]
pub fn drive_sync_now(app: AppHandle) {
    request_drive_sync(&app, Duration::from_millis(50));
}

// =====================================================================================
// PC (servidor)
// =====================================================================================

#[cfg(desktop)]
pub use server::*;

#[cfg(desktop)]
mod server {
    use super::*;
    use crate::sync::client::make_link;
    use crate::sync::http::{self, Changes, ServerCtx};
    use crate::sync::proto::{HTTP_PORT, KeyBytes, key_from_b64, key_to_b64, new_key};

    /// QR code válido por 10 minutos.
    const PAIR_TTL: Duration = Duration::from_secs(600);

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct PairedDevice {
        pub id: String,
        pub name: String,
        pub key: String,
        #[serde(default)]
        pub paired_at: u64,
    }

    #[derive(Debug, Clone, Default, Serialize, Deserialize)]
    pub struct ServerConfig {
        pub server_id: String,
        #[serde(default)]
        pub devices: Vec<PairedDevice>,
    }

    pub struct ServerState {
        cfg: Mutex<ServerConfig>,
        file: PathBuf,
        pending: Mutex<Option<(KeyBytes, Instant)>>,
        last_seen: Mutex<std::collections::HashMap<String, u64>>,
        error: Mutex<Option<String>>,
        name: String,
    }

    impl ServerState {
        pub fn load(file: PathBuf) -> Self {
            let mut cfg: ServerConfig =
                fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let fresh = cfg.server_id.is_empty();
            if fresh {
                cfg.server_id = new_id();
            }
            let name = hostname::get().ok().and_then(|h| h.into_string().ok()).unwrap_or_else(|| "PC".into());
            let s = Self {
                cfg: Mutex::new(cfg),
                file,
                pending: Mutex::new(None),
                last_seen: Mutex::new(Default::default()),
                error: Mutex::new(None),
                name,
            };
            if fresh {
                s.save(&s.cfg.lock().unwrap());
            }
            s
        }

        fn save(&self, cfg: &ServerConfig) {
            if let Ok(json) = serde_json::to_vec_pretty(cfg) {
                let _ = crate::textfile::write_atomic(&self.file, &json);
            }
        }

        #[cfg(test)]
        pub fn device_count(&self) -> usize {
            self.cfg.lock().unwrap().devices.len()
        }

        #[cfg(test)]
        pub fn server_id(&self) -> String {
            self.cfg.lock().unwrap().server_id.clone()
        }
    }

    impl ServerCtx for AppHost {
        fn server_id(&self) -> String {
            self.app.state::<AppState>().server.cfg.lock().unwrap().server_id.clone()
        }
        fn server_name(&self) -> String {
            self.app.state::<AppState>().server.name.clone()
        }
        fn device_key(&self, device_id: &str) -> Option<KeyBytes> {
            let state = self.app.state::<AppState>();
            let cfg = state.server.cfg.lock().unwrap();
            cfg.devices.iter().find(|d| d.id == device_id).and_then(|d| key_from_b64(&d.key))
        }
        fn pending_key(&self) -> Option<KeyBytes> {
            let state = self.app.state::<AppState>();
            let p = state.server.pending.lock().unwrap();
            p.filter(|(_, at)| at.elapsed() < PAIR_TTL).map(|(k, _)| k)
        }
        fn complete_pair(&self, device_id: &str, device_name: &str, key: KeyBytes) -> Result<(), String> {
            let state = self.app.state::<AppState>();
            // O QR vale para um pareamento só.
            state.server.pending.lock().unwrap().take();
            let mut cfg = state.server.cfg.lock().unwrap();
            cfg.devices.retain(|d| d.id != device_id);
            cfg.devices.push(PairedDevice {
                id: device_id.into(),
                name: if device_name.trim().is_empty() { "Celular".into() } else { device_name.trim().into() },
                key: key_to_b64(&key),
                paired_at: crate::sync::proto::now_ms(),
            });
            state.server.save(&cfg);
            state.server.last_seen.lock().unwrap().insert(device_id.into(), crate::sync::proto::now_ms());
            Ok(())
        }
        fn touch_device(&self, device_id: &str) {
            let state = self.app.state::<AppState>();
            state.server.last_seen.lock().unwrap().insert(device_id.into(), crate::sync::proto::now_ms());
        }
        fn changes(&self) -> std::sync::Arc<Changes> {
            self.app.state::<AppState>().changes.clone()
        }
        fn drive_credentials(&self) -> (Option<String>, Option<String>) {
            self.app.state::<AppState>().drive.credentials()
        }
    }

    pub fn start_server(app: AppHandle) {
        let ctx: std::sync::Arc<dyn ServerCtx> = std::sync::Arc::new(AppHost { app: app.clone() });
        if let Err(e) = http::start(ctx) {
            *app.state::<AppState>().server.error.lock().unwrap() = Some(e);
        }
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DeviceView {
        id: String,
        name: String,
        last_seen: Option<u64>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ServerStatus {
        running: bool,
        error: Option<String>,
        name: String,
        port: u16,
        ips: Vec<String>,
        devices: Vec<DeviceView>,
        pairing: bool,
    }

    #[tauri::command]
    pub fn sync_server_status(state: State<AppState>) -> ServerStatus {
        let s = &state.server;
        let seen = s.last_seen.lock().unwrap().clone();
        let error = s.error.lock().unwrap().clone();
        ServerStatus {
            running: error.is_none(),
            error,
            name: s.name.clone(),
            port: HTTP_PORT,
            ips: http::local_ipv4(),
            devices: s
                .cfg
                .lock()
                .unwrap()
                .devices
                .iter()
                .map(|d| DeviceView { id: d.id.clone(), name: d.name.clone(), last_seen: seen.get(&d.id).copied() })
                .collect(),
            pairing: s.pending.lock().unwrap().is_some_and(|(_, at)| at.elapsed() < PAIR_TTL),
        }
    }

    #[derive(Serialize)]
    pub struct PairCode {
        link: String,
        svg: String,
        ips: Vec<String>,
    }

    /// Gera um QR code novo (vale 10 minutos, para um celular).
    #[tauri::command]
    pub fn sync_pair_start(state: State<AppState>) -> CmdResult<PairCode> {
        let s = &state.server;
        if let Some(e) = s.error.lock().unwrap().clone() {
            return Err(e);
        }
        let ips = http::local_ipv4();
        if ips.is_empty() {
            return Err("Este PC não está conectado a uma rede local (Wi-Fi ou cabo).".into());
        }
        let key = new_key();
        *s.pending.lock().unwrap() = Some((key, Instant::now()));
        let info = ServerInfo {
            id: s.cfg.lock().unwrap().server_id.clone(),
            name: s.name.clone(),
            addrs: ips.clone(),
            port: HTTP_PORT,
            key: key_to_b64(&key),
        };
        let link = make_link(&info);
        let svg = qrcode::QrCode::new(link.as_bytes())
            .map_err(|e| e.to_string())?
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(240, 240)
            .quiet_zone(true)
            .build();
        Ok(PairCode { link, svg, ips })
    }

    #[tauri::command]
    pub fn sync_pair_cancel(state: State<AppState>) {
        state.server.pending.lock().unwrap().take();
    }

    #[tauri::command]
    pub fn sync_remove_device(state: State<AppState>, id: String) {
        let s = &state.server;
        let mut cfg = s.cfg.lock().unwrap();
        cfg.devices.retain(|d| d.id != id);
        s.save(&cfg);
        s.last_seen.lock().unwrap().remove(&id);
    }
}

#[cfg(all(test, desktop))]
mod server_tests {
    use super::server::*;

    #[test]
    fn celulares_pareados_sobrevivem_a_reabrir_o_app() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sync-server.json");
        let json = r#"{ "server_id": "abc", "devices": [ { "id": "c1", "name": "moto g75 5G", "key": "k", "paired_at": 1 } ] }"#;
        std::fs::write(&file, json).unwrap();
        let s = ServerState::load(file.clone());
        assert_eq!(s.device_count(), 1);
        assert_eq!(s.server_id(), "abc");
        // O arquivo não é regravado ao abrir.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), json);
    }
}

#[cfg(test)]
mod tests {
    use super::local_label;

    #[test]
    fn rotulo_de_data_local() {
        // 2026-10-12 09:20 UTC = 06h20 em Brasília (UTC-3).
        let ms = 1_791_796_800_000u64;
        assert_eq!(local_label(ms, 0), "2026-10-12 09h20");
        assert_eq!(local_label(ms, -180), "2026-10-12 06h20");
        assert_eq!(local_label(0, 0), "1970-01-01 00h00");
    }
}
