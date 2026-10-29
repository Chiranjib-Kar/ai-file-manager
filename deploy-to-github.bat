@echo off
echo ========================================================
echo        Push AI File Manager to GitHub for Render
echo ========================================================
echo.
set /p REPO_URL="Enter your GitHub Repository URL (e.g. https://github.com/username/ai-file-manager.git): "
if "%REPO_URL%"=="" (
    echo No URL entered. Exiting.
    pause
    exit /b
)

git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%
git branch -M main
git push -u origin main

echo.
echo ========================================================
echo Code pushed to GitHub successfully!
echo Now open https://dashboard.render.com/select-repo?type=web
echo and select this repository to deploy 24/7 on Render!
echo ========================================================
pause
