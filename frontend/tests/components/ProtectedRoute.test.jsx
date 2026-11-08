import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import { AuthProvider } from '../../src/context/AuthContext.jsx';
import ProtectedRoute from '../../src/components/ProtectedRoute.jsx';

function renderRoutes(initialUser) {
  if (initialUser) localStorage.setItem('ss_user', JSON.stringify(initialUser));
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<div>Login Page</div>} />
          <Route path="/" element={<div>Home Page</div>} />
          <Route path="/dashboard" element={<ProtectedRoute><div>Dashboard Content</div></ProtectedRoute>} />
          <Route path="/admin-only" element={<ProtectedRoute roles={['admin']}><div>Admin Content</div></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('ProtectedRoute', () => {
  it('redirects to /login when there is no logged-in user', () => {
    renderRoutes(null);
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('renders the protected content for a logged-in user with no role restriction', () => {
    renderRoutes({ id: 'u1', role: 'staff' });
    expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
  });

  it('allows a matching role through a role-restricted route', () => {
    localStorage.setItem('ss_user', JSON.stringify({ id: 'u1', role: 'admin' }));
    render(
      <MemoryRouter initialEntries={['/admin-only']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>Home Page</div>} />
            <Route path="/admin-only" element={<ProtectedRoute roles={['admin']}><div>Admin Content</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
    expect(screen.getByText('Admin Content')).toBeInTheDocument();
  });

  it('redirects a wrong-role user to / rather than showing the content', () => {
    localStorage.setItem('ss_user', JSON.stringify({ id: 'u1', role: 'staff' }));
    render(
      <MemoryRouter initialEntries={['/admin-only']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>Home Page</div>} />
            <Route path="/admin-only" element={<ProtectedRoute roles={['admin']}><div>Admin Content</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
    expect(screen.getByText('Home Page')).toBeInTheDocument();
    expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
  });
});
