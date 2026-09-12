@echo off
rem One-time setup for the local Whisper service (ai-service) - SLIM EDITION ONLY.
rem The FULL edition ships with a built-in runtime (ai-service\python) and does
rem NOT need this script at all - local Whisper works out of the box.
rem Needs Python 3.10 - 3.12 installed (python.org). Downloads ~300MB (CPU).
setlocal EnableExtensions
set "ROOT=%~dp0"

if exist "%ROOT%ai-service\python\python.exe" (
  echo This package already ships a built-in runtime ^(ai-service\python^).
  echo Local Whisper works out of the box - no setup needed.
  pause
  exit /b 0
)

set "PYCMD="
py -3.12 --version >nul 2>nul && set "PYCMD=py -3.12"
if not defined PYCMD py -3.11 --version >nul 2>nul && set "PYCMD=py -3.11"
if not defined PYCMD py -3.10 --version >nul 2>nul && set "PYCMD=py -3.10"
if not defined PYCMD (
  echo Python 3.10 / 3.11 / 3.12 not found.
  echo Install Python 3.12 from https://www.python.org/downloads/ first
  echo ^(check "Add python.exe to PATH" and "py launcher" during install^).
  pause
  exit /b 1
)

echo Using %PYCMD%
cd /d "%ROOT%ai-service"
%PYCMD% -m venv .venv
if errorlevel 1 (echo venv creation failed & pause & exit /b 1)
rem use Tsinghua PyPI mirror: much faster and reliable inside China
set "PIP_MIRROR=-i https://pypi.tuna.tsinghua.edu.cn/simple"
.venv\Scripts\python -m pip install --upgrade pip %PIP_MIRROR%
.venv\Scripts\python -m pip install %PIP_MIRROR% fastapi "uvicorn[standard]" "faster-whisper>=1.1.0" "edge-tts>=6.1.0"
if errorlevel 1 (echo pip install failed, check network & pause & exit /b 1)

rem NVIDIA GPU detected? Install CUDA runtime libs automatically (~600MB) so GPU
rem acceleration works out of the box. Skipped on machines without nvidia-smi.
where nvidia-smi >nul 2>nul
if not errorlevel 1 (
  echo.
  echo NVIDIA GPU detected - installing CUDA runtime libs for GPU acceleration...
  .venv\Scripts\python -m pip install %PIP_MIRROR% nvidia-cublas-cu12 nvidia-cudnn-cu12
  if errorlevel 1 (
    echo CUDA libs install failed - will run in CPU mode. You can retry later with:
    echo   ai-service\.venv\Scripts\python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
  ) else (
    echo GPU acceleration ready.
  )
)

echo.
echo Setup done ^(CPU mode^). To enable NVIDIA GPU ^(CUDA 12^) acceleration, also run:
echo   ai-service\.venv\Scripts\python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
echo.
echo That's all. The recognition service now STARTS AUTOMATICALLY when you
echo translate with "Local Whisper" - no need to run anything manually.
echo ^(run-ai-service.bat remains as a manual fallback.^)
echo Whisper models download automatically on first use ^(via China mirror^).
pause
