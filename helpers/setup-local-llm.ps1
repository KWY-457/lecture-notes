# ============================================================
#  讲义笔记 —— 本地大模型一键部署 / 修复
#
#  作用：把 llama.cpp 运行时和启动脚本装到指定目录，
#        并让「讲义笔记」的启动器知道去哪找它。
#
#  用法（普通 PowerShell 窗口即可，不需要管理员）：
#      powershell -ExecutionPolicy Bypass -File helpers\setup-local-llm.ps1
#
#  想装到别处（比如 D 盘）就加 -AiHome：
#      powershell -ExecutionPolicy Bypass -File helpers\setup-local-llm.ps1 -AiHome D:\AI
#
#  可以重复运行，不会重复下载（文件已存在就跳过）。
# ============================================================
param(
  # 不传就自动选：数据目录下 local-llm（一定可写）→ 项目目录下 local-llm → 用户目录
  # 早期版本默认写死 D:\Download\AI，买家没有 D 盘就直接失败。
  [string]$AiHome = "",
  [string]$Tag = "b11057",
  [string]$ModelFile = "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
  [switch]$KeepZips
)

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot          # 项目根目录
$utf16 = [System.Text.UnicodeEncoding]::new($false, $true)

function Say($m) { Write-Host "  $m" }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

# ------------------------------------------------------------
#  选安装位置
#
#  顺序有讲究：数据目录排第一，因为它是运行中的服务真正写数据的地方，
#  一定是可写的（不可写服务根本起不来）。项目目录排第二是为了兼容
#  「绿色版解压在桌面」的老用户；用户目录兜底，防止整个盘都只读。
# ------------------------------------------------------------
function Pick-AiHome {
  $candidates = @()
  # 服务把数据目录写进 runtime.json，从那里反推最准
  $runtime = Join-Path $proj "data\runtime.json"
  if (Test-Path $runtime) {
    try {
      $j = Get-Content $runtime -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.dataDir) { $candidates += (Join-Path $j.dataDir "local-llm") }
    } catch { }
  }
  $candidates += (Join-Path $proj "data\local-llm")
  $candidates += (Join-Path $proj "local-llm")
  $home_ = $env:LOCALAPPDATA
  if (-not $home_) { $home_ = $env:USERPROFILE }
  $candidates += (Join-Path $home_ "LectureNotes\local-llm")

  foreach ($c in $candidates) {
    try {
      New-Item -ItemType Directory -Force -Path $c | Out-Null
      # 真的写一个文件试一下 —— 目录存在不等于能写
      $probe = Join-Path $c ".write-test"
      [System.IO.File]::WriteAllText($probe, "ok")
      Remove-Item $probe -Force
      return $c
    } catch { continue }
  }
  throw "找不到可写的目录来安装本地模型。请用 -AiHome 指定一个你有写权限的位置，例如：`n  -AiHome D:\AI"
}

if (-not $AiHome) { $AiHome = Pick-AiHome }

Step "1/5 检查目录"
foreach ($d in @("$AiHome\runtime", "$AiHome\models", "$AiHome\logs")) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Say "AI 目录: $AiHome"
if ($AiHome -match '\s') {
  Say "⚠ 路径里有空格，通常没问题（脚本都加了引号），但个别旧版 llama.cpp 会踩坑"
}

Step "2/5 解压运行时（如果还没解压）"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zips = @{
  "$AiHome\runtime\llama-$Tag-bin-win-vulkan-x64.zip" = "$AiHome\runtime\vulkan"
  "$AiHome\runtime\llama-$Tag-bin-win-cuda-13.4-x64.zip" = "$AiHome\runtime\cuda"
  "$AiHome\runtime\cudart-llama-bin-win-cuda-13.4-x64.zip" = "$AiHome\runtime\cuda"
}
foreach ($zip in $zips.Keys) {
  $dir = $zips[$zip]
  if (-not (Test-Path $zip)) { Say "缺少 $([System.IO.Path]::GetFileName($zip))（跳过）"; continue }
  if (Test-Path "$dir\llama-server.exe") { Say "$([System.IO.Path]::GetFileName($dir)) 已解压（跳过）"; continue }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dir)
  Say "已解压 -> $dir"
}

Step "3/5 生成启动/停止脚本（UTF-16LE，中文不乱码）"
$jobs = @(
  @{ src = "$proj\helpers\model-start-src.vbs"; dst = "$AiHome\start-llm.vbs" },
  @{ src = "$proj\helpers\model-stop-src.vbs";  dst = "$AiHome\stop-llm.vbs" }
)
foreach ($j in $jobs) {
  if (-not (Test-Path $j.src)) { throw "缺少模板 $($j.src)" }
  $text = [System.IO.File]::ReadAllText($j.src, [System.Text.Encoding]::UTF8)
  [System.IO.File]::WriteAllText($j.dst, $text, $utf16)
  Say "已生成 $($j.dst)"
}
# 旧版本用过中文文件名，清掉避免混淆
foreach ($old in @("$AiHome\启动本地模型.vbs", "$AiHome\停止本地模型.vbs")) {
  if (Test-Path $old) { Remove-Item $old -Force; Say "已移除旧文件 $([System.IO.Path]::GetFileName($old))" }
}

Step "4/5 告诉应用去哪找本地模型"
# 指针文件必须保持纯 ASCII：VBScript 端按 ASCII 读它。
# 写两处：数据目录（主，装到 Program Files 也能写）+ 项目 helpers（兼容旧位置）。
$launcher = "$AiHome\start-llm.vbs"
$pointers = @()
$runtime = Join-Path $proj "data\runtime.json"
if (Test-Path $runtime) {
  try {
    $j = Get-Content $runtime -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($j.dataDir) { $pointers += (Join-Path $j.dataDir "local-llm-path.txt") }
  } catch { }
}
$pointers += (Join-Path $proj "data\local-llm-path.txt")
$pointers += "$proj\helpers\local-llm-path.txt"
# 去重：数据目录就是项目目录时（绿色版），上面两条是同一个文件，
# 不去重会连着写两遍、日志里也重复两行，看着像写错了地方。
$pointers = @($pointers | Select-Object -Unique)
foreach ($p in $pointers) {
  try {
    $dir = Split-Path -Parent $p
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    [System.IO.File]::WriteAllText($p, $launcher, [System.Text.ASCIIEncoding]::new())
    Say "已写入 $p"
  } catch {
    Say "（跳过 $p —— 这里写不进去，服务会自己扫目录找）"
  }
}

Step "5/5 检查模型文件"
$model = "$AiHome\models\$ModelFile"
if (Test-Path $model) {
  $mb = [math]::Round((Get-Item $model).Length / 1MB, 1)
  $fs = [System.IO.File]::OpenRead($model)
  $buf = New-Object byte[] 4
  [void]$fs.Read($buf, 0, 4); $fs.Close()
  $magic = [System.Text.Encoding]::ASCII.GetString($buf)
  if ($magic -eq "GGUF") { Say "模型 OK: $ModelFile ($mb MB)" }
  else { Say "⚠ 模型文件头不是 GGUF，可能没下完（$mb MB）" }
} else {
  Say "⚠ 还没有模型文件，请下载到 $model"
  Say "  例如： curl -L -C - -o `"$model`" https://hf-mirror.com/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/$ModelFile"
  Say "  （约 4.4GB。没有模型也能用，只是「AI 润色」会退回离线引擎。）"
}

if (-not $KeepZips) {
  $freed = 0
  foreach ($zip in $zips.Keys) {
    if (Test-Path $zip) { $freed += (Get-Item $zip).Length; Remove-Item $zip -Force }
  }
  if ($freed -gt 0) { Say "已删除下载的压缩包，释放 $([math]::Round($freed/1MB,0)) MB" }
}

Write-Host "`n完成。本地模型装在：$AiHome" -ForegroundColor Green
Write-Host "现在打开「讲义笔记」，设置里点「启动本地大模型」就能用。" -ForegroundColor Green
Write-Host "占用：模型约 4.4GB 磁盘 + 约 6GB 显存（随时可以在设置里停掉释放显存）`n" -ForegroundColor Gray
