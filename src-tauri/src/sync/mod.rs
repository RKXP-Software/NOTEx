// Sincronização PC ↔ celular pela rede local (Fase 3).
//
// O PC é o servidor (http.rs, só desktop); o celular é o cliente e roda o motor de três vias
// (engine.rs): compara a versão local, a do PC e a da última sincronização de cada arquivo.

pub mod client;
pub mod drive;
pub mod engine;
pub mod google;
pub mod proto;
pub mod store;

#[cfg(desktop)]
pub mod http;

use proto::{NotebookInfo, Request, Response, b64_decode, b64_encode};
use std::path::PathBuf;

/// Um lado da sincronização: os cadernos de um aparelho.
pub trait Host {
    fn notebooks(&self) -> Vec<(NotebookInfo, PathBuf)>;
    /// Cria (ou devolve, se já existe) o caderno com esse id.
    fn create_notebook(&self, id: &str, name: &str) -> Result<PathBuf, String>;
    /// Tira o caderno da lista (os arquivos ficam).
    fn forget_notebook(&self, id: &str);
    /// Arquivos alterados/removidos por uma sincronização (atualiza a interface).
    fn changed(&self, changed: Vec<PathBuf>, removed: Vec<PathBuf>);
}

fn root_of(host: &dyn Host, id: &str) -> Result<PathBuf, String> {
    host.notebooks()
        .into_iter()
        .find(|(n, _)| n.id == id)
        .map(|(_, p)| p)
        .ok_or_else(|| "Caderno não encontrado no PC.".to_string())
}

/// Atende uma requisição já decifrada (todas menos Pair e Wait, tratadas na camada HTTP).
pub fn handle(host: &dyn Host, req: Request) -> Response {
    match handle_inner(host, req) {
        Ok(r) => r,
        Err(message) => Response::Error { message },
    }
}

fn handle_inner(host: &dyn Host, req: Request) -> Result<Response, String> {
    Ok(match req {
        Request::Notebooks => {
            Response::Notebooks { list: host.notebooks().into_iter().map(|(n, _)| n).collect() }
        }
        Request::CreateNotebook { id, name } => {
            if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                return Err("Id de caderno inválido.".into());
            }
            host.create_notebook(&id, &name)?;
            Response::Ok
        }
        Request::DeleteNotebook { id } => {
            host.forget_notebook(&id);
            Response::Ok
        }
        Request::Manifest { notebook } => Response::Manifest { manifest: store::manifest(&root_of(host, &notebook)?) },
        Request::Get { notebook, path } => {
            Response::File { data: b64_encode(&store::read(&root_of(host, &notebook)?, &path)?) }
        }
        Request::Put { notebook, path, data, expected } => {
            let root = root_of(host, &notebook)?;
            let current = store::current_hash(&root, &path)?;
            if current != expected {
                return Ok(Response::Conflict { current });
            }
            let abs = store::write(&root, &path, &b64_decode(&data)?)?;
            host.changed(vec![abs], vec![]);
            Response::Ok
        }
        Request::Delete { notebook, path, expected } => {
            let root = root_of(host, &notebook)?;
            let current = store::current_hash(&root, &path)?;
            if current.as_deref() != Some(expected.as_str()) {
                return Ok(Response::Conflict { current });
            }
            let abs = store::trash(&root, &path)?;
            host.changed(vec![], vec![abs]);
            Response::Ok
        }
        Request::Mkdir { notebook, path } => {
            store::mkdir(&root_of(host, &notebook)?, &path)?;
            Response::Ok
        }
        Request::Rmdir { notebook, path } => {
            store::rmdir_if_empty(&root_of(host, &notebook)?, &path)?;
            Response::Ok
        }
        Request::Pair { .. } | Request::Wait { .. } | Request::DriveCredentials => return Err("Requisição fora de contexto.".into()),
    })
}
