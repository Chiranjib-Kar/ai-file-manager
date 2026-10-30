@echo off
echo ========================================================
echo       Building Aegis AI File Manager Android APK
echo ========================================================
set "TC=C:\Users\HP\.gemini\antigravity\scratch\android-toolchain"
for /d %%i in ("%TC%\jdk\*") do set "JAVA_HOME=%%i"
for /d %%i in ("%TC%\gradle\*") do set "GRADLE_BIN=%%i\bin\gradle.bat"
set "ANDROID_HOME=%TC%\sdk"
set "ANDROID_SDK_ROOT=%TC%\sdk"

cd /d "%~dp0"
if not exist "app\keystore\aegis-release.jks" (
    mkdir "app\keystore" 2>nul
    "%JAVA_HOME%\bin\keytool.exe" -genkeypair -v -keystore "app\keystore\aegis-release.jks" -alias aegis -keyalg RSA -keysize 2048 -validity 10000 -storepass aegisvault -keypass aegisvault -dname "CN=Aegis Vault, OU=AI, O=Aegis, L=City, ST=State, C=US"
)
python sync_assets.py
call "%GRADLE_BIN%" assembleRelease --no-daemon
if exist "app\build\outputs\apk\release\app-release.apk" (
    copy /Y "app\build\outputs\apk\release\app-release.apk" "..\Aegis-AI-File-Manager.apk" >nul
    echo.
    echo APK built successfully: ..\Aegis-AI-File-Manager.apk
)
pause
