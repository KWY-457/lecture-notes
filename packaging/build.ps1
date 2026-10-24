# ===========================================================================
#  讲义笔记 LectureNotes —— 打包脚本
#
#  做什么：
#    1. 把要交付的文件挑出来，拷到 packaging\stage\
#    2. 把 helpers\*-src.vbs 转成 UTF-16LE 的 启动.vbs / 停止.vbs
#    3. 自检（node --check、启动器语法、必需文件齐全）
#    4. 有 Inno Setup 就顺手打出安装包
#
#  用法（PowerShell 7 / Windows PowerShell 5.1 都行）：
#      pwsh -File packaging\build.ps1              # 只准备 stage + 自检
#      pwsh -File packaging\build.ps1 -MakeInstaller   # 准备完再打安装包
#      pwsh -File packaging\build.ps1 -Clean       # 先清空 stage
#
#  为什么用「白名单」而不是「排除法」：
#    项目根目录里有 data（3.7G 模型和录音）、tests（1.4M）、_scratch、
#    .browser-profile（4.3G）——用排除法迟早漏一个，买家装完发现硬盘少 8G。
#    所以这里只列「必须带」的东西，别的一概不进去。
# ===========================================================================

[CmdletBinding()]
param(
    [switch]$MakeInstaller,
    [switch]$Clean,
    [string]$Iscc = ""
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# ---- 路径 ----------------------------------------------------------------
$PackDir = $PSScriptRoot
$Root    = Split-Path -Parent $PackDir
$Stage   = Join-Path $PackDir 'stage'
$OutDir  = Join-Path $PackDir 'output'

function Say([string]$msg, [string]$color = 'Gray') {
    Write-Host $msg -ForegroundColor $color
}
function Step([string]$msg) {
    Write-Host "`n== $msg ==" -ForegroundColor Cyan
}
function Die([string]$msg) {
    Write-Host "`n[打包失败] $msg" -ForegroundColor Red
    exit 1
}

Say "项目根目录：$Root" 'DarkGray'
Say "打包产物目录：$Stage" 'DarkGray'

if (-not (Test-Path (Join-Path $Root 'server.mjs'))) {
    Die "在 $Root 下没找到 server.mjs —— 这个脚本必须放在 packaging\ 子目录里"
}

# ---- 0. 清理 -------------------------------------------------------------
if ($Clean -and (Test-Path $Stage)) {
    Step '0/4 清理旧的 stage'
    Remove-Item $Stage -Recurse -Force
    Say "已删除 $Stage"
}

# ---- 1. 拷文件（白名单） --------------------------------------------------
Step '1/4 拷贝程序文件'

$null = New-Item -ItemType Directory -Force -Path $Stage

# 单文件：源相对路径 -> stage 里放哪
$Files = @(
    @{ From = 'server.mjs';            To = 'server.mjs' },
    @{ From = 'docx.mjs';              To = 'docx.mjs' },
    @{ From = 'start.cmd';             To = 'start.cmd' },
    @{ From = 'README.md';             To = 'README.md' },
    @{ From = 'LICENSE.txt';           To = 'LICENSE.txt' },
    @{ From = 'PRIVACY.txt';           To = 'PRIVACY.txt' }
)

# 目录：整个目录拷过去，但要排掉不该带的东西
# 显式列出每个目录的排除项，public 也要排除 —— 里面的 *.bak-* 是改代码前的
# 备份，不该发给买家（而且会让安装包多出几百 KB 和一堆看不懂的文件）。
#
# docs 用白名单（Include）而不是黑名单：
#   quality-report.md 里有真实讲次的标题（「思想道德法治」「工程制图」）、
#   时长、模型名和一整章质量分析，是给作者自己看的东西，不该发给买家。
#   底层数据流诊断.md 同理是内部文档。所以 docs 只发 API接入教程.md，
#   以后要发别的就显式加进来 —— 新增的内部文档不会被顺手带出去。
#
# 排除项的匹配注意：下面用的是 `$rel -like $pat`，$rel 是相对路径且带反斜杠
# （例如 research\00-调研大纲.md）。所以「排除整个目录」必须写成 research\*，
# 只写 research 是匹配不上的 —— 之前就踩过这个坑，stage\docs\research\ 里
# 那 10 份内部调研文档一直被悄悄拷进去。
$Dirs = @(
    @{ From = 'public';             To = 'public';             Exclude = @('*.bak*', '*.orig', '*.tmp', '.DS_Store') },
    @{ From = 'helpers';            To = 'helpers';            Exclude = @('local-llm-path.txt', '*.bak*') },
    @{ From = 'docs';               To = 'docs';               Include = @('API接入教程.md') }
)

$copiedBytes = 0
foreach ($f in $Files) {
    $src = Join-Path $Root $f.From
    if (-not (Test-Path $src)) { Die "缺少必需文件：$($f.From)" }
    $dst = Join-Path $Stage $f.To
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst)
    Copy-Item $src $dst -Force
    $copiedBytes += (Get-Item $src).Length
    Say "  $($f.From)"
}

foreach ($d in $Dirs) {
    $src = Join-Path $Root $d.From
    if (-not (Test-Path $src)) { Die "缺少必需目录：$($d.From)" }
    $dst = Join-Path $Stage $d.To
    $null = New-Item -ItemType Directory -Force -Path $dst
    Get-ChildItem $src -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($src.Length + 1)
        if ($d.ContainsKey('Include')) {
            # 有 Include 就只认白名单（相对路径或文件名任一匹配即可），
            # 没有才走 Exclude。两套同时写没有意义，白名单更保守。
            $keep = $false
            foreach ($pat in $d.Include) {
                if ($rel -like $pat -or $_.Name -like $pat) { $keep = $true; break }
            }
            $keep
        } else {
            $keep = $true
            foreach ($pat in $d.Exclude) {
                if ($rel -like $pat -or $_.Name -like $pat) { $keep = $false; break }
            }
            $keep
        }
    } | ForEach-Object {
        $rel = $_.FullName.Substring($src.Length + 1)
        $target = Join-Path $dst $rel
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)
        Copy-Item $_.FullName $target -Force
        $copiedBytes += $_.Length
    }
    $n = (Get-ChildItem $dst -Recurse -File | Measure-Object).Count
    Say "  $($d.From)\ ($n 个文件)"
}

# ---- Node 运行时 ----------------------------------------------------------
$NodeExe = Join-Path $Root 'runtime\node.exe'
if (-not (Test-Path $NodeExe)) {
    Die @"
没找到 runtime\node.exe。

买家机器上不一定装了 Node.js，所以必须把 node.exe 一起带上。
先用项目里的 bundle-runtime.py 把它复制过来：

    python bundle-runtime.py

它会从本机的 DSH 运行时里挑一个 node.exe 放进 runtime\。
"@
}
$rtDst = Join-Path $Stage 'runtime'
$null = New-Item -ItemType Directory -Force -Path $rtDst
Copy-Item $NodeExe (Join-Path $rtDst 'node.exe') -Force
$copiedBytes += (Get-Item $NodeExe).Length
Say ("  runtime\node.exe  ({0:N1} MB)" -f ((Get-Item $NodeExe).Length / 1MB))

# ---- 2. 启动器转 UTF-16LE -------------------------------------------------
Step '2/4 生成启动器（UTF-16LE）'

# VBScript 在中文 Windows 上默认按 ANSI 读 .vbs，源码里有中文就必须写成
# UTF-16LE + BOM，否则双击会报「无效字符」。这个转换每次打包都要重做。
$VbsPairs = @(
    @{ From = 'helpers\launcher-src.vbs';  To = '启动.vbs' },
    @{ From = 'helpers\stop-src.vbs';      To = '停止.vbs' }
)
foreach ($v in $VbsPairs) {
    $src = Join-Path $Root $v.From
    if (-not (Test-Path $src)) { Die "缺少启动器模板：$($v.From)" }
    $text = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::UTF8)
    $dst = Join-Path $Stage $v.To
    [System.IO.File]::WriteAllText($dst, $text, [System.Text.UnicodeEncoding]::new($false, $true))
    $len = (Get-Item $dst).Length
    $head = [System.IO.File]::ReadAllBytes($dst)[0..1]
    if ($head[0] -ne 0xFF -or $head[1] -ne 0xFE) { Die "$($v.To) 没有写成 UTF-16LE（头部应为 FFFE）" }
    Say ("  {0}  ({1:N0} 字节, UTF-16LE)" -f $v.To, $len)
}

# ---- 3. 自检 -------------------------------------------------------------
Step '3/4 自检'

# 3.1 必需文件齐全（和 .iss 里的 [Files] 一一对应）
$Required = @(
    'server.mjs', 'docx.mjs', 'start.cmd', 'runtime\node.exe',
    '启动.vbs', '停止.vbs', 'README.md', 'LICENSE.txt', 'PRIVACY.txt',
    'public\index.html', 'public\app.js', 'public\app.css',
    'public\transcript.js', 'public\note.js', 'public\summarize.js',
    'helpers\launcher-src.vbs', 'helpers\stop-src.vbs', 'helpers\lecture-notes.ico',
    'docs\API接入教程.md'
)
$missing = @()
foreach ($r in $Required) {
    if (-not (Test-Path (Join-Path $Stage $r))) { $missing += $r }
}
if ($missing.Count -gt 0) {
    Die ("stage 里缺这些文件：`n  " + ($missing -join "`n  "))
}
Say "  必需文件齐全（$($Required.Count) 项）" 'Green'

# 3.2 服务端语法
$nodeForCheck = if (Test-Path $NodeExe) { $NodeExe } else { 'node' }
& $nodeForCheck --check (Join-Path $Stage 'server.mjs') 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'stage\server.mjs 语法检查没通过' }
& $nodeForCheck --check (Join-Path $Stage 'docx.mjs') 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'stage\docx.mjs 语法检查没通过' }
Say "  server.mjs / docx.mjs 语法 OK" 'Green'

# 3.3 启动器是合法 VBScript
#
#    别用 cscript //X 做这个检查 —— 那个开关是「用调试器启动」，会真的把
#    启动器跑起来：起服务、建 data\instance.json、弹出浏览器窗口。第一次
#    写这个脚本就踩了，stage 里凭空多出 61M 的 .browser-profile。
#
#    改成静态检查：UTF-16LE 头、大小合理、关键语句在、没有明显的引号不配对。
foreach ($vbs in @('启动.vbs', '停止.vbs')) {
    $p = Join-Path $Stage $vbs
    $bytes = [System.IO.File]::ReadAllBytes($p)
    if ($bytes.Length -lt 1000) { Die "$vbs 只有 $($bytes.Length) 字节，太小了，不像完整的启动器" }
    if ($bytes[0] -ne 0xFF -or $bytes[1] -ne 0xFE) { Die "$vbs 不是 UTF-16LE" }

    $text = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    # 中文 Windows 的 wscript 遇到语法错误只会弹个看不懂的框，所以这里先挡一遍
    foreach ($need in @('WScript.Shell', 'WScript.ScriptFullName')) {
        if ($text -notmatch [regex]::Escape($need)) { Die "$vbs 里缺少关键语句：$need" }
    }
    # 引号必须成对（VBScript 用双引号，一行内的双引号数必须是偶数）
    $lineNo = 0
    foreach ($line in ($text -split "`r?`n")) {
        $lineNo++
        if ($line.TrimStart().StartsWith("'")) { continue }   # 整行注释
        # 去掉行内的注释（简单处理：不在引号里的单引号后面都是注释）
        $inQ = $false; $q = 0; $kept = ''
        foreach ($ch in $line.ToCharArray()) {
            if ($ch -eq '"') { $inQ = -not $inQ; $q++ }
            if ($ch -eq "'" -and -not $inQ) { break }
            $kept += $ch
        }
        if ($q % 2 -ne 0) { Die "$vbs 第 $lineNo 行双引号没配对：$line" }
    }
}
Say "  启动.vbs / 停止.vbs 结构检查 OK" 'Green'

# 3.4 stage 里绝不能出现用户数据
foreach ($forbidden in @('data\lectures', 'data\models', 'data\config.json', 'data\instance.json', '.browser-profile', 'tests', '_scratch')) {
    if (Test-Path (Join-Path $Stage $forbidden)) {
        Die "stage 里混进了不该发的东西：$forbidden（会泄漏你的录音/Key/模型缓存）"
    }
}
Say "  没有混入用户数据" 'Green'

# 3.4b stage 里也不能出现备份/临时文件
#
#     第一次打包就漏了：public\ 里躺着 app.js.bak-20261019-1830 这类改代码前
#     的备份，一起被塞进安装包，多出几百 KB 还让买家看到一堆莫名其妙的名字。
#     这里按文件名兜底，不管它来自哪个目录。
$junk = Get-ChildItem $Stage -Recurse -File | Where-Object {
    $_.Name -match '\.(bak|orig|tmp|swp|log)$' -or $_.Name -match '\.bak-' -or $_.Name -eq '.DS_Store' -or $_.Name -match '~$'
}
if ($junk.Count -gt 0) {
    $list = ($junk | ForEach-Object { '    ' + $_.FullName.Substring($Stage.Length + 1) }) -join "`n"
    Die "stage 里混进了备份/临时文件，不该发给买家：`n$list"
}
Say "  没有混入备份/临时文件" 'Green'

# 3.4d docs\ 里只能有白名单允许的文件
#
#     docs 是白名单拷贝（见上面 $Dirs），这里兜底核一遍：stage\docs\ 里
#     多出任何东西都拦下来。quality-report.md 有真实讲次标题和时长，
#     底层数据流诊断.md 是内部文档，research\ 是调研笔记 —— 都只给作者自己看。
$docsSrc = Join-Path $Root 'docs'
$docsAllow = ($Dirs | Where-Object { $_.From -eq 'docs' }).Include
$docsGot = @(Get-ChildItem (Join-Path $Stage 'docs') -Recurse -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring((Join-Path $Stage 'docs').Length + 1) })
$docsBad = @($docsGot | Where-Object { $r = $_; -not ($docsAllow | Where-Object { $r -eq $_ }) })
if ($docsBad.Count -gt 0) {
    Die "stage\docs\ 里出现了不该发的文件：`n  " + ($docsBad -join "`n  ") + "`n（白名单只有：$($docsAllow -join '、')）"
}
Say "  docs\ 只带了 $($docsGot -join '、')" 'Green'

# 3.4c 绝不能把签名私钥打进安装包
#
#     授权码是用 RSA 私钥签的，公钥写死在 public\license.js 里。
#     私钥一旦跟着安装包发出去，买家能自己签任意授权码 —— 试用/激活就形同虚设。
#     现在 packaged 用的是白名单（private-keys\ 不在名单里），但将来谁要是
#     把私钥挪进 public\ 或 helpers\，白名单会一声不响地把它带上。
#     所以按文件名和内容双重兜底。
$keyFiles = Get-ChildItem $Stage -Recurse -File | Where-Object {
    $_.Name -match '\.(pem|pfx|p12|key)$' -or $_.Name -match 'private' -or $_.Name -match '私钥'
}
if ($keyFiles.Count -gt 0) {
    $list = ($keyFiles | ForEach-Object { '    ' + $_.FullName.Substring($Stage.Length + 1) }) -join "`n"
    Die "stage 里混进了私钥/证书文件，绝对不能发给买家：`n$list`n（私钥在项目根的 private-keys\，白名单不会带它，但请确认下面这些是不是误放的）"
}
# 再按内容查一遍：PEM 私钥的头是 RSA PRIVATE KEY / PRIVATE KEY
foreach ($f in (Get-ChildItem $Stage -Recurse -File -Include '*.js', '*.txt', '*.json', '*.md')) {
    $head = [System.IO.File]::ReadAllText($f.FullName)
    if ($head -match '-----BEGIN (RSA )?PRIVATE KEY-----') {
        Die "文件里嵌了私钥，绝对不能发给买家：$($f.FullName.Substring($Stage.Length + 1))"
    }
}
Say "  没有混入签名私钥" 'Green'

# 3.6 版本号一致（server.mjs 的 VERSION 和 .iss 的 AppVersion 必须是同一个）
$ssSrc = Get-Content (Join-Path $Stage 'server.mjs') -Raw -Encoding UTF8
if ($ssSrc -notmatch "const VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'") {
    Die '在 server.mjs 里找不到 const VERSION = ''x.y.z'';'
}
$srvVer = $Matches[1]
$issSrc = Get-Content (Join-Path $PackDir 'lecture-notes.iss') -Raw -Encoding UTF8
if ($issSrc -notmatch '#define\s+AppVersion\s+"([0-9]+\.[0-9]+\.[0-9]+)"') {
    Die '在 lecture-notes.iss 里找不到 #define AppVersion "x.y.z"'
}
$issVer = $Matches[1]
if ($srvVer -ne $issVer) {
    Die @"
版本号对不上：
    server.mjs            VERSION    = $srvVer
    lecture-notes.iss     AppVersion = $issVer
两处必须一致，否则安装包写的版本和界面里 /api/health 报的版本不是一个东西。
"@
}
Say "  版本号一致：$srvVer" 'Green'

# 3.5 体积
$stageSize = (Get-ChildItem $Stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
$stageCount = (Get-ChildItem $Stage -Recurse -File | Measure-Object).Count
Say ("  stage 合计：{0} 个文件，{1:N1} MB" -f $stageCount, ($stageSize / 1MB)) 'Green'

# ---- 4. 打安装包 ---------------------------------------------------------
if ($MakeInstaller) {
    Step '4/4 调用 Inno Setup'

    if (-not $Iscc) {
        $candidates = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
            (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'),
            (Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'),
            # winget 装的是「当前用户」范围，落在这里而不是 Program Files
            (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
            # 免安装版：把 Inno Setup 的 zip/解包目录放到这里也能用
            (Join-Path $env:TEMP 'inno605\ISCC.exe'),
            (Join-Path $PackDir 'inno\ISCC.exe')
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
        # 注意别写成 $candidates.Count —— 只有一个命中时它是 String，.Count 在
        # 老版本 PowerShell 上不报错但也不可靠，用 @() 包一层最稳。
        $candidates = @($candidates)
        if ($candidates.Count -gt 0) { $Iscc = $candidates[0] }
        if (-not $Iscc) { Say "  （找过这些位置都没命中：$($candidates.Count) 个候选）" 'DarkGray' }
    }
    if (-not $Iscc -or -not (Test-Path -LiteralPath $Iscc)) {
        Die @"
没找到 Inno Setup 的编译器 ISCC.exe。

装一个就行（免费，离线也能用）：
    winget install JRSoftware.InnoSetup

装完重跑：
    pwsh -File packaging\build.ps1 -MakeInstaller

或者手动指定路径：
    pwsh -File packaging\build.ps1 -MakeInstaller -Iscc "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"

（stage\ 已经准备好了，手动用 Inno Setup 打开 packaging\lecture-notes.iss 点 Build 也一样。）
"@
    }

    $null = New-Item -ItemType Directory -Force -Path $OutDir
    Say "  编译器：$Iscc"
    & $Iscc (Join-Path $PackDir 'lecture-notes.iss') 2>&1 | ForEach-Object { Say "    $_" }
    if ($LASTEXITCODE -ne 0) { Die "ISCC 打安装包失败（退出码 $LASTEXITCODE）" }

    $exe = Get-ChildItem $OutDir -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $exe) { Die 'ISCC 说成功了，但 output\ 里没有 .exe —— 检查 .iss 里的 OutputDir' }
    Say ("`n安装包：{0}  ({1:N1} MB)" -f $exe.FullName, ($exe.Length / 1MB)) 'Green'
} else {
    Step '4/4 跳过打安装包'
    Say '  要打安装包加 -MakeInstaller：' 'DarkGray'
    Say '      pwsh -File packaging\build.ps1 -MakeInstaller' 'DarkGray'
}

Say "`n完成。" 'Green'
