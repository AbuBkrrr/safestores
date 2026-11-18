import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

const HIDE_KEY = 'ss_onboarding_hidden';

/** Dashboard checklist for new stores — disappears once everything is done (or dismissed). */
export default function GettingStarted() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [s, setS] = useState(null);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(`${HIDE_KEY}_${user.storeId}`) === '1'; } catch { return false; } });
  const [busy, setBusy] = useState(false);

  const load = () => api.get(`/stores/${user.storeId}/onboarding`).then((r) => setS(r.data)).catch(() => setS(null));
  useEffect(() => { if (['admin', 'manager'].includes(user.role) && !hidden) load(); }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s || s.complete || hidden || !Array.isArray(s.steps)) return null;
  const done = s.steps.filter((x) => x.done).length;

  const samples = async () => {
    setBusy(true);
    try { await api.post(`/stores/${user.storeId}/onboarding/sample-data`); await load(); } finally { setBusy(false); }
  };
  const dismiss = () => { try { localStorage.setItem(`${HIDE_KEY}_${user.storeId}`, '1'); } catch { /* ignore */ } setHidden(true); };

  return (
    <div className="card getting-started">
      <div className="flex-between">
        <h3>🚀 {t('onboarding.title')} <span className="muted">({done}/{s.steps.length})</span></h3>
        <button className="btn small secondary" onClick={dismiss}>{t('onboarding.hide')}</button>
      </div>
      <div className="progress" aria-hidden="true"><span style={{ width: `${(done / s.steps.length) * 100}%` }} /></div>
      <ol className="gs-steps">
        {s.steps.map((step) => (
          <li key={step.key} className={step.done ? 'done' : ''}>
            <span aria-hidden="true">{step.done ? '✅' : '⬜'}</span>
            <span><strong>{t(`onboarding.steps.${step.key}.title`)}</strong><br /><span className="muted">{t(`onboarding.steps.${step.key}.hint`)}</span></span>
            {!step.done && <Link className="btn small" to={step.to}>{t('onboarding.go')}</Link>}
          </li>
        ))}
      </ol>
      {s.canLoadSamples && user.role === 'admin' && (
        <p className="muted">{t('onboarding.samplesHint')} <button className="btn small secondary" disabled={busy} onClick={samples}>{t('onboarding.loadSamples')}</button></p>
      )}
    </div>
  );
}
