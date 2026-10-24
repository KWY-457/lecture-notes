' ============================================================
'  讲义笔记 —— 本地大模型服务（停止）
'  双击即可。没在跑也不会报错。
' ============================================================
Option Explicit

Dim wmi, procs, p, n
n = 0
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='llama-server.exe'")
For Each p In procs
  p.Terminate()
  n = n + 1
Next
On Error GoTo 0

If n > 0 Then
  MsgBox "已关闭本地大模型服务（" & n & " 个进程），显存已释放。", 64, "讲义笔记"
Else
  MsgBox "本地大模型服务没有在运行。", 64, "讲义笔记"
End If
