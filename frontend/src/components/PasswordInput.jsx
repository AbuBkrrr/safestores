import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// A password field with a show/hide button. Takes every normal <input> prop.
export default function PasswordInput({ style, className, ...props }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  return (
    <span className={`pw-wrap${className ? ` ${className}` : ''}`} style={style}>
      <input {...props} type={shown ? 'text' : 'password'} />
      <button type="button" className="pw-toggle" onClick={() => setShown((s) => !s)}
        aria-label={shown ? t('common.hidePassword') : t('common.showPassword')} aria-pressed={shown} title={shown ? t('common.hidePassword') : t('common.showPassword')}>
        {shown ? '🙈' : '👁️'}
      </button>
    </span>
  );
}
