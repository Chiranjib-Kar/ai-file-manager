@echo off
echo ========================================================
echo        Starting Aegis AI File Manager
echo ========================================================
echo.
echo Checking dependencies...
python -c "import fastapi, uvicorn, pypdf, docx" >nul 2>&1
if errorlevel 1 (
    echo Installing missing requirements...
    python -m pip install -r requirements.txt
)
echo.
echo Launching Server on http://localhost:8000 ...
echo Press Ctrl+C in this window to stop the server.
echo.
start "" http://localhost:8000
python app.py
pause
