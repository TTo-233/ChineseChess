@echo off
chcp 65001 >nul
title 中国象棋服务端
if "%PORT%"=="" set PORT=9091
echo ============================================
echo   中国象棋服务端  端口: %PORT%
echo ============================================
node dist\index.js
echo.
echo 服务已退出。
pause
