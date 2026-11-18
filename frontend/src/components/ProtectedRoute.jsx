import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// roles: optional array restricting which roles may view this route.
export default function ProtectedRoute({ children, roles }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) {
    // Send each role to its own home; redirecting everyone to "/" left
    // auditors (and the super admin) on a blank page that redirected to itself.
    const home = { auditor: '/auditor', super_admin: '/super' }[user.role] || '/';
    if (home === pathname) return <Navigate to="/login" replace />;
    return <Navigate to={home} replace />;
  }
  return children;
}
