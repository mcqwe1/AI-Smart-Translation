@echo off
rem aifanyi portable launcher (ASCII only - do not add non-ASCII chars to .bat files)
setlocal EnableExtensions
set "ROOT=%~dp0"
set "AIFANYI_PORT=8080"
if not "%~1"=="" set "AIFANYI_PORT=%~1"
set "AIFANYI_STORAGE_ROOT=%ROOT%data"
set "FFMPEG_PATH=%ROOT%bin\ffmpeg.exe"
if not exist "%ROOT%data" mkdir "%ROOT%data"

rem per-install random JWT secret, generated on first run
if not exist "%ROOT%data\jwt.secret" (
  powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N') | Set-Content -NoNewline -Encoding ascii '%ROOT%data\jwt.secret'"
)
set /p AIFANYI_JWT_SECRET=<"%ROOT%data\jwt.secret"

rem already running? just open the browser
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',%AIFANYI_PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
if %errorlevel%==0 (
  echo aifanyi already running on port %AIFANYI_PORT%, opening browser...
  start "" http://localhost:%AIFANYI_PORT%/
  goto :eof
)

echo Starting aifanyi on port %AIFANYI_PORT% ... first start may take ~20s
cd /d "%ROOT%"
set "LOGFILE=%ROOT%data\backend-%AIFANYI_PORT%.log"
start "aifanyi-backend" /min cmd /c ""%ROOT%runtime\bin\java.exe" -Xms512m -Xmx2048m -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -Dserver.address=127.0.0.1 "-DAIFANYI_PORT=%AIFANYI_PORT%" -jar "%ROOT%app\aifanyi.jar" > "%LOGFILE%" 2>&1"

powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',%AIFANYI_PORT%);$c.Close();exit 0}catch{Start-Sleep 1}};exit 1" >nul 2>nul
if not %errorlevel%==0 (
  echo Backend did not start within 90 seconds. Check data\backend-%AIFANYI_PORT%.log
  pause
  goto :eof
)
echo Ready. Opening http://localhost:%AIFANYI_PORT%/  (demo account: demo / demo123)
start "" http://localhost:%AIFANYI_PORT%/
endlocal
