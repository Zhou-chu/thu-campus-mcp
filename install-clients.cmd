@echo off
setlocal
if exist "%~dp0.runtime\node.exe" (
  "%~dp0.runtime\node.exe" "%~dp0bin\thu-campus.mjs" install --unified --apply
) else (
  node "%~dp0bin\thu-campus.mjs" install --unified --apply
)
endlocal
