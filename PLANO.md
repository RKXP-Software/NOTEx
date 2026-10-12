# NOTEx — Planejamento

Bloco de notas leve para Windows e Android, com abas, grade de colunas/linhas, cadernos, edição visual (WYSIWYG), sincronização por Wi-Fi e Google Drive, e glossário/busca global.

Base de referência: MDR (`F:\DESENVOLVIMENTO\Claude\MDR`) — reaproveitar interface em TypeScript, tema claro/escuro, CSS, e portar para Rust a lógica de arquivos (detecção UTF-8/Windows-1252, BOM, CRLF/LF, gravação atômica).

## Decisões

| Tema | Decisão |
|---|---|
| Tecnologia | **Tauri 2** (núcleo Rust + interface web/TypeScript, sem framework de UI, como o MDR). Um código para Windows (.exe/NSIS) e Android (APK) |
| Editor | **WYSIWYG** (TipTap/ProseMirror) para `.md`: negrito, itálico, títulos, listas, checklists, citações, parágrafos/espaçamento. Barra de formatação + atalhos. Grava Markdown por baixo |
| `.txt` | Editor de texto puro (CodeMirror 6, como no MDR) |
| Organização | **Vários cadernos** (pastas independentes, com subpastas) + caderno padrão **"Rápidas"** |
| Nota rápida | `Ctrl+N` cria na hora no caderno "Rápidas", sem pedir nome; nome derivado da 1ª linha (ou data/hora). Pode ser movida para outro caderno depois |
| Salvamento | **Automático** (alguns ms após parar de digitar) + **sessão restaurada** (abas, grade, posição do cursor) |
| Layout desktop | Abas em **grade livre**: dividir horizontal e verticalmente, cada painel com seu grupo de abas, arrastar abas entre painéis |
| Layout celular | **Abas no topo**, um painel por vez, lista de cadernos/notas em menu lateral |
| Celular | Ler, editar, criar e apagar notas |
| Sincronização | **Wi-Fi local** (PC ↔ celular na mesma rede) e **Google Drive**. Sem Bluetooth |
| Glossário | **Busca em tudo** (ocorrências em todos os cadernos, com trecho e link) + **Termos definidos** (dicionário consultável) |
| Nome | NOTEx |
| Versionamento | Git + GitHub `RKXP-Software/NOTEx` (privado) |

## Arquitetura

```
src/                 Interface (TypeScript, Vite) — compartilhada entre desktop e Android
  editor/            WYSIWYG (TipTap) para .md, CodeMirror para .txt
  layout/            Grade de painéis + abas (desktop) / abas simples (mobile)
  notebooks/         Árvore de cadernos e notas
  search/            UI de busca global e glossário
  sync/              UI de pareamento (QR), status, conflitos
src-tauri/           Núcleo Rust
  files.rs           Ler/gravar (codificação, BOM, EOL, gravação atômica) — portado do MDR
  notebooks.rs       Cadernos, notas rápidas, mover/renomear, observar alterações em disco
  session.rs         Persistência de sessão (abas, grade)
  index.rs           Índice de busca (texto completo) + termos do glossário
  sync/
    manifest.rs      Estado por arquivo: hash, data, versão base da última sincronização
    engine.rs        Motor comum: compara manifestos, decide enviar/receber/conflito
    lan.rs           Transporte Wi-Fi: servidor HTTP no PC, descoberta mDNS, pareamento por QR+token
    gdrive.rs        Transporte Google Drive: OAuth, pasta "NOTEx" no Drive
```

### Sincronização (um motor, dois transportes)

1. Cada caderno tem um manifesto: `caminho → hash do conteúdo, data, hash da última versão sincronizada`.
2. Comparando os três (local, remoto e base), o motor decide: só mudou aqui → envia; só mudou lá → recebe; mudou nos dois → **conflito**.
3. Conflito nunca perde texto: mantém as duas versões (`nota (conflito – celular 2026-10-12).md`) e avisa na interface.
4. Exclusões viram registros de "apagado" no manifesto, para não ressuscitarem.
5. **Wi-Fi:** o PC roda um servidor local (porta configurável). O pareamento é feito uma vez por QR code (IP + token). Depois o celular acha o PC sozinho via mDNS e sincroniza ao abrir o app, a cada alteração ou por botão. Comunicação autenticada pelo token; só rede local.
6. **Google Drive:** login Google (OAuth) nos dois aparelhos, pasta `NOTEx/` no Drive. Funciona fora de casa. Exige um projeto gratuito no Google Cloud Console (guiado na fase 4).

### Glossário

- **Termos definidos:** um arquivo `Glossário.md` por caderno (ou geral), no formato `**Termo**: definição`. Também é detectada a sintaxe `Termo:: definição` em qualquer nota. Fica consultável num painel de dicionário com busca incremental.
- **Busca em tudo:** índice de texto completo atualizado ao salvar. Ignora acentos e maiúsculas/minúsculas e mostra o trecho com o termo destacado.

## Fases

| # | Entrega | Critério de pronto |
|---|---|---|
| 0 | Ambiente: Rust, Tauri CLI, Android SDK/NDK; projeto Tauri criado; git + GitHub | `npm run tauri dev` abre janela; build Android "olá mundo" instala no celular |
| 1 | **Desktop núcleo**: cadernos, nota rápida, abas, grade de painéis, editor WYSIWYG (.md) e texto (.txt), salvamento automático, sessão, tema claro/escuro, instalador | Uso diário possível no Windows; instalador < 15 MB |
| 2 | **Android**: mesma interface adaptada (abas no topo, menu de cadernos), armazenamento local dos cadernos | APK instalado, cria/edita notas offline |
| 3 | **Sincronização Wi-Fi**: motor + transporte LAN + pareamento QR + conflitos | Editar no celular aparece no PC e vice-versa; conflito gera cópia |
| 4 | **Google Drive**: OAuth + transporte Drive | Sincroniza fora da rede local |
| 5 | **Glossário**: busca global + termos definidos | Busca em todos os cadernos em < 200 ms para ~milhares de notas |

Cada fase tem testes automatizados (Vitest na interface, `cargo test` no Rust), como no MDR.

## Riscos e observações

- **WYSIWYG e Markdown escrito à mão:** ao abrir um `.md` criado em outro editor, o NOTEx pode normalizar a sintaxe ao salvar (ex.: `*itálico*` → `_itálico_`, espaçamento de listas). O conteúdo é preservado; só a forma do Markdown muda. Haverá um modo "Markdown cru" por aba para quem quiser editar o código.
- **Android e pastas:** no celular, os cadernos ficam no armazenamento do app. Exportar ou compartilhar `.md`/`.txt` é feito pelo menu "Compartilhar" do Android.
- **Wi-Fi:** o Firewall do Windows vai pedir permissão na primeira vez. Algumas redes públicas e corporativas bloqueiam a comunicação entre aparelhos; nesse caso, use o Google Drive ou o hotspot do celular.
- **Instalação:** Rust (~1,5 GB) + Android SDK/NDK (~5 GB) + Android Studio (opcional).
