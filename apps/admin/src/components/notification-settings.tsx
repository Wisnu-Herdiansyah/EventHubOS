'use client';

import { useActionState } from 'react';
import { updateDownloadAlertsAction } from '@/app/actions/notifications';
import { initialFormState } from '@/lib/errors';
import { FormMessage, SubmitButton } from './form';

/** The person's own choice about download alerts in this organization (ADR-0049). */
export function DownloadAlertsForm(props: {
  organizationId: string;
  idempotencyKey: string;
  enabled: boolean;
}) {
  const [state, action] = useActionState(updateDownloadAlertsAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <div className="field">
        <label className="checkbox">
          <input
            type="checkbox"
            name="dataDownload"
            defaultChecked={props.enabled}
            aria-describedby="data-download-hint"
          />
          <span>Email me when someone downloads an attendee list or the audit log</span>
        </label>
        <span className="field__hint" id="data-download-hint">
          Says who downloaded what and how many rows, never attendee details. You are not emailed
          about your own downloads.
        </span>
      </div>
      <div>
        <SubmitButton pendingLabel="Saving…">Save email settings</SubmitButton>
      </div>
    </form>
  );
}
