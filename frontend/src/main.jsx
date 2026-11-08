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

ReactDOM.createRoot(document.getElementById('root')).render(
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
);

// Native-shell-only, no-op on web/desktop — see mobile/push.js.
setupStatusBar();
hideSplashScreen();
// A relaunch with an already-persisted session (localStorage still has
// ss_user) needs its own re-registration call — AuthContext's login()
// only fires this on a fresh login, not on rehydrating existing state.
if (localStorage.getItem('ss_user')) registerPushOnLogin();
