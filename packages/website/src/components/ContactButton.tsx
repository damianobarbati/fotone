import cx from 'clsx-tw';
import { ISend } from '../icons.tsx';

type ContactButtonProps = { className?: string; labelClassName?: string };

export const ContactButton = ({ className, labelClassName }: ContactButtonProps) => {
  const result = (
    <button
      className={cx('site-action text-sm', className)}
      type="button"
      onClick={(event) => {
        if (!event.isTrusted) return;

        window.location.href = window.atob('bWFpbHRvOmRhbWlhbm8uYmFyYmF0aUBnbWFpbC5jb20=');
      }}
    >
      <ISend aria-hidden="true" size="1rem" />
      <span className={labelClassName}>Contact me</span>
    </button>
  );

  return result;
};
