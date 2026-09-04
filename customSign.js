// Signs build artifacts via SSL.com's eSigner CodeSignTool CLI (EV cert, cloud HSM).
// Requires SSLDOTCOM_USER, SSLDOTCOM_PASS, SSLDOTCOM_CREDENTIAL_ID, SSLDOTCOM_TOTP env vars
// and CodeSignTool installed locally (see tasks/ev-code-signing-guide.md). Falls back to a
// no-op when those aren't present, so contributors without signing credentials can still build.
const path = require('path');
const { execFileSync } = require('child_process');

const SIGN_HELPER_PATH = path.join(__dirname, 'build', 'sign-helper.ps1');

// SSL.com's plan is capped at 10 signing attempts/month, and electron-builder's signDlls:true
// calls this hook for every .exe/.dll it finds (Electron's own bundled Chromium helper DLLs,
// third-party NuGet DLLs, etc.) — a full unfiltered pass measured at ~68 real signing calls in
// one build (see release/dry-run-sign-log.txt from the dry run that caught this). Only WireDog's
// own binaries and the installer/uninstaller actually need the signature: Windows SmartScreen
// and AppLocker trust decisions key off the top-level executable, not every loaded DLL — signing
// Electron's/NuGet's third-party DLLs adds cost without adding real trust. Matched against the
// file's basename only, so this doesn't care which arch folder or nsis variant it's found in.
const SIGN_ALLOWLIST = [
  /^WireDog VPN\.exe$/i,
  /^WireDog\.Service\.(exe|dll)$/i,
  /^WireDog-VPN-Setup-.*\.exe$/i,
  /^__uninstaller-nsis-.*\.exe$/i,
];

function isInSignScope(filePath) {
  const base = path.basename(filePath);
  return SIGN_ALLOWLIST.some(pattern => pattern.test(base));
}

function isAlreadyValidlySigned(filePath) {
  const result = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${filePath}').Status`],
    { encoding: 'utf-8' }
  ).trim();
  return result === 'Valid';
}

module.exports = async function(configuration) {
  if (!process.env.SSLDOTCOM_USER || !process.env.SSLDOTCOM_CREDENTIAL_ID) {
    console.warn('[sign] SSL.com credentials not found in environment — skipping signing');
    return [];
  }

  const filePath = configuration.path;

  if (!isInSignScope(filePath)) {
    console.log(`[sign] Not in sign scope (see SIGN_ALLOWLIST), skipping: ${filePath}`);
    return [];
  }

  // Don't clobber a file that's already validly signed by its original publisher
  // (e.g. Microsoft's .NET runtime DLLs, WireGuard LLC's wintun.dll).
  if (isAlreadyValidlySigned(filePath)) {
    console.log(`[sign] Already validly signed, skipping: ${filePath}`);
    return [];
  }

  console.log(`[sign] Signing: ${filePath}`);
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-File', SIGN_HELPER_PATH,
        '-Username', process.env.SSLDOTCOM_USER,
        '-Password', process.env.SSLDOTCOM_PASS,
        '-CredentialId', process.env.SSLDOTCOM_CREDENTIAL_ID,
        '-TotpSecret', process.env.SSLDOTCOM_TOTP,
        '-InputFilePath', filePath,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    );
  } catch (err) {
    // Re-throw a sanitized error — never let the original (which embeds the
    // full command line, including credentials, in err.message/err.cmd) escape.
    throw new Error(`[sign] CodeSignTool failed for ${filePath} (exit ${err.status ?? 'unknown'})`);
  }

  // CodeSignTool.bat's own exit code is not reliable — observed empirically returning 0
  // even when the underlying Java process printed an OAuth "invalid_grant" error and never
  // actually applied a signature (stale/rotated SSL.com password). Rather than parse
  // CodeSignTool's output text (which could change across tool versions), verify the actual
  // outcome directly: does the file now carry a valid signature? If not, fail loudly instead
  // of letting the build silently ship an unsigned artifact as if it succeeded.
  if (!isAlreadyValidlySigned(filePath)) {
    throw new Error(
      `[sign] CodeSignTool reported success but ${filePath} is not actually signed — ` +
      `treating this as a failure. Check the CodeSignTool output above for the real error ` +
      `(e.g. an expired/invalid SSL.com credential).`
    );
  }
};
