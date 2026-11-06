@echo off
rem thu-campus-mcp keepalive: headless re-login for learnx (scheduled task thu-campus-mcp-keepalive)
"%ProgramFiles%\nodejs\node.exe" "D:\code\thu-campus-mcp\bin\thu-campus.mjs" browser restore learnx >> "%USERPROFILE%\.thu-campus-mcp\keepalive.log" 2>&1
