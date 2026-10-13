// Cadernos privados: o conteúdo das notas fica cifrado no disco (e, por isso, também no Drive e
// na sincronização direta, que só carregam os bytes).
//
// - Senha mestra → chave de 256 bits com Argon2id e um sal próprio de cada caderno.
// - Cada nota vira `NXE1 + nonce(12) + ChaCha20-Poly1305(bytes do arquivo)`.
// - O arquivo `.notex-vault` na raiz do caderno guarda o sal e uma verificação da senha; a
//   presença dele é o que marca o caderno como privado (e ele sincroniza como qualquer arquivo).
// - Os nomes das notas e das pastas NÃO são cifrados; só o conteúdo.
// - As chaves ficam só na memória; trancar (ou fechar o app) esquece tudo.

use crate::notebooks::is_note_file;
use crate::sync::proto::{b64_decode, b64_encode};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key as AeadKey, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const HEADER_FILE: &str = ".notex-vault";
const MAGIC: &[u8; 4] = b"NXE1";
const CHECK_TEXT: &[u8] = b"notex-vault-ok";
const NONCE_LEN: usize = 12;

pub type Key = [u8; 32];

#[derive(Serialize, Deserialize)]
struct Header {
    v: u8,
    /// Sal do Argon2id (base64).
    salt: String,
    /// `CHECK_TEXT` cifrado com a chave (base64): confirma a senha sem guardá-la.
    check: String,
}

pub fn is_private(root: &Path) -> bool {
    root.join(HEADER_FILE).is_file()
}

pub fn is_encrypted(data: &[u8]) -> bool {
    data.len() >= MAGIC.len() + NONCE_LEN && &data[..MAGIC.len()] == MAGIC
}

fn derive(password: &str, salt: &[u8]) -> Result<Key, String> {
    // 19 MiB, 2 passagens: o mínimo recomendado pela OWASP; ~0,2 s num celular comum.
    let params = Params::new(19 * 1024, 2, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("Falha ao derivar a chave: {e}"))?;
    Ok(key)
}

pub fn encrypt(key: &Key, plain: &[u8]) -> Vec<u8> {
    let cipher = ChaCha20Poly1305::new(AeadKey::from_slice(key));
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let body = cipher.encrypt(Nonce::from_slice(&nonce), plain).expect("cifrar em memória não falha");
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + body.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    out
}

pub fn decrypt(key: &Key, data: &[u8]) -> Result<Vec<u8>, String> {
    if !is_encrypted(data) {
        return Err("O arquivo não está cifrado.".into());
    }
    let (nonce, body) = data[MAGIC.len()..].split_at(NONCE_LEN);
    ChaCha20Poly1305::new(AeadKey::from_slice(key))
        .decrypt(Nonce::from_slice(nonce), body)
        .map_err(|_| "Não foi possível decifrar a nota (senha incorreta ou arquivo danificado).".to_string())
}

fn read_header(root: &Path) -> Option<Header> {
    serde_json::from_slice(&fs::read(root.join(HEADER_FILE)).ok()?).ok()
}

/// Chave do caderno se `password` confere com o cabeçalho; None se estiver errada (ou sem cabeçalho).
pub fn open(root: &Path, password: &str) -> Option<Key> {
    let h = read_header(root)?;
    let key = derive(password, &b64_decode(&h.salt).ok()?).ok()?;
    let check = b64_decode(&h.check).ok()?;
    (decrypt(&key, &check).ok()? == CHECK_TEXT).then_some(key)
}

/// Grava o cabeçalho (sal novo) e devolve a chave. Não cifra as notas (veja `encrypt_all`).
pub fn create(root: &Path, password: &str) -> Result<Key, String> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive(password, &salt)?;
    let header = Header { v: 1, salt: b64_encode(&salt), check: b64_encode(&encrypt(&key, CHECK_TEXT)) };
    let json = serde_json::to_vec_pretty(&header).map_err(|e| e.to_string())?;
    crate::textfile::write_atomic(&root.join(HEADER_FILE), &json).map_err(|e| format!("Não foi possível gravar o cofre: {e}"))?;
    Ok(key)
}

/// Todas as notas do caderno (inclusive subpastas e a lixeira).
fn note_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let path = item.path();
        match item.file_type() {
            Ok(t) if t.is_dir() => note_files(&path, out),
            Ok(t) if t.is_file() && is_note_file(&path) => out.push(path),
            _ => {}
        }
    }
}

/// Cifra todas as notas ainda em texto. Devolve quantas foram cifradas.
pub fn encrypt_all(root: &Path, key: &Key) -> Result<usize, String> {
    let mut files = Vec::new();
    note_files(root, &mut files);
    let mut n = 0;
    for p in files {
        let data = fs::read(&p).map_err(|e| format!("Não foi possível ler {}: {e}", p.display()))?;
        if is_encrypted(&data) {
            continue;
        }
        crate::textfile::write_atomic(&p, &encrypt(key, &data)).map_err(|e| format!("Não foi possível cifrar {}: {e}", p.display()))?;
        n += 1;
    }
    Ok(n)
}

/// Volta todas as notas cifradas para texto e remove o cabeçalho.
pub fn decrypt_all(root: &Path, key: &Key) -> Result<usize, String> {
    let mut files = Vec::new();
    note_files(root, &mut files);
    // Primeiro confere que dá para decifrar tudo; só então grava (evita deixar o caderno pela metade).
    let mut plain = Vec::new();
    for p in files {
        let data = fs::read(&p).map_err(|e| format!("Não foi possível ler {}: {e}", p.display()))?;
        if is_encrypted(&data) {
            plain.push((p, decrypt(key, &data)?));
        }
    }
    for (p, bytes) in &plain {
        crate::textfile::write_atomic(p, bytes).map_err(|e| format!("Não foi possível gravar {}: {e}", p.display()))?;
    }
    let _ = fs::remove_file(root.join(HEADER_FILE));
    Ok(plain.len())
}

/// Estado em memória: senha mestra da sessão e chaves já abertas por caderno.
#[derive(Default)]
pub struct Vault {
    password: Option<String>,
    keys: HashMap<String, Key>,
}

impl Vault {
    pub fn is_unlocked(&self) -> bool {
        self.password.is_some()
    }

    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }

    pub fn lock(&mut self) {
        self.password = None;
        self.keys.clear();
    }

    /// Chave do caderno privado: do cache ou derivada da senha da sessão. None = bloqueado.
    pub fn key_for(&mut self, id: &str, root: &Path) -> Option<Key> {
        if let Some(k) = self.keys.get(id) {
            return Some(*k);
        }
        let key = open(root, self.password.as_deref()?)?;
        self.keys.insert(id.to_string(), key);
        Some(key)
    }

    pub fn remember_key(&mut self, id: &str, key: Key) {
        self.keys.insert(id.to_string(), key);
    }

    pub fn forget_key(&mut self, id: &str) {
        self.keys.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cifra_e_decifra() {
        let key = [7u8; 32];
        let enc = encrypt(&key, "olá, mundo".as_bytes());
        assert!(is_encrypted(&enc));
        assert!(!enc.windows(3).any(|w| w == "olá".as_bytes()));
        assert_eq!(decrypt(&key, &enc).unwrap(), "olá, mundo".as_bytes());
        assert!(decrypt(&[8u8; 32], &enc).is_err());
        let mut adulterado = enc.clone();
        *adulterado.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, &adulterado).is_err());
        assert!(!is_encrypted(b"texto normal"));
    }

    #[test]
    fn senha_certa_abre_e_errada_nao() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_private(dir.path()));
        let key = create(dir.path(), "segredo").unwrap();
        assert!(is_private(dir.path()));
        assert_eq!(open(dir.path(), "segredo"), Some(key));
        assert_eq!(open(dir.path(), "Segredo"), None);
        assert_eq!(open(dir.path(), ""), None);
    }

    #[test]
    fn torna_privado_e_volta_ao_normal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "# A\nsegredo").unwrap();
        fs::write(root.join("sub").join("b.txt"), "b").unwrap();
        fs::write(root.join("foto.png"), "não é nota").unwrap();
        let key = create(root, "pw").unwrap();
        assert_eq!(encrypt_all(root, &key).unwrap(), 2);
        assert_eq!(encrypt_all(root, &key).unwrap(), 0, "não cifra duas vezes");
        assert!(is_encrypted(&fs::read(root.join("a.md")).unwrap()));
        assert_eq!(fs::read(root.join("foto.png")).unwrap(), "não é nota".as_bytes());

        assert_eq!(decrypt_all(root, &key).unwrap(), 2);
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "# A\nsegredo");
        assert!(!is_private(root));
    }

    #[test]
    fn cofre_em_memoria_deriva_pela_senha_da_sessao() {
        let dir = tempfile::tempdir().unwrap();
        let key = create(dir.path(), "pw").unwrap();
        let mut v = Vault::default();
        assert_eq!(v.key_for("nb", dir.path()), None);
        v.set_password("errada".into());
        assert_eq!(v.key_for("nb", dir.path()), None);
        v.set_password("pw".into());
        assert_eq!(v.key_for("nb", dir.path()), Some(key));
        v.lock();
        assert!(!v.is_unlocked());
        assert_eq!(v.key_for("nb", dir.path()), None);
    }
}
