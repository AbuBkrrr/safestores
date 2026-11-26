import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/**
 * Shows the camera over the whole screen (phones and tablets) so the item,
 * barcode or QR code is easy to aim at. Children: the <video> (it fills the
 * screen) and optional overlay content (guide box, buttons, results).
 */
export default function FullCamera({ onClose, children, footer, hint }) {
  const { t } = useTranslation();
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return createPortal(
    <div className="camera-full" role="dialog" aria-modal="true">
      {children}
      <button type="button" className="camera-close" onClick={onClose} aria-label={t('common.close', 'Close')}>✕</button>
      {hint && <div className="camera-hint">{hint}</div>}
      {footer && <div className="camera-footer">{footer}</div>}
    </div>,
    document.body,
  );
}
