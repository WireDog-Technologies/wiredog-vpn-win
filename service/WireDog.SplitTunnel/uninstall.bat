@echo off
:: WireDog Split Tunnel Driver - Uninstall Script
:: Must be run as Administrator

echo Uninstalling WireDog Split Tunnel Driver...

:: Check for admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    pause
    exit /b 1
)

:: Stop the driver
sc stop WireDogSplitTunnel >nul 2>&1
timeout /t 2 /nobreak >nul

:: Delete the service
sc delete WireDogSplitTunnel >nul 2>&1

:: Remove driver file
del /f "%SystemRoot%\System32\drivers\WireDogSplitTunnel.sys" >nul 2>&1

echo.
echo WireDog Split Tunnel Driver uninstalled successfully.
echo.
pause
