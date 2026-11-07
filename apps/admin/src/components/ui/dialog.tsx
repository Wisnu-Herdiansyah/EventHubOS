'use client';

import { useId, useRef, type ReactNode } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from './button';
import { Icon, type IconName } from './icons';

export interface DialogTriggerProps {
  /**
   * Text of the button that opens the dialog. When the visible text is short ("Remove…"), add
   * the context in a visually hidden span, so the name stays unique and starts with what is seen.
   */
  label: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  disabled?: boolean;
}

/**
 * A modal dialog (centred) or slide-over panel (docked right) built on the native <dialog>
 * element: the browser traps focus, closes on Escape and returns focus to the trigger.
 * Clicking the backdrop also closes it.
 */
export function Dialog({
  trigger,
  title,
  description,
  kind = 'dialog',
  children,
}: {
  trigger: DialogTriggerProps;
  title: string;
  description?: ReactNode;
  kind?: 'dialog' | 'sheet';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = () => ref.current?.close();
  return (
    <>
      <button
        type="button"
        className={buttonClass({ variant: trigger.variant, size: trigger.size })}
        aria-haspopup="dialog"
        disabled={trigger.disabled}
        onClick={() => ref.current?.showModal()}
      >
        {trigger.icon ? <Icon name={trigger.icon} size={18} /> : null}
        {/* One inline run, so hidden context joins the visible text without extra spaces. */}
        <span>{trigger.label}</span>
      </button>
      <dialog
        ref={ref}
        className={kind === 'sheet' ? 'dialog dialog--sheet' : 'dialog'}
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="dialog__header">
          <div>
            <h2 className="dialog__title" id={`${id}-title`}>
              {title}
            </h2>
            {description ? (
              <p className="dialog__description" id={`${id}-desc`}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className={buttonClass({
              variant: 'plain',
              size: 'sm',
              iconOnly: true,
              className: 'dialog__close',
            })}
            onClick={close}
          >
            <Icon name="close" size={18} />
            <span className="visually-hidden">Close</span>
          </button>
        </div>
        <div className="dialog__body">{children}</div>
      </dialog>
    </>
  );
}

/** Closes the dialog it sits in. For "Cancel" next to a dialog's submit button. */
export function DialogCancel({ children = 'Cancel' }: { children?: ReactNode }) {
  return (
    <button
      type="button"
      className={buttonClass({ variant: 'secondary' })}
      onClick={(e) => e.currentTarget.closest('dialog')?.close()}
    >
      {children}
    </button>
  );
}
