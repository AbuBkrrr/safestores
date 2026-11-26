import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { CurrencyProvider } from './context/CurrencyContext.jsx';
import { SocketProvider } from './context/SocketContext.jsx';
import { OfflineProvider } from './context/OfflineContext.jsx';
import { hideSplashScreen, setupStatusBar, registerPushOnLogin } from './mobile/push.js';
import { init as initErrorMonitoring, ErrorBoundary } from './utils/errorMonitoring.js';
import './i18n/config.js';
import './styles/global.css';
import { initPreferences } from './utils/preferences.js';

initPreferences(); // theme + text size, before first paint

// Offline start for the web edition (see public/sw.js). Not in the
// Android (Capacitor) or desktop (Electron) shells — they ship the app
// files locally already — and not in dev, where it would cache stale code.
if (import.meta.env.PROD && import.meta.env.VITE_EDITION !== 'desktop' && 'serviceWorker' in navigator
    && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

initErrorMonitoring(); // safe no-op if VITE_SENTRY_DSN wasn't set at build time — see that file

function CrashFallback({ error, resetError }) {
  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <h1>Something went wrong</h1>
        <p className="muted" style={{ marginBottom: 16 }}>
          The app hit an unexpected error. Your data is safe — reloading usually fixes this.
        </p>
        <button className="btn" style={{ width: '100%' }} onClick={() => window.location.reload()}>Reload</button>
        <button className="btn secondary" style={{ width: '100%', marginTop: 8 }} onClick={resetError}>Try to continue without reloading</button>
      </div>
    </div>
  );
}

// A store's own custom domain (shop.example.com) opens straight into its
// storefront. Hosts in VITE_MAIN_HOSTS (and their subdomains) are the app itself.
const MAIN_HOSTS = (import.meta.env.VITE_MAIN_HOSTS || 'safestore.com.ng,app.safestore.com.ng,safestores.name.ng,app.safestores.name.ng,localhost,127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
function isCustomShopHost() {
  const h = window.location.hostname;
  if (!/^https?:$/.test(window.location.protocol) || !h || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  if (import.meta.env.VITE_EDITION === 'desktop') return false;
  return !MAIN_HOSTS.some((m) => h === m || h.endsWith(`.${m}`));
}
async function resolveShopHost() {
  if (!isCustomShopHost()) return;
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/public/by-domain/${encodeURIComponent(window.location.hostname)}`);
    if (res.ok) window.__SHOP_DOMAIN_STORE__ = (await res.json()).storeId;
  } catch { /* not a shop domain — load the normal app */ }
}

resolveShopHost().then(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary fallback={CrashFallback}>
      <BrowserRouter>
        <AuthProvider>
          <CurrencyProvider>
            <OfflineProvider>
              <SocketProvider>
                <App />
              </SocketProvider>
            </OfflineProvider>
          </CurrencyProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
));

// Native-shell-only, no-op on web/desktop — see mobile/push.js.
setupStatusBar();
hideSplashScreen();
// A relaunch with an already-persisted session (localStorage still has
// ss_user) needs its own re-registration call — AuthContext's login()
// only fires this on a fresh login, not on rehydrating existing state.
if (localStorage.getItem('ss_user')) registerPushOnLogin();
