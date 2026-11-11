'use client';

import { useActionState } from 'react';
import { deleteImageAction, updateImageAction, uploadImageAction } from '@/app/actions/images';
import { initialFormState } from '@/lib/errors';
import { IMAGE_ACCEPT } from '@/lib/images';
import { Field, FormMessage, SubmitButton } from './form';
import { Dialog, DialogCancel } from './ui/dialog';

/** Upload form for the image library (ADR-0042). */
export function UploadImageForm(props: { organizationId: string; idempotencyKey: string }) {
  const [state, action] = useActionState(uploadImageAction, initialFormState);
  return (
    <form action={action} className="form" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="organizationId" value={props.organizationId} />
      <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
      <Field
        name="data"
        label="Image"
        type="file"
        accept={IMAGE_ACCEPT}
        state={state}
        required
        hint="JPEG, PNG or WebP, up to 8 MB. Location and camera details are removed."
      />
      <Field
        name="name"
        label="Name"
        state={state}
        maxLength={200}
        hint="For finding it in the library. Leave empty to use the file name."
      />
      <Field
        name="altText"
        label="Text alternative"
        state={state}
        maxLength={300}
        hint="Describes the image for people who cannot see it. Leave empty if it is decorative."
      />
      <div>
        <SubmitButton pendingLabel="Uploading…">Upload image</SubmitButton>
      </div>
    </form>
  );
}

/** Rename an image or change its text alternative. */
export function EditImageDialog(props: {
  organizationId: string;
  assetId: string;
  name: string;
  altText: string;
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(updateImageAction, initialFormState);
  return (
    <Dialog
      trigger={{
        label: (
          <>
            Edit<span className="visually-hidden"> {props.name}</span>
          </>
        ),
        variant: 'secondary',
        size: 'sm',
      }}
      title="Edit image"
      description="Pages show the new text the next time they are published."
    >
      <form action={action} className="form" noValidate>
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="assetId" value={props.assetId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <Field
          name="name"
          id={`name-${props.assetId}`}
          label="Name"
          state={state}
          defaultValue={props.name}
          maxLength={200}
          required
        />
        <Field
          name="altText"
          id={`alt-${props.assetId}`}
          label="Text alternative"
          state={state}
          defaultValue={props.altText}
          maxLength={300}
          hint="Leave empty if the image is decorative."
        />
        <div className="cluster">
          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          <DialogCancel />
        </div>
      </form>
    </Dialog>
  );
}

/** Delete, confirmed in a dialog. A page that uses the image blocks it; the API says which. */
export function DeleteImageDialog(props: {
  organizationId: string;
  assetId: string;
  name: string;
  idempotencyKey: string;
}) {
  const [state, action] = useActionState(deleteImageAction, initialFormState);
  return (
    <Dialog
      trigger={{
        label: (
          <>
            Delete<span className="visually-hidden"> {props.name}</span>
          </>
        ),
        variant: 'plain',
        size: 'sm',
        icon: 'trash',
      }}
      title="Delete this image?"
      description="It is removed from the library and storage. Images used on a page cannot be deleted."
    >
      <form action={action} className="form">
        <FormMessage state={state} />
        <input type="hidden" name="organizationId" value={props.organizationId} />
        <input type="hidden" name="assetId" value={props.assetId} />
        <input type="hidden" name="idempotencyKey" value={props.idempotencyKey} />
        <div className="cluster">
          <SubmitButton variant="danger" pendingLabel="Deleting…">
            Delete image
          </SubmitButton>
          <DialogCancel />
        </div>
      </form>
    </Dialog>
  );
}
