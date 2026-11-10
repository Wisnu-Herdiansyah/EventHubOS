import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-secondary' | 'plain';
export type ButtonSize = 'md' | 'sm';

export interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Icon-only button: the children become a visually hidden label. */
  iconOnly?: boolean;
  block?: boolean;
}

export function buttonClass({
  variant = 'primary',
  size = 'md',
  iconOnly,
  block,
  className,
}: ButtonStyleProps & { className?: string | undefined }): string {
  return [
    'btn',
    variant === 'primary' ? null : `btn--${variant}`,
    size === 'sm' ? 'btn--sm' : null,
    iconOnly ? 'btn--icon' : null,
    block ? 'btn--block' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

function Content({ icon, iconOnly, children }: ButtonStyleProps & { children: ReactNode }) {
  return (
    <>
      {icon ? <Icon name={icon} size={18} /> : null}
      {iconOnly ? <span className="visually-hidden">{children}</span> : children}
    </>
  );
}

export function Button({
  variant,
  size,
  icon,
  iconOnly,
  block,
  className,
  type = 'button',
  children,
  ref,
  ...rest
}: ButtonStyleProps & ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, iconOnly, block, className })}
      {...rest}
    >
      <Content icon={icon} iconOnly={iconOnly}>
        {children}
      </Content>
    </button>
  );
}

/** A link that looks like a button, for navigation (never for actions). */
export function ButtonLink({
  href,
  variant,
  size,
  icon,
  iconOnly,
  block,
  className,
  children,
}: ButtonStyleProps & { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass({ variant, size, iconOnly, block, className })}>
      <Content icon={icon} iconOnly={iconOnly}>
        {children}
      </Content>
    </Link>
  );
}
