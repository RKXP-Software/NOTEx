// Servidor de sincronização do PC (só desktop): HTTP na porta 47800 e descoberta por UDP na 47801.
//
// Toda requisição vem cifrada com a chave de um celular pareado (cabeçalho X-Notex-Device) ou,
// no pareamento, com a chave temporária mostrada no QR code (cabeçalho X-Notex-Pair).

use super::Host;
use super::proto::{
    DISCOVERY_PORT, HTTP_PORT, KeyBytes, Request, Response, WAIT_TIMEOUT_MS, open_json, seal_json,
};
use std::io::Read;
use std::net::UdpSocket;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Contador de mudanças no PC; o celular espera nele (Wait) para saber quando sincronizar.
#[derive(Default)]
pub struct Changes {
    counter: Mutex<u64>,
    cv: Condvar,
}

impl Changes {
    pub fn bump(&self) {
        if let Ok(mut c) = self.counter.lock() {
            *c += 1;
            self.cv.notify_all();
        }
    }


    /// Espera o contador passar de `since` ou o tempo esgotar; devolve o valor atual.
    pub fn wait(&self, since: u64, timeout: Duration) -> u64 {
        let Ok(guard) = self.counter.lock() else { return since };
        // Cliente que ainda não conhece o contador (since além do atual): responde na hora.
        if since > *guard {
            return *guard;
        }
        match self.cv.wait_timeout_while(guard, timeout, |c| *c <= since) {
            Ok((c, _)) => *c,
            Err(_) => since,
        }
    }
}

pub trait ServerCtx: Host + Send + Sync + 'static {
    fn server_id(&self) -> String;
    fn server_name(&self) -> String;
    fn device_key(&self, device_id: &str) -> Option<KeyBytes>;
    /// Chave do pareamento em andamento (QR na tela), se ainda válida.
    fn pending_key(&self) -> Option<KeyBytes>;
    fn complete_pair(&self, device_id: &str, device_name: &str, key: KeyBytes) -> Result<(), String>;
    fn touch_device(&self, device_id: &str);
    fn changes(&self) -> Arc<Changes>;
    /// Refresh token e e-mail do Google Drive conectado no PC, se houver.
    fn drive_credentials(&self) -> (Option<String>, Option<String>);
}

/// Liga o servidor HTTP e a descoberta UDP em segundo plano.
pub fn start(ctx: Arc<dyn ServerCtx>) -> Result<(), String> {
    start_on(ctx, "0.0.0.0", HTTP_PORT, DISCOVERY_PORT).map(|_| ())
}

/// Como `start`, em endereço/portas escolhidos (0 = porta livre). Devolve a porta HTTP usada.
pub fn start_on(ctx: Arc<dyn ServerCtx>, host: &str, http_port: u16, udp_port: u16) -> Result<u16, String> {
    let server = tiny_http::Server::http((host, http_port))
        .map_err(|e| format!("Não foi possível abrir a porta {http_port}: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(http_port);
    let http_ctx = ctx.clone();
    std::thread::Builder::new()
        .name("notex-sync-http".into())
        .spawn(move || {
            for req in server.incoming_requests() {
                let ctx = http_ctx.clone();
                // Uma thread por requisição: Wait fica bloqueado até 25 s.
                let _ = std::thread::Builder::new().name("notex-sync-req".into()).spawn(move || serve(ctx.as_ref(), req));
            }
        })
        .map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("notex-sync-udp".into())
        .spawn(move || discovery_responder(ctx, udp_port, port))
        .map_err(|e| e.to_string())?;
    Ok(port)
}

const MAX_BODY: u64 = 64 * 1024 * 1024;

fn header(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn serve(ctx: &dyn ServerCtx, mut req: tiny_http::Request) {
    let respond = |req: tiny_http::Request, code: u16, body: Vec<u8>| {
        let _ = req.respond(tiny_http::Response::from_data(body).with_status_code(code));
    };
    if req.method() != &tiny_http::Method::Post || req.url() != "/notex/v1" {
        return respond(req, 404, b"NOTEx".to_vec());
    }
    let Some(device) = header(&req, "X-Notex-Device").filter(|d| !d.is_empty() && d.len() <= 64) else {
        return respond(req, 400, vec![]);
    };
    let pairing = header(&req, "X-Notex-Pair").is_some();
    let key = if pairing { ctx.pending_key() } else { ctx.device_key(&device) };
    let Some(key) = key else {
        // Aparelho desconhecido ou QR expirado: não revela nada além disso.
        return respond(req, 401, vec![]);
    };
    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY).read_to_end(&mut body).is_err() {
        return respond(req, 400, vec![]);
    }
    let request: Request = match open_json(&key, &device, &body) {
        Ok(r) => r,
        Err(_) => return respond(req, 401, vec![]),
    };
    let response = match request {
        Request::Pair { device_id, device_name } if pairing && device_id == device => {
            match ctx.complete_pair(&device_id, &device_name, key) {
                Ok(()) => Response::Paired { server_id: ctx.server_id(), server_name: ctx.server_name() },
                Err(message) => Response::Error { message },
            }
        }
        _ if pairing => Response::Error { message: "Pareamento inválido.".into() },
        Request::DriveCredentials => {
            ctx.touch_device(&device);
            let (refresh_token, email) = ctx.drive_credentials();
            Response::DriveCredentials { refresh_token, email }
        }
        Request::Wait { since } => {
            ctx.touch_device(&device);
            Response::Changes { counter: ctx.changes().wait(since, Duration::from_millis(WAIT_TIMEOUT_MS)) }
        }
        other => {
            ctx.touch_device(&device);
            super::handle(ctx, other)
        }
    };
    respond(req, 200, seal_json(&key, &device, &response));
}

/// Responde "NOTEX?<id do PC>" com "NOTEX!<id>:<porta>", para o celular achar o PC mesmo se o IP mudou.
fn discovery_responder(ctx: Arc<dyn ServerCtx>, udp_port: u16, http_port: u16) {
    let Ok(sock) = UdpSocket::bind(("0.0.0.0", udp_port)) else { return };
    let mut buf = [0u8; 256];
    loop {
        let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
        let msg = String::from_utf8_lossy(&buf[..n]);
        if let Some(id) = msg.strip_prefix("NOTEX?") {
            let me = ctx.server_id();
            if id.trim() == me {
                let _ = sock.send_to(format!("NOTEX!{me}:{http_port}").as_bytes(), from);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::client::{HttpRemote, ServerInfo};
    use crate::sync::engine::{Options, Remote, SyncBase, sync_all};
    use crate::sync::proto::{NotebookInfo, key_to_b64, new_key};
    use std::path::PathBuf;

    /// PC de teste: um caderno "rapidas" numa pasta temporária, pareamento em memória.
    struct FakePc {
        dir: tempfile::TempDir,
        pending: Mutex<Option<KeyBytes>>,
        devices: Mutex<Vec<(String, KeyBytes)>>,
        changes: Arc<Changes>,
    }

    impl Host for FakePc {
        fn notebooks(&self) -> Vec<(NotebookInfo, PathBuf)> {
            vec![(NotebookInfo { id: "rapidas".into(), name: "Rápidas".into() }, self.dir.path().to_path_buf())]
        }
        fn create_notebook(&self, _: &str, _: &str) -> Result<PathBuf, String> {
            Err("não usado".into())
        }
        fn forget_notebook(&self, _: &str) {}
        fn changed(&self, _: Vec<PathBuf>, _: Vec<PathBuf>) {
            self.changes.bump();
        }
    }

    impl ServerCtx for FakePc {
        fn server_id(&self) -> String {
            "pc-teste".into()
        }
        fn server_name(&self) -> String {
            "PC de teste".into()
        }
        fn device_key(&self, id: &str) -> Option<KeyBytes> {
            self.devices.lock().unwrap().iter().find(|(d, _)| d == id).map(|(_, k)| *k)
        }
        fn pending_key(&self) -> Option<KeyBytes> {
            *self.pending.lock().unwrap()
        }
        fn complete_pair(&self, id: &str, _: &str, key: KeyBytes) -> Result<(), String> {
            self.pending.lock().unwrap().take();
            self.devices.lock().unwrap().push((id.into(), key));
            Ok(())
        }
        fn touch_device(&self, _: &str) {}
        fn changes(&self) -> Arc<Changes> {
            self.changes.clone()
        }
        fn drive_credentials(&self) -> (Option<String>, Option<String>) {
            (None, None)
        }
    }

    /// Celular de teste: o mesmo caderno, noutra pasta.
    struct FakePhone(tempfile::TempDir);
    impl Host for FakePhone {
        fn notebooks(&self) -> Vec<(NotebookInfo, PathBuf)> {
            vec![(NotebookInfo { id: "rapidas".into(), name: "Rápidas".into() }, self.0.path().to_path_buf())]
        }
        fn create_notebook(&self, _: &str, _: &str) -> Result<PathBuf, String> {
            Ok(self.0.path().to_path_buf())
        }
        fn forget_notebook(&self, _: &str) {}
        fn changed(&self, _: Vec<PathBuf>, _: Vec<PathBuf>) {}
    }

    #[test]
    fn pareamento_e_sincronizacao_pela_rede() {
        let key = new_key();
        let pc = Arc::new(FakePc {
            dir: tempfile::tempdir().unwrap(),
            pending: Mutex::new(Some(key)),
            devices: Mutex::new(vec![]),
            changes: Default::default(),
        });
        std::fs::write(pc.dir.path().join("do-pc.md"), "olá do PC").unwrap();
        let port = start_on(pc.clone(), "127.0.0.1", 0, 0).unwrap();
        let info = ServerInfo {
            id: "pc-teste".into(),
            name: "PC de teste".into(),
            addrs: vec!["127.0.0.1".into()],
            port,
            key: key_to_b64(&key),
        };

        // Sem pareamento, o PC recusa.
        let mut intruso = HttpRemote::new(info.clone(), "intruso".into(), false).unwrap();
        assert!(intruso.call(Request::Notebooks).unwrap_err().contains("não está mais pareado"));

        // Pareia com a chave do QR; o QR não serve uma segunda vez.
        let mut pairing = HttpRemote::new(info.clone(), "cel-1".into(), true).unwrap();
        let r = pairing.call(Request::Pair { device_id: "cel-1".into(), device_name: "moto".into() }).unwrap();
        assert!(matches!(r, Response::Paired { .. }));
        let mut de_novo = HttpRemote::new(info.clone(), "cel-2".into(), true).unwrap();
        assert!(de_novo.call(Request::Pair { device_id: "cel-2".into(), device_name: "x".into() }).is_err());

        // Sincroniza nos dois sentidos pela rede.
        let phone = FakePhone(tempfile::tempdir().unwrap());
        std::fs::write(phone.0.path().join("do-celular.md"), "olá do celular").unwrap();
        let mut remote = HttpRemote::new(info.clone(), "cel-1".into(), false).unwrap();
        let mut base = SyncBase::default();
        let out = sync_all(&phone, &mut remote, &mut base, &Options { conflict_label: "t".into() }).unwrap();
        assert_eq!((out.downloads, out.uploads), (1, 1));
        assert_eq!(std::fs::read_to_string(phone.0.path().join("do-pc.md")).unwrap(), "olá do PC");
        assert_eq!(std::fs::read_to_string(pc.dir.path().join("do-celular.md")).unwrap(), "olá do celular");

        // Wait: responde na hora para quem não conhece o contador e acorda quando algo muda.
        let Response::Changes { counter } = remote.call(Request::Wait { since: u64::MAX }).unwrap() else { panic!() };
        let waker = pc.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            waker.changes.bump();
        });
        let t = std::time::Instant::now();
        let Response::Changes { counter: depois } = remote.call(Request::Wait { since: counter }).unwrap() else { panic!() };
        assert!(depois > counter && t.elapsed() < Duration::from_secs(5));
    }
}

/// Faixa 100.64.0.0/10, usada por redes privadas sobre a internet (NordVPN Meshnet, Tailscale).
fn is_mesh(ip: &std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0b1100_0000) == 64
}

/// Endereços IPv4 deste PC que o celular pode alcançar (para o QR code): rede local primeiro
/// (192.168.x.x, depois 10.x e 172.16-31.x) e, por último, redes mesh — com elas o celular
/// sincroniza mesmo fora do Wi-Fi, pelos dados móveis.
pub fn local_ipv4() -> Vec<String> {
    let mut ips: Vec<(u8, String)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v4) if v4.is_private() => {
                Some((if v4.octets()[..2] == [192, 168] { 0 } else { 1 }, v4.to_string()))
            }
            std::net::IpAddr::V4(v4) if is_mesh(&v4) => Some((2, v4.to_string())),
            _ => None,
        })
        .collect();
    ips.sort();
    ips.dedup();
    ips.into_iter().map(|(_, ip)| ip).collect()
}
