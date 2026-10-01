@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限：请右键本脚本，选择"以管理员身份运行"。
  pause
  exit /b 1
)
schtasks /Delete /TN "ChessServerAutoStart" /F
echo 已移除开机自启任务（不影响当前正在运行的服务）。
pause
