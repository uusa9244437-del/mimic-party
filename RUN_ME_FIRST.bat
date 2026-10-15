@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===============================================
echo  QALLIDHA! - Mimic Party MVP
echo ===============================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\express\package.json (
  echo Installing the required packages for the first run...
  call npm install
  if errorlevel 1 (
    echo Package installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
echo Starting the game server...
echo Open http://localhost:3000 in Chrome or Edge.
echo Keep this window open while playing.
call npm start
pause
