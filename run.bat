@echo off
rem Stopmotion Clipper launcher: sets up on first run, then opens the app in your browser.
cd /d "%~dp0"
if not exist .venv (
  echo Creating Python environment...
  py -3.13 -m venv .venv || goto :error
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt || goto :error
)
if not exist frontend\dist\index.html (
  echo Building the interface...
  pushd frontend
  call npm install --no-audit --no-fund || goto :error
  call npm install-scripts approve esbuild >nul 2>&1
  call npm rebuild esbuild >nul 2>&1
  call npm run build || goto :error
  popd
)
set CLIPPER_OPEN_BROWSER=1
.venv\Scripts\python -m backend.app
pause
goto :eof
:error
echo Setup failed. See the messages above.
pause
