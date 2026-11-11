@echo off
setlocal
set "ROOT=%~dp0.."
if exist "%ROOT%\.runtime\node.exe" (
  "%ROOT%\.runtime\node.exe" "%ROOT%\desktop\launcher.mjs" %*
) else (
  node "%ROOT%\desktop\launcher.mjs" %*
)
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo 启动失败，退出码 %CODE%。日志：%USERPROFILE%\.thu-campus-mcp\app\desktop.log
  pause
)
endlocal & exit /b %CODE%