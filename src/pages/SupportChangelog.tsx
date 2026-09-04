import React, { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useElectron } from '@/context/ElectronContext';

const SupportChangelog: React.FC = () => {
  const navigate = useNavigate();
  const { getAppVersion } = useElectron();
  const [appVersion, setAppVersion] = useState('1.1.0');

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => {});
  }, [getAppVersion]);

  const changelog = [
    {
      version: '1.1.0',
      date: 'September 2026',
      changes: [
        'Guardian Mode: independently toggle ad blocking and malware blocking, applied at the DNS level',
        'In-app announcements: a bell icon now surfaces service updates and maintenance notices',
        'Quick server switching: select a new server while connected and it switches over automatically',
        'You can now cancel a connection attempt: a Cancel button appears while connecting',
        'Clearer error when you’ve hit your 5-device connection limit',
        'Location and IP now show "Loading..." during connect/disconnect instead of briefly showing stale info',
        'Sessions now stay signed in significantly longer',
      ],
    },
    {
      version: '1.0.0',
      date: 'May 2026',
      changes: [
        'Initial release of WireDog VPN',
        'WireGuard protocol support',
        'Kill Switch protection',
        'Auto-connect functionality',
        'IPv6 leak protection',
        'Debug logs export',
        'Issue reporting system',
      ],
    },
  ];

  return (
    <div className="h-full p-6 star-pattern overflow-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate(-1)}
        className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="font-display text-4xl tracking-wider text-foreground mb-2">
            CHANGELOG
          </h1>
          <p className="text-muted-foreground">
            Version history and release notes
          </p>
        </div>

        {/* Version Info */}
        <Card className="p-6 mb-6 bg-muted/50">
          <div>
            <p className="text-sm text-muted-foreground mb-1">Current Version</p>
            <div className="flex items-center gap-2">
              <p className="font-display text-2xl font-bold text-foreground">{appVersion}</p>
              <Badge variant="outline">Latest</Badge>
            </div>
          </div>
        </Card>

        {/* Changelog */}
        <div className="space-y-6">
          {changelog.map((release) => (
            <Card key={release.version} className="p-6">
              <div className="mb-4">
                <div className="flex items-center gap-3 mb-2">
                  <p className="font-display text-xl font-bold text-foreground">
                    v{release.version}
                  </p>
                  <Badge variant="secondary">{release.date}</Badge>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground mb-3">Release Notes:</p>
                <ul className="space-y-2">
                  {release.changes.map((change, index) => (
                    <li key={index} className="flex gap-3 text-sm">
                      <span className="text-patriot-blue-light flex-shrink-0 mt-0.5">•</span>
                      <span className="text-foreground">{change}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SupportChangelog;