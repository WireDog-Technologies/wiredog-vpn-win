@echo off
REM WireDog Service Uninstallation Script
REM Must be run as Administrator

setlocal

set SERVICE_NAME=WireDogVPNService

echo Uninstalling %SERVICE_NAME%...

REM Stop the service
echo Stopping service...
sc stop %SERVICE_NAME% >nul 2>&1
timeout /t 3 /nobreak >nul

REM Delete the service
echo Removing service...
sc delete %SERVICE_NAME%
if %ERRORLEVEL% neq 0 (
    echo WARNING: Failed to delete service (may not exist)
)

REM Clean up WireGuard tunnel if exists
echo Cleaning up WireGuard tunnel...
"C:\Program Files\WireGuard\wireguard.exe" /uninstalltunnelservice WireDog >nul 2>&1

REM Clean up config directory (optional - keep logs for troubleshooting)
REM rmdir /s /q "%ProgramData%\WireDog" >nul 2>&1

echo.
echo Service uninstalled.
echo.
echo Note: Log files remain at %ProgramData%\WireDog\logs\
echo Delete manually if not needed.

endlocal
