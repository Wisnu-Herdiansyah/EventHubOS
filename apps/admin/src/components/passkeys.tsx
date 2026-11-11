'use client';

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  addPasskeyAction,
  completePasskeyLoginAction,
  passkeyLoginOptionsAction,
  removePasskeyAction,
  startPasskeyAction,
  type PasskeyActionResult,
} from '@/app/actions/passkeys';
import { formatInZone } from '@/lib/time';
import { Input, Problem } from './two-step';
import { Button } from './ui/button';
import { Dialog, DialogCancel } from './ui/dialog';
import { Notice } from './ui/notice';

export interface PasskeyItem {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What went wrong in the browser's part of the ceremony, in words people understand. */
function browserProblem(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return 'The passkey request was cancelled or timed out. Try again when you are ready.';
  }
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  return 'This browser could not use a passkey. Try another browser or device.';
}

const closeDialogs = () =>
  document.querySelectorAll('dialog[open]').forEach((d) => (d as HTMLDialogElement).close());

function AddFlow({ onFinished }: { onFinished: () => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<PasskeyActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          if (!name.trim()) {
            setResult({
              ok: false,
              message: 'Check the highlighted fields.',
              fields: { name: 'Give the passkey a name.' },
            });
            return;
          }
          const options = await startPasskeyAction(password);
          if (!options.ok || !options.options) return setResult(options);
          let response: unknown;
          try {
            response = await startRegistration({ optionsJSON: options.options as never });
          } catch (error) {
            return setResult({ ok: false, message: browserProblem(error) });
          }
          const added = await addPasskeyAction(name, response);
          setResult(added);
          if (added.ok) onFinished();
        });
      }}
    >
      <Problem result={result} />
      <Input
        id="passkey-name"
        label="Name"
        value={name}
        onChange={setName}
        hint="So you can tell your passkeys apart, like “Work laptop” or “Phone”."
        error={result?.fields?.name}
      />
      <Input
        id="passkey-password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={result?.fields?.currentPassword}
      />
      <div className="form__actions form__actions--end">
        <DialogCancel />
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Waiting for your device…' : 'Add passkey'}
        </Button>
      </div>
    </form>
  );
}

function RemoveFlow({ passkey, onFinished }: { passkey: PasskeyItem; onFinished: () => void }) {
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<PasskeyActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await removePasskeyAction(passkey.id, password);
          setResult(r);
          if (r.ok) onFinished();
        });
      }}
    >
      <Problem result={result} />
      <Input
        id={`passkey-remove-${passkey.id}`}
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={result?.fields?.currentPassword}
      />
      <div className="form__actions form__actions--end">
        <DialogCancel />
        <Button type="submit" variant="danger" disabled={pending} aria-busy={pending}>
          {pending ? 'Removing…' : 'Remove passkey'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Passkeys on the Account page (ADR-0033): a faster second step than typing a code, offered once
 * two-step verification is on.
 */
export function PasskeysPanel({
  passkeys,
  mfaOn,
  available,
}: {
  passkeys: PasskeyItem[];
  mfaOn: boolean;
  available: boolean;
}) {
  const router = useRouter();
  const [round, setRound] = useState(0);
  const finish = () => {
    setRound((r) => r + 1);
    closeDialogs();
    router.refresh();
  };
  if (!available) return null;
  return (
    <div className="stack-sm passkeys">
      <h3 className="passkeys__title">Passkeys</h3>
      {!mfaOn ? (
        <p className="text-secondary">
          Once two-step verification is on, you can add a passkey: Face ID, Touch ID, Windows Hello
          or a security key, instead of typing a code.
        </p>
      ) : (
        <>
          <p className="text-secondary">
            Sign in with Face ID, Touch ID, Windows Hello or a security key instead of a code.
          </p>
          {passkeys.length > 0 ? (
            <ul className="passkey-list" aria-label="Your passkeys">
              {passkeys.map((p) => (
                <li key={p.id} className="passkey-list__item">
                  <span>
                    <span className="table__primary wrap-anywhere">{p.name}</span>
                    <span className="table__secondary">
                      Added {formatInZone(p.createdAt, 'UTC')} ·{' '}
                      {p.lastUsedAt
                        ? `last used ${formatInZone(p.lastUsedAt, 'UTC')}`
                        : 'not used yet'}
                    </span>
                  </span>
                  <Dialog
                    trigger={{
                      label: (
                        <>
                          Remove<span className="visually-hidden"> passkey {p.name}</span>…
                        </>
                      ),
                      variant: 'danger-secondary',
                      size: 'sm',
                    }}
                    title={`Remove “${p.name}”?`}
                    description="It will no longer work for signing in."
                  >
                    <RemoveFlow key={`${p.id}-${round}`} passkey={p} onFinished={finish} />
                  </Dialog>
                </li>
              ))}
            </ul>
          ) : null}
          <div>
            <Dialog
              trigger={{ label: 'Add a passkey…', variant: 'secondary' }}
              title="Add a passkey"
              description="Your device will ask you to confirm with your face, fingerprint, PIN or security key."
            >
              <AddFlow key={`a${round}`} onFinished={finish} />
            </Dialog>
          </div>
        </>
      )}
    </div>
  );
}

/** "Use your passkey" on the second sign-in step (ADR-0033). */
export function PasskeyLoginButton({ next }: { next: string }) {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, start] = useTransition();
  if (expired) {
    return (
      <Notice tone="warning" title="This sign-in has expired">
        <a href="/login">Sign in again</a>.
      </Notice>
    );
  }
  return (
    <div className="stack-sm">
      {problem ? (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      ) : null}
      <Button
        block
        icon="lock"
        disabled={pending}
        aria-busy={pending}
        onClick={() =>
          start(async () => {
            setProblem(null);
            const options = await passkeyLoginOptionsAction();
            if (!options.ok || !options.options) {
              if (options.reason === 'challenge_invalid') return setExpired(true);
              return setProblem(options.message ?? 'Something went wrong.');
            }
            let response: unknown;
            try {
              response = await startAuthentication({ optionsJSON: options.options as never });
            } catch (error) {
              return setProblem(browserProblem(error));
            }
            const r = await completePasskeyLoginAction(response);
            if (r.ok) return router.push(next);
            if (r.reason === 'challenge_invalid' || r.reason === 'locked') {
              setProblem(r.message ?? null);
              return setExpired(r.reason === 'challenge_invalid');
            }
            setProblem(r.message ?? 'That passkey could not be verified.');
          })
        }
      >
        {pending ? 'Waiting for your device…' : 'Use your passkey'}
      </Button>
    </div>
  );
}
