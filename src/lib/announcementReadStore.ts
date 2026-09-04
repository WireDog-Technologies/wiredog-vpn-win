// Persists which announcement ids the user has already seen — localStorage, matching the
// pattern Sidebar.tsx already uses for favoriteServerIds.
const STORAGE_KEY = 'wiredog:readAnnouncementIds';

export function loadReadIds(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveReadIds(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch (error) {
    console.error('Failed to save read announcement ids:', error);
  }
}
