@echo off
rem ===========================================================================
rem  诊断用：模拟「双击 启动.vbs 后，start.cmd 在后台跑」的环境
rem
rem  动机：启动器把一个隐藏窗口的 start.cmd 拉起来，如果它 90 秒内没就绪，
rem  VBS 只会弹一句「后台服务没能启动起来」，看不到真正的报错。
rem  这里用一个「普通用户」的 PATH（不带任何 DSH_* 变量）跑同一份 start.cmd，
rem  把输出全部记下来 —— 这就能看到双击时到底发生了什么。
rem
rem  注意：本文件里一律写死绝对 ASCII 路径，不要用 %~dp0。
rem  %~dp0 会展开出中文路径（项目在 D:\Download\dev 下，上一级目录名是中文），
rem  中文落在批处理文件里会让 cmd.exe 按字节偏移重新定位时错位，
rem  结果整份脚本被切碎成 "'xxx' 不是内部或外部命令"。
rem ===========================================================================
setlocal

> "D:\Download\dev\_scratch\startcmd-diag.log" echo ==== 1. 环境检查 ====
>> "D:\Download\dev\_scratch\startcmd-diag.log" echo PATH=%PATH%
>> "D:\Download\dev\_scratch\startcmd-diag.log" echo NODE_EXE=%NODE_EXE%

>> "D:\Download\dev\_scratch\startcmd-diag.log" echo ==== 2. where node ====
where node >> "D:\Download\dev\_scratch\startcmd-diag.log" 2>&1
if errorlevel 1 >> "D:\Download\dev\_scratch\startcmd-diag.log" echo [where node] 找不到 node

>> "D:\Download\dev\_scratch\startcmd-diag.log" echo ==== 3. start.cmd 输出 ====
call "D:\Download\dev\lecture-notes\start.cmd" >> "D:\Download\dev\_scratch\startcmd-diag.log" 2>&1
>> "D:\Download\dev\_scratch\startcmd-diag.log" echo ==== 4. start.cmd 退出码 %ERRORLEVEL% ====
exit /b 0
