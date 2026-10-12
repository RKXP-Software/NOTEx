// Leitura/gravação de arquivos texto preservando o formato em disco (portado do MDR, files.ts):
// UTF-8 estrito (com ou sem BOM) ou, se não for UTF-8 válido, Windows-1252; fim de linha
// predominante (CRLF/LF). A gravação é atômica (temporário no mesmo diretório + rename).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Encoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "windows-1252")]
    Windows1252,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

/// Formato em disco de um documento, para salvar de volta como foi lido.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextFormat {
    pub encoding: Encoding,
    pub bom: bool,
    pub eol: Eol,
}

/// Documento novo: UTF-8, sem BOM, LF (a interface usa o mesmo padrão).
#[cfg(test)]
pub const DEFAULT_FORMAT: TextFormat = TextFormat { encoding: Encoding::Utf8, bom: false, eol: Eol::Lf };

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    /// Texto com quebras CRLF normalizadas para `\n` e sem BOM.
    pub text: String,
    pub format: TextFormat,
}

// windows-1252 (WHATWG) em 0x80–0x9F; as posições indefinidas (0x81, 0x8D, 0x8F, 0x90, 0x9D)
// mapeiam para o próprio code point C1, então todo byte faz round-trip. O resto é latin1 direto.
const CP1252_HIGH: [u32; 32] = [
    0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d,
    0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d,
    0x17e, 0x178,
];

const UTF8_BOM: [u8; 3] = [0xef, 0xbb, 0xbf];

fn cp1252_byte(c: char) -> Option<u8> {
    let cp = c as u32;
    if cp < 0x80 || (0xa0..=0xff).contains(&cp) {
        return Some(cp as u8);
    }
    CP1252_HIGH.iter().position(|&h| h == cp).map(|i| 0x80 + i as u8)
}

pub fn decode_windows1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if (0x80..0xa0).contains(&b) {
                char::from_u32(CP1252_HIGH[(b - 0x80) as usize]).unwrap_or('\u{fffd}')
            } else {
                b as char
            }
        })
        .collect()
}

/// Primeiro caractere que não pode ser gravado na codificação; None se todos podem.
pub fn find_unencodable(text: &str, encoding: Encoding) -> Option<char> {
    match encoding {
        Encoding::Utf8 => None,
        Encoding::Windows1252 => text.chars().find(|&c| cp1252_byte(c).is_none()),
    }
}

/// Fim de linha predominante (empate: o da primeira quebra). Sem quebras: LF.
pub fn detect_eol(text: &str) -> Eol {
    let (mut crlf, mut lf) = (0usize, 0usize);
    let mut first = None;
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            let kind = if i > 0 && bytes[i - 1] == b'\r' { Eol::Crlf } else { Eol::Lf };
            match kind {
                Eol::Crlf => crlf += 1,
                Eol::Lf => lf += 1,
            }
            first.get_or_insert(kind);
        }
    }
    if crlf != lf {
        return if crlf > lf { Eol::Crlf } else { Eol::Lf };
    }
    first.unwrap_or(Eol::Lf)
}

pub fn decode(buf: &[u8]) -> Decoded {
    let bom = buf.starts_with(&UTF8_BOM);
    let body = if bom { &buf[3..] } else { buf };
    let (raw, encoding) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_owned(), Encoding::Utf8),
        Err(_) => (decode_windows1252(buf), Encoding::Windows1252),
    };
    let eol = detect_eol(&raw);
    Decoded {
        text: raw.replace("\r\n", "\n"),
        format: TextFormat { encoding, bom: bom && encoding == Encoding::Utf8, eol },
    }
}

/// Codifica texto (com `\n`) no formato dado. Erro se houver caractere não representável.
pub fn encode(text: &str, format: &TextFormat) -> Result<Vec<u8>, String> {
    let normalized = text.replace("\r\n", "\n");
    let body = match format.eol {
        Eol::Crlf => normalized.replace('\n', "\r\n"),
        Eol::Lf => normalized,
    };
    let mut out = Vec::with_capacity(body.len() + 3);
    match format.encoding {
        Encoding::Utf8 => {
            if format.bom {
                out.extend_from_slice(&UTF8_BOM);
            }
            out.extend_from_slice(body.as_bytes());
        }
        Encoding::Windows1252 => {
            for c in body.chars() {
                let b = cp1252_byte(c)
                    .ok_or_else(|| format!("Caractere não representável em Windows-1252: {c:?}"))?;
                out.push(b);
            }
        }
    }
    Ok(out)
}

/// Temporário da escrita atômica: no mesmo diretório do destino (rename não cruza volumes).
pub fn temp_path_for(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.tmp", std::process::id()))
}

/// Escreve atomicamente: grava num temporário no mesmo diretório e renomeia por cima do destino.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = temp_path_for(path);
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        rename_with_retry(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// No Windows o rename falha transitoriamente se outro processo (antivírus, indexador) segura o destino.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0u64;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 && e.kind() == std::io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

pub fn read_file(path: &Path) -> std::io::Result<Decoded> {
    Ok(decode(&fs::read(path)?))
}

pub fn write_file(path: &Path, text: &str, format: &TextFormat) -> Result<(), String> {
    let data = encode(text, format)?;
    write_atomic(path, &data).map_err(|e| format!("Não foi possível salvar {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodifica_utf8_sem_bom_com_lf() {
        let d = decode("olá\nmundo".as_bytes());
        assert_eq!(d.text, "olá\nmundo");
        assert_eq!(d.format, DEFAULT_FORMAT);
    }

    #[test]
    fn decodifica_utf8_com_bom_e_crlf() {
        let mut buf = UTF8_BOM.to_vec();
        buf.extend_from_slice("a\r\nb\r\n".as_bytes());
        let d = decode(&buf);
        assert_eq!(d.text, "a\nb\n");
        assert_eq!(d.format, TextFormat { encoding: Encoding::Utf8, bom: true, eol: Eol::Crlf });
    }

    #[test]
    fn utf8_invalido_cai_para_windows_1252() {
        // "ação€" em windows-1252
        let d = decode(&[0x61, 0xe7, 0xe3, 0x6f, 0x80]);
        assert_eq!(d.text, "ação€");
        assert_eq!(d.format.encoding, Encoding::Windows1252);
        assert!(!d.format.bom);
    }

    #[test]
    fn todo_byte_windows_1252_faz_round_trip() {
        let bytes: Vec<u8> = (0..=255u8).filter(|&b| b != b'\r' && b != b'\n').collect();
        let text = decode_windows1252(&bytes);
        let fmt = TextFormat { encoding: Encoding::Windows1252, bom: false, eol: Eol::Lf };
        assert_eq!(encode(&text, &fmt).unwrap(), bytes);
    }

    #[test]
    fn round_trip_preserva_bom_e_crlf() {
        let mut original = UTF8_BOM.to_vec();
        original.extend_from_slice("título\r\n\r\n- item\r\n".as_bytes());
        let d = decode(&original);
        assert_eq!(encode(&d.text, &d.format).unwrap(), original);
    }

    #[test]
    fn encode_recusa_caractere_fora_do_windows_1252() {
        let fmt = TextFormat { encoding: Encoding::Windows1252, bom: false, eol: Eol::Lf };
        assert!(encode("emoji 😀", &fmt).is_err());
        assert_eq!(find_unencodable("emoji 😀", Encoding::Windows1252), Some('😀'));
        assert_eq!(find_unencodable("emoji 😀", Encoding::Utf8), None);
    }

    #[test]
    fn eol_predominante_e_empate() {
        assert_eq!(detect_eol("a\r\nb\r\nc\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\nb\nc\r\n"), Eol::Lf);
        assert_eq!(detect_eol("a\r\nb\n"), Eol::Crlf);
        assert_eq!(detect_eol("sem quebra"), Eol::Lf);
    }

    #[test]
    fn escrita_atomica_substitui_e_nao_deixa_temporario() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nota.md");
        fs::write(&path, "antigo").unwrap();
        write_file(&path, "novo\ntexto", &TextFormat { eol: Eol::Crlf, ..DEFAULT_FORMAT }).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"novo\r\ntexto");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
