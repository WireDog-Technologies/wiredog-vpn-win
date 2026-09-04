export type AnnouncementSeverity = 'info' | 'maintenance' | 'incident';

export type AnnouncementTarget =
  | { type: 'all' }
  | { type: 'region'; value: string }
  | { type: 'server'; value: string };

// Mirrors the backend's AnnouncementResponse (src/services/announcements.ts). `target` is
// carried for backend organization/reporting only — every active announcement the backend
// returns is shown to every user.
export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  target: AnnouncementTarget;
  startAt: string;
  endAt: string | null;
}
