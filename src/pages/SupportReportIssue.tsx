import React, { useState, useEffect } from 'react';
import { ChevronLeft, Send, CheckCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { useVPN } from '@/context/VPNContext';
import { useElectron } from '@/context/ElectronContext';
import { reportIssue } from '@/lib/api';

// Strip HTML tags and trim whitespace
function sanitize(input: string): string {
  return input.replace(/<[^>]*>/g, '').trim();
}

const SupportReportIssue: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useVPN();
  const { getAppVersion, getOsVersion } = useElectron();

  const [os, setOs] = useState('Windows');
  const [osVersion, setOsVersion] = useState('');
  const [vpnVersion, setVpnVersion] = useState('');
  const [username, setUsername] = useState(user?.isAnonymous ? '' : user?.username || '');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitSuccess, setSubmitSuccess] = useState(false);

  useEffect(() => {
    getAppVersion().then(setVpnVersion).catch(() => {});
    getOsVersion().then(setOsVersion).catch(() => {});
  }, [getAppVersion, getOsVersion]);

  const isFormValid = os && osVersion && vpnVersion && email && subject.length > 0 && subject.length <= 100 && description.length >= 20;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitError('');
    setSubmitSuccess(false);

    try {
      const payload = {
        os,
        osVersion: sanitize(osVersion),
        vpnVersion: sanitize(vpnVersion),
        ...(username.trim() && { username: sanitize(username) }),
        email: email.trim(),
        subject: sanitize(subject),
        message: sanitize(description),
      };

      await reportIssue(payload);

      // Reset user-entered fields back to defaults
      setEmail('');
      setSubject('');
      setDescription('');
      setSubmitSuccess(true);
    } catch (error: any) {
      console.error('Failed to submit issue:', error);
      setSubmitError(error?.message || 'Failed to submit issue. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

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
            REPORT AN ISSUE
          </h1>
          <p className="text-muted-foreground">
            Help us improve by reporting any problems you encounter
          </p>
        </div>

        {/* Form Card */}
        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Row 1: Operating System + OS Version */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Operating System</Label>
                <Select value={os} onValueChange={setOs}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Windows">Windows</SelectItem>
                    <SelectItem value="macOS">macOS</SelectItem>
                    <SelectItem value="Linux">Linux</SelectItem>
                    <SelectItem value="Android">Android</SelectItem>
                    <SelectItem value="iOS">iOS</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>OS Version</Label>
                <Input
                  className="mt-1.5"
                  value={osVersion}
                  onChange={(e) => setOsVersion(e.target.value)}
                  placeholder="e.g. Windows 11 22H2"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">Your operating system version.</p>
              </div>
            </div>

            {/* Row 2: VPN Version + Username */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>WireDog VPN Version</Label>
                <Input
                  className="mt-1.5"
                  value={vpnVersion}
                  onChange={(e) => setVpnVersion(e.target.value)}
                  placeholder="Loading..."
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">Application version helps us debug version-specific issues.</p>
              </div>

              <div>
                <Label>Username</Label>
                <Input
                  className="mt-1.5"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Optional"
                />
                <p className="text-xs text-muted-foreground mt-1">Username will help us identify your account, if applicable.</p>
              </div>
            </div>

            {/* Row 3: Email Address */}
            <div>
              <Label>Email Address</Label>
              <Input
                className="mt-1.5"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@example.com"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">We'll use this to respond to your issue.</p>
            </div>

            {/* Row 4: Subject */}
            <div>
              <Label>Subject</Label>
              <Input
                className="mt-1.5"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief description of your issue"
                maxLength={100}
                required
              />
              <p className="text-xs text-muted-foreground mt-1">Maximum 100 characters.</p>
            </div>

            {/* Row 5: Description */}
            <div>
              <Label>Describe Your Issue</Label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Please provide detailed information about the issue you're experiencing..."
                rows={6}
                className="mt-1.5 w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">Minimum 20 characters to help us better assist you.</p>
            </div>

            {/* Success Message */}
            {submitSuccess && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-connection-active/10 border border-connection-active/30">
                <CheckCircle className="w-5 h-5 text-connection-active flex-shrink-0" />
                <p className="text-sm text-connection-active">Your issue has been submitted successfully. We'll get back to you at the email provided.</p>
              </div>
            )}

            {/* Error Message */}
            {submitError && (
              <p className="text-sm text-accent">{submitError}</p>
            )}

            {/* Submit Button */}
            <div className="flex gap-3 pt-4">
              <Button
                type="submit"
                disabled={isSubmitting || !isFormValid}
                className="flex-1 flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                {isSubmitting ? 'Submitting...' : 'Send Report'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(-1)}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
};

export default SupportReportIssue;
