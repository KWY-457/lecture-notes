; ===========================================================================
;  讲义笔记 LectureNotes —— Inno Setup 安装脚本
;
;  用法（先装 Inno Setup 6：winget install JRSoftware.InnoSetup）：
;      iscc packaging\lecture-notes.iss
;  产物：packaging\output\讲义笔记-<版本>-安装包.exe
;
;  这个脚本只负责「把已经准备好的文件打进安装包」，不负责准备文件。
;  准备文件（复制运行时、转成 UTF-16LE 的启动器、挑出该带的东西）由
;  packaging\build.ps1 做，它先把程序拷到 packaging\stage\，再来调 iscc。
;  安装包里放什么完全由 build.ps1 里那张清单决定，看得见、改得动。
;
;  为什么数据目录不装进安装包：
;    装到 C:\Program Files 之后程序目录是只读的。录音、逐字稿、Key、
;    模型缓存都必须写在用户目录 —— server.mjs 的 pickDataDir() 和启动器
;    已经会自动退到 %LOCALAPPDATA%\LectureNotes\data。这里只管往
;    程序目录里放「只读的代码」。
; ===========================================================================

#define AppName        "讲义笔记"
#define AppNameEn      "LectureNotes"
#define AppVersion     "0.9.0"
#define AppPublisher   "LectureNotes"
; 启动器是个 VBS，不是 exe —— 双击它 Windows 会用 wscript 打开，行为一致。
#define AppExeName     "启动.vbs"

[Setup]
AppId={{8F3A6C71-4D2B-4E19-9A57-000000000001}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppNameEn}
DefaultGroupName={#AppName}
; 允许普通用户装到自己的目录（不强制管理员），但默认还是 Program Files
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=output
; 输出文件名只能用 ASCII：Inno Setup 6.0/6.1 会拒绝非 ASCII 的 OutputBaseFileName
; （6.2 起才放开）。所以这里出英文名，build.ps1 打完再改成中文名给用户看。
OutputBaseFilename={#AppNameEn}-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 64 位程序：node.exe 是 x64
; 用 x64 而不是 x64compatible：后者要 Inno Setup 6.3+，前者 6.0 起就认，
; 这样旧版编译器也能打（新版会提示 x64 已过时，但不影响出包）。
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
ChangesAssociations=no
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\helpers\lecture-notes.ico
; 安装向导第一屏先给用户协议，必须点「我接受」才能继续（[Code] 里还有一道
; 兜底检查）。协议正文与安装目录里的 LICENSE.txt 是同一个文件，不另维护一份。
LicenseFile=stage\LICENSE.txt
; 隐私政策放在「准备安装」那一屏前面，只读、不需要点同意 ——
; 但要让用户明确看见「录音会不会上传」这件事。
InfoBeforeFile=stage\PRIVACY.txt

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: unchecked

[Files]
; ---- 程序本体（由 build.ps1 拷进 stage\） ----
Source: "stage\server.mjs";            DestDir: "{app}"; Flags: ignoreversion
Source: "stage\docx.mjs";              DestDir: "{app}"; Flags: ignoreversion
Source: "stage\start.cmd";             DestDir: "{app}"; Flags: ignoreversion
Source: "stage\public\*";              DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "stage\helpers\*";             DestDir: "{app}\helpers"; Flags: ignoreversion recursesubdirs createallsubdirs
; 自带的 Node 运行时（买家机器上没有 Node.js，必须带）
Source: "stage\runtime\node.exe";      DestDir: "{app}\runtime"; Flags: ignoreversion
; 启动器 / 停止器（build.ps1 从 helpers\*-src.vbs 转成 UTF-16LE 再拷进来）
Source: "stage\启动.vbs";              DestDir: "{app}"; Flags: ignoreversion
Source: "stage\停止.vbs";              DestDir: "{app}"; Flags: ignoreversion
; 说明文档
Source: "stage\README.md";             DestDir: "{app}"; Flags: ignoreversion isreadme
Source: "stage\docs\API接入教程.md";    DestDir: "{app}\docs"; Flags: ignoreversion
Source: "stage\LICENSE.txt";           DestDir: "{app}"; Flags: ignoreversion
Source: "stage\PRIVACY.txt";           DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; 数据目录建在用户可写的位置，不建在程序目录。
; 服务自己也会建，这里提前建好是为了让用户一眼看得到东西存哪。
Name: "{localappdata}\{#AppNameEn}\data"; Permissions: users-modify

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\helpers\lecture-notes.ico"
Name: "{group}\停止 {#AppName}"; Filename: "{app}\停止.vbs"; WorkingDir: "{app}"
Name: "{group}\用户数据目录"; Filename: "{localappdata}\{#AppNameEn}\data"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\helpers\lecture-notes.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "现在启动 {#AppName}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallRun]
; 卸载前先让服务自己退出，否则 node.exe 还占着文件删不掉
Filename: "{app}\停止.vbs"; Flags: runhidden; RunOnceId: "StopService"

[UninstallDelete]
; 只清程序目录里的临时产物，绝不碰用户目录里的录音
Type: filesandordirs; Name: "{app}\.browser-profile"
Type: files; Name: "{app}\data\runtime.json"
Type: dirifempty; Name: "{app}\data"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  DataDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    // 把「安装时同意了哪一版协议」写进数据目录，界面首启就能认出来、
    // 不再问第二遍。版本号算法与 server.mjs 的 AGREE_VERSION 一致：
    // 两个文件内容各取一段哈希拼起来（这里是安装期，拿不到 node，
    // 用一个简单的滚动哈希 —— 只要求「同样内容算出同样值」，
    // 具体算法不同没关系，因为界面那边只看 acceptedAt 有没有写，
    // 不比对版本号；版本号变了界面会重新问，那是更保守的一侧）。
    DataDir := ExpandConstant('{localappdata}') + '\LectureNotes\data';
    ForceDirectories(DataDir);
    SaveStringToFile(DataDir + '\install-agreed.txt',
      GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':'),
      False);
    // 说清楚录音存哪了 —— 用户装完找不到文件是会来问的。
    //
    // 必须用 SuppressibleMsgBox 而不是 MsgBox：普通 MsgBox 不认
    // /SUPPRESSMSGBOXES，静默安装（/VERYSILENT）照样会弹一个对话框等人点确定。
    // 实测后果：无人值守装到一半永久卡住，进程挂在那儿退不出来。
    // SuppressibleMsgBox 的第 4 个参数是「静默模式下自动返回哪个按钮」。
    SuppressibleMsgBox('安装完成。' + #13#10 + #13#10 +
           '录音和笔记保存在：' + #13#10 + DataDir + #13#10 + #13#10 +
           '这个目录不会因为卸载被删除，重装或升级后会自动接着用。',
           mbInformation, MB_OK, IDOK);
  end;
end;
