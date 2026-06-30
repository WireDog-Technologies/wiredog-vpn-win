import React, { useState } from 'react';
import { ChevronLeft, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { useVPN } from '@/context/VPNContext';

// Validates IPv4, IPv6, and CIDR notation
function isValidIpOrCidr(value: string): boolean {
  const trimmed = value.trim();
  // IPv4 with optional CIDR
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  // IPv6 with optional CIDR (simplified)
  const ipv6 = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/;

  if (ipv4.test(trimmed)) {
    const [ip, cidr] = trimmed.split('/');
    const parts = ip.split('.').map(Number);
    if (parts.some(p => p > 255)) return false;
    if (cidr !== undefined && (Number(cidr) < 0 || Number(cidr) > 32)) return false;
    return true;
  }

  if (ipv6.test(trimmed)) {
    if (trimmed.includes('/')) {
      const cidr = Number(trimmed.split('/')[1]);
      if (cidr < 0 || cidr > 128) return false;
    }
    return true;
  }

  return false;
}

const SplitTunnelIPs: React.FC = () => {
  const navigate = useNavigate();
  const { settings, updateSettings } = useVPN();
  const splitTunneling = settings.splitTunneling;

  const [newIp, setNewIp] = useState('');
  const [error, setError] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  const addIp = () => {
    const trimmed = newIp.trim();
    if (!trimmed) return;

    if (!isValidIpOrCidr(trimmed)) {
      setError('Invalid IP address or CIDR notation');
      return;
    }

    if (splitTunneling.ips.includes(trimmed)) {
      setError('This IP is already in the list');
      return;
    }

    updateSettings({
      splitTunneling: {
        ...splitTunneling,
        ips: [...splitTunneling.ips, trimmed],
      },
    });
    setNewIp('');
    setError('');
  };

  const removeIp = (index: number) => {
    const newIps = splitTunneling.ips.filter((_, i) => i !== index);
    updateSettings({
      splitTunneling: { ...splitTunneling, ips: newIps },
    });
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditValue(splitTunneling.ips[index]);
    setError('');
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    const trimmed = editValue.trim();

    if (!isValidIpOrCidr(trimmed)) {
      setError('Invalid IP address or CIDR notation');
      return;
    }

    const newIps = [...splitTunneling.ips];
    newIps[editingIndex] = trimmed;
    updateSettings({
      splitTunneling: { ...splitTunneling, ips: newIps },
    });
    setEditingIndex(null);
    setEditValue('');
    setError('');
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValue('');
    setError('');
  };

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      action();
    }
  };

  return (
    <div className="h-full p-6 star-pattern overflow-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate('/settings/split-tunneling')}
        className="text-muted-foreground hover:text-foreground transition-colors mb-4 p-0"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-4">
          <h1 className="font-display text-4xl tracking-wider text-foreground mb-1">
            IP ADDRESSES
          </h1>
          <p className="text-muted-foreground text-sm">
            {splitTunneling.mode === 'exclude'
              ? 'Traffic to these IPs will bypass the VPN'
              : 'Only traffic to these IPs will use the VPN'
            }
          </p>
        </div>

        {/* Add IP Input */}
        <Card className="p-4 mb-4">
          <p className="text-sm font-medium mb-2">Add IP Address or CIDR Range</p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. 192.168.1.0/24 or 10.0.0.1"
              value={newIp}
              onChange={(e) => { setNewIp(e.target.value); setError(''); }}
              onKeyDown={(e) => handleKeyDown(e, addIp)}
              className="flex-1 px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-connection-active"
            />
            <button
              onClick={addIp}
              className="flex items-center gap-1 px-3 py-2 bg-connection-active text-background rounded-lg text-sm font-medium hover:bg-connection-active/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
          {error && (
            <p className="text-xs text-destructive mt-1">{error}</p>
          )}
        </Card>

        {/* IP List */}
        <Card className="p-4 mb-4">
          <p className="text-sm font-medium mb-2">
            {splitTunneling.ips.length === 0
              ? 'No IP addresses added'
              : `${splitTunneling.ips.length} IP${splitTunneling.ips.length !== 1 ? 's' : ''} added`
            }
          </p>

          {splitTunneling.ips.length > 0 && (
            <div className="space-y-1">
              {splitTunneling.ips.map((ip, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border"
                >
                  {editingIndex === index ? (
                    <>
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => { setEditValue(e.target.value); setError(''); }}
                        onKeyDown={(e) => handleKeyDown(e, saveEdit)}
                        className="flex-1 px-2 py-1 bg-background border border-border rounded text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-connection-active"
                        autoFocus
                      />
                      <button onClick={saveEdit} className="text-connection-active hover:text-connection-active/80">
                        <Check className="w-4 h-4" />
                      </button>
                      <button onClick={cancelEdit} className="text-muted-foreground hover:text-foreground">
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="flex-1 text-sm font-mono">{ip}</p>
                      <button
                        onClick={() => startEdit(index)}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => removeIp(index)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

export default SplitTunnelIPs;
