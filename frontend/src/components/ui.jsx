import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext.jsx';

export function Metric({ value, label }) {
  return (
    <div className="card metric">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function Alert({ type = 'info', children }) {
  if (!children) return null;
  return <div className={`alert ${type}`}>{children}</div>;
}

// The super-admin console stays English-only regardless of whatever
// language a store session last set in localStorage (see Layout.jsx's
// note on superNav) — there's no switcher shown there on purpose, so a
// leftover non-English `ss_lang` (e.g. a shared browser, or a demo
// environment) shouldn't silently translate status badges here either.
export function Badge({ status }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const lng = user?.role === 'super_admin' ? 'en' : undefined;
  return <span className={`badge ${status}`}>{t(`common.status.${status}`, { defaultValue: status, lng })}</span>;
}

export function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Toast({ message, type }) {
  if (!message) return null;
  return (
    <div
      style={{
        position: 'fixed', bottom: 20, right: 20, zIndex: 1000,
        background: type === 'error' ? '#b33a3a' : type === 'success' ? '#1f7a4d' : type === 'warning' ? '#c98a1f' : '#0f7180',
        color: '#fff', padding: '12px 18px', borderRadius: 8, boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
      }}
    >
      {message}
    </div>
  );
}

export function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>;
}

export function BrandFooter() {
  return (
    <div style={{ textAlign: 'center', fontSize: 12, color: '#8aa5a8', marginTop: 20 }}>
      A product of <strong>A I Brains Ventures</strong>
    </div>
  );
}

export function AuthBrand({ tagline }) {
  return (
    <div className="brand">
      <div className="brand-mark">🏪</div>
      <div className="brand-text">
        SAFE Stores
        <small>{tagline}</small>
      </div>
    </div>
  );
}
