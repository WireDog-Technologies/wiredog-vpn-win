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

### 4. Configure environment (optional)

API/frontend URLs come from `.env.development` (integration — used by `npm run dev` and
`npm run build:integration`) and `.env.production` (production — used by
`npm run build:production`). Both are gitignored, not committed — create them yourself at the
repo root, same two keys in each:

```powershell
# .env.development
VITE_API_URL=https://intapi.wiredogvpn.com/api
VITE_FRONTEND_URL=https://int.wiredogvpn.com

# .env.production
VITE_API_URL=https://api.wiredogvpn.com/api
VITE_FRONTEND_URL=https://wiredogvpn.com
```

Confirm the integration hostname with a teammate if you're not sure it's current.

`.env.local` is only needed to override a URL locally (e.g. pointing at a backend running on
localhost instead of integration):

```powershell
Copy-Item .env.local.example .env.local
# Edit .env.local and uncomment/fill in what you need
```

### 5. Start the app (frontend + Electron)

```powershell
npm run dev
```

Runs against the **integration** backend/frontend (`.env.development`) by default. Override
via `.env.local` if you need to point at something else (e.g. a local backend).

### 6. Rebuild the service after changes

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
3. Bakes `.env.production` into the root `.env` (read by the packaged app at startup)
4. Packages everything into a Windows NSIS installer via electron-builder

Output: `release/WireDog-VPN-Setup-<version>-x64.exe`

#### Code signing

Every build artifact electron-builder considers is passed through `customSign.js`
(configured as its `sign` hook). It signs via SSL.com's eSigner CodeSignTool (EV cert, cloud
HSM) **only if** `SSLDOTCOM_USER`, `SSLDOTCOM_PASS`, `SSLDOTCOM_CREDENTIAL_ID`, and
`SSLDOTCOM_TOTP` are all present in the environment — see `tasks/ev-code-signing-guide.md`.
If any of those four are missing, it logs a warning and skips signing for that file; nothing
else in this repo signs a build. **A real release build needs all four set; a local/test
build should have all four unset** — check with `Get-ChildItem Env: | Where-Object Name -like
'SSLDOTCOM_*'` before building if you're not sure what's currently in your shell.

**The SSL.com plan is capped at 10 signing attempts/month.** Two things in
`electron-builder.json` keep real builds well under that:

- **`signingHashAlgorithms: ["sha256"]`** — electron-builder dual-signs every file with SHA-1
  *and* SHA-256 by default (SHA-1 exists only for Windows 7/Vista/Server 2008 compatibility).
  Since this app's minimum supported OS is Windows 10 (full native SHA-256 support), the SHA-1
  pass is pure overhead — this config halves the sign count with no loss of compatibility for
  any OS this app actually supports.
- **`SIGN_ALLOWLIST` in `customSign.js`** — `signDlls: true` makes electron-builder consider
  signing every `.exe`/`.dll` it packages, including Electron's own bundled Chromium helper
  DLLs (`ffmpeg.dll`, `libEGL.dll`, `vulkan-1.dll`, etc.) and third-party NuGet DLLs (Serilog).
  Windows SmartScreen/AppLocker trust is driven by the top-level executable and installer, not
  every loaded DLL, so `customSign.js` only actually signs files matching the allowlist —
  everything else is skipped regardless of credentials.

With both in place, a real build signs exactly one attempt per file that needs it:

**x64** (`npm run build:production`) — 5 signs:

| File | What it is |
|---|---|
| `win-unpacked\WireDog VPN.exe` | Main Electron app executable — embedded into the installer, so this is what makes the *installed* app trusted. |
| `win-unpacked\resources\service\WireDog.Service.exe` | Privileged Windows Service apphost (self-contained .NET publish) — runs as SYSTEM. |
| `win-unpacked\resources\service\WireDog.Service.dll` | The service's managed assembly, paired with the apphost above. |
| `WireDog-VPN-Setup-<version>-x64.exe` | The NSIS installer — what SmartScreen evaluates for reputation on first run. |
| `__uninstaller-nsis-wiredog-vpn.exe` | The NSIS-generated uninstaller, launched from "Add/Remove Programs." |

**arm64** (`npm run build:production:arm64`) — 5 signs, same five roles, arm64 build.

**Running both together** (`npm run build:production:all`) adds a third, *combined*
x64+arm64 installer (`WireDog-VPN-Setup-<version>.exe`, auto-detects the machine's
architecture at install time) plus its own uninstaller sign — **12 total**, not 10. If you
don't need the combined installer, run the two scripts above separately instead: same 5+5=10
total signs, without the extra 2. Either way, **shipping both architectures uses the entire
monthly quota** — releasing only x64 (5 signs) leaves half the budget for the month.

**Before any real signed build**, confirm this repo's actual counts still match reality: use
the dry-run method in `build/dryRunSign.js` (mirrors `customSign.js`'s allowlist/skip logic
exactly, but only logs — never calls SSL.com) via a throwaway `electron-builder` config that
overrides `win.sign` to it, e.g. `electron-builder --win --x64 --config
electron-builder.production-dryrun.json` if that file still exists, or recreate it the same
way. Re-verify after any change to `electron-builder.json`'s `win`/`nsis` config,
`customSign.js`'s `SIGN_ALLOWLIST`, or an electron-builder version bump.

### Building Against Integration

```powershell
npm run build:integration
```

Builds the frontend in Vite's `development` mode (loads `.env.development`) instead of
bundling against production, and bakes `.env.development` into the root `.env`. Packages via
`electron-builder.integration.json` (`extends` the base `electron-builder.json`), which
overrides Windows signing to `build/noSign.js` — a stub that always skips regardless of any
`SSLDOTCOM_*` env vars present, so a test build can't consume one of the account's monthly
signing attempts even by accident (**never signs**). Output artifacts are named
`WireDog-VPN-Test-<version>-<arch>.<ext>` so they're never confused with a real release sitting
in `release/`.

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
