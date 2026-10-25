@echo off
setlocal
if exist "%~dp0.runtime\node.exe" (
  "%~dp0.runtime\node.exe" "%~dp0bin\thu-campus.mjs" browser login %*
) else (
  node "%~dp0bin\thu-campus.mjs" browser login %*
)
endlocal
