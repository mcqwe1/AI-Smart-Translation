@echo off
rem start the local Whisper service on port 8001 (manual fallback - it normally
rem AUTO-STARTS when you translate with "Local Whisper", no need to run this).
setlocal
cd /d "%~dp0ai-service"
if exist python\python.exe (
  python\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
) else if exist .venv\Scripts\python.exe (
  .venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
) else (
  echo No local runtime found. Full edition ships with ai-service\python built in;
  echo for the slim edition, run setup-ai-service.bat first.
  pause
  exit /b 1
)
pause
