import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import api from './api/client.js';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import SuperLogin from './pages/SuperLogin.jsx';
import Setup from './pages/Setup.jsx';
import ActivateStore from './pages/ActivateStore.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';
import Account from './pages/Account.jsx';
import ActivityLog from './pages/ActivityLog.jsx';
import Sales from './pages/Sales.jsx';
import Shifts from './pages/Shifts.jsx';
import DailyReport from './pages/DailyReport.jsx';
import StoreSettings from './pages/StoreSettings.jsx';
import PublicReceipt from './pages/PublicReceipt.jsx';
import ImportProducts from './pages/ImportProducts.jsx';
import Labels from './pages/Labels.jsx';
import Insights from './pages/Insights.jsx';
import Transfers from './pages/Transfers.jsx';
import TrackOrder from './pages/TrackOrder.jsx';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { useAuth } from './context/AuthContext.jsx';

import Dashboard from './pages/Dashboard.jsx';
import Analytics from './pages/Analytics.jsx';
import Products from './pages/Products.jsx';
import StockArrival from './pages/StockArrival.jsx';
import Movements from './pages/Movements.jsx';
import Replenishment from './pages/Replenishment.jsx';
import ShelfAudit from './pages/ShelfAudit.jsx';
import AuditReport from './pages/AuditReport.jsx';
import ShrinkageReport from './pages/ShrinkageReport.jsx';
import Auditor from './pages/Auditor.jsx';
import Receipts from './pages/Receipts.jsx';
import Camera from './pages/Camera.jsx';
import Checkout from './pages/Checkout.jsx';
import BillingStatus from './pages/BillingStatus.jsx';
import Marketplace from './pages/Marketplace.jsx';
import LendingPartners from './pages/LendingPartners.jsx';
import Invites from './pages/Invites.jsx';
import Users from './pages/Users.jsx';
import Reports from './pages/Reports.jsx';
import Export from './pages/Export.jsx';
import Support from './pages/Support.jsx';
import Integrations from './pages/Integrations.jsx';
import Suppliers from './pages/Suppliers.jsx';
import Customers from './pages/Customers.jsx';
import ExpiryTracking from './pages/ExpiryTracking.jsx';
import CycleCounting from './pages/CycleCounting.jsx';

import AuditorSignup from './pages/AuditorSignup.jsx';
import AuditorLogin from './pages/AuditorLogin.jsx';
import AuditorDashboard from './pages/AuditorDashboard.jsx';
import Storefront from './pages/Storefront.jsx';
import MarketplaceHome from './pages/MarketplaceHome.jsx';

import SuperDashboard from './pages/super/SuperDashboard.jsx';
import ManageStores from './pages/super/ManageStores.jsx';
import Subscriptions from './pages/super/Subscriptions.jsx';
import BillingCharges from './pages/super/BillingCharges.jsx';
import Auditors from './pages/super/Auditors.jsx';
import MarketplaceControl from './pages/super/MarketplaceControl.jsx';
import AllUsers from './pages/super/AllUsers.jsx';
import Referrals from './pages/super/Referrals.jsx';
import SupportTickets from './pages/super/SupportTickets.jsx';
import LendingPartnersAdmin from './pages/super/LendingPartnersAdmin.jsx';

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
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      {/* Digital receipt behind the QR code — public, no login. */}
      <Route path="/r/:token" element={<PublicReceipt />} />
      <Route path="/track/:token" element={<TrackOrder />} />
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
        </Route>
      )}

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
