# WireDog VPN - Windows Application

Copyright (c) 2026 WireDog Technologies

[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/Electron-latest-blue.svg)](https://www.electronjs.org)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](https://www.microsoft.com/windows)
[![.NET 8](https://img.shields.io/badge/.NET-8-purple.svg)](https://dotnet.microsoft.com)

## Features

- **WireGuard VPN Protocol** - Modern, efficient, and secure VPN implementation
- **Secure Authentication** - Email/password and anonymous account options
- **Kill Switch** - Prevents data leaks if VPN connection drops
- **Always-On Kill Switch** - Persistent protection across disconnects and reboots
- **DNS & IPv6 Leak Protection** - Ensures all traffic stays private
- **Server Selection** - Choose from multiple VPN servers with favorites and recents
- **Subscription Management** - Built-in subscription validation and management
- **Privileged Backend Service** - Isolated Windows Service with minimal attack surface

## Requirements

- **OS**: Windows 10 or later (64-bit)
- **Node.js**: 18 or later
- **Visual Studio 2022**: Required to build the C# service
- **.NET 8 SDK**: For the Windows Service backend
- **WireGuard for Windows**: `wireguard.dll` and `tunnel.dll` (included in `resources/wireguard/`)

## Development Setup

Run all terminals as Administrator.

### 1. Install Node dependencies

```powershell
npm install
```

### 2. Build the backend service

```powershell
dotnet build service\WireDog.Service\WireDog.Service.csproj --configuration Debug
```

### 3. Start the backend service (separate terminal, Admin)

```powershell
.\service\WireDog.Service\bin\Debug\net8.0-windows\win-x64\WireDog.Service.exe --console --dev
```

Add `--local` if the VPN server is on a local network:

```powershell
.\service\WireDog.Service\bin\Debug\net8.0-windows\win-x64\WireDog.Service.exe --console --dev --local
```

### 4. Start the app (frontend + Electron)

```powershell
npm run dev
```

### 5. Rebuild the service after changes

```powershell
dotnet build .\WireDog.Service\WireDog.Service.csproj --configuration Debug
```

## Production Build

Run all terminals as Administrator.

### Build and publish the .NET service

Run from the `service\` directory:

```powershell
dotnet build .\WireDog.Service\WireDog.Service.csproj --configuration Release
dotnet publish .\WireDog.Service\WireDog.Service.csproj --configuration Release --no-build
```

### Build the full production installer

Use this to produce a complete, distributable installer (run from repo root):

```powershell
npm run build:production  # Builds everything in sequence (service → React → Installer)
```

This runs all steps in sequence:
1. Publishes the .NET backend service (self-contained, win-x64)
2. Bundles the Vite/React frontend
3. Packages everything into a Windows NSIS installer via electron-builder

Output: `release/WireDog VPN Setup <version>.exe`

## Project Structure

```
wiredog-vpn-win/
├── electron/                 # Electron main process
│   ├── ipc/                  # IPC handlers and named pipe client
│   └── vpn/                  # VPN orchestration logic
├── src/                      # React frontend (TypeScript + Vite)
│   ├── components/           # Reusable UI components
│   ├── pages/                # Application pages/views
│   ├── hooks/                # React hooks
│   └── lib/                  # Utilities and API client
├── service/                  # Privileged Windows Service backend
│   └── WireDog.Service/      # C# .NET 8 service (WireGuard, kill switch)
├── build/                    # NSIS installer scripts
├── resources/                # Bundled binaries (WireGuard DLLs)
└── docs/                     # Documentation (local only, not tracked)
```

## Security Issues

**Do not open public GitHub issues for security vulnerabilities.**

If you believe you have found a security vulnerability, please email support@wiredogvpn.com with a description of the vulnerability, steps to reproduce, potential impact, and suggested fix if available.

## License

Licensed under the **GNU General Public License v3 (GPLv3)**. See [`LICENSE`](LICENSE) for details.

This project relies on WireGuard for Windows and other open-source tools. See [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md) for full attribution.

## Questions?

- Open a [GitHub Issue](https://github.com/[fill]/wiredog-vpn-win/issues)
- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidelines
