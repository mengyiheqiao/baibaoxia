@echo off
chcp 65001 >nul
title Baibaoxia
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Please install it from https://nodejs.org
  echo.
  pause
  exit /b
)
node server.js
pause
