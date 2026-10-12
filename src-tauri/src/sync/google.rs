// Google: login OAuth (no PC, pelo navegador) e a API do Drive sobre HTTPS.
//
// Login: fluxo de "app instalado" com redirecionamento para 127.0.0.1 e PKCE. O NOTEx abre o
// navegador padrão, recebe o código numa porta local e troca por um refresh token. O ID e a
// chave do cliente OAuth vêm de src-tauri/google.secret.json no momento do build (fora do git).

use super::drive::{DriveApi, DriveFile, FOLDER_MIME, NewFile};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";

/// Erro quando o acesso foi revogado (ou o login expirou): é preciso conectar de novo.
pub const REVOKED: &str = "O acesso ao Google Drive foi revogado ou expirou. Conecte de novo no PC.";

#[derive(Clone)]
pub struct OAuthClient {
    pub id: String,
    pub secret: String,
}

/// Credenciais do cliente OAuth embutidas no build (None se o build não foi configurado).
pub fn client() -> Option<OAuthClient> {
    let id = option_env!("NOTEX_GOOGLE_CLIENT_ID")?.trim();
    let secret = option_env!("NOTEX_GOOGLE_CLIENT_SECRET")?.trim();
    (!id.is_empty() && !secret.is_empty()).then(|| OAuthClient { id: id.into(), secret: secret.into() })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(60)).build()
}

/// Codifica para URL (RFC 3986, caracteres não reservados ficam).
pub fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match (b[i], hex) {
            (_, Some(v)) => {
                out.push(v);
                i += 2;
            }
            (b'+', None) => out.push(b' '),
            (c, None) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    B64URL.encode(b)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let resp = match agent().post(TOKEN_URL).send_form(form) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("Sem conexão com o Google: {e}")),
    };
    let t: TokenResponse = resp.into_json().map_err(|e| format!("Resposta inválida do Google: {e}"))?;
    if let Some(err) = &t.error {
        if err == "invalid_grant" {
            return Err(REVOKED.into());
        }
        return Err(format!("Google recusou o login: {}", t.error_description.as_deref().unwrap_or(err)));
    }
    Ok(t)
}

/// Login pelo navegador. `open` abre a URL no navegador padrão. Devolve o refresh token.
pub fn authorize(client: &OAuthClient, open: impl Fn(&str) -> Result<(), String>) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Não foi possível abrir a porta local: {e}"))?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    let verifier = random_token(48);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(16);
    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&access_type=offline&prompt=consent",
        enc(&client.id),
        enc(&redirect),
        enc(SCOPE)
    );
    open(&url)?;

    // Espera o navegador voltar (até 5 minutos).
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let (code, returned_state) = loop {
        if Instant::now() > deadline {
            return Err("O login não foi concluído a tempo. Tente de novo.".into());
        }
        let mut stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        let _ = BufReader::new(&mut stream).read_line(&mut line);
        let query = line.split_whitespace().nth(1).and_then(|p| p.split_once('?')).map(|(_, q)| q.to_string());
        let Some(query) = query else {
            // Requisições do navegador sem parâmetros (ex.: favicon).
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        };
        let params: BTreeMap<String, String> =
            query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (dec(k), dec(v))).collect();
        let ok = params.contains_key("code");
        let page = if ok {
            "<h2>NOTEx conectado ao Google Drive.</h2><p>Pode fechar esta aba e voltar ao NOTEx.</p>"
        } else {
            "<h2>Login cancelado.</h2><p>Pode fechar esta aba.</p>"
        };
        let body = format!("<!doctype html><meta charset=utf-8><title>NOTEx</title><body style=\"font-family:sans-serif;padding:40px\">{page}</body>");
        let _ = stream.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                .as_bytes(),
        );
        if !ok {
            return Err("Login cancelado no navegador.".into());
        }
        break (params["code"].clone(), params.get("state").cloned().unwrap_or_default());
    };
    if returned_state != state {
        return Err("Resposta de login inválida (state). Tente de novo.".into());
    }
    let t = token_request(&[
        ("code", &code),
        ("client_id", &client.id),
        ("client_secret", &client.secret),
        ("redirect_uri", &redirect),
        ("grant_type", "authorization_code"),
        ("code_verifier", &verifier),
    ])?;
    t.refresh_token.ok_or_else(|| "O Google não devolveu acesso permanente. Tente de novo.".into())
}

/// Desfaz o acesso no Google (o refresh token deixa de funcionar em todos os aparelhos).
pub fn revoke(token: &str) {
    let _ = agent().post(REVOKE_URL).send_form(&[("token", token)]);
}

pub struct GoogleDrive {
    client: OAuthClient,
    refresh: String,
    access: Option<(String, Instant)>,
    agent: ureq::Agent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
    next_page_token: Option<String>,
}

const FIELDS: &str = "id,name,mimeType,parents,appProperties";

impl GoogleDrive {
    pub fn new(client: OAuthClient, refresh: String) -> Self {
        Self { client, refresh, access: None, agent: agent() }
    }

    fn token(&mut self) -> Result<String, String> {
        if let Some((t, until)) = &self.access {
            if Instant::now() < *until {
                return Ok(t.clone());
            }
        }
        let t = token_request(&[
            ("client_id", &self.client.id),
            ("client_secret", &self.client.secret),
            ("refresh_token", &self.refresh),
            ("grant_type", "refresh_token"),
        ])?;
        let access = t.access_token.ok_or("O Google não devolveu um token de acesso.")?;
        let ttl = t.expires_in.unwrap_or(3600).saturating_sub(120);
        self.access = Some((access.clone(), Instant::now() + Duration::from_secs(ttl)));
        Ok(access)
    }

    /// Executa a chamada; se o token expirou (401), renova e tenta de novo uma vez.
    fn call(&mut self, f: impl Fn(&ureq::Agent, &str) -> Result<ureq::Response, ureq::Error>) -> Result<ureq::Response, String> {
        for attempt in 0..2 {
            let bearer = format!("Bearer {}", self.token()?);
            match f(&self.agent, &bearer) {
                Ok(r) => return Ok(r),
                Err(ureq::Error::Status(401, _)) if attempt == 0 => self.access = None,
                Err(ureq::Error::Status(code, r)) => {
                    let detail = r.into_string().unwrap_or_default();
                    let msg = serde_json::from_str::<serde_json::Value>(&detail)
                        .ok()
                        .and_then(|v| v["error"]["message"].as_str().map(String::from))
                        .unwrap_or(detail);
                    return Err(format!("Google Drive respondeu {code}: {msg}"));
                }
                Err(e) => return Err(format!("Sem conexão com o Google Drive: {e}")),
            }
        }
        Err(REVOKED.into())
    }

    pub fn user_email(&mut self) -> Result<String, String> {
        let r = self.call(|a, auth| a.get(&format!("{API}/about?fields=user(emailAddress)")).set("Authorization", auth).call())?;
        let v: serde_json::Value = r.into_json().map_err(|e| e.to_string())?;
        Ok(v["user"]["emailAddress"].as_str().unwrap_or_default().to_string())
    }

    fn multipart(meta: &serde_json::Value, data: &[u8]) -> (String, Vec<u8>) {
        let boundary = format!("notex{}", random_token(12).replace(['-', '_'], "x"));
        let mut body = Vec::with_capacity(data.len() + 512);
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n").as_bytes());
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (format!("multipart/related; boundary={boundary}"), body)
    }
}

impl DriveApi for GoogleDrive {
    fn find(&mut self, key: &str, value: &str) -> Result<Vec<DriveFile>, String> {
        let q = format!("appProperties has {{ key='{key}' and value='{value}' }} and trashed=false");
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = format!("{API}/files?q={}&fields={}&pageSize=1000&spaces=drive", enc(&q), enc(&format!("nextPageToken,files({FIELDS})")));
            if let Some(p) = &page {
                url.push_str(&format!("&pageToken={}", enc(p)));
            }
            let r = self.call(|a, auth| a.get(&url).set("Authorization", auth).call())?;
            let list: FileList = r.into_json().map_err(|e| e.to_string())?;
            out.extend(list.files);
            match list.next_page_token {
                Some(p) => page = Some(p),
                None => return Ok(out),
            }
        }
    }

    fn download(&mut self, id: &str) -> Result<Vec<u8>, String> {
        let url = format!("{API}/files/{}?alt=media", enc(id));
        let r = self.call(|a, auth| a.get(&url).set("Authorization", auth).call())?;
        let mut data = Vec::new();
        r.into_reader().take(64 * 1024 * 1024).read_to_end(&mut data).map_err(|e| e.to_string())?;
        Ok(data)
    }

    fn create(&mut self, file: NewFile<'_>, data: Option<&[u8]>) -> Result<DriveFile, String> {
        let mut meta = serde_json::json!({ "name": file.name, "appProperties": file.props });
        if let Some(p) = file.parent {
            meta["parents"] = serde_json::json!([p]);
        }
        if file.folder {
            meta["mimeType"] = serde_json::json!(FOLDER_MIME);
            let url = format!("{API}/files?fields={}", enc(FIELDS));
            let r = self.call(|a, auth| a.post(&url).set("Authorization", auth).send_json(meta.clone()))?;
            return r.into_json().map_err(|e| e.to_string());
        }
        let (ctype, body) = Self::multipart(&meta, data.unwrap_or_default());
        let url = format!("{UPLOAD}/files?uploadType=multipart&fields={}", enc(FIELDS));
        let r = self.call(|a, auth| a.post(&url).set("Authorization", auth).set("Content-Type", &ctype).send_bytes(&body))?;
        r.into_json().map_err(|e| e.to_string())
    }

    fn update(&mut self, id: &str, props: BTreeMap<String, String>, data: &[u8]) -> Result<(), String> {
        let meta = serde_json::json!({ "appProperties": props });
        let (ctype, body) = Self::multipart(&meta, data);
        let url = format!("{UPLOAD}/files/{}?uploadType=multipart&fields=id", enc(id));
        self.call(|a, auth| a.request("PATCH", &url).set("Authorization", auth).set("Content-Type", &ctype).send_bytes(&body))?;
        Ok(())
    }

    fn trash(&mut self, id: &str) -> Result<(), String> {
        let url = format!("{API}/files/{}?fields=id", enc(id));
        self.call(|a, auth| a.request("PATCH", &url).set("Authorization", auth).send_json(serde_json::json!({ "trashed": true })))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codificacao_de_url() {
        assert_eq!(enc("a b/ç?=&"), "a%20b%2F%C3%A7%3F%3D%26");
        assert_eq!(dec("a%20b%2F%C3%A7+x"), "a b/ç x");
        assert_eq!(dec("4%2F0A%"), "4/0A%");
    }
}
