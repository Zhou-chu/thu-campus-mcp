@echo off
rem thu-campus-mcp keepalive: daily headless re-login for all campus services (scheduled task thu-campus-mcp-keepalive)
"%ProgramFiles%\nodejs\node.exe" "D:\code\thu-campus-mcp\bin\thu-campus.mjs" browser restore all >> "%USERPROFILE%\.thu-campus-mcp\keepalive.log" 2>&1
