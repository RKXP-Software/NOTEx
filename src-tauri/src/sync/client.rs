// Lado do celular: conexão com o PC (HTTP cifrado), descoberta na rede e dados do pareamento.

use super::engine::{Remote, SyncBase};
use super::proto::{
    DISCOVERY_PORT, KeyBytes, Request, Response, WAIT_TIMEOUT_MS, key_from_b64, open_json, seal_json,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

/// Prefixo do conteúdo do QR code de pareamento.
pub const LINK_PREFIX: &str = "notex1:";

/// PC pareado, como lido do QR code (e atualizado quando o IP muda).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub addrs: Vec<String>,
    pub port: u16,
    pub key: String,
}

#[derive(Serialize, Deserialize)]
struct LinkPayload {
    s: String,
    n: String,
    a: Vec<String>,
    p: u16,
    k: String,
}

pub fn make_link(info: &ServerInfo) -> String {
    let p = LinkPayload { s: info.id.clone(), n: info.name.clone(), a: info.addrs.clone(), p: info.port, k: info.key.clone() };
    format!("{LINK_PREFIX}{}", B64URL.encode(serde_json::to_vec(&p).unwrap_or_default()))
}

pub fn parse_link(link: &str) -> Result<ServerInfo, String> {
    let invalid = || "Código de pareamento inválido. Gere um novo no PC.".to_string();
    let data = link.trim().strip_prefix(LINK_PREFIX).ok_or_else(invalid)?;
    let p: LinkPayload = serde_json::from_slice(&B64URL.decode(data).map_err(|_| invalid())?).map_err(|_| invalid())?;
    key_from_b64(&p.k).ok_or_else(invalid)?;
    if p.s.is_empty() || p.p == 0 {
        return Err(invalid());
    }
    Ok(ServerInfo { id: p.s, name: p.n, addrs: p.a, port: p.p, key: p.k })
}

/// Configuração do celular: identidade, PC pareado e base da última sincronização.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientConfig {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub server: Option<ServerInfo>,
    #[serde(default)]
    pub base: SyncBase,
}

pub struct HttpRemote {
    pub info: ServerInfo,
    device_id: String,
    key: KeyBytes,
    pairing: bool,
    /// O endereço do PC mudou (descoberto na rede): salvar em `info`.
    pub addrs_changed: bool,
}

impl HttpRemote {
    pub fn new(info: ServerInfo, device_id: String, pairing: bool) -> Result<Self, String> {
        let key = key_from_b64(&info.key).ok_or("Chave de pareamento inválida.")?;
        Ok(Self { info, device_id, key, pairing, addrs_changed: false })
    }

    fn post(&self, addr: &str, body: &[u8], timeout: Duration) -> Result<Vec<u8>, ureq::Error> {
        let url = format!("http://{addr}:{}/notex/v1", self.info.port);
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout(timeout).build();
        let mut req = agent.post(&url).set("X-Notex-Device", &self.device_id);
        if self.pairing {
            req = req.set("X-Notex-Pair", "1");
        }
        let resp = req.send_bytes(body)?;
        let mut out = Vec::new();
        resp.into_reader().take(64 * 1024 * 1024).read_to_end(&mut out).map_err(|e| ureq::Error::from(e))?;
        Ok(out)
    }

    fn try_addrs(&mut self, body: &[u8], timeout: Duration) -> Result<Option<Vec<u8>>, String> {
        for i in 0..self.info.addrs.len() {
            let addr = self.info.addrs[i].clone();
            match self.post(&addr, body, timeout) {
                Ok(data) => {
                    if i > 0 {
                        // Endereço que funcionou vai para a frente da lista.
                        let a = self.info.addrs.remove(i);
                        self.info.addrs.insert(0, a);
                        self.addrs_changed = true;
                    }
                    return Ok(Some(data));
                }
                Err(ureq::Error::Status(401, _)) => {
                    return Err(if self.pairing {
                        "O QR code expirou ou já foi usado. Gere um novo no PC.".into()
                    } else {
                        "Este celular não está mais pareado com o PC. Pareie de novo.".into()
                    });
                }
                Err(ureq::Error::Status(code, _)) => return Err(format!("O PC respondeu com erro {code}.")),
                Err(_) => continue,
            }
        }
        Ok(None)
    }
}

impl Remote for HttpRemote {
    fn call(&mut self, req: Request) -> Result<Response, String> {
        let timeout = match req {
            Request::Wait { .. } => Duration::from_millis(WAIT_TIMEOUT_MS + 10_000),
            _ => Duration::from_secs(30),
        };
        let body = seal_json(&self.key, &self.device_id, &req);
        let data = match self.try_addrs(&body, timeout)? {
            Some(d) => d,
            None => {
                // Nenhum endereço respondeu: procura o PC na rede (o IP pode ter mudado).
                let ip = discover(&self.info.id, Duration::from_millis(1500)).ok_or(OFFLINE)?;
                self.info.addrs.retain(|a| a != &ip);
                self.info.addrs.insert(0, ip);
                self.addrs_changed = true;
                self.try_addrs(&body, timeout)?.ok_or(OFFLINE)?
            }
        };
        open_json(&self.key, &self.device_id, &data)
    }
}

pub const OFFLINE: &str = "PC não encontrado na rede. Confira se o NOTEx está aberto no PC e se os dois estão no mesmo Wi-Fi.";

/// Procura o PC com esse id por broadcast UDP. Devolve o IP de quem respondeu.
pub fn discover(server_id: &str, timeout: Duration) -> Option<String> {
    let sock = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    sock.set_broadcast(true).ok()?;
    sock.set_read_timeout(Some(Duration::from_millis(300))).ok()?;
    let msg = format!("NOTEX?{server_id}");
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; 256];
    while Instant::now() < deadline {
        let _ = sock.send_to(msg.as_bytes(), ("255.255.255.255", DISCOVERY_PORT));
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            let reply = String::from_utf8_lossy(&buf[..n]);
            if reply.strip_prefix("NOTEX!").and_then(|r| r.split(':').next()) == Some(server_id) {
                return Some(from.ip().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_de_pareamento_ida_e_volta() {
        let info = ServerInfo {
            id: "pc1".into(),
            name: "PC da sala".into(),
            addrs: vec!["192.168.0.10".into()],
            port: 47800,
            key: super::super::proto::key_to_b64(&super::super::proto::new_key()),
        };
        assert_eq!(parse_link(&make_link(&info)).unwrap(), info);
        assert!(parse_link("notex1:lixo").is_err());
        assert!(parse_link("https://exemplo.com").is_err());
    }
}
