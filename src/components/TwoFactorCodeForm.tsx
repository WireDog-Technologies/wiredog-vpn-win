import React, { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface TwoFactorCodeFormProps {
  /** Verifies the code; throws on failure. The form shows `describeError(error)` and lets the user retry. */
  onSubmit: (code: string) => Promise<void>;
  describeError: (error: unknown) => string;
  /** Called when the user backs out (the pending sign-in is abandoned). */
  onBack: () => void;
}

/**
 * Second step of a sign-in for an account with two-factor authentication on. Accepts a 6-digit
 * authenticator code or a recovery code.
 */
const TwoFactorCodeForm: React.FC<TwoFactorCodeFormProps> = ({ onSubmit, describeError, onBack }) => {
  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter the code from your authenticator app, or a recovery code.');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex flex-col items-center text-center gap-2 mb-2">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
          <ShieldCheck className="w-6 h-6 text-muted-foreground" />
        </div>
        <h2 className="font-display text-xl tracking-wide">TWO-FACTOR AUTHENTICATION</h2>
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app, or one of your recovery codes.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">Code</label>
        <Input
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          placeholder="Authenticator or recovery code"
          value={code}
          onChange={(e) => setCode(e.target.value.slice(0, 32))}
          className="font-mono tracking-wider"
        />
      </div>

      {error && <p className="text-sm text-red-400" role="alert">{error}</p>}

      <Button type="submit" variant="patriot" size="lg" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Verifying...
          </>
        ) : (
          'Verify'
        )}
      </Button>

      <button
        type="button"
        onClick={onBack}
        disabled={isLoading}
        className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        Back to sign in
      </button>
    </form>
  );
};

export default TwoFactorCodeForm;
