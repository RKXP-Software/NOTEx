# NOTEx 0.5 — Correções e melhorias (rascunho para aprovação)

A fase 5 (glossário) fica em espera.

## Causas encontradas

**Pasta/caderno excluído não some do Drive.** `remove_notebook` (lib.rs) só tira o caderno da lista local. No motor (`sync/engine.rs`, `sync_once`), um caderno que existe no Drive e não existe local é recriado localmente (linhas 91-96), e o Drive nunca recebe a ordem de apagar (não existe `Request` para apagar caderno). Falta um "túmulo": caderno que estava em `base.known`, sumiu local e ainda está no Drive → mover a pasta do caderno no Drive para a lixeira. Subpastas apagadas dentro de um caderno já têm caminho (`Rmdir`), mas só quando ficam vazias; será coberto por teste para confirmar.

**Teclado empurra a barra de funções.** O viewport usa `interactive-widget=resizes-content`, então o layout encolhe, mas a barra fica na rolagem do conteúdo e o WebView (Android) desloca a página. Correção: `html/body` com `position: fixed; height = visualViewport.height` (variável CSS atualizada por `visualViewport.resize`), a rolagem só dentro do editor.

## Itens

| # | Item | Abordagem | Tamanho |
|---|---|---|---|
| 1 | Excluir caderno apaga no Drive | `Request::DeleteNotebook` + túmulo no motor; teste no `FakeDrive`; ao excluir também oferecer "apagar os arquivos do disco?" | M |
| 2 | Teclado empurra o cabeçalho | Altura = `visualViewport`; barra fixa | P |
| 3 | ☰ e "+ nota" fixos, ferramentas de edição roláveis | Dividir a barra em duas partes: fixa à esquerda, `overflow-x:auto` à direita | P |
| 4 | Pinça só no editor | `touch-action: pan-x pan-y` fora do editor; no editor, pinça tratada em JS (muda o zoom do app) e `user-scalable=no` no viewport | M |
| 5 | Menu de funções +5% | Botões e fonte da barra (mobile e desktop) | P |
| 6 | Versão na barra de status | Mostra `v0.5.0` (lida do `package.json` no build) | P |
| 7 | Notas da versão | Janela "Novidades" (ícone na barra de status) + abre sozinha uma vez após atualizar; texto em `CHANGELOG.md` embutido no build | M |
| 8 | Versão portátil (Windows) | `.zip` com o `.exe` + arquivo `portable` ao lado: configuração e cadernos ficam na pasta do app; `npm run portable` gera o zip | M |
| 9 | Pasta privada com PIN | Ver perguntas | G |
| 10 | Outros serviços de nuvem (OneDrive) | Camada `DriveApi` já é um trait; adicionar `OneDriveApi` (Microsoft Graph, OAuth PKCE). Exige registro de app no Azure | G |

## Dúvidas (respostas)

1. **Sem internet:** sim. Tudo é gravado primeiro no disco local do aparelho. O que falhar no envio fica marcado como diferente da última sincronização e é enviado na próxima tentativa (a cada ~20 s com rede, ou ao abrir o app). Hoje não há aviso visual de "pendente/offline"; posso incluir no item 6/7.
2. **Celular pareado com o PC, com o Drive ligado:** não faz diferença para a sincronização; os dois falam só com o Drive. O pareamento só é necessário uma vez, para o celular receber o acesso ao Drive (e serve de plano B sem Drive). Dá para mudar para: o celular entrar no Drive por conta própria (login no próprio celular), sem precisar do PC.
3. **PC desligado:** sim, já funciona assim com o Drive: o celular grava no Drive; quando o PC liga, baixa tudo. Sem o Drive (conexão direta) não, porque o PC é o servidor. Limitação: o celular precisa estar com o app aberto para sincronizar.

## Decisões do usuário

- Pasta privada: PIN/biometria do aparelho no celular; senha do NOTEx no PC; **arquivos cifrados** (disco e Drive). Sem a senha não há recuperação.
- OneDrive e outras nuvens: **fora do escopo** (item 10 descartado).
- Celular continua dependendo do pareamento com o PC para receber o acesso ao Drive.

## Ordem proposta (versões)

- **0.4.2:** itens 1, 2, 3, 4, 5, 6 (correções e ajustes visuais).
- **0.5.0:** itens 7, 8, 9 (notas da versão, portátil, pasta privada).
- Depois: fase 5 (glossário).
