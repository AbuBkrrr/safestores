import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../helpers/renderWithProviders.jsx';
import Login from '../../src/pages/Login.jsx';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../src/api/client.js', () => ({ default: { post: vi.fn() } }));
const api = (await import('../../src/api/client.js')).default;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Login page', () => {
  it('submits admin credentials and navigates to dashboard on success', async () => {
    api.post.mockResolvedValue({ data: { token: 't1', user: { role: 'admin', subscriptionStatus: 'active' } } });
    renderWithProviders(<Login />);

    await userEvent.type(screen.getByLabelText(/email/i), 'admin@shop.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'Password123!');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/auth/admin/login', { email: 'admin@shop.com', password: 'Password123!' });
    });
    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(localStorage.getItem('ss_token')).toBe('t1');
  });

  it('sends a pending-store admin to /activate-store instead of the dashboard', async () => {
    api.post.mockResolvedValue({ data: { token: 't1', user: { role: 'admin', subscriptionStatus: 'pending' } } });
    renderWithProviders(<Login />);

    await userEvent.type(screen.getByLabelText(/email/i), 'admin@shop.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'Password123!');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/activate-store'));
  });

  it('shows the server error message on failed login, without navigating', async () => {
    api.post.mockRejectedValue({ response: { data: { error: 'Invalid credentials' } } });
    renderWithProviders(<Login />);

    await userEvent.type(screen.getByLabelText(/email/i), 'admin@shop.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrongpass');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(localStorage.getItem('ss_token')).toBeNull();
  });

  it('switches to the Invite tab and logs in with a code', async () => {
    api.post.mockResolvedValue({ data: { token: 't2', user: { role: 'staff' } } });
    renderWithProviders(<Login />);

    await userEvent.click(screen.getByRole('button', { name: /invite login/i }));
    await userEvent.type(screen.getByPlaceholderText(/INV-/i), 'inv-abc123');
    await userEvent.click(screen.getByRole('button', { name: /enter with code/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/auth/invite/login', { code: 'INV-ABC123' }); // uppercased as typed
    });
  });

  it('pre-fills and switches to the Invite tab when a ?invite= link is opened', () => {
    renderWithProviders(<Login />, { route: '/login?invite=inv-xyz789' });
    expect(screen.getByPlaceholderText(/INV-/i)).toHaveValue('INV-XYZ789');
  });
});
