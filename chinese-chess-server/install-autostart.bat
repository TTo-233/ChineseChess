@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限：请右键本脚本，选择"以管理员身份运行"。
  pause
  exit /b 1
)
set "TASKNAME=ChessServerAutoStart"
set "RUNNER=%~dp0run-server.bat"
schtasks /Create /TN "%TASKNAME%" /TR "\"%RUNNER%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 (
  echo 创建开机自启任务失败，请确认已以管理员身份运行。
) else (
  echo 已创建开机自启任务：%TASKNAME%
  echo 之后每次开机都会自动启动服务端；进程异常退出也会被 run-server.bat 自动拉起。
  echo 立即测试：schtasks /Run /TN "%TASKNAME%"
  echo 查看状态：schtasks /Query /TN "%TASKNAME%"
)
pause
