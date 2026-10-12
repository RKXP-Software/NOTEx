// Protocolo de sincronização PC ↔ celular: mensagens, criptografia e validação de caminhos.
//
// Cada requisição é um envelope JSON cifrado com ChaCha20-Poly1305 usando a chave do pareamento
// (32 bytes, entregue pelo QR code e nunca transmitida). Quem está na mesma rede não lê nem altera
// as notas. O carimbo de tempo no envelope limita a reutilização de mensagens capturadas.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HTTP_PORT: u16 = 47800;
pub const DISCOVERY_PORT: u16 = 47801;
/// Diferença máxima de relógio aceita entre os aparelhos (ms).
pub const MAX_CLOCK_SKEW_MS: u64 = 10 * 60 * 1000;
/// Tempo máximo de espera de uma requisição Wait (o celular "escutando" mudanças do PC).
pub const WAIT_TIMEOUT_MS: u64 = 25_000;

pub type KeyBytes = [u8; 32];

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn new_key() -> KeyBytes {
    let mut k = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut k);
    k
}

pub fn new_id() -> String {
    let mut b = [0u8; 9];
    rand::thread_rng().fill_bytes(&mut b);
    B64URL.encode(b)
}

pub fn key_to_b64(k: &KeyBytes) -> String {
    B64URL.encode(k)
}

pub fn key_from_b64(s: &str) -> Option<KeyBytes> {
    B64URL.decode(s).ok()?.try_into().ok()
}

/// Cifra `plain`; `context` (id do aparelho) entra como dado associado. Saída: nonce || cifrado.
pub fn seal(key: &KeyBytes, context: &str, plain: &[u8]) -> Vec<u8> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: context.as_bytes() })
        .expect("cifragem não falha com chave de 32 bytes");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    out
}

/// Decifra (e autentica) o que `seal` produziu. None se a chave ou o contexto não conferem.
pub fn open(key: &KeyBytes, context: &str, data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 12 + 16 {
        return None;
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher.decrypt(Nonce::from_slice(&data[..12]), Payload { msg: &data[12..], aad: context.as_bytes() }).ok()
}

pub fn hash_bytes(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn b64_encode(data: &[u8]) -> String {
    B64.encode(data)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s).map_err(|_| "Conteúdo inválido.".to_string())
}

// ---- Mensagens ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotebookInfo {
    pub id: String,
    pub name: String,
}

/// Estado de um caderno: arquivo (caminho relativo com "/") → hash, e pastas.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub files: BTreeMap<String, String>,
    pub dirs: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// Primeiro contato (cifrado com a chave do QR): registra o celular.
    Pair { device_id: String, device_name: String },
    Notebooks,
    CreateNotebook { id: String, name: String },
    Manifest { notebook: String },
    Get { notebook: String, path: String },
    /// `expected`: hash que o cliente acha que o PC tem (None = o arquivo não deve existir).
    Put { notebook: String, path: String, data: String, expected: Option<String> },
    /// Apaga (move para a lixeira do caderno) se o hash atual for `expected`.
    Delete { notebook: String, path: String, expected: String },
    Mkdir { notebook: String, path: String },
    /// Remove a pasta se estiver vazia.
    Rmdir { notebook: String, path: String },
    /// Espera até haver mudança no PC depois de `since` (ou o tempo esgotar).
    Wait { since: u64 },
    /// O celular pede o acesso ao Google Drive conectado no PC (para sincronizar só pelo Drive).
    DriveCredentials,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok,
    Paired { server_id: String, server_name: String },
    Notebooks { list: Vec<NotebookInfo> },
    Manifest { manifest: Manifest },
    File { data: String },
    /// O arquivo mudou no PC desde o manifesto: o cliente refaz a sincronização.
    Conflict { current: Option<String> },
    Changes { counter: u64 },
    /// None se o PC não tem Google Drive conectado.
    DriveCredentials { refresh_token: Option<String>, email: Option<String> },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub ts: u64,
    pub body: T,
}

pub fn seal_json<T: Serialize>(key: &KeyBytes, context: &str, body: &T) -> Vec<u8> {
    let env = serde_json::json!({ "ts": now_ms(), "body": body });
    seal(key, context, env.to_string().as_bytes())
}

/// Decifra e valida o carimbo de tempo.
pub fn open_json<T: for<'de> Deserialize<'de>>(key: &KeyBytes, context: &str, data: &[u8]) -> Result<T, String> {
    let plain = open(key, context, data).ok_or("Chave de sincronização inválida.")?;
    let env: Envelope<T> = serde_json::from_slice(&plain).map_err(|e| format!("Mensagem inválida: {e}"))?;
    if now_ms().abs_diff(env.ts) > MAX_CLOCK_SKEW_MS {
        return Err("Relógio do celular e do PC muito diferentes (ajuste a hora automática).".into());
    }
    Ok(env.body)
}

// ---- Caminhos ----

/// Caminho relativo seguro dentro de um caderno: "/" como separador, sem "..", sem partes
/// vazias ou ocultas (exceto o arquivo de ícones `.notex.json` na raiz), sem ":" nem "\".
pub fn valid_rel_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 1024 || path.contains('\\') || path.contains(':') || path.contains('\0') {
        return false;
    }
    if path == crate::meta::META_FILE {
        return true;
    }
    path.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.starts_with('.'))
}

/// Arquivos que entram na sincronização: notas (.md/.txt/.markdown) e o `.notex.json` da raiz.
pub fn is_synced_file(rel: &str) -> bool {
    rel == crate::meta::META_FILE
        || std::path::Path::new(rel).extension().and_then(|e| e.to_str()).is_some_and(|e| {
            crate::notebooks::NOTE_EXTENSIONS.contains(&e.to_lowercase().as_str())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cifra_e_decifra_com_contexto() {
        let k = new_key();
        let sealed = seal(&k, "celular-1", b"ola");
        assert_eq!(open(&k, "celular-1", &sealed).as_deref(), Some(&b"ola"[..]));
        assert!(open(&k, "celular-2", &sealed).is_none(), "contexto diferente");
        assert!(open(&new_key(), "celular-1", &sealed).is_none(), "chave diferente");
        let mut adulterado = sealed.clone();
        *adulterado.last_mut().unwrap() ^= 1;
        assert!(open(&k, "celular-1", &adulterado).is_none(), "conteúdo alterado");
    }

    #[test]
    fn envelope_json_ida_e_volta() {
        let k = new_key();
        let req = Request::Get { notebook: "rapidas".into(), path: "a/b.md".into() };
        let sealed = seal_json(&k, "x", &req);
        assert_eq!(open_json::<Request>(&k, "x", &sealed).unwrap(), req);
    }

    #[test]
    fn caminhos_relativos() {
        for ok in ["a.md", "pasta/sub/nota.txt", ".notex.json", "Ação 1/ç.md"] {
            assert!(valid_rel_path(ok), "{ok}");
        }
        for bad in ["", "../x.md", "a/../b.md", "/abs.md", "a//b.md", "C:/x.md", "a\\b.md", ".lixeira/x.md", "p/.notex.json"] {
            assert!(!valid_rel_path(bad), "{bad}");
        }
        assert!(is_synced_file("a/b.MD") && is_synced_file(".notex.json") && !is_synced_file("foto.png"));
    }

    #[test]
    fn chave_em_texto() {
        let k = new_key();
        assert_eq!(key_from_b64(&key_to_b64(&k)), Some(k));
        assert_eq!(key_from_b64("curta"), None);
    }
}
