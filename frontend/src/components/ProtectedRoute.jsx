import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// roles: optional array restricting which roles may view this route.
export default function ProtectedRoute({ children, roles }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  // A store's own audit staff have role 'auditor' plus a storeId; independent
  // auditor firms have no storeId. Treat the first as a store user.
  const role = user.role === 'auditor' && user.storeId ? 'store_auditor' : user.role;
  if (roles && !roles.includes(role)) {
    // Send each role to its own home; redirecting everyone to "/" left
    // auditors (and the super admin) on a blank page that redirected to itself.
    const home = { auditor: '/auditor', super_admin: '/super', guarantor: '/partner', courier: '/partner' }[role] || '/';
    if (home === pathname) return <Navigate to="/login" replace />;
    return <Navigate to={home} replace />;
  }
  return children;
}
