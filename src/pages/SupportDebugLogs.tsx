import React from 'react';
import { ChevronLeft, FileText, Server } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { useElectron } from '@/context/ElectronContext';

const SupportDebugLogs: React.FC = () => {
  const navigate = useNavigate();
  const { openAppLogs, openServiceLogs } = useElectron();

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
            DEBUG LOGS
          </h1>
          <p className="text-muted-foreground">
            View diagnostic information to help troubleshoot issues
          </p>
        </div>

        {/* Log Buttons */}
        <div className="space-y-4">
          <Card
            className="p-6 cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={openAppLogs}
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                <FileText className="w-6 h-6 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium text-lg">Application Logs</p>
                <p className="text-sm text-muted-foreground">
                  Open the application log directory in your file explorer
                </p>
              </div>
            </div>
          </Card>

          <Card
            className="p-6 cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={openServiceLogs}
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                <Server className="w-6 h-6 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium text-lg">Service Logs</p>
                <p className="text-sm text-muted-foreground">
                  Open the VPN service log directory in your file explorer
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default SupportDebugLogs;
