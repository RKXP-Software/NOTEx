; Ganchos do instalador do NOTEx (NSIS, Tauri).
;
; Instalação "para todos os usuários": cria as pastas compartilhadas e dá permissão de
; modificação ao grupo Usuários (SID S-1-5-32-545). Sem isso, a pasta criada pelo primeiro
; usuário ficaria só para leitura para os demais.
;   C:\ProgramData\NOTEx                 configuração compartilhada (cadernos, sessão, Drive, pareamento)
;   C:\Users\Public\Documents\NOTEx      cadernos padrão compartilhados

!macro NSIS_HOOK_POSTINSTALL
  ${If} $MultiUser.InstallMode == "AllUsers"
    ReadEnvStr $0 PROGRAMDATA
    CreateDirectory "$0\NOTEx"
    nsExec::Exec 'icacls "$0\NOTEx" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
    Pop $1
    ReadEnvStr $0 PUBLIC
    CreateDirectory "$0\Documents\NOTEx"
    nsExec::Exec 'icacls "$0\Documents\NOTEx" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
    Pop $1
  ${EndIf}
!macroend

; Desinstalação com "apagar dados do aplicativo" marcado, numa instalação para todos os usuários:
; remove também a configuração compartilhada. As notas (Documentos Públicos\NOTEx) nunca são apagadas.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $MultiUser.InstallMode == "AllUsers"
    ReadEnvStr $0 PROGRAMDATA
    RMDir /r "$0\NOTEx"
  ${EndIf}
!macroend
