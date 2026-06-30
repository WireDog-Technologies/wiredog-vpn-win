@echo off
REM WireDog Service Installation Script
REM Must be run as Administrator

setlocal

set SERVICE_NAME=WireDogVPNService
set SERVICE_DISPLAY=WireDog VPN Service
set SERVICE_DESC=WireDog VPN Service - Manages VPN connections and kill switch
set SERVICE_EXE=%~dp0..\WireDog.Service.exe

echo Installing %SERVICE_NAME%...

REM Stop existing service if running
sc stop %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul

REM Delete existing service if exists
sc delete %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul

REM Create the service
sc create %SERVICE_NAME% binPath= "%SERVICE_EXE%" start= auto DisplayName= "%SERVICE_DISPLAY%"
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to create service
    exit /b 1
)

REM Set service description
sc description %SERVICE_NAME% "%SERVICE_DESC%"

REM Configure service recovery (restart on failure)
sc failure %SERVICE_NAME% reset= 86400 actions= restart/5000/restart/10000/restart/30000

REM Set service to run as LocalSystem (default, but explicit)
sc config %SERVICE_NAME% obj= LocalSystem

REM Start the service
echo Starting %SERVICE_NAME%...
sc start %SERVICE_NAME%
if %ERRORLEVEL% neq 0 (
    echo WARNING: Service created but failed to start
    echo Check Event Viewer for details
    exit /b 1
)

echo.
echo Service installed and started successfully!
echo.
echo Service Name: %SERVICE_NAME%
echo Log Location: %ProgramData%\WireDog\logs\

endlocal
