; Inno Setup: gera dist-app\Brito-<versão>-windows-x64-setup.exe
; Uso (depois de `node desktop/package.mjs`): iscc /DAppVersion=0.4.0 desktop\windows\brito.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
CloseApplications=yes
RestartApplications=no
AppId={{3C1F7B52-9E04-4D6A-8B1E-5A7D20C4F9E1}
AppName=Brito
AppVersion={#AppVersion}
AppPublisher=Wilson Brito
DefaultDirName={autopf}\Brito
DefaultGroupName=Brito
OutputDir=..\dist-app
OutputBaseFilename=Brito-{#AppVersion}-windows-x64-setup
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\Brito.exe
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Files]
Source: "..\dist-app\Brito\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\build\icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Brito"; Filename: "{app}\Brito.exe"; IconFilename: "{app}\icon.ico"
Name: "{autodesktop}\Brito"; Filename: "{app}\Brito.exe"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na Área de Trabalho"; Flags: unchecked

[Run]
Filename: "{app}\Brito.exe"; Description: "Abrir o Brito"; Flags: postinstall nowait
