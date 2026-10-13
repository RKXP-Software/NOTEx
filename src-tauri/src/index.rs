// Busca em todos os cadernos e glossário (termos definidos nas notas).
//
// Mantém em memória o texto das notas (linhas originais e linhas "dobradas": sem acento e em
// minúsculas). A cada consulta só relê os arquivos cuja data/tamanho mudou, então não precisa de
// aviso de alteração: a sincronização, o editor e outros programas são tratados do mesmo jeito.

use crate::notebooks::{is_note_file, TRASH_DIR};
use crate::textfile;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HITS: usize = 300;
const MAX_HITS_PER_FILE: usize = 8;
const MAX_TERM_CHARS: usize = 80;
/// Consultas seguidas (digitando) reaproveitam a lista de arquivos por este tempo.
const LISTING_TTL: Duration = Duration::from_millis(1500);

pub struct NotebookRef {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    /// Caderno privado: só entra no índice com a chave (as notas são decifradas na memória).
    pub private: bool,
    pub key: Option<crate::vault::Key>,
}

struct Entry {
    stamp: (SystemTime, u64),
    lines: Vec<String>,
    folded: Vec<String>,
}

#[derive(Default)]
pub struct Index {
    files: HashMap<PathBuf, Entry>,
    /// Última varredura: quando, de quais cadernos e o resultado.
    listing: Option<(Instant, Vec<PathBuf>, Vec<(usize, PathBuf)>)>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub notebook_id: String,
    pub notebook_name: String,
    pub path: String,
    /// Caminho dentro do caderno, com "/".
    pub rel: String,
    /// Linha (1 = primeira); 0 = o nome da nota.
    pub line: usize,
    /// Quantas linhas com o termo vieram antes desta na mesma nota (para achar o trecho no editor visual).
    pub occurrence: usize,
    pub before: String,
    pub hit: String,
    pub after: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    pub term: String,
    pub definition: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub path: String,
    pub line: usize,
}

/// Minúsculas e sem acentos (á→a, ç→c), para comparar sem se importar com isso.
pub fn fold(s: &str) -> String {
    fold_map(s).0.into_iter().collect()
}

/// Como `fold`, mas também devolve, para cada caractere dobrado, o índice do caractere original.
fn fold_map(s: &str) -> (Vec<char>, Vec<usize>) {
    let (mut out, mut map) = (Vec::new(), Vec::new());
    for (i, c) in s.chars().enumerate() {
        for d in std::iter::once(c).nfd().filter(|d| !is_combining_mark(*d)) {
            for l in d.to_lowercase() {
                out.push(l);
                map.push(i);
            }
        }
    }
    (out, map)
}

fn find_chars(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Lê e decodifica a nota (decifrando-a, se o caderno for privado).
fn read_text(nb: &NotebookRef, path: &Path) -> Option<textfile::Decoded> {
    let bytes = fs::read(path).ok()?;
    let bytes = match (nb.key, crate::vault::is_encrypted(&bytes)) {
        (Some(key), true) => crate::vault::decrypt(&key, &bytes).ok()?,
        (None, true) => return None,
        _ => bytes,
    };
    Some(textfile::decode(&bytes))
}

fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// No Windows o `DirEntry` já traz data e tamanho, sem outra chamada ao disco por arquivo.
fn collect_notes(dir: &Path, out: &mut Vec<(PathBuf, fs::Metadata)>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut items: Vec<_> = read.flatten().collect();
    items.sort_by_key(|i| i.file_name());
    for item in items {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == TRASH_DIR {
            continue;
        }
        let path = item.path();
        let Ok(meta) = item.metadata() else { continue };
        if meta.is_dir() {
            collect_notes(&path, out);
        } else if meta.is_file() && is_note_file(&path) {
            out.push((path, meta));
        }
    }
}

impl Index {
    /// Esquece tudo (ao trancar os cadernos privados, para não deixar texto decifrado na memória).
    pub fn clear(&mut self) {
        self.files.clear();
        self.listing = None;
    }

    /// Esquece a última varredura (algo foi salvo ou sincronizado): a próxima busca relê a lista.
    pub fn invalidate(&mut self) {
        self.listing = None;
    }

    /// Lista as notas dos cadernos e atualiza o que mudou. Devolve (caderno, arquivo) em ordem.
    fn refresh(&mut self, nbs: &[NotebookRef]) -> Vec<(usize, PathBuf)> {
        let roots: Vec<PathBuf> = nbs.iter().map(|n| n.path.clone()).collect();
        if let Some((at, r, listed)) = &self.listing {
            if *r == roots && at.elapsed() < LISTING_TTL {
                return listed.clone();
            }
        }
        let listed = self.scan(nbs);
        self.listing = Some((Instant::now(), roots, listed.clone()));
        listed
    }

    fn scan(&mut self, nbs: &[NotebookRef]) -> Vec<(usize, PathBuf)> {
        let mut listed = Vec::new();
        let mut seen = HashSet::new();
        for (i, nb) in nbs.iter().enumerate() {
            if nb.private && nb.key.is_none() {
                continue;
            }
            let mut paths = Vec::new();
            collect_notes(&nb.path, &mut paths);
            for (p, meta) in paths {
                if meta.len() > MAX_FILE_BYTES {
                    continue;
                }
                let stamp = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
                let fresh = self.files.get(&p).is_some_and(|e| e.stamp == stamp);
                if !fresh {
                    let Some(d) = read_text(nb, &p) else { continue };
                    let lines: Vec<String> = d.text.lines().map(str::to_string).collect();
                    let folded = lines.iter().map(|l| fold(l)).collect();
                    self.files.insert(p.clone(), Entry { stamp, lines, folded });
                }
                seen.insert(p.clone());
                listed.push((i, p));
            }
        }
        self.files.retain(|p, _| seen.contains(p));
        listed
    }

    pub fn search(&mut self, nbs: &[NotebookRef], query: &str, limit: Option<usize>) -> Vec<Hit> {
        let q: Vec<char> = fold(query.trim()).chars().collect();
        if q.is_empty() {
            return Vec::new();
        }
        let q_str: String = q.iter().collect();
        let limit = limit.unwrap_or(MAX_HITS).min(MAX_HITS);
        let mut hits = Vec::new();
        for (i, path) in self.refresh(nbs) {
            if hits.len() >= limit {
                break;
            }
            let nb = &nbs[i];
            let rel = rel_of(&nb.path, &path);
            let entry = &self.files[&path];
            let base = |line, occurrence, before: String, hit: String, after: String| Hit {
                notebook_id: nb.id.clone(),
                notebook_name: nb.name.clone(),
                path: path.to_string_lossy().into_owned(),
                rel: rel.clone(),
                line,
                occurrence,
                before,
                hit,
                after,
            };
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let (stem_f, stem_map) = fold_map(&stem);
            if let Some(at) = find_chars(&stem_f, &q) {
                let orig: Vec<char> = stem.chars().collect();
                let (s, e) = (stem_map[at], stem_map[at + q.len() - 1] + 1);
                hits.push(base(0, 0, orig[..s].iter().collect(), orig[s..e].iter().collect(), orig[e..].iter().collect()));
            }
            let mut occurrence = 0;
            for (n, folded) in entry.folded.iter().enumerate() {
                if !folded.contains(q_str.as_str()) {
                    continue;
                }
                if occurrence < MAX_HITS_PER_FILE {
                    let orig: Vec<char> = entry.lines[n].chars().collect();
                    let (f, map) = fold_map(&entry.lines[n]);
                    if let Some(at) = find_chars(&f, &q) {
                        let (s, e) = (map[at], map[at + q.len() - 1] + 1);
                        let from = s.saturating_sub(40);
                        let to = (e + 80).min(orig.len());
                        let cut_l = if from > 0 { "…" } else { "" };
                        let cut_r = if to < orig.len() { "…" } else { "" };
                        hits.push(base(
                            n + 1,
                            occurrence,
                            format!("{cut_l}{}", orig[from..s].iter().collect::<String>()),
                            orig[s..e].iter().collect(),
                            format!("{}{cut_r}", orig[e..to].iter().collect::<String>()),
                        ));
                    }
                }
                occurrence += 1;
            }
        }
        hits.truncate(limit);
        hits
    }

    pub fn terms(&mut self, nbs: &[NotebookRef]) -> Vec<Term> {
        let mut out = Vec::new();
        for (i, path) in self.refresh(nbs) {
            let nb = &nbs[i];
            let mut fence = false;
            for (n, line) in self.files[&path].lines.iter().enumerate() {
                if line.trim_start().starts_with("```") {
                    fence = !fence;
                    continue;
                }
                if fence {
                    continue;
                }
                if let Some((term, definition)) = parse_term(line) {
                    out.push(Term {
                        term,
                        definition,
                        notebook_id: nb.id.clone(),
                        notebook_name: nb.name.clone(),
                        path: path.to_string_lossy().into_owned(),
                        line: n + 1,
                    });
                }
            }
        }
        out.sort_by(|a, b| fold(&a.term).cmp(&fold(&b.term)));
        out
    }
}

/// `**Termo**: definição`, `**Termo:** definição` ou `Termo:: definição` (uma linha).
pub fn parse_term(line: &str) -> Option<(String, String)> {
    let t = line.trim_start();
    let t = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).unwrap_or(t);
    let valid = |term: &str, def: &str| {
        let term = term.trim();
        let def = def.trim();
        (!term.is_empty() && !def.is_empty() && term.chars().count() <= MAX_TERM_CHARS).then(|| (term.to_string(), def.to_string()))
    };
    if let Some(rest) = t.strip_prefix("**") {
        let end = rest.find("**")?;
        let (inner, after) = (&rest[..end], &rest[end + 2..]);
        if let Some(inner) = inner.strip_suffix(':') {
            return valid(inner, after.strip_prefix(':').unwrap_or(after));
        }
        return valid(inner, after.trim_start().strip_prefix(':')?);
    }
    let (left, right) = t.split_once("::")?;
    if left.contains(':') || left.contains('*') || !right.starts_with(' ') {
        return None;
    }
    valid(left, right)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nb(dir: &Path, id: &str, name: &str) -> NotebookRef {
        NotebookRef { id: id.into(), name: name.into(), path: dir.join(id), private: false, key: None }
    }

    fn write(dir: &Path, id: &str, rel: &str, text: &str) {
        let p = dir.join(id).join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn dobra_acentos_e_maiusculas() {
        assert_eq!(fold("Ação É Útil"), "acao e util");
        assert_eq!(fold("cafe\u{301}"), "cafe");
    }

    #[test]
    fn termos_nos_dois_formatos() {
        assert_eq!(parse_term("**Ação**: o que se faz"), Some(("Ação".into(), "o que se faz".into())));
        assert_eq!(parse_term("- **Ação:** o que se faz"), Some(("Ação".into(), "o que se faz".into())));
        assert_eq!(parse_term("Termo:: definição aqui"), Some(("Termo".into(), "definição aqui".into())));
        assert_eq!(parse_term("std::vec é uma coisa"), None);
        assert_eq!(parse_term("**negrito** sem dois pontos"), None);
        assert_eq!(parse_term("**vazio**:"), None);
        assert_eq!(parse_term("texto normal"), None);
    }

    #[test]
    fn busca_ignora_acento_e_acha_o_trecho() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a", "Reunião.md", "primeira linha\nA AÇÃO foi aprovada ontem\nnada\nmais uma acao aqui");
        write(dir.path(), "a", ".lixeira/velha.md", "acao escondida");
        write(dir.path(), "b", "sub/outra.txt", "sem nada");
        let nbs = vec![nb(dir.path(), "a", "Trabalho"), nb(dir.path(), "b", "Casa")];
        let mut idx = Index::default();
        let hits = idx.search(&nbs, "acao", None);
        assert_eq!(hits.len(), 2);
        assert_eq!((hits[0].line, hits[0].occurrence, hits[0].hit.as_str()), (2, 0, "AÇÃO"));
        assert_eq!((hits[1].line, hits[1].occurrence, hits[1].hit.as_str()), (4, 1, "acao"));
        assert_eq!(hits[0].before, "A ");
        assert_eq!(hits[0].rel, "Reunião.md");
        // O nome da nota também conta, e a lixeira nunca entra.
        let by_title = idx.search(&nbs, "reuniao", None);
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].line, 0);
        assert!(idx.search(&nbs, "escondida", None).is_empty());
    }

    #[test]
    fn reindexa_so_o_que_mudou_e_esquece_o_que_sumiu() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a", "n.md", "alfa");
        let nbs = vec![nb(dir.path(), "a", "A")];
        let mut idx = Index::default();
        assert_eq!(idx.search(&nbs, "alfa", None).len(), 1);
        write(dir.path(), "a", "n.md", "beta beta");
        idx.invalidate();
        assert!(idx.search(&nbs, "alfa", None).is_empty());
        assert_eq!(idx.search(&nbs, "beta", None).len(), 1);
        fs::remove_file(dir.path().join("a").join("n.md")).unwrap();
        idx.invalidate();
        assert!(idx.search(&nbs, "beta", None).is_empty());
        assert!(idx.files.is_empty());
    }

    #[test]
    fn glossario_global_em_ordem_alfabetica() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a", "x.md", "# T\n**Zebra**: listrada\n```\n**Falso**: dentro de código\n```\n");
        write(dir.path(), "b", "y.md", "Água:: líquido\n");
        let nbs = vec![nb(dir.path(), "a", "A"), nb(dir.path(), "b", "B")];
        let terms = Index::default().terms(&nbs);
        let names: Vec<_> = terms.iter().map(|t| t.term.as_str()).collect();
        assert_eq!(names, ["Água", "Zebra"]);
        assert_eq!((terms[1].line, terms[1].notebook_name.as_str()), (2, "A"));
    }

    #[test]
    fn caderno_privado_so_entra_no_indice_com_a_chave() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("p");
        fs::create_dir_all(&root).unwrap();
        let key = crate::vault::create(&root, "senha").unwrap();
        fs::write(root.join("n.md"), crate::vault::encrypt(&key, "**Segredo**: tesouro enterrado".as_bytes())).unwrap();
        let mut nbs = vec![NotebookRef { id: "p".into(), name: "P".into(), path: root, private: true, key: None }];
        let mut idx = Index::default();
        assert!(idx.search(&nbs, "tesouro", None).is_empty(), "trancado: nada aparece");
        assert!(idx.terms(&nbs).is_empty());
        nbs[0].key = Some(key);
        idx.invalidate();
        assert_eq!(idx.search(&nbs, "tesouro", None).len(), 1);
        assert_eq!(idx.terms(&nbs).len(), 1);
        nbs[0].key = None;
        idx.clear();
        assert!(idx.search(&nbs, "tesouro", None).is_empty());
    }

    #[test]
    fn busca_rapida_com_milhares_de_notas() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..3000 {
            write(dir.path(), "a", &format!("p{}/nota{i}.md", i % 30), &format!("linha um\nconteúdo da nota número {i}\ntermo-{i} fim"));
        }
        let nbs = vec![nb(dir.path(), "a", "A")];
        let mut idx = Index::default();
        idx.search(&nbs, "x", None); // indexa
        // Com a varredura já feita (digitando) e relendo a pasta toda (pior caso, sem o depurador).
        let t = std::time::Instant::now();
        let hits = idx.search(&nbs, "NÚMERO 2999", None);
        let fast = t.elapsed().as_millis();
        idx.invalidate();
        let t = std::time::Instant::now();
        let again = idx.search(&nbs, "NÚMERO 2999", None);
        let rescan = t.elapsed().as_millis();
        assert_eq!((hits.len(), again.len()), (1, 1));
        let limit = if cfg!(debug_assertions) { 1500 } else { 200 };
        assert!(fast < 200 && rescan < limit, "busca levou {fast} ms (cache) e {rescan} ms (nova varredura)");
    }
}
