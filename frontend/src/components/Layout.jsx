import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext.jsx';
import { useSocket } from '../context/SocketContext.jsx';
import { useOffline } from '../context/OfflineContext.jsx';
import { SUPPORTED_LANGUAGES } from '../i18n/config.js';

// Inventory features (Products, Suppliers, Cycle Counting, etc.) work
// identically in both editions now — Web/LAN Edition runs the same
// feature set against Postgres that Desktop Edition runs against SQLite
// (see backend/src/controllers/*.js's parallel implementations). `group`
// just drives the sidebar section labels below, rendered in the order
// items first appear rather than as separate hardcoded arrays. `navKey`
// looks up the label from the nav.* translation namespace — see
// i18n/locales/en.json for the source strings.
const storeNav = [
  { group: 'overview', to: '/', navKey: 'dashboard', icon: '📊', end: true },
  { group: 'overview', to: '/analytics', navKey: 'analytics', icon: '📈' },
  { group: 'storeOperations', to: '/products', navKey: 'products', icon: '📦' },
  { group: 'storeOperations', to: '/stock-arrival', navKey: 'stockArrival', icon: '🚚' },
  { group: 'storeOperations', to: '/movements', navKey: 'movements', icon: '🔁' },
  { group: 'storeOperations', to: '/replenishment', navKey: 'replenishment', icon: '🔄', roles: ['admin', 'manager'] },
  { group: 'storeOperations', to: '/suppliers', navKey: 'suppliers', icon: '🚚', roles: ['admin', 'manager'] },
  { group: 'storeOperations', to: '/customers', navKey: 'customers', icon: '🧾', roles: ['admin', 'manager', 'cashier', 'checkout', 'staff'] },
  { group: 'storeOperations', to: '/expiry-tracker', navKey: 'expiryTracker', icon: '⏳', roles: ['admin', 'manager'] },
  { group: 'storeOperations', to: '/cycle-counting', navKey: 'cycleCounting', icon: '⏱️' },
  { group: 'storeOperations', to: '/shelf-audit', navKey: 'shelfAudit', icon: '📋' },
  { group: 'storeOperations', to: '/audit-report', navKey: 'auditReport', icon: '📑' },
  { group: 'storeOperations', to: '/checkout', navKey: 'checkout', icon: '🛒' },
  { group: 'storeOperations', to: '/sales', navKey: 'sales', icon: '🧮', roles: ['admin', 'manager', 'cashier', 'checkout'] },
  { group: 'storeOperations', to: '/shifts', navKey: 'shifts', icon: '⏰', roles: ['admin', 'manager', 'cashier', 'checkout'] },
  { group: 'storeOperations', to: '/receipts', navKey: 'receipts', icon: '🧾' },
  { group: 'storeOperations', to: '/camera', navKey: 'camera', icon: '📷' },
  { group: 'administration', to: '/settings', navKey: 'settings', icon: '⚙️', roles: ['admin'] },
  { group: 'administration', to: '/billing', navKey: 'billing', icon: '💰' },
  { group: 'administration', to: '/invites', navKey: 'invites', icon: '✉️' },
  { group: 'administration', to: '/users', navKey: 'users', icon: '👥' },
  { group: 'administration', to: '/export', navKey: 'export', icon: '⬇️', roles: ['admin'] },
  { group: 'administration', to: '/support', navKey: 'support', icon: '🎧', roles: ['admin', 'manager'] },
  { group: 'administration', to: '/integrations', navKey: 'integrations', icon: '🔌', roles: ['admin'] },
  { group: 'administration', to: '/activity', navKey: 'activity', icon: '🕓', roles: ['admin', 'manager'] },
  { group: 'administration', to: '/account', navKey: 'account', icon: '👤' },
  { group: 'reports', to: '/daily-report', navKey: 'dailyReport', icon: '📅', roles: ['admin', 'manager'] },
  { group: 'reports', to: '/reports', navKey: 'reports', icon: '📄' },
  { group: 'reports', to: '/shrinkage-report', navKey: 'shrinkage', icon: '📉', roles: ['admin', 'manager'] },
];
// The auditor-marketplace flow (hiring an independent third-party auditor
// across stores, and the cross-store customer marketplace) needs a
// central directory and only exists on the cloud backend — a standalone
// Desktop Edition install has no concept of "other stores" to cross-
// reference, so these stay edition-gated even though inventory features
// no longer are. The physical shelf/floor/row count audit above is a
// same-store feature and works in both editions unconditionally.
const marketplaceNav = [
  { group: 'marketplace', to: '/auditor-tab', navKey: 'hireAuditor', icon: '🕵️' },
  { group: 'marketplace', to: '/marketplace', navKey: 'marketplace', icon: '🛍️' },
  { group: 'lending', to: '/lending-partners', navKey: 'lendingPartners', icon: '🏦', roles: ['admin'] },
];

// The super-admin console is internal tooling used only by this
// business's own staff, not by shopkeepers/cashiers — English-only for
// now is a deliberate scope line for this pass, not an oversight; the
// group/label strings below stay hardcoded English rather than pulling
// from the nav.* namespace like storeNav/marketplaceNav do.
const superNav = [
  { group: 'Administration', to: '/super', label: '⭐ Super Dashboard', icon: '⭐', text: 'Super Dashboard', end: true },
  { group: 'Administration', to: '/super/stores', label: '🏪 Manage Stores', icon: '🏪', text: 'Manage Stores' },
  { group: 'Administration', to: '/super/referrals', label: '🎯 Referrals', icon: '🎯', text: 'Referrals' },
  { group: 'Administration', to: '/super/users', label: '👥 All Users', icon: '👥', text: 'All Users' },
  { group: 'Administration', to: '/super/subscriptions', label: '💳 Tiers & Codes', icon: '💳', text: 'Tiers & Codes' },
  { group: 'Administration', to: '/super/billing', label: '💰 Billing Charges', icon: '💰', text: 'Billing Charges' },
  { group: 'Administration', to: '/super/support', label: '🎧 Support Tickets', icon: '🎧', text: 'Support Tickets' },
  { group: 'Administration', to: '/super/activity', label: '🕓 Activity Log', icon: '🕓', text: 'Activity Log' },
  { group: 'Administration', to: '/super/account', label: '👤 My Account', icon: '👤', text: 'My Account' },
];
const superMarketplaceNav = [
  { group: 'Marketplace', to: '/super/marketplace', label: '🛒 Marketplace Control', icon: '🛒', text: 'Marketplace Control' },
  { group: 'Marketplace', to: '/super/auditors', label: '🕵️ Auditors', icon: '🕵️', text: 'Auditors' },
  { group: 'Marketplace', to: '/super/lending-partners', label: '🏦 Lending Partners', icon: '🏦', text: 'Lending Partners' },
];

// Compact language switcher — a native-name dropdown, not flags (a flag
// implies a country, not a language; several of these languages are
// spoken across many countries, and a couple of countries here use more
// than one of these languages, so a flag would misrepresent it either
// way). Changing it persists to localStorage (see i18n/config.js's
// detection config) so it survives a reload/relaunch.
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <select
      aria-label={t('common.language')}
      value={i18n.resolvedLanguage}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      style={{ width: '100%', marginTop: 8, fontSize: 12, padding: '4px 6px' }}
    >
      {SUPPORTED_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>{l.nativeName}</option>
      ))}
    </select>
  );
}

export default function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { connected, peers } = useSocket();
  const { isOnline, queuedCount } = useOffline();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isDesktop = import.meta.env.VITE_EDITION === 'desktop';
  const isSuperAdmin = user?.role === 'super_admin';
  const nav = (isSuperAdmin
    ? (isDesktop ? superNav : [...superNav, ...superMarketplaceNav])
    : (isDesktop ? storeNav : [...storeNav, ...marketplaceNav])
  ).filter((item) => !item.roles || item.roles.includes(user?.role));

  const groups = [];
  for (const item of nav) {
    let g = groups.find((x) => x.name === item.group);
    // storeNav/marketplaceNav use short keys ('overview', 'storeOperations', …)
    // resolved via nav.groups.*; superNav/superMarketplaceNav already carry
    // the literal English label to display (see the comment above superNav).
    const displayName = isSuperAdmin ? item.group : t(`nav.groups.${item.group}`);
    if (!g) { g = { name: item.group, displayName, items: [] }; groups.push(g); }
    g.items.push(item);
  }

  // Mobile sidebar auto-closes on every route change — otherwise it would
  // stay open (covering the page) after tapping a nav link, which is the
  // one interaction the mockup's toggleSidebar()/overlay-click handlers
  // provide that a plain CSS class-toggle wouldn't give us for free here.
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const statusLabel = !isSuperAdmin && !isOnline
    ? t('nav.status.offline')
    : !isSuperAdmin && connected
      ? `${t('nav.status.online')}${peers > 0 ? ` · ${t('nav.status.otherOnline', { count: peers })}` : ''}`
      : isSuperAdmin
        ? t('nav.status.online')
        : t('nav.status.connecting');
  const statusOk = isSuperAdmin || (isOnline && connected);

  return (
    <>
      <div className="status-bar">
        <div className="sync-status">
          <span className={`sync-dot${statusOk ? '' : ' offline'}`} />
          <span>{statusLabel}</span>
        </div>
        {!isSuperAdmin && (
          <div>
            {queuedCount > 0 && <span style={{ marginRight: 12 }}>📤 {t('nav.status.pending', { count: queuedCount })}</span>}
            <span>{isOnline ? (connected ? t('nav.status.liveSyncActive') : t('nav.status.reconnecting')) : t('nav.status.workingOffline')}</span>
          </div>
        )}
      </div>

      <div className="app-layout">
        {sidebarOpen && <div className="sidebar-overlay active" onClick={() => setSidebarOpen(false)} />}
        <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
          <div className="brand">
            <div className="brand-mark">🏪</div>
            <div className="brand-text">
              SAFE Stores
              <small>{isSuperAdmin ? t('nav.systemAdministration') : t('nav.inventoryIntelligence')}</small>
            </div>
          </div>

          <div className="user-info">
            <div className="name">{user?.name}</div>
            <div className="role">
              <span className={`badge ${isSuperAdmin ? 'super-admin' : 'admin'}`}>{user?.role}</span>
            </div>
          </div>

          <nav className="nav">
            {groups.map((g) => (
              <div key={g.name}>
                <div className="nav-section-label">{g.displayName}</div>
                {g.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end}>
                    <span className="icon">{item.icon}</span> {item.navKey ? t(`nav.${item.navKey}`) : item.text}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="bottom-actions">
            <button onClick={handleLogout}><span>🚪</span> {t('nav.signOut')}</button>
          </div>
          {!isSuperAdmin && <LanguageSwitcher />}
          <div style={{ padding: '12px 4px 0', fontSize: 11, color: '#5a6f7c', textAlign: 'center', opacity: 0.8 }}>
            A product of <strong>A I Brains Ventures</strong>
          </div>
        </aside>

        <main className="main-content">
          {/* Every page renders its own `.topbar`/<h1> (see the comment on
              .topbar in global.css) — rather than editing each of those
              pages, one persistent toggle button here covers all of them.
              CSS shows it only under the 768px breakpoint, same as the
              mockup's .mobile-toggle. */}
          <button
            type="button"
            className="mobile-toggle"
            aria-label={t('nav.toggleMenu')}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          <Outlet />
        </main>
      </div>
    </>
  );
}
