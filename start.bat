@echo off
rem Double-click to start the Book Browser server and open the browser. Closing this window stops the server.
setlocal
cd /d "%~dp0"

rem Find node even when PATH has not been refreshed since installing Node.js
where node >nul 2>nul && goto :found
for %%D in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LOCALAPPDATA%\Programs\nodejs" "%APPDATA%\nvm\current" "%NVM_SYMLINK%") do (
  if not defined NODEDIR if exist "%%~D\node.exe" set "NODEDIR=%%~D"
)
if defined NODEDIR (
  set "PATH=%NODEDIR%;%PATH%"
  goto :found
)
echo Node.js was not found. Install the LTS version from https://nodejs.org and run this again.
echo If you just installed it, sign out of Windows (or restart) and try again.
start "" https://nodejs.org
pause
exit /b 1

:found
for /f "delims=" %%V in ('node -v') do echo Using Node.js %%V
if not exist node_modules (
  echo First run - installing packages...
  call npm install --omit=dev
)
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){Start-Sleep 1; try{Invoke-WebRequest -UseBasicParsing http://localhost:3456/api/millie/data -TimeoutSec 2 | Out-Null; Start-Process http://localhost:3456; break}catch{}}"
echo Starting Book Browser at http://localhost:3456 (close this window to stop it)
node server.js
pause
