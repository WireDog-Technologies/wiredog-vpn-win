import React from 'react';
import { Minus, X, Maximize2, Minimize2, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useElectron } from '@/context/ElectronContext';
import Logo from "../../assets/logos/wiredog-minimal-navy_1024x1024.png";
import TextLogo from "../../assets/logos/wiredog_text_logo_1024.png";

const TitleBar: React.FC = () => {
  const {
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    isWindowMaximized,
    isMac,
    isElectron
  } = useElectron();

  const [isMaximized, setIsMaximized] = React.useState(false);

  React.useEffect(() => {
    const checkMaximized = async () => {
      if (isElectron) {
        const maximized = await isWindowMaximized();
        setIsMaximized(maximized);
      }
    };
    checkMaximized();
  }, [isElectron, isWindowMaximized]);

  // Don't render title bar in web mode or on macOS (uses native title bar)
  if (!isElectron || isMac) {
    return null;
  }

  const handleMinimize = async () => {
    try {
      await minimizeWindow();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleMaximize = async () => {
    try {
      await maximizeWindow();
      // Update local state after action
      setIsMaximized(!isMaximized);
    } catch (error) {
      console.error('Failed to maximize window:', error);
    }
  };

  const handleClose = async () => {
    try {
      await closeWindow();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  };

  return (
    <div className="relative flex items-center justify-center h-8 bg-background border-b border-border select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* App title with Shield icon - centered absolutely */}
      <div className="flex items-center justify-center gap-1">
        <div className="w-6 h-6 rounded flex items-center justify-center">
            <img
              src={Logo}
              alt="WireDog VPN Logo"
              className="w-5 h-5 object-contain"
            />
        </div>
            <img
              src={TextLogo}
              alt="WireDog VPN Logo"
              className="w-20 h-auto"
            />
      </div>

      {/* Window controls */}
      <div className="absolute right-0 flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleMinimize}
          className="h-8 w-10 rounded-none hover:bg-accent/50 focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          <Minus className="h-3 w-3" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleMaximize}
          className="h-8 w-10 rounded-none hover:bg-accent/50 focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          {isMaximized ? (
            <Minimize2 className="h-3 w-3" />
          ) : (
            <Maximize2 className="h-3 w-3" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-8 w-10 rounded-none hover:bg-red-500/20 hover:text-red-600 focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
};

export default TitleBar;