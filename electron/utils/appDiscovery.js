const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const log = require('electron-log');

// Common Start Menu paths
const START_MENU_PATHS = [
  path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
  path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs'),
];

// Apps to exclude from the list (system utilities, our own app, etc.)
const EXCLUDED_NAMES = new Set([
  'wiredog vpn',
  'uninstall',
  'remove',
  'setup',
  'installer',
  'updater',
  'update',
]);

/**
 * Recursively find all .lnk shortcut files in a directory
 */
function findShortcuts(dir, shortcuts = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findShortcuts(fullPath, shortcuts);
      } else if (entry.name.endsWith('.lnk')) {
        shortcuts.push(fullPath);
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }
  return shortcuts;
}

/**
 * Resolve a .lnk shortcut to its target exe path using shell
 */
function resolveShortcut(lnkPath) {
  try {
    const target = shell.readShortcutLink(lnkPath);
    return target.target || null;
  } catch {
    return null;
  }
}

/**
 * Get a list of installed applications by scanning Start Menu shortcuts
 */
async function getInstalledApps() {
  const appMap = new Map(); // exePath -> app info, deduplicates

  for (const startMenuPath of START_MENU_PATHS) {
    if (!fs.existsSync(startMenuPath)) continue;

    const shortcuts = findShortcuts(startMenuPath);

    for (const lnkPath of shortcuts) {
      const target = resolveShortcut(lnkPath);
      if (!target) continue;

      // Only include .exe files
      if (!target.toLowerCase().endsWith('.exe')) continue;

      // Skip if exe doesn't exist
      if (!fs.existsSync(target)) continue;

      // Get display name from shortcut filename
      const name = path.basename(lnkPath, '.lnk');

      // Skip excluded apps
      const nameLower = name.toLowerCase();
      if (EXCLUDED_NAMES.has(nameLower)) continue;
      if ([...EXCLUDED_NAMES].some(excl => nameLower.includes(excl))) continue;

      // Skip system paths (Windows directory)
      const targetLower = target.toLowerCase();
      if (targetLower.includes('\\windows\\system32\\') ||
          targetLower.includes('\\windows\\syswow64\\')) continue;

      // Deduplicate by exe path (keep first found name)
      const normalizedPath = target.toLowerCase();
      if (!appMap.has(normalizedPath)) {
        appMap.set(normalizedPath, {
          name,
          exePath: target,
          icon: null,
        });
      }
    }
  }

  // Sort alphabetically by name
  const apps = Array.from(appMap.values());
  apps.sort((a, b) => a.name.localeCompare(b.name));

  log.info(`App discovery found ${apps.length} applications`);
  return apps;
}

module.exports = { getInstalledApps };
