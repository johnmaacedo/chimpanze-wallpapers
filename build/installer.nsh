; Chimpanzé Wallpapers: installer page with the requirements and the optional AI packages.
; The ticked packages are written to %LOCALAPPDATA%\ChimpanzeWallpapers\install-components.txt;
; the app downloads them on first start (electron/components.js). Unticked ones can be
; downloaded later in Ajustes -> Recursos de IA.
!include nsDialogs.nsh
!include LogicLib.nsh

; Everything below exists only in the installer (the uninstaller is built from the same script).
!ifndef BUILD_UNINSTALLER
Var CwDlg
Var CwChkDepth
Var CwChkUp
Var CwChkSam
Var CwDepth
Var CwUp
Var CwSam

!macro customInit
  StrCpy $CwDepth ${BST_CHECKED}
  StrCpy $CwUp ${BST_CHECKED}
  StrCpy $CwSam ${BST_CHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom CwComponentsPage CwComponentsLeave
!macroend

Function CwComponentsPage
  nsDialogs::Create 1018
  Pop $CwDlg
  ${If} $CwDlg == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 44u "Requisitos: Windows 10 ou 11 de 64 bits. Para as funções de IA, placa de vídeo com DirectX 12 (NVIDIA recomendada) e internet para baixar os recursos abaixo. Opcional: o app do ChatGPT (Microsoft Store) para Expandir/Editar com o ChatGPT e uma conta do YouTube para a música dos wallpapers."
  Pop $0
  ${NSD_CreateLabel} 0 48u 100% 20u "Recursos de IA (baixados pelo app na primeira vez que ele abrir). Desmarque o que não quiser agora: dá para baixar depois em Ajustes > Recursos de IA."
  Pop $0
  ${NSD_CreateCheckbox} 8u 72u 100% 12u "Profundidade 3D, recorte de personagens e piscar dos olhos (295 MB)"
  Pop $CwChkDepth
  ${NSD_SetState} $CwChkDepth $CwDepth
  ${NSD_CreateCheckbox} 8u 88u 100% 12u "Upscale 4K com IA (244 MB)"
  Pop $CwChkUp
  ${NSD_SetState} $CwChkUp $CwUp
  ${NSD_CreateCheckbox} 8u 104u 100% 12u "Clique mágico no recorte (111 MB)"
  Pop $CwChkSam
  ${NSD_SetState} $CwChkSam $CwSam
  ${NSD_CreateLabel} 0 124u 100% 20u "A IA local de expansão (cerca de 12 GB, placa com 12 GB de vídeo) é baixada dentro do app, no Editor."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function CwComponentsLeave
  ${NSD_GetState} $CwChkDepth $CwDepth
  ${NSD_GetState} $CwChkUp $CwUp
  ${NSD_GetState} $CwChkSam $CwSam
FunctionEnd

!macro customInstall
  CreateDirectory "$LOCALAPPDATA\ChimpanzeWallpapers"
  FileOpen $9 "$LOCALAPPDATA\ChimpanzeWallpapers\install-components.txt" w
  ${If} $CwDepth == ${BST_CHECKED}
    FileWrite $9 "depth$\r$\n"
  ${EndIf}
  ${If} $CwUp == ${BST_CHECKED}
    FileWrite $9 "upscale$\r$\n"
  ${EndIf}
  ${If} $CwSam == ${BST_CHECKED}
    FileWrite $9 "sam$\r$\n"
  ${EndIf}
  FileClose $9
!macroend
!endif
