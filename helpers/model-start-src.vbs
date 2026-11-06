' ============================================================
'  讲义笔记 —— 本地大模型服务（启动）
'
'  在后台拉起 llama.cpp 的 llama-server，供「讲义笔记」的
'  「AI 版笔记」功能使用。不弹黑框。
'
'  想省钱/省显存不想跑模型时，不要双击这个文件即可。
'  关闭：双击「停止本地模型.vbs」。
' ============================================================
Option Explicit

Dim sh, fso, base, url, exePath, modelPath, cmd, wmi, procs
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
url  = "http://127.0.0.1:8080"

If Healthy(url) Then WScript.Quit 0        ' 已经在跑了

' 双保险：两个启动器同时双击时，上面的 Health 检查可能同时失手
' （都以为还没起来），于是拉起两个 llama-server 把内存吃双份。
' 这里再按进程名查一遍：已经有一个在跑就直接退出，杜绝双开。
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE Name='llama-server.exe'")
If procs.Count > 0 Then WScript.Quit 0

' 后端优先级：CUDA（若可用）> Vulkan
exePath = base & "\runtime\cuda\llama-server.exe"
If Not fso.FileExists(base & "\runtime\cuda\cudart64_13.dll") Then
  exePath = base & "\runtime\vulkan\llama-server.exe"
End If
If Not fso.FileExists(exePath) Then
  MsgBox "找不到 llama-server.exe，请先运行项目里的 helpers\setup-local-llm.ps1 完成部署。", 16, "讲义笔记"
  WScript.Quit 1
End If

' ------------------------------------------------------------
' 加载哪个 gguf？
'
' 一次只能装一个模型，所以「用哪档」记在 models\active-model.txt 里，
' 每行一个文件名（相对 models\ 目录），# 开头是注释。服务端切模型时
' 只改这个文件、再调一次本脚本 —— 不用给 wscript 传参，用户双击
' 这个 vbs 也照样能用（那是这个文件唯一的对外接口）。
'
' 读不到、或者文件里写的那个 gguf 不在，就退回 7B —— 老部署没这个
' 文件，不能让升级一下就把本地大模型弄没了。
' ------------------------------------------------------------
Dim ptrFile, want
modelPath = ""
ptrFile = base & "\models\active-model.txt"
If fso.FileExists(ptrFile) Then
  Dim ts, ln
  Set ts = fso.OpenTextFile(ptrFile, 1)
  Do While Not ts.AtEndOfStream
    ln = Trim(ts.ReadLine)
    If Len(ln) > 0 And Left(ln, 1) <> "#" Then
      want = ln
      Exit Do
    End If
  Loop
  ts.Close
  If Len(want) > 0 Then
    If fso.FileExists(base & "\models\" & want) Then
      modelPath = base & "\models\" & want
    End If
  End If
End If
If Len(modelPath) = 0 Then
  modelPath = base & "\models\Qwen2.5-7B-Instruct-Q4_K_M.gguf"
End If
If Not fso.FileExists(modelPath) Then
  MsgBox "找不到模型文件：" & vbCrLf & modelPath & vbCrLf & vbCrLf & _
         "请在软件的「设置 → ⑤ 环境自检」里重新部署本地模型。", 16, "讲义笔记"
  WScript.Quit 1
End If

' 别名取文件名去掉后缀，纯粹为了 /v1/models 和日志里能看出装的是哪个。
' llama-server 其实不校验请求里的 model 字段（实测：随便写也回 200），
' 所以这个名字不影响调用。
Dim aliasName
aliasName = fso.GetFileName(modelPath)
If InStrRev(aliasName, ".") > 0 Then aliasName = Left(aliasName, InStrRev(aliasName, ".") - 1)

' 16K 上下文；KV 用 q8_0 省显存；--jinja 用模型自带对话模板。
'
' ⚠ 这里**故意不写 -ngl**（不给「把所有层都放显卡」这个指令）。
' 2026-11-06 实测：14B 在 8GB 显存上，一句 -ngl 99 会让 llama.cpp 的自动
' 分层直接放弃 —— 日志原文
'   common_fit_params: failed to fit params to free device memory:
'   n_gpu_layers already set by user to 99, abort
' 然后它退化成「大部分层跑 CPU」，速度掉到 1.05 tok/s（生成 164 个 token
' 花了 5 分 21 秒）。同一台机器、同一个模型，不给 -ngl 让它自己算：
' 6.50 tok/s，快 6 倍。
' 而小模型完全不受影响（实测 3B 104.7 vs 100.0、7B 62.4 vs 56.7，
' 显存占用一模一样）—— 显存够的时候它照样会全部层上显卡。
' 一句话：显存够就全上显卡，不够就自己挑一个能塞下的层数，都别管。
cmd = """" & exePath & """" & _
      " -m """ & modelPath & """" & _
      " -c 16384 --flash-attn on -ctk q8_0 -ctv q8_0" & _
      " --host 127.0.0.1 --port 8080 --alias """ & aliasName & """ -t 8 --jinja"
sh.CurrentDirectory = base
sh.Run cmd, 0, False

' ------------------------------------------------------------
Function Healthy(u)
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.Open "GET", u & "/health", False
  http.Send
  Healthy = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function
