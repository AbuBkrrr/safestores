import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const KEY = 'ss_market_install_dismissed';
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const recentlyDismissed = () => { try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < 3 * 86400000; } catch { return false; } };

/**
 * Offers shoppers "SAFE Stores Market" on their home screen: Android/Chrome
 * gets a one-tap Install; iPhone gets the two-step "Share → Add to Home
 * Screen" hint. Hidden once installed, and for 3 days after "Not now".
 */
export default function InstallMarketBanner() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState(() => window.__ssInstall || null);
  const [hidden, setHidden] = useState(() => standalone() || recentlyDismissed());
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const ready = () => setPrompt(window.__ssInstall || null);
    const done = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('ss-install-ready', ready);
    window.addEventListener('appinstalled', done);
    return () => { window.removeEventListener('ss-install-ready', ready); window.removeEventListener('appinstalled', done); };
  }, []);
  if (hidden || (!prompt && !isIos() && !installed)) return null;
  const dismiss = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ } setHidden(true); };
  const install = async () => {
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => ({}));
    window.__ssInstall = null; setPrompt(null);
    if (choice?.outcome === 'accepted') setInstalled(true); else dismiss();
  };
  return (
    <div role="dialog" aria-label={t('installMarket.title')} style={{
      position: 'fixed', left: 12, right: 12, bottom: 'max(12px, env(safe-area-inset-bottom))', zIndex: 1500,
      background: 'var(--card, #fff)', color: 'var(--ink, #1f2937)', borderRadius: 14, boxShadow: '0 8px 30px rgba(0,0,0,.25)',
      padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, maxWidth: 520, margin: '0 auto',
    }}>
      <img src="/icon-192.png" alt="" width="44" height="44" style={{ borderRadius: 10, flex: '0 0 auto' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{installed ? t('installMarket.done') : t('installMarket.title')}</strong>
        {!installed && <div className="small muted">{prompt ? t('installMarket.why') : t('installMarket.ios')}</div>}
      </div>
      {!installed && prompt && <button type="button" className="btn small" onClick={install}>{t('installMarket.install')}</button>}
      <button type="button" className="btn secondary small" onClick={dismiss} aria-label={t('installMarket.notNow')}>{installed ? '✓' : t('installMarket.notNow')}</button>
    </div>
  );
}
