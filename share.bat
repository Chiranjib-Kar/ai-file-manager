@echo off
echo ========================================================
echo       Launching Aegis AI File Manager with Public Share
echo ========================================================
echo.
echo Starting local server on 0.0.0.0:8000...
start "Aegis Server" /min cmd /c "python app.py"

echo Waiting 2 seconds for server to start...
timeout /t 2 /nobreak >nul

echo Starting Cloudflare Public Tunnel...
echo.
echo ========================================================
echo Look for the 'https://....trycloudflare.com' link below:
echo ========================================================
echo.
cloudflared.exe tunnel --url http://127.0.0.1:8000
pause
