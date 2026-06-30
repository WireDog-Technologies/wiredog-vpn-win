import { useElectron } from '@/context/ElectronContext';
import { useEffect, useState } from 'react';

/**
 * Hook for window controls in Electron environment
 * Provides window management functionality with fallbacks for web
 */
export const useWindowControls = () => {
  const {
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    isWindowMaximized,
    isElectron
  } = useElectron();

  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isElectron) {
      // Check initial maximized state
      isWindowMaximized().then(setMaximized).catch(console.error);

      // Set up periodic check for maximized state changes
      const interval = setInterval(async () => {
        try {
          const isMax = await isWindowMaximized();
          setMaximized(isMax);
        } catch (error) {
          console.error('Failed to check window maximized state:', error);
        }
      }, 500);

      return () => clearInterval(interval);
    }
  }, [isElectron, isWindowMaximized]);

  const minimize = async () => {
    try {
      await minimizeWindow();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const maximize = async () => {
    try {
      await maximizeWindow();
      // Update state immediately for better UX
      setMaximized(!maximized);
    } catch (error) {
      console.error('Failed to maximize window:', error);
    }
  };

  const close = async () => {
    try {
      await closeWindow();
    } catch (error) {
      console.error('Failed to close window:', error);
      // Fallback: use browser close
      window.close();
    }
  };

  return {
    minimize,
    maximize,
    close,
    isMaximized: maximized,
    isElectron
  };
};