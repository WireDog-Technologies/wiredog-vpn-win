import React, { useRef, useState } from 'react';
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

const CODE_LENGTH = 6;

/**
 * Second step of a sign-in for an account with two-factor authentication on. The default is six
 * single-digit boxes for the authenticator code; "Use a recovery code instead" switches to a text
 * field, because a recovery code is longer and not only digits (and is the way in for someone who
 * lost their authenticator).
 */
const TwoFactorCodeForm: React.FC<TwoFactorCodeFormProps> = ({ onSubmit, describeError, onBack }) => {
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  const focusBox = (index: number) => {
    const box = boxes.current[Math.max(0, Math.min(index, CODE_LENGTH - 1))];
    box?.focus();
    box?.select();
  };

  // Digits only, never more than six, and never a gap: a digit always lands at the next free spot.
  const handleDigitChange = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    setError(null);
    if (digits.length === 0) {
      // The box was cleared: drop that digit and close the gap.
      setCode(code.slice(0, index) + code.slice(index + 1));
      return;
    }
    if (digits.length === 1 && index < code.length) {
      // Typing over a filled box replaces that digit and leaves the others alone.
      setCode(code.slice(0, index) + digits + code.slice(index + 1));
      focusBox(index + 1);
      return;
    }
    const start = Math.min(index, code.length);
    const next = (code.slice(0, start) + digits).slice(0, CODE_LENGTH);
    setCode(next);
    focusBox(Math.min(start + digits.length, CODE_LENGTH - 1));
  };

  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      e.preventDefault();
      setCode(code.slice(0, index - 1) + code.slice(index));
      focusBox(index - 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusBox(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusBox(index + 1);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (!digits) return;
    e.preventDefault();
    setError(null);
    setCode(digits);
    focusBox(digits.length);
  };

  const switchMode = (recovery: boolean) => {
    setUseRecovery(recovery);
    setCode('');
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (useRecovery ? !trimmed : trimmed.length !== CODE_LENGTH) {
      setError(useRecovery
        ? 'Enter one of your recovery codes.'
        : 'Enter the 6-digit code from your authenticator app.');
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
          {useRecovery
            ? 'Enter one of your recovery codes.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </div>

      {useRecovery ? (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Recovery code</label>
          <Input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            placeholder="Recovery code"
            value={code}
            onChange={(e) => setCode(e.target.value.slice(0, 32))}
            className="font-mono tracking-wider"
          />
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground block text-center">Code</label>
          <div className="flex justify-center gap-2" onPaste={handlePaste}>
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <Input
                key={i}
                ref={(el) => { boxes.current[i] = el; }}
                type="text"
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                autoFocus={i === 0}
                spellCheck={false}
                aria-label={`Digit ${i + 1} of ${CODE_LENGTH}`}
                value={code[i] ?? ''}
                onChange={(e) => handleDigitChange(i, e.target.value)}
                onKeyDown={(e) => handleDigitKeyDown(i, e)}
                onFocus={(e) => e.target.select()}
                className="w-11 h-12 px-0 text-center text-lg font-mono"
              />
            ))}
          </div>
        </div>
      )}

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
        onClick={() => switchMode(!useRecovery)}
        disabled={isLoading}
        className="w-full text-sm text-accent hover:underline"
      >
        {useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
      </button>

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
