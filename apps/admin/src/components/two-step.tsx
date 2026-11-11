'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import {
  confirmMfaAction,
  disableMfaAction,
  regenerateRecoveryCodesAction,
  startMfaSetupAction,
  type MfaActionResult,
} from '@/app/actions/mfa';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogCancel } from './ui/dialog';
import { Notice } from './ui/notice';

export interface TwoStepStatus {
  available: boolean;
  status: 'off' | 'pending' | 'on';
  enabledAt: string | null;
  recoveryCodesRemaining: number;
}

export function Input(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'text';
  hint?: string;
}) {
  const describedBy =
    [props.hint ? `${props.id}-hint` : null, props.error ? `${props.id}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="input"
        type={props.type ?? 'text'}
        value={props.value}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint ? (
        <span className="field__hint" id={`${props.id}-hint`}>
          {props.hint}
        </span>
      ) : null}
      {props.error ? (
        <div className="field__error" id={`${props.id}-error`}>
          {props.error}
        </div>
      ) : null}
    </div>
  );
}

export function Problem({
  result,
}: {
  result: Pick<MfaActionResult, 'ok' | 'message' | 'reference'> | null;
}) {
  if (!result || result.ok || !result.message) return null;
  return (
    <Notice tone="danger" reference={result.reference}>
      {result.message}
    </Notice>
  );
}

/** Recovery codes, shown once, with copy and download. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  return (
    <div className="stack-sm">
      <Notice tone="warning" title="Save these recovery codes now" role={null}>
        Each code signs you in once if you lose your phone. They will not be shown again.
      </Notice>
      <ol className="recovery-codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="text-mono">
            {c}
          </li>
        ))}
      </ol>
      <div className="form__actions">
        <Button
          variant="secondary"
          icon="copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <a
          className="btn btn--secondary"
          download="eventhub-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(`EventHub OS recovery codes\n\n${text}\n`)}`}
        >
          Download
        </a>
        <Button onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function SetupFlow({ onFinished }: { onFinished: () => void }) {
  const [step, setStep] = useState<'password' | 'scan' | 'codes'>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<MfaActionResult | null>(null);
  const [result, setResult] = useState<MfaActionResult | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    start(fn);
  };

  if (step === 'codes' && result?.recoveryCodes) {
    return <RecoveryCodes codes={result.recoveryCodes} onDone={onFinished} />;
  }
  if (step === 'scan' && setup?.secret) {
    return (
      <form
        className="form"
        noValidate
        onSubmit={(e) =>
          submit(e, async () => {
            const r = await confirmMfaAction(code);
            setResult(r);
            if (r.ok) setStep('codes');
          })
        }
      >
        <Problem result={result} />
        <p>
          Scan this code with your authenticator app (for example 1Password or Google
          Authenticator).
        </p>
        {setup.qr ? (
          <img
            className="qr-code"
            src={setup.qr}
            width={200}
            height={200}
            alt="QR code for adding EventHub OS to your authenticator app"
          />
        ) : null}
        <p className="field__hint">
          Can’t scan it? Enter this key instead: <span className="text-mono">{setup.secret}</span>
        </p>
        <Input
          id="mfa-confirm-code"
          label="Code from your app"
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          inputMode="numeric"
          error={result?.fields?.code}
        />
        <div className="form__actions">
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? 'Checking…' : 'Turn on'}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) =>
        submit(e, async () => {
          const r = await startMfaSetupAction(password);
          setSetup(r);
          setResult(r.ok ? null : r);
          if (r.ok) setStep('scan');
        })
      }
    >
      <Problem result={result} />
      <Input
        id="mfa-setup-password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={result?.fields?.currentPassword}
      />
      <div className="form__actions">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Checking…' : 'Continue'}
        </Button>
        <DialogCancel />
      </div>
    </form>
  );
}

function RegenerateFlow({ onFinished }: { onFinished: () => void }) {
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<MfaActionResult | null>(null);
  const [pending, start] = useTransition();
  if (result?.ok && result.recoveryCodes) {
    return <RecoveryCodes codes={result.recoveryCodes} onDone={onFinished} />;
  }
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setResult(await regenerateRecoveryCodesAction(password)));
      }}
    >
      <Problem result={result} />
      <Input
        id="mfa-regen-password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={result?.fields?.currentPassword}
      />
      <div className="form__actions">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating…' : 'Create new codes'}
        </Button>
        <DialogCancel />
      </div>
    </form>
  );
}

function DisableFlow({ onFinished }: { onFinished: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [result, setResult] = useState<MfaActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await disableMfaAction(
            password,
            useRecovery ? { recoveryCode: code } : { code },
          );
          setResult(r);
          if (r.ok) onFinished();
        });
      }}
    >
      <Problem result={result} />
      <Input
        id="mfa-disable-password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={result?.fields?.currentPassword}
      />
      <Input
        id="mfa-disable-code"
        label={useRecovery ? 'Recovery code' : 'Code from your app'}
        value={code}
        onChange={setCode}
        autoComplete={useRecovery ? 'off' : 'one-time-code'}
        inputMode={useRecovery ? 'text' : 'numeric'}
        error={useRecovery ? result?.fields?.recoveryCode : result?.fields?.code}
      />
      <Button variant="plain" size="sm" onClick={() => setUseRecovery((v) => !v)}>
        {useRecovery ? 'Use a code from your app instead' : 'Use a recovery code instead'}
      </Button>
      <div className="form__actions form__actions--end">
        <DialogCancel />
        <Button type="submit" variant="danger" disabled={pending} aria-busy={pending}>
          {pending ? 'Turning off…' : 'Turn off two-step verification'}
        </Button>
      </div>
    </form>
  );
}

/** Account page card: status and the three flows, each in a dialog. */
export function TwoStepPanel({
  status,
  enabledLabel,
}: {
  status: TwoStepStatus;
  enabledLabel?: ReactNode;
}) {
  const router = useRouter();
  const [round, setRound] = useState(0);
  const finish = () => {
    setRound((r) => r + 1); // fresh flows next time
    document.querySelectorAll('dialog[open]').forEach((d) => (d as HTMLDialogElement).close());
    router.refresh();
  };
  if (!status.available) {
    return <Notice role={null}>Two-step verification is not available on this server yet.</Notice>;
  }
  if (status.status !== 'on') {
    return (
      <div className="stack-sm">
        <p>
          <Badge>Off</Badge>
        </p>
        <p className="text-secondary">
          Add a second step to sign-in: a 6-digit code from an authenticator app on your phone.
        </p>
        <div>
          <Dialog
            kind="sheet"
            trigger={{ label: 'Turn on two-step verification…' }}
            title="Turn on two-step verification"
            description="You will need your password and your phone."
          >
            <SetupFlow key={round} onFinished={finish} />
          </Dialog>
        </div>
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <p className="cluster">
        <Badge tone="success" dot>
          On
        </Badge>
        {enabledLabel}
      </p>
      <p className="text-secondary">
        {status.recoveryCodesRemaining} of 10 recovery codes left.
        {status.recoveryCodesRemaining <= 3 ? ' Create new ones soon.' : ''}
      </p>
      <div className="form__actions">
        <Dialog
          trigger={{ label: 'New recovery codes…', variant: 'secondary' }}
          title="Create new recovery codes"
          description="Your current codes will stop working."
        >
          <RegenerateFlow key={`r${round}`} onFinished={finish} />
        </Dialog>
        <Dialog
          trigger={{ label: 'Turn off…', variant: 'danger-secondary' }}
          title="Turn off two-step verification?"
          description="Signing in will need only your password."
        >
          <DisableFlow key={`d${round}`} onFinished={finish} />
        </Dialog>
      </div>
    </div>
  );
}
