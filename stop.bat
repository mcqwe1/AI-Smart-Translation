@echo off
rem stop the aifanyi backend listening on the given port (default 8080)
rem also stops the bundled ai-service python, which the backend starts on demand
rem (local transcription / voice activity detection / term embeddings). That child
rem process outlives the backend as an orphan; leaving it running keeps file handles
rem on ai-service\python, which makes the next repackage fail with "file in use".
rem NOTE: .bat files here must stay ASCII only - do not add non-ASCII chars.
setlocal
set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"
set "ROOT=%~dp0"

powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1; if($p){Stop-Process -Id $p -Force; Write-Host ('stopped backend pid ' + $p)}else{Write-Host 'aifanyi is not running (nothing to stop). To START the app, double-click start.bat'}"

rem Kill only the python bundled in THIS install directory - never a python the user
rem installed elsewhere. Matching on ExecutablePath under %ROOT% guarantees that.
powershell -NoProfile -Command "$root='%ROOT%'; $n=0; Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'OrdinalIgnoreCase') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $n++ } catch {} }; if($n -gt 0){Write-Host ('stopped ai-service python x' + $n)}"

pause
