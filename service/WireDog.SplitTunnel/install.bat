@echo off
:: WireDog Split Tunnel Driver - Install Script
:: Must be run as Administrator

echo Installing WireDog Split Tunnel Driver...

:: Check for admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    pause
    exit /b 1
)

:: Get script directory
set SCRIPT_DIR=%~dp0

:: Check if driver file exists
if not exist "%SCRIPT_DIR%WireDogSplitTunnel.sys" (
    echo ERROR: WireDogSplitTunnel.sys not found in %SCRIPT_DIR%
    pause
    exit /b 1
)

:: Stop existing service if running
sc stop WireDogSplitTunnel >nul 2>&1
timeout /t 2 /nobreak >nul

:: Delete existing service if present
sc delete WireDogSplitTunnel >nul 2>&1

:: Copy driver to System32\drivers
copy /y "%SCRIPT_DIR%WireDogSplitTunnel.sys" "%SystemRoot%\System32\drivers\" >nul
if %errorLevel% neq 0 (
    echo ERROR: Failed to copy driver file.
    pause
    exit /b 1
)

:: Create the service (demand-start kernel driver)
sc create WireDogSplitTunnel type= kernel start= demand binPath= "%SystemRoot%\System32\drivers\WireDogSplitTunnel.sys" DisplayName= "WireDog Split Tunnel Driver"
if %errorLevel% neq 0 (
    echo ERROR: Failed to create service.
    pause
    exit /b 1
)

:: Start the driver
sc start WireDogSplitTunnel
if %errorLevel% neq 0 (
    echo WARNING: Failed to start driver. Check test signing is enabled.
    echo Run: bcdedit /set testsigning on
    pause
    exit /b 1
)

echo.
echo WireDog Split Tunnel Driver installed and started successfully.
echo.
pause
