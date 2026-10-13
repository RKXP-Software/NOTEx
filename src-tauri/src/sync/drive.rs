// Google Drive como o "outro lado" da sincronização (Fase 4).
//
// No Drive: pasta "NOTEx" → uma pasta por caderno → pastas e arquivos normais, como no disco.
// Cada item criado pelo NOTEx leva appProperties: `nb` (id do caderno), `notex` (root/notebook/dir)
// e, nos arquivos, `sha256` (o mesmo hash do manifesto local). Com o escopo drive.file o app só
// enxerga o que ele mesmo criou. Apagar = mandar para a lixeira do Drive (recuperável por 30 dias).
//
// `DriveRemote` traduz as requisições do motor (Manifest/Get/Put/Delete...) em chamadas da
// `DriveApi`; a implementação HTTP real fica em `google.rs`, e os testes usam uma em memória.

use super::engine::Remote;
use super::proto::{Manifest, NotebookInfo, Request, Response, b64_decode, b64_encode, hash_bytes, is_synced_file, valid_rel_path};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};

pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub app_properties: BTreeMap<String, String>,
}

impl DriveFile {
    pub fn is_folder(&self) -> bool {
        self.mime_type == FOLDER_MIME
    }
    fn prop(&self, k: &str) -> Option<&str> {
        self.app_properties.get(k).map(String::as_str)
    }
}

pub struct NewFile<'a> {
    pub name: &'a str,
    pub parent: Option<&'a str>,
    pub folder: bool,
    pub props: BTreeMap<String, String>,
}

/// Operações do Drive usadas pela sincronização.
pub trait DriveApi {
    /// Arquivos não apagados que têm a appProperty `key` = `value` (todas as páginas).
    fn find(&mut self, key: &str, value: &str) -> Result<Vec<DriveFile>, String>;
    fn download(&mut self, id: &str) -> Result<Vec<u8>, String>;
    fn create(&mut self, file: NewFile<'_>, data: Option<&[u8]>) -> Result<DriveFile, String>;
    fn update(&mut self, id: &str, props: BTreeMap<String, String>, data: &[u8]) -> Result<(), String>;
    fn trash(&mut self, id: &str) -> Result<(), String>;
    fn rename(&mut self, id: &str, name: &str) -> Result<(), String>;
}

fn props(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// Índice de um caderno no Drive: caminho relativo → id (e hash, para arquivos).
#[derive(Default)]
struct NbIndex {
    folder: String,
    files: BTreeMap<String, (String, String)>,
    dirs: BTreeMap<String, String>,
}

pub struct DriveRemote<A: DriveApi> {
    pub api: A,
    root: Option<String>,
    /// Caderno → id da pasta.
    notebooks: HashMap<String, String>,
    index: HashMap<String, NbIndex>,
}

impl<A: DriveApi> DriveRemote<A> {
    pub fn new(api: A) -> Self {
        Self { api, root: None, notebooks: HashMap::new(), index: HashMap::new() }
    }

    /// Começo de uma sincronização: relê cadernos e arquivos do Drive (mantém a pasta NOTEx).
    pub fn reset(&mut self) {
        self.notebooks.clear();
        self.index.clear();
    }

    fn root(&mut self) -> Result<String, String> {
        if let Some(r) = &self.root {
            return Ok(r.clone());
        }
        let found = self.api.find("notex", "root")?;
        let id = match found.into_iter().find(|f| f.is_folder()) {
            Some(f) => f.id,
            None => self.api.create(NewFile { name: "NOTEx", parent: None, folder: true, props: props(&[("notex", "root")]) }, None)?.id,
        };
        self.root = Some(id.clone());
        Ok(id)
    }

    fn list_notebooks(&mut self) -> Result<Vec<NotebookInfo>, String> {
        let root = self.root()?;
        let mut out = Vec::new();
        for f in self.api.find("notex", "notebook")? {
            let Some(nb) = f.prop("nb") else { continue };
            if !f.is_folder() || !f.parents.contains(&root) || out.iter().any(|n: &NotebookInfo| n.id == nb) {
                continue;
            }
            self.notebooks.insert(nb.to_string(), f.id.clone());
            out.push(NotebookInfo { id: nb.to_string(), name: f.name.clone() });
        }
        Ok(out)
    }

    fn notebook_folder(&mut self, nb: &str) -> Result<String, String> {
        if !self.notebooks.contains_key(nb) {
            self.list_notebooks()?;
        }
        self.notebooks.get(nb).cloned().ok_or_else(|| "Caderno não encontrado no Google Drive.".to_string())
    }

    /// Lê todos os itens do caderno numa consulta e monta os caminhos pelas pastas-pai.
    fn build_index(&mut self, nb: &str) -> Result<&NbIndex, String> {
        let folder = self.notebook_folder(nb)?;
        let items = self.api.find("nb", nb)?;
        let by_id: HashMap<&str, &DriveFile> = items.iter().map(|f| (f.id.as_str(), f)).collect();
        let path_of = |f: &DriveFile| -> Option<String> {
            let mut parts = vec![f.name.clone()];
            let mut cur = f;
            for _ in 0..64 {
                let parent = cur.parents.first()?;
                if parent == &folder {
                    parts.reverse();
                    return Some(parts.join("/"));
                }
                cur = by_id.get(parent.as_str())?;
                parts.push(cur.name.clone());
            }
            None
        };
        let mut idx = NbIndex { folder: folder.clone(), ..Default::default() };
        for f in &items {
            if f.id == folder {
                continue;
            }
            let Some(path) = path_of(f) else { continue };
            if !valid_rel_path(&path) {
                continue;
            }
            if f.is_folder() {
                idx.dirs.entry(path).or_insert_with(|| f.id.clone());
            } else if is_synced_file(&path) {
                let hash = f.prop("sha256").unwrap_or_default().to_string();
                idx.files.entry(path).or_insert_with(|| (f.id.clone(), hash));
            }
        }
        self.index.insert(nb.to_string(), idx);
        Ok(&self.index[nb])
    }

    fn idx(&mut self, nb: &str) -> Result<&mut NbIndex, String> {
        if !self.index.contains_key(nb) {
            self.build_index(nb)?;
        }
        Ok(self.index.get_mut(nb).unwrap())
    }

    /// Garante a pasta `path` (e as acima dela); devolve o id.
    fn ensure_dir(&mut self, nb: &str, path: &str) -> Result<String, String> {
        if path.is_empty() {
            return Ok(self.idx(nb)?.folder.clone());
        }
        if let Some(id) = self.idx(nb)?.dirs.get(path) {
            return Ok(id.clone());
        }
        let (parent, name) = match path.rfind('/') {
            Some(i) => (&path[..i], &path[i + 1..]),
            None => ("", path),
        };
        let parent_id = self.ensure_dir(nb, parent)?;
        let f = self.api.create(
            NewFile { name, parent: Some(&parent_id), folder: true, props: props(&[("nb", nb), ("notex", "dir")]) },
            None,
        )?;
        self.idx(nb)?.dirs.insert(path.to_string(), f.id.clone());
        Ok(f.id)
    }

    fn handle(&mut self, req: Request) -> Result<Response, String> {
        Ok(match req {
            Request::Notebooks => Response::Notebooks { list: self.list_notebooks()? },
            Request::CreateNotebook { id, name } => {
                if self.list_notebooks()?.iter().all(|n| n.id != id) {
                    let root = self.root()?;
                    let f = self.api.create(
                        NewFile { name: &name, parent: Some(&root), folder: true, props: props(&[("nb", &id), ("notex", "notebook")]) },
                        None,
                    )?;
                    self.notebooks.insert(id, f.id);
                }
                Response::Ok
            }
            Request::RenameNotebook { id, name } => {
                if let Ok(folder) = self.notebook_folder(&id) {
                    self.api.rename(&folder, &name)?;
                }
                Response::Ok
            }
            Request::DeleteNotebook { id } => {
                if let Ok(folder) = self.notebook_folder(&id) {
                    self.api.trash(&folder)?;
                }
                self.notebooks.remove(&id);
                self.index.remove(&id);
                Response::Ok
            }
            Request::Manifest { notebook } => {
                let idx = self.build_index(&notebook)?;
                Response::Manifest {
                    manifest: Manifest {
                        files: idx.files.iter().map(|(p, (_, h))| (p.clone(), h.clone())).collect(),
                        dirs: idx.dirs.keys().cloned().collect(),
                    },
                }
            }
            Request::Get { notebook, path } => {
                let id = self.idx(&notebook)?.files.get(&path).map(|(id, _)| id.clone()).ok_or("Arquivo não encontrado no Drive.")?;
                Response::File { data: b64_encode(&self.api.download(&id)?) }
            }
            Request::Put { notebook, path, data, expected } => {
                let current = self.idx(&notebook)?.files.get(&path).cloned();
                if current.as_ref().map(|(_, h)| h) != expected.as_ref() {
                    return Ok(Response::Conflict { current: current.map(|(_, h)| h) });
                }
                let bytes = b64_decode(&data)?;
                let hash = hash_bytes(&bytes);
                let id = match current {
                    Some((id, _)) => {
                        self.api.update(&id, props(&[("sha256", &hash)]), &bytes)?;
                        id
                    }
                    None => {
                        let (dir, name) = match path.rfind('/') {
                            Some(i) => (&path[..i], &path[i + 1..]),
                            None => ("", path.as_str()),
                        };
                        let parent = self.ensure_dir(&notebook, dir)?;
                        let p = props(&[("nb", &notebook), ("sha256", &hash)]);
                        self.api.create(NewFile { name, parent: Some(&parent), folder: false, props: p }, Some(&bytes))?.id
                    }
                };
                self.idx(&notebook)?.files.insert(path, (id, hash));
                Response::Ok
            }
            Request::Delete { notebook, path, expected } => {
                let current = self.idx(&notebook)?.files.get(&path).cloned();
                match current {
                    Some((id, h)) if h == expected => {
                        self.api.trash(&id)?;
                        self.idx(&notebook)?.files.remove(&path);
                        Response::Ok
                    }
                    other => Response::Conflict { current: other.map(|(_, h)| h) },
                }
            }
            Request::Mkdir { notebook, path } => {
                self.ensure_dir(&notebook, &path)?;
                Response::Ok
            }
            Request::Rmdir { notebook, path } => {
                let idx = self.idx(&notebook)?;
                let prefix = format!("{path}/");
                let empty = !idx.files.keys().chain(idx.dirs.keys()).any(|k| k.starts_with(&prefix));
                if let (true, Some(id)) = (empty, idx.dirs.get(&path).cloned()) {
                    self.api.trash(&id)?;
                    self.idx(&notebook)?.dirs.remove(&path);
                }
                Response::Ok
            }
            Request::Pair { .. } | Request::Wait { .. } | Request::DriveCredentials => {
                return Err("Operação não disponível no Google Drive.".into());
            }
        })
    }
}

impl<A: DriveApi> Remote for DriveRemote<A> {
    fn call(&mut self, req: Request) -> Result<Response, String> {
        self.handle(req)
    }
}

/// Drive em memória para testes.
#[cfg(test)]
pub mod fake {
    use super::*;

    #[derive(Default)]
    pub struct FakeDrive {
        pub files: Vec<(DriveFile, Vec<u8>, bool)>,
        next: u32,
        pub calls: u32,
    }

    impl FakeDrive {
        /// Arquivos não apagados, por nome.
        pub fn names(&self) -> Vec<String> {
            self.files.iter().filter(|(_, _, t)| !t).map(|(f, _, _)| f.name.clone()).collect()
        }
    }

    impl DriveApi for FakeDrive {
        fn find(&mut self, key: &str, value: &str) -> Result<Vec<DriveFile>, String> {
            self.calls += 1;
            Ok(self.files.iter().filter(|(f, _, t)| !t && f.prop(key) == Some(value)).map(|(f, _, _)| f.clone()).collect())
        }
        fn download(&mut self, id: &str) -> Result<Vec<u8>, String> {
            self.calls += 1;
            self.files.iter().find(|(f, _, _)| f.id == id).map(|(_, d, _)| d.clone()).ok_or("404".into())
        }
        fn create(&mut self, file: NewFile<'_>, data: Option<&[u8]>) -> Result<DriveFile, String> {
            self.calls += 1;
            self.next += 1;
            let f = DriveFile {
                id: format!("id{}", self.next),
                name: file.name.into(),
                mime_type: if file.folder { FOLDER_MIME.into() } else { "text/markdown".into() },
                parents: file.parent.map(|p| vec![p.to_string()]).unwrap_or_else(|| vec!["raiz-do-drive".into()]),
                app_properties: file.props,
            };
            self.files.push((f.clone(), data.unwrap_or_default().to_vec(), false));
            Ok(f)
        }
        fn update(&mut self, id: &str, props: BTreeMap<String, String>, data: &[u8]) -> Result<(), String> {
            self.calls += 1;
            let e = self.files.iter_mut().find(|(f, _, _)| f.id == id).ok_or("404")?;
            e.0.app_properties.extend(props);
            e.1 = data.to_vec();
            Ok(())
        }
        fn trash(&mut self, id: &str) -> Result<(), String> {
            self.calls += 1;
            self.files.iter_mut().find(|(f, _, _)| f.id == id).ok_or("404")?.2 = true;
            Ok(())
        }
        fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
            self.calls += 1;
            self.files.iter_mut().find(|(f, _, _)| f.id == id).ok_or("404")?.0.name = name.into();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeDrive;
    use super::*;
    use crate::sync::Host;
    use crate::sync::engine::{Options, SyncBase, sync_all};
    use crate::sync::store;
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

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
        fn rename_notebook(&self, id: &str, name: &str) {
            if let Some(n) = self.nbs.borrow_mut().iter_mut().find(|n| n.id == id) {
                n.name = name.into();
            }
        }
        fn changed(&self, _: Vec<PathBuf>, _: Vec<PathBuf>) {}
    }

    fn sync(dev: &Device, drive: &mut DriveRemote<FakeDrive>, base: &mut SyncBase) {
        // Cada sincronização começa relendo o Drive, como no app.
        drive.reset();
        sync_all(dev, drive, base, &Options { conflict_label: "t".into() }).unwrap();
    }

    #[test]
    fn pc_e_celular_trocam_notas_pelo_drive() {
        let (pc, phone) = (Device::new(), Device::new());
        let (mut bpc, mut bphone) = (SyncBase::default(), SyncBase::default());
        let mut drive = DriveRemote::new(FakeDrive::default());

        pc.put("rapidas", "Projetos/Ideias.md", "do PC");
        pc.create_notebook("trab", "Trabalho").unwrap();
        pc.put("trab", "a.txt", "A");
        sync(&pc, &mut drive, &mut bpc);
        // No Drive: pasta NOTEx, cadernos e subpastas com os nomes reais.
        let names = drive.api.names();
        for n in ["NOTEx", "Rápidas", "Trabalho", "Projetos", "Ideias.md", "a.txt"] {
            assert!(names.contains(&n.to_string()), "faltou {n} em {names:?}");
        }

        sync(&phone, &mut drive, &mut bphone);
        assert_eq!(phone.get("rapidas", "Projetos/Ideias.md").as_deref(), Some("do PC"));
        assert_eq!(phone.get("trab", "a.txt").as_deref(), Some("A"));

        phone.put("rapidas", "Projetos/Ideias.md", "editado no celular");
        store::trash(&phone.root("trab"), "a.txt").unwrap();
        sync(&phone, &mut drive, &mut bphone);
        sync(&pc, &mut drive, &mut bpc);
        assert_eq!(pc.get("rapidas", "Projetos/Ideias.md").as_deref(), Some("editado no celular"));
        assert_eq!(pc.get("trab", "a.txt"), None);
        assert!(pc.root("trab").join(".lixeira").join("a.txt").exists());
        // No Drive, o apagado foi para a lixeira (não sumiu).
        assert!(drive.api.files.iter().any(|(f, _, trashed)| f.name == "a.txt" && *trashed));
    }

    #[test]
    fn caderno_removido_de_um_lado_vai_para_a_lixeira_do_drive() {
        let (pc, phone) = (Device::new(), Device::new());
        let (mut bpc, mut bphone) = (SyncBase::default(), SyncBase::default());
        let mut drive = DriveRemote::new(FakeDrive::default());
        pc.create_notebook("trab", "Trabalho").unwrap();
        pc.put("trab", "Sub/a.txt", "A");
        sync(&pc, &mut drive, &mut bpc);
        sync(&phone, &mut drive, &mut bphone);
        assert!(phone.get("trab", "Sub/a.txt").is_some());

        // Pasta dentro do caderno apagada no PC: some do Drive e do celular.
        store::trash(&pc.root("trab"), "Sub/a.txt").unwrap();
        fs::remove_dir(pc.root("trab").join("Sub")).unwrap();
        sync(&pc, &mut drive, &mut bpc);
        assert!(drive.api.files.iter().any(|(f, _, t)| f.name == "Sub" && *t));
        sync(&phone, &mut drive, &mut bphone);
        assert!(!phone.root("trab").join("Sub").exists());

        // Caderno removido no PC: a pasta vai para a lixeira do Drive e não volta.
        pc.forget_notebook("trab");
        sync(&pc, &mut drive, &mut bpc);
        assert!(drive.api.files.iter().any(|(f, _, t)| f.name == "Trabalho" && *t));
        assert!(!pc.nbs.borrow().iter().any(|n| n.id == "trab"));
        sync(&phone, &mut drive, &mut bphone);
        assert!(!phone.nbs.borrow().iter().any(|n| n.id == "trab"));
    }

    #[test]
    fn renomear_caderno_chega_ao_outro_aparelho_e_ao_drive() {
        let (pc, phone) = (Device::new(), Device::new());
        let (mut bpc, mut bphone) = (SyncBase::default(), SyncBase::default());
        let mut drive = DriveRemote::new(FakeDrive::default());
        pc.create_notebook("trab", "Trabalho").unwrap();
        sync(&pc, &mut drive, &mut bpc);
        sync(&phone, &mut drive, &mut bphone);
        let name_of = |d: &Device| d.nbs.borrow().iter().find(|n| n.id == "trab").unwrap().name.clone();
        assert_eq!(name_of(&phone), "Trabalho");

        pc.rename_notebook("trab", "Projetos");
        sync(&pc, &mut drive, &mut bpc);
        assert!(drive.api.names().contains(&"Projetos".to_string()));
        assert!(!drive.api.names().contains(&"Trabalho".to_string()));
        sync(&phone, &mut drive, &mut bphone);
        assert_eq!(name_of(&phone), "Projetos");

        // E no sentido contrário.
        phone.rename_notebook("trab", "Estudos");
        sync(&phone, &mut drive, &mut bphone);
        sync(&pc, &mut drive, &mut bpc);
        assert_eq!(name_of(&pc), "Estudos");
    }

    #[test]
    fn sincronizacao_sem_mudancas_nao_regrava() {
        let pc = Device::new();
        let mut base = SyncBase::default();
        let mut drive = DriveRemote::new(FakeDrive::default());
        pc.put("rapidas", "a.md", "x");
        sync(&pc, &mut drive, &mut base);
        let before = drive.api.files.len();
        sync(&pc, &mut drive, &mut base);
        assert_eq!(drive.api.files.len(), before);
    }

    #[test]
    fn itens_estranhos_no_drive_sao_ignorados() {
        let phone = Device::new();
        let mut base = SyncBase::default();
        let mut drive = DriveRemote::new(FakeDrive::default());
        drive.handle(Request::Notebooks).unwrap();
        let nb = drive.notebook_folder("rapidas").err();
        assert!(nb.is_some());
        drive.handle(Request::CreateNotebook { id: "rapidas".into(), name: "Rápidas".into() }).unwrap();
        let folder = drive.notebook_folder("rapidas").unwrap();
        let p = props(&[("nb", "rapidas"), ("sha256", "x")]);
        drive.api.create(NewFile { name: "../fuga.md", parent: Some(&folder), folder: false, props: p.clone() }, Some(b"!")).unwrap();
        drive.api.create(NewFile { name: "foto.png", parent: Some(&folder), folder: false, props: p }, Some(b"!")).unwrap();
        sync(&phone, &mut drive, &mut base);
        assert_eq!(fs::read_dir(phone.root("rapidas")).unwrap().count(), 0);
    }
}
