import { useEffect, useState, useCallback } from 'react';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'force-required'
  | 'maintenance';

export interface UpdateInfo {
  message: string | null;
  downloadUrl: string | null;
  latestVersion: number | null;
}

export interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export const useAutoUpdate = () => {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({ message: null, downloadUrl: null, latestVersion: null });
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const isElectron = !!window.electronAPI?.update;

  useEffect(() => {
    if (!isElectron) return;

    const api = window.electronAPI.update;

    const cleanupAvailable = api.onAvailable((data: any) => {
      setUpdateInfo({
        message: data.message || null,
        downloadUrl: data.downloadUrl || null,
        latestVersion: data.latestVersion || null,
      });
      setUpdateStatus('available');
    });

    const cleanupForce = api.onForceRequired((data: any) => {
      setUpdateInfo({
        message: data.message || null,
        downloadUrl: data.downloadUrl || null,
        latestVersion: null,
      });
      setUpdateStatus('force-required');
    });

    const cleanupMaintenance = api.onMaintenance((data: any) => {
      setUpdateInfo({
        message: data.message || null,
        downloadUrl: null,
        latestVersion: null,
      });
      setUpdateStatus('maintenance');
    });

    const cleanupProgress = api.onDownloadProgress((data: any) => {
      setDownloadProgress(data);
      setUpdateStatus('downloading');
    });

    const cleanupDownloaded = api.onDownloaded(() => {
      setUpdateStatus('downloaded');
      setDownloadProgress(null);
    });

    // Signal to main process that listeners are ready — triggers initial policy check
    api.signalReady();

    return () => {
      cleanupAvailable();
      cleanupForce();
      cleanupMaintenance();
      cleanupProgress();
      cleanupDownloaded();
    };
  }, [isElectron]);

  const checkForUpdates = useCallback(async () => {
    if (!isElectron) return;
    setUpdateStatus('checking');
    try {
      const result = await window.electronAPI.update.checkForUpdates();
      if (result.upToDate) {
        setUpdateStatus('idle');
      }
      return result;
    } catch {
      setUpdateStatus('idle');
      return { upToDate: true };
    }
  }, [isElectron]);

  const downloadUpdate = useCallback(async () => {
    if (!isElectron) return;
    setUpdateStatus('downloading');
    try {
      await window.electronAPI.update.downloadUpdate();
    } catch {
      setUpdateStatus('available');
    }
  }, [isElectron]);

  const installUpdate = useCallback(() => {
    if (!isElectron) return;
    window.electronAPI.update.installUpdate();
  }, [isElectron]);

  const dismissUpdate = useCallback(() => {
    setDismissed(true);
    setUpdateStatus('idle');
  }, []);

  return {
    updateStatus,
    updateInfo,
    downloadProgress,
    dismissed,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    dismissUpdate,
    isElectron,
  };
};
