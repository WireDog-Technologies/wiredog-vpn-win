import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { VPNProvider, useVPN } from "./context/VPNContext";
import { ElectronProvider } from "./context/ElectronContext";
import UpdateDialog from "./components/UpdateDialog";
import ConnectionErrorToast from "./components/ConnectionErrorToast";
import ErrorBoundary from "./components/ErrorBoundary";
import LoadingScreen from "./components/LoadingScreen";
import AppLayout from "./components/layout/AppLayout";
import Login from "./pages/Login";
import CreateAccount from "./pages/CreateAccount";
import StandardAccount from "./pages/StandardAccount";
import AnonymousAccount from "./pages/AnonymousAccount";
import Dashboard from "./pages/Dashboard";
import Account from "./pages/Account";
import Settings from "./pages/Settings";
import SettingsConnection from "./pages/SettingsConnection";
import SettingsProtocol from "./pages/SettingsProtocol";
import SettingsKillSwitch from "./pages/SettingsKillSwitch";
import SettingsIPv6 from "./pages/SettingsIPv6";
import SettingsGuardianMode from "./pages/SettingsGuardianMode";
import SettingsSplitTunneling from "./pages/SettingsSplitTunneling";
import SplitTunnelApps from "./pages/SplitTunnelApps";
import SplitTunnelIPs from "./pages/SplitTunnelIPs";
import SupportReportIssue from "./pages/SupportReportIssue";
import SupportDebugLogs from "./pages/SupportDebugLogs";
import SupportChangelog from "./pages/SupportChangelog";
import CompactWindow from "./pages/CompactWindow";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useVPN();
  
  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }
  
  return <>{children}</>;
};

const AppRoutes: React.FC = () => {
  const { isAuthenticated } = useVPN();

  return (
    <Routes>
      <Route path="/compact" element={<CompactWindow />} />
      <Route path="/" element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route path="/create-account" element={<CreateAccount />} />
      <Route path="/create-account/standard" element={<StandardAccount />} />
      <Route path="/create-account/anonymous" element={<AnonymousAccount />} />
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/account" element={<Account />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/connection" element={<SettingsConnection />} />
        <Route path="/settings/protocol" element={<SettingsProtocol />} />
        <Route path="/settings/kill-switch" element={<SettingsKillSwitch />} />
        <Route path="/settings/ipv6" element={<SettingsIPv6 />} />
        <Route path="/settings/guardian-mode" element={<SettingsGuardianMode />} />
        <Route path="/settings/split-tunneling" element={<SettingsSplitTunneling />} />
        <Route path="/settings/split-tunneling/apps" element={<SplitTunnelApps />} />
        <Route path="/settings/split-tunneling/ips" element={<SplitTunnelIPs />} />
        <Route path="/support/report-issue" element={<SupportReportIssue />} />
        <Route path="/support/debug-logs" element={<SupportDebugLogs />} />
        <Route path="/support/changelog" element={<SupportChangelog />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

const AppContent = () => {
  const [isLoading, setIsLoading] = useState(true);
  const isCompactMode = window.location.hash === '#/compact';

  useEffect(() => {
    // Auto-hide loading after 2 seconds (skip for compact mode)
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, isCompactMode ? 0 : 2000);

    return () => clearTimeout(timer);
  }, [isCompactMode]);

  // Add cleanup on window unload/reload
  useEffect(() => {
    const handleBeforeUnload = async (e: BeforeUnloadEvent) => {
      // Check if VPN is connected
      if (window.electronAPI?.vpn) {
        try {
          const status = await window.electronAPI.vpn.getStatus();
          if (status.status === 'connected' || status.killSwitchEnabled) {
            // Prevent immediate unload
            e.preventDefault();
            e.returnValue = '';

            // Trigger cleanup via disconnect
            await window.electronAPI.vpn.disconnect();
          }
        } catch (error) {
          console.error('Failed to cleanup VPN on unload:', error);
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <>
      <UpdateDialog />
      <ConnectionErrorToast />
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </>
  );
};

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ElectronProvider>
          <VPNProvider>
            <AppContent />
          </VPNProvider>
        </ElectronProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
