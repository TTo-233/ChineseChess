@echo off
chcp 65001 >nul
cd /d "%~dp0"
:loop
where node >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] 未检测到 node，请确认 Node.js 已安装并加入系统 PATH，60秒后重试 >> server-watchdog.log
  timeout /t 60 /nobreak >nul
  goto loop
)
echo [%date% %time%] ===== 启动中国象棋服务端 ===== >> server-watchdog.log
node dist\index.js >> server-watchdog.log 2>&1
echo [%date% %time%] 服务已退出(code %errorlevel%)，5秒后自动重启 >> server-watchdog.log
timeout /t 5 /nobreak >nul
goto loop
