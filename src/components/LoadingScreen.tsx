import React from 'react';
import { Loader2, Shield } from 'lucide-react';
import Logo from "../assets/logos/wiredog-minimal-navy_1024x1024.png";
import TextLogo from "../assets/logos/wiredog_text_logo_1024.png";

interface LoadingScreenProps {
  message?: string;
  showSecurityBadge?: boolean;
}

const LoadingScreen: React.FC<LoadingScreenProps> = ({
  message = "Starting WireDog VPN...",
  showSecurityBadge = true
}) => {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center space-y-6">
        {/* Logo/Brand */}
        <div className="flex items-center justify-center space-x-3">
        <div className="w-24 h-24 rounded flex items-center justify-center">
            <img
              src={Logo}
              alt="WireDog VPN Logo"
              className="w-24 h-24 object-contain"
            />
        </div>
        {/* Brand Text */}
          <img
            src={TextLogo}
            alt="WireDog"
            className="h-20 w-auto"
          />
        </div>

        {/* Loading Animation */}
        <div className="flex flex-col items-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-patriot-blue" />
          <p className="text-muted-foreground">{message}</p>
        </div>
      </div>
    </div>
  );
};

export default LoadingScreen;