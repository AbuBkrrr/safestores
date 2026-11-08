import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import api from './api/client.js';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import SuperLogin from './pages/SuperLogin.jsx';
import Setup from './pages/Setup.jsx';
import ActivateStore from './pages/ActivateStore.jsx';
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const ActivityLog = lazy(() => import('./pages/ActivityLog.jsx'));
const Sales = lazy(() => import('./pages/Sales.jsx'));
const Shifts = lazy(() => import('./pages/Shifts.jsx'));
const DailyReport = lazy(() => import('./pages/DailyReport.jsx'));
const StoreSettings = lazy(() => import('./pages/StoreSettings.jsx'));
const PublicReceipt = lazy(() => import('./pages/PublicReceipt.jsx'));
const ImportProducts = lazy(() => import('./pages/ImportProducts.jsx'));
const Labels = lazy(() => import('./pages/Labels.jsx'));
const Insights = lazy(() => import('./pages/Insights.jsx'));
const Transfers = lazy(() => import('./pages/Transfers.jsx'));
const TrackOrder = lazy(() => import('./pages/TrackOrder.jsx'));
const Help = lazy(() => import('./pages/Help.jsx'));
const Terms = lazy(() => import('./pages/Legal.jsx').then((m) => ({ default: m.Terms })));
const Privacy = lazy(() => import('./pages/Legal.jsx').then((m) => ({ default: m.Privacy })));
const Licenses = lazy(() => import('./pages/Legal.jsx').then((m) => ({ default: m.Licenses })));
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { useAuth } from './context/AuthContext.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Analytics = lazy(() => import('./pages/Analytics.jsx'));
const Products = lazy(() => import('./pages/Products.jsx'));
const StockArrival = lazy(() => import('./pages/StockArrival.jsx'));
const Movements = lazy(() => import('./pages/Movements.jsx'));
const Replenishment = lazy(() => import('./pages/Replenishment.jsx'));
const ShelfAudit = lazy(() => import('./pages/ShelfAudit.jsx'));
const AuditReport = lazy(() => import('./pages/AuditReport.jsx'));
const ShrinkageReport = lazy(() => import('./pages/ShrinkageReport.jsx'));
const Auditor = lazy(() => import('./pages/Auditor.jsx'));
const Receipts = lazy(() => import('./pages/Receipts.jsx'));
const Camera = lazy(() => import('./pages/Camera.jsx'));
const Checkout = lazy(() => import('./pages/Checkout.jsx'));
const BillingStatus = lazy(() => import('./pages/BillingStatus.jsx'));
const Marketplace = lazy(() => import('./pages/Marketplace.jsx'));
const LendingPartners = lazy(() => import('./pages/LendingPartners.jsx'));
const Invites = lazy(() => import('./pages/Invites.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Export = lazy(() => import('./pages/Export.jsx'));
const Support = lazy(() => import('./pages/Support.jsx'));
const Integrations = lazy(() => import('./pages/Integrations.jsx'));
const Suppliers = lazy(() => import('./pages/Suppliers.jsx'));
const Customers = lazy(() => import('./pages/Customers.jsx'));
const ExpiryTracking = lazy(() => import('./pages/ExpiryTracking.jsx'));
const CycleCounting = lazy(() => import('./pages/CycleCounting.jsx'));

const AuditorSignup = lazy(() => import('./pages/AuditorSignup.jsx'));
const AuditorLogin = lazy(() => import('./pages/AuditorLogin.jsx'));
const AuditorDashboard = lazy(() => import('./pages/AuditorDashboard.jsx'));
const Storefront = lazy(() => import('./pages/Storefront.jsx'));
const MarketplaceHome = lazy(() => import('./pages/MarketplaceHome.jsx'));

const SuperDashboard = lazy(() => import('./pages/super/SuperDashboard.jsx'));
const ManageStores = lazy(() => import('./pages/super/ManageStores.jsx'));
const Subscriptions = lazy(() => import('./pages/super/Subscriptions.jsx'));
const BillingCharges = lazy(() => import('./pages/super/BillingCharges.jsx'));
const Auditors = lazy(() => import('./pages/super/Auditors.jsx'));
const MarketplaceControl = lazy(() => import('./pages/super/MarketplaceControl.jsx'));
const AllUsers = lazy(() => import('./pages/super/AllUsers.jsx'));
const Referrals = lazy(() => import('./pages/super/Referrals.jsx'));
const SupportTickets = lazy(() => import('./pages/super/SupportTickets.jsx'));
const LendingPartnersAdmin = lazy(() => import('./pages/super/LendingPartnersAdmin.jsx'));

const STORE_ROLES = ['admin', 'manager', 'staff', 'cashier', 'checkout', 'stock_taker'];

// Baked in at build time (see desktop/package.json's build:win:admin vs
// build:win:superadmin scripts). 'superadmin' (the default) is today's full
// app — Super Admin setup wizard, login, and dashboard all present. The
// 'admin' variant is a separate installer for store owners/staff only: no
// Super Admin setup step, login screen, or dashboard routes exist in that
// build at all, not just role-gated — so there's nothing to stumble into.
const APP_VARIANT = import.meta.env.VITE_APP_VARIANT || 'superadmin';

// 'desktop' (set by desktop/package.json's build scripts) vs the default
// 'web' — distinguishes features that need a central multi-tenant backend
// (auditor marketplace, cross-store marketplace) which the offline desktop
// SQLite edition has no backend support for at all.
const EDITION = import.meta.env.VITE_EDITION || 'web';

// Redirects a store user to the activation screen if their store isn't
// active yet. Only fires when subscriptionStatus is present and non-active
// (invite-logged-in users without this field are already guaranteed active
// by the backend at login time, so they pass through untouched).
function RequireActiveStore({ children }) {
  const { user } = useAuth();
  if (user?.subscriptionStatus && user.subscriptionStatus !== 'active') {
    return <Navigate to="/activate-store" replace />;
  }
  return children;
}

// Pages load on demand (code-splitting) so the first visit downloads only
// what the current screen needs — much faster on slow mobile networks.
export function PageLoading() {
  return <div className="page-loading" role="status" aria-live="polite"><span className="spinner" /></div>;
}

export default function App() {
  // Desktop edition only: checks whether the one-time Super Admin setup
  // wizard needs to run. On the web backend this endpoint doesn't exist,
  // so a failed request just means "no setup step needed" — normal login
  // screens are shown as usual.
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (APP_VARIANT === 'admin') { setChecked(true); return; }
    api.get('/setup/status')
      .then((r) => setNeedsSetup(!!r.data.needsSetup))
      .catch(() => setNeedsSetup(false))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (needsSetup) return <Setup onComplete={() => setNeedsSetup(false)} />;

  return (
    <Suspense fallback={<PageLoading />}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      {/* Digital receipt behind the QR code — public, no login. */}
      <Route path="/r/:token" element={<PublicReceipt />} />
      <Route path="/track/:token" element={<TrackOrder />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/licenses" element={<Licenses />} />
      {APP_VARIANT === 'superadmin' && <Route path="/super-login" element={<SuperLogin />} />}
      <Route path="/auditor-signup" element={<AuditorSignup />} />
      <Route path="/auditor-login" element={<AuditorLogin />} />

      {/* Public customer storefront — no staff login involved */}
      <Route path="/shop/:storeId" element={<Storefront />} />

      {/* Unified cross-store marketplace — same reasoning as the auditor
          marketplace below: this cloud service has no presence on the
          desktop edition at all. */}
      {EDITION !== 'desktop' && <Route path="/marketplace-home" element={<MarketplaceHome />} />}

      <Route
        element={
          <ProtectedRoute roles={STORE_ROLES}>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Deliberately NOT wrapped in RequireActiveStore: a pending store's
            admin needs /activate-store to activate in the first place, and
            a locked store's admin needs /billing to see why and pay — both
            would otherwise be unreachable due to the redirect they exist to
            resolve. */}
        <Route path="/activate-store" element={<ActivateStore />} />
        <Route path="/billing" element={<BillingStatus />} />
        {/* Account + activity stay reachable for pending/locked stores too. */}
        <Route path="/account" element={<Account />} />
        <Route path="/activity" element={<ActivityLog />} />
        <Route path="/help" element={<Help />} />
      </Route>

      {/* Auditor-marketplace portal — separate role, not store-scoped.
          No backend support on the desktop edition (see Layout.jsx's
          marketplaceNav comment) — excluded there so there's no route to
          land on even via a typed URL. */}
      {EDITION !== 'desktop' && (
        <Route
          path="/auditor"
          element={
            <ProtectedRoute roles={['auditor']}>
              <AuditorDashboard />
            </ProtectedRoute>
          }
        />
      )}

      {/* Store-scoped app */}
      <Route
        element={
          <ProtectedRoute roles={STORE_ROLES}>
            <RequireActiveStore>
              <Layout />
            </RequireActiveStore>
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/import" element={<ImportProducts />} />
        <Route path="/labels" element={<Labels />} />
        <Route path="/insights" element={<Insights />} />
        {EDITION !== 'desktop' && <Route path="/transfers" element={<Transfers />} />}
        <Route path="/stock-arrival" element={<StockArrival />} />
        <Route path="/movements" element={<Movements />} />
        <Route path="/replenishment" element={<Replenishment />} />
        <Route path="/shelf-audit" element={<ShelfAudit />} />
        <Route path="/audit-report" element={<AuditReport />} />
        <Route path="/shrinkage-report" element={<ShrinkageReport />} />
        {EDITION !== 'desktop' && <Route path="/auditor-tab" element={<Auditor />} />}
        <Route path="/receipts" element={<Receipts />} />
        <Route path="/camera" element={<Camera />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/sales" element={<Sales />} />
        <Route path="/shifts" element={<Shifts />} />
        <Route path="/daily-report" element={<DailyReport />} />
        <Route path="/settings" element={<StoreSettings />} />
        {EDITION !== 'desktop' && <Route path="/marketplace" element={<Marketplace />} />}
        {EDITION !== 'desktop' && <Route path="/lending-partners" element={<LendingPartners />} />}
        <Route path="/invites" element={<Invites />} />
        <Route path="/users" element={<Users />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/export" element={<Export />} />
        <Route path="/support" element={<Support />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/expiry-tracker" element={<ExpiryTracking />} />
        <Route path="/cycle-counting" element={<CycleCounting />} />
      </Route>

      {/* Super admin app — superadmin build variant only */}
      {APP_VARIANT === 'superadmin' && (
        <Route
          element={
            <ProtectedRoute roles={['super_admin']}>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/super" element={<SuperDashboard />} />
          <Route path="/super/stores" element={<ManageStores />} />
          <Route path="/super/subscriptions" element={<Subscriptions />} />
          <Route path="/super/billing" element={<BillingCharges />} />
          {EDITION !== 'desktop' && <Route path="/super/auditors" element={<Auditors />} />}
          {EDITION !== 'desktop' && <Route path="/super/marketplace" element={<MarketplaceControl />} />}
          {EDITION !== 'desktop' && <Route path="/super/lending-partners" element={<LendingPartnersAdmin />} />}
          <Route path="/super/users" element={<AllUsers />} />
          <Route path="/super/referrals" element={<Referrals />} />
          <Route path="/super/support" element={<SupportTickets />} />
          <Route path="/super/activity" element={<ActivityLog />} />
          <Route path="/super/account" element={<Account />} />
          <Route path="/super/help" element={<Help />} />
        </Route>
      )}

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
