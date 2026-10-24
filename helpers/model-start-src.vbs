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

modelPath = base & "\models\Qwen2.5-7B-Instruct-Q4_K_M.gguf"
If Not fso.FileExists(modelPath) Then
  MsgBox "找不到模型文件：" & vbCrLf & modelPath, 16, "讲义笔记"
  WScript.Quit 1
End If

' -ngl 99 全部层放显卡；16K 上下文；KV 用 q8_0 省显存；--jinja 用模型自带对话模板
cmd = """" & exePath & """" & _
      " -m """ & modelPath & """" & _
      " -c 16384 -ngl 99 --flash-attn on -ctk q8_0 -ctv q8_0" & _
      " --host 127.0.0.1 --port 8080 --alias qwen2.5-7b -t 8 --jinja"
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
