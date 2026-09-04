// Signs build artifacts via SSL.com's eSigner CodeSignTool CLI (EV cert, cloud HSM).
// Requires SSLDOTCOM_USER, SSLDOTCOM_PASS, SSLDOTCOM_CREDENTIAL_ID, SSLDOTCOM_TOTP env vars
// and CodeSignTool installed locally (see tasks/ev-code-signing-guide.md). Falls back to a
// no-op when those aren't present, so contributors without signing credentials can still build.
const path = require('path');
const { execFileSync } = require('child_process');

const SIGN_HELPER_PATH = path.join(__dirname, 'build', 'sign-helper.ps1');

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
};
