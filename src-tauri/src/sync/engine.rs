// Motor de sincronização de três vias (roda no celular, o cliente).
//
// Para cada arquivo compara a versão local (L), a do PC (R) e a da última sincronização (B):
//   L = R          → nada a fazer
//   só R mudou     → baixa (ou apaga aqui, se R foi apagado)
//   só L mudou     → envia (ou apaga no PC, se L foi apagado)
//   os dois mudaram→ conflito: apagar × editar mantém a edição; editar × editar guarda a
//                    versão do PC no nome original e a local numa cópia "(conflito …)" nos dois lados.
// Apagar é sempre mover para a lixeira do caderno. Escritas no PC levam o hash esperado; se o
// arquivo mudou no meio do caminho, a sincronização é refeita.

use super::Host;
use super::proto::{Manifest, NotebookInfo, Request, Response, b64_decode, b64_encode, hash_bytes};
use super::store;
use crate::meta::{META_FILE, Meta};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub trait Remote {
    fn call(&mut self, req: Request) -> Result<Response, String>;
}

/// Estado guardado entre sincronizações (por PC pareado).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncBase {
    /// Manifesto acordado na última sincronização, por caderno.
    #[serde(default)]
    pub notebooks: BTreeMap<String, Manifest>,
    /// Cadernos que já existiram nos dois lados (sumir do PC = foi removido lá).
    #[serde(default)]
    pub known: BTreeSet<String>,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub changed: Vec<PathBuf>,
    pub removed: Vec<PathBuf>,
    pub conflicts: Vec<PathBuf>,
    pub uploads: usize,
    pub downloads: usize,
    /// Algo mudou no PC durante a sincronização: rodar de novo.
    pub retry: bool,
}

pub struct Options {
    /// Rótulo das cópias de conflito, ex.: "celular 2026-10-12 06h20".
    pub conflict_label: String,
}

fn unexpected(r: Response) -> String {
    match r {
        Response::Error { message } => message,
        other => format!("Resposta inesperada do PC: {other:?}"),
    }
}

fn expect_ok(r: Response) -> Result<(), String> {
    match r {
        Response::Ok => Ok(()),
        other => Err(unexpected(other)),
    }
}

/// Sincroniza todos os cadernos (refaz até 3 vezes se o PC mudou durante a operação).
pub fn sync_all(local: &dyn Host, remote: &mut dyn Remote, base: &mut SyncBase, opts: &Options) -> Result<Outcome, String> {
    let mut total = Outcome::default();
    for _ in 0..3 {
        let out = sync_once(local, remote, base, opts)?;
        total.changed.extend(out.changed);
        total.removed.extend(out.removed);
        total.conflicts.extend(out.conflicts);
        total.uploads += out.uploads;
        total.downloads += out.downloads;
        total.retry = out.retry;
        if !out.retry {
            break;
        }
    }
    local.changed(total.changed.clone(), total.removed.clone());
    Ok(total)
}

fn sync_once(local: &dyn Host, remote: &mut dyn Remote, base: &mut SyncBase, opts: &Options) -> Result<Outcome, String> {
    let remote_nbs: Vec<NotebookInfo> = match remote.call(Request::Notebooks)? {
        Response::Notebooks { list } => list,
        other => return Err(unexpected(other)),
    };
    let local_nbs = local.notebooks();

    for r in &remote_nbs {
        if !local_nbs.iter().any(|(l, _)| l.id == r.id) {
            if base.known.contains(&r.id) && r.id != crate::notebooks::QUICK_NOTEBOOK_ID {
                // Existia nos dois e sumiu daqui: foi removido deste aparelho; remove do outro lado.
                expect_ok(remote.call(Request::DeleteNotebook { id: r.id.clone() })?)?;
                base.known.remove(&r.id);
                base.notebooks.remove(&r.id);
                continue;
            }
            local.create_notebook(&r.id, &r.name)?;
        }
        base.known.insert(r.id.clone());
    }
    for (l, _) in &local_nbs {
        if remote_nbs.iter().any(|r| r.id == l.id) {
            continue;
        }
        if base.known.contains(&l.id) {
            // Existia nos dois e sumiu do PC: foi removido da lista lá.
            local.forget_notebook(&l.id);
            base.known.remove(&l.id);
            base.notebooks.remove(&l.id);
        } else {
            expect_ok(remote.call(Request::CreateNotebook { id: l.id.clone(), name: l.name.clone() })?)?;
            base.known.insert(l.id.clone());
        }
    }

    let mut out = Outcome::default();
    for (nb, root) in local.notebooks() {
        if !base.known.contains(&nb.id) {
            continue;
        }
        let prev = base.notebooks.get(&nb.id).cloned().unwrap_or_default();
        let agreed = sync_notebook(remote, &nb.id, &root, &prev, opts, &mut out)?;
        base.notebooks.insert(nb.id.clone(), agreed);
    }
    Ok(out)
}

struct Ctx<'a> {
    remote: &'a mut dyn Remote,
    nb: &'a str,
    root: &'a Path,
    out: &'a mut Outcome,
    agreed: Manifest,
}

impl Ctx<'_> {
    fn download(&mut self, p: &str) -> Result<(), String> {
        let data = match self.remote.call(Request::Get { notebook: self.nb.into(), path: p.into() })? {
            Response::File { data } => b64_decode(&data)?,
            other => return Err(unexpected(other)),
        };
        let abs = store::write(self.root, p, &data)?;
        self.agreed.files.insert(p.into(), hash_bytes(&data));
        self.out.changed.push(abs);
        self.out.downloads += 1;
        Ok(())
    }

    /// Envia o arquivo local `p`. Em conflito, mantém `keep` (o hash base) como acordado.
    fn upload(&mut self, p: &str, expected: Option<String>, keep: Option<&String>) -> Result<(), String> {
        let data = store::read(self.root, p)?;
        let req = Request::Put { notebook: self.nb.into(), path: p.into(), data: b64_encode(&data), expected };
        match self.remote.call(req)? {
            Response::Ok => {
                self.agreed.files.insert(p.into(), hash_bytes(&data));
                self.out.uploads += 1;
            }
            Response::Conflict { .. } => self.conflicted(p, keep),
            other => return Err(unexpected(other)),
        }
        Ok(())
    }

    fn delete_remote(&mut self, p: &str, expected: &str, keep: Option<&String>) -> Result<(), String> {
        let req = Request::Delete { notebook: self.nb.into(), path: p.into(), expected: expected.into() };
        match self.remote.call(req)? {
            Response::Ok => {}
            Response::Conflict { .. } => self.conflicted(p, keep),
            other => return Err(unexpected(other)),
        }
        Ok(())
    }

    fn delete_local(&mut self, p: &str) -> Result<(), String> {
        let abs = store::trash(self.root, p)?;
        self.out.removed.push(abs);
        Ok(())
    }

    fn conflicted(&mut self, p: &str, keep: Option<&String>) {
        self.out.retry = true;
        if let Some(b) = keep {
            self.agreed.files.insert(p.into(), b.clone());
        }
    }

    /// Editado nos dois lados: a versão do PC fica no nome original; a local vira uma cópia.
    fn conflict_copy(&mut self, p: &str, taken: &BTreeSet<String>, label: &str) -> Result<(), String> {
        let data = store::read(self.root, p)?;
        let copy = conflict_name(p, label, |c| taken.contains(c) || store::resolve(self.root, c).is_ok_and(|a| a.exists()));
        let abs = store::write(self.root, &copy, &data)?;
        self.out.conflicts.push(abs.clone());
        self.out.changed.push(abs);
        self.upload(&copy, None, None)?;
        self.download(p)
    }

    /// `.notex.json` editado nos dois lados: junta os ícones (o do PC vence na mesma pasta).
    fn merge_meta(&mut self, remote_hash: &str) -> Result<(), String> {
        let theirs = match self.remote.call(Request::Get { notebook: self.nb.into(), path: META_FILE.into() })? {
            Response::File { data } => b64_decode(&data)?,
            other => return Err(unexpected(other)),
        };
        let mut merged: Meta = serde_json::from_slice(&store::read(self.root, META_FILE)?).unwrap_or_default();
        let theirs: Meta = serde_json::from_slice(&theirs).unwrap_or_default();
        merged.icons.extend(theirs.icons);
        let json = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
        let abs = store::write(self.root, META_FILE, &json)?;
        self.out.changed.push(abs);
        self.upload(META_FILE, Some(remote_hash.into()), None)
    }
}

/// "pasta/nota.md" → "pasta/nota (conflito celular 2026-10-12 06h20).md" (com (2), (3)… se preciso).
pub fn conflict_name(p: &str, label: &str, taken: impl Fn(&str) -> bool) -> String {
    let (dir, file) = match p.rfind('/') {
        Some(i) => (&p[..=i], &p[i + 1..]),
        None => ("", p),
    };
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    let label = crate::notebooks::sanitize_name(label);
    for n in 1.. {
        let suffix = if n == 1 { format!("conflito {label}") } else { format!("conflito {label} {n}") };
        let candidate = format!("{dir}{stem} ({suffix}){ext}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn sync_notebook(
    remote: &mut dyn Remote,
    nb: &str,
    root: &Path,
    base: &Manifest,
    opts: &Options,
    out: &mut Outcome,
) -> Result<Manifest, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("Pasta do caderno inacessível: {e}"))?;
    let l = store::manifest(root);
    let r = match remote.call(Request::Manifest { notebook: nb.into() })? {
        Response::Manifest { manifest } => manifest,
        other => return Err(unexpected(other)),
    };
    let mut ctx = Ctx { remote, nb, root, out, agreed: Manifest::default() };

    // Pastas: criações agora, remoções no fim (depois de os arquivos irem para a lixeira).
    let mut rm_local = Vec::new();
    let mut rm_remote = Vec::new();
    let dirs: BTreeSet<&String> = l.dirs.iter().chain(&r.dirs).chain(&base.dirs).collect();
    for d in dirs {
        match (l.dirs.contains(d), r.dirs.contains(d), base.dirs.contains(d)) {
            (true, true, _) => {
                ctx.agreed.dirs.insert(d.clone());
            }
            (true, false, true) => rm_local.push(d.clone()),
            (true, false, false) => {
                expect_ok(ctx.remote.call(Request::Mkdir { notebook: nb.into(), path: d.clone() })?)?;
                ctx.agreed.dirs.insert(d.clone());
            }
            (false, true, true) => rm_remote.push(d.clone()),
            (false, true, false) => {
                store::mkdir(root, d)?;
                ctx.agreed.dirs.insert(d.clone());
            }
            (false, false, _) => {}
        }
    }

    let taken: BTreeSet<String> = l.files.keys().chain(r.files.keys()).cloned().collect();
    let paths: BTreeSet<&String> = l.files.keys().chain(r.files.keys()).chain(base.files.keys()).collect();
    for p in paths {
        let (lh, rh, bh) = (l.files.get(p), r.files.get(p), base.files.get(p));
        if lh == rh {
            if let Some(h) = lh {
                ctx.agreed.files.insert(p.clone(), h.clone());
            }
            continue;
        }
        if lh == bh {
            // Só o PC mudou.
            match rh {
                Some(_) => ctx.download(p)?,
                None => ctx.delete_local(p)?,
            }
        } else if rh == bh {
            // Só o celular mudou.
            match lh {
                Some(_) => ctx.upload(p, rh.cloned(), bh)?,
                None => ctx.delete_remote(p, rh.expect("rh == bh e lh != rh"), bh)?,
            }
        } else {
            // Os dois mudaram.
            match (lh, rh) {
                (None, Some(_)) => ctx.download(p)?,
                (Some(_), None) => ctx.upload(p, None, bh)?,
                (Some(_), Some(rh)) if p == META_FILE => ctx.merge_meta(rh)?,
                (Some(_), Some(_)) => ctx.conflict_copy(p, &taken, &opts.conflict_label)?,
                (None, None) => {}
            }
        }
    }

    // Remove pastas apagadas do outro lado, das mais fundas para as mais rasas.
    let depth = |s: &String| s.matches('/').count();
    rm_local.sort_by_key(|d| std::cmp::Reverse(depth(d)));
    rm_remote.sort_by_key(|d| std::cmp::Reverse(depth(d)));
    for d in rm_local {
        store::rmdir_if_empty(root, &d)?;
    }
    for d in rm_remote {
        expect_ok(ctx.remote.call(Request::Rmdir { notebook: nb.into(), path: d })?)?;
    }
    Ok(ctx.agreed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::handle;
    use std::cell::RefCell;
    use std::fs;

    /// Aparelho de teste: cadernos numa pasta temporária.
    struct Device {
        dir: tempfile::TempDir,
        nbs: RefCell<Vec<NotebookInfo>>,
    }

    impl Device {
        fn new() -> Self {
            let d = Device { dir: tempfile::tempdir().unwrap(), nbs: RefCell::new(vec![]) };
            d.create_notebook("rapidas", "Rápidas").unwrap();
            d
        }
        fn root(&self, id: &str) -> PathBuf {
            self.dir.path().join(id)
        }
        fn put(&self, nb: &str, rel: &str, text: &str) {
            store::write(&self.root(nb), rel, text.as_bytes()).unwrap();
        }
        fn get(&self, nb: &str, rel: &str) -> Option<String> {
            fs::read_to_string(store::resolve(&self.root(nb), rel).unwrap()).ok()
        }
        fn trashed(&self, nb: &str, name: &str) -> bool {
            self.root(nb).join(".lixeira").join(name).exists()
        }
    }

    impl Host for Device {
        fn notebooks(&self) -> Vec<(NotebookInfo, PathBuf)> {
            self.nbs.borrow().iter().map(|n| (n.clone(), self.root(&n.id))).collect()
        }
        fn create_notebook(&self, id: &str, name: &str) -> Result<PathBuf, String> {
            if !self.nbs.borrow().iter().any(|n| n.id == id) {
                self.nbs.borrow_mut().push(NotebookInfo { id: id.into(), name: name.into() });
            }
            fs::create_dir_all(self.root(id)).unwrap();
            Ok(self.root(id))
        }
        fn forget_notebook(&self, id: &str) {
            self.nbs.borrow_mut().retain(|n| n.id != id);
        }
        fn changed(&self, _: Vec<PathBuf>, _: Vec<PathBuf>) {}
    }

    /// "Rede" de teste: chama o tratador do PC direto.
    struct Direct<'a>(&'a Device);
    impl Remote for Direct<'_> {
        fn call(&mut self, req: Request) -> Result<Response, String> {
            Ok(handle(self.0, req))
        }
    }

    fn sync(phone: &Device, pc: &Device, base: &mut SyncBase) -> Outcome {
        let opts = Options { conflict_label: "celular 2026-10-12 06h20".into() };
        sync_all(phone, &mut Direct(pc), base, &opts).unwrap()
    }

    #[test]
    fn primeira_sincronizacao_traz_tudo_do_pc() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        pc.put("rapidas", "a.md", "A");
        pc.put("rapidas", "pasta/b.txt", "B");
        pc.create_notebook("trab", "Trabalho").unwrap();
        pc.put("trab", "c.md", "C");
        let out = sync(&phone, &pc, &mut base);
        assert_eq!(out.downloads, 3);
        assert_eq!(phone.get("rapidas", "pasta/b.txt").as_deref(), Some("B"));
        assert_eq!(phone.get("trab", "c.md").as_deref(), Some("C"));
        assert!(phone.notebooks().iter().any(|(n, _)| n.name == "Trabalho"));
        // Nada mudou: segunda rodada não transfere nada.
        let out = sync(&phone, &pc, &mut base);
        assert_eq!((out.downloads, out.uploads), (0, 0));
    }

    #[test]
    fn edicoes_vao_e_voltam() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        pc.put("rapidas", "a.md", "v1");
        sync(&phone, &pc, &mut base);
        phone.put("rapidas", "a.md", "v2 celular");
        phone.put("rapidas", "nova.md", "nova");
        let out = sync(&phone, &pc, &mut base);
        assert_eq!(out.uploads, 2);
        assert_eq!(pc.get("rapidas", "a.md").as_deref(), Some("v2 celular"));
        pc.put("rapidas", "a.md", "v3 pc");
        sync(&phone, &pc, &mut base);
        assert_eq!(phone.get("rapidas", "a.md").as_deref(), Some("v3 pc"));
    }

    #[test]
    fn apagar_de_um_lado_apaga_do_outro_para_a_lixeira() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        pc.put("rapidas", "a.md", "A");
        pc.put("rapidas", "b.md", "B");
        sync(&phone, &pc, &mut base);
        store::trash(&phone.root("rapidas"), "a.md").unwrap();
        store::trash(&pc.root("rapidas"), "b.md").unwrap();
        sync(&phone, &pc, &mut base);
        assert_eq!(pc.get("rapidas", "a.md"), None);
        assert!(pc.trashed("rapidas", "a.md"));
        assert_eq!(phone.get("rapidas", "b.md"), None);
        assert!(phone.trashed("rapidas", "b.md"));
    }

    #[test]
    fn editar_nos_dois_lados_gera_copia_de_conflito() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        pc.put("rapidas", "pasta/a.md", "base");
        sync(&phone, &pc, &mut base);
        pc.put("rapidas", "pasta/a.md", "do pc");
        phone.put("rapidas", "pasta/a.md", "do celular");
        let out = sync(&phone, &pc, &mut base);
        assert_eq!(out.conflicts.len(), 1);
        let copy = "pasta/a (conflito celular 2026-10-12 06h20).md";
        for d in [&pc, &phone] {
            assert_eq!(d.get("rapidas", "pasta/a.md").as_deref(), Some("do pc"));
            assert_eq!(d.get("rapidas", copy).as_deref(), Some("do celular"));
        }
        // Estável depois do conflito.
        let out = sync(&phone, &pc, &mut base);
        assert_eq!((out.downloads, out.uploads, out.conflicts.len()), (0, 0, 0));
    }

    #[test]
    fn apagar_contra_editar_mantem_a_edicao() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        pc.put("rapidas", "a.md", "base");
        pc.put("rapidas", "b.md", "base");
        sync(&phone, &pc, &mut base);
        store::trash(&phone.root("rapidas"), "a.md").unwrap();
        pc.put("rapidas", "a.md", "editada no pc");
        store::trash(&pc.root("rapidas"), "b.md").unwrap();
        phone.put("rapidas", "b.md", "editada no celular");
        sync(&phone, &pc, &mut base);
        assert_eq!(phone.get("rapidas", "a.md").as_deref(), Some("editada no pc"));
        assert_eq!(pc.get("rapidas", "b.md").as_deref(), Some("editada no celular"));
    }

    #[test]
    fn cadernos_criados_e_removidos() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        phone.create_notebook("nbcel", "Do celular").unwrap();
        phone.put("nbcel", "x.md", "x");
        sync(&phone, &pc, &mut base);
        assert!(pc.notebooks().iter().any(|(n, _)| n.id == "nbcel"));
        assert_eq!(pc.get("nbcel", "x.md").as_deref(), Some("x"));
        // Removido da lista no PC: sai da lista do celular também.
        pc.forget_notebook("nbcel");
        sync(&phone, &pc, &mut base);
        assert!(!phone.notebooks().iter().any(|(n, _)| n.id == "nbcel"));
    }

    #[test]
    fn pastas_vazias_criadas_e_removidas() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        store::mkdir(&phone.root("rapidas"), "vazia/sub").unwrap();
        sync(&phone, &pc, &mut base);
        assert!(pc.root("rapidas").join("vazia").join("sub").is_dir());
        fs::remove_dir_all(pc.root("rapidas").join("vazia")).unwrap();
        sync(&phone, &pc, &mut base);
        assert!(!phone.root("rapidas").join("vazia").exists());
    }

    #[test]
    fn icones_editados_nos_dois_lados_sao_juntados() {
        let (pc, phone, mut base) = (Device::new(), Device::new(), SyncBase::default());
        store::mkdir(&pc.root("rapidas"), "a").unwrap();
        store::mkdir(&pc.root("rapidas"), "b").unwrap();
        sync(&phone, &pc, &mut base);
        crate::meta::set_icon(&pc.root("rapidas"), &pc.root("rapidas").join("a"), Some("📚")).unwrap();
        crate::meta::set_icon(&phone.root("rapidas"), &phone.root("rapidas").join("b"), Some("⭐")).unwrap();
        sync(&phone, &pc, &mut base);
        for d in [&pc, &phone] {
            let m = crate::meta::load(&d.root("rapidas"));
            assert_eq!(m.icons.get("a").map(String::as_str), Some("📚"));
            assert_eq!(m.icons.get("b").map(String::as_str), Some("⭐"));
        }
    }

    #[test]
    fn nome_da_copia_de_conflito() {
        let none = |_: &str| false;
        assert_eq!(conflict_name("a.md", "x", none), "a (conflito x).md");
        assert_eq!(conflict_name("p/q/nota", "x", none), "p/q/nota (conflito x)");
        assert_eq!(conflict_name("a.md", "x", |c| c == "a (conflito x).md"), "a (conflito x 2).md");
    }
}
