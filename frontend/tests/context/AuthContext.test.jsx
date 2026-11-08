import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../../src/context/AuthContext.jsx';

function Probe() {
  const { user, login, logout, updateUser } = useAuth();
  return (
    <div>
      <span data-testid="user">{user ? JSON.stringify(user) : 'none'}</span>
      <button onClick={() => login('tok', { id: 'u1', role: 'admin' })}>login</button>
      <button onClick={() => logout()}>logout</button>
      <button onClick={() => updateUser({ name: 'Updated' })}>update</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('AuthContext', () => {
  it('starts with no user when localStorage is empty', () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('restores a user from localStorage on mount', () => {
    localStorage.setItem('ss_user', JSON.stringify({ id: 'u2', role: 'staff' }));
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(JSON.parse(screen.getByTestId('user').textContent)).toEqual({ id: 'u2', role: 'staff' });
  });

  it('login stores the token and user, and updates context state', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { screen.getByText('login').click(); });

    expect(localStorage.getItem('ss_token')).toBe('tok');
    expect(JSON.parse(localStorage.getItem('ss_user'))).toEqual({ id: 'u1', role: 'admin' });
    expect(JSON.parse(screen.getByTestId('user').textContent)).toEqual({ id: 'u1', role: 'admin' });
  });

  it('logout clears everything', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { screen.getByText('login').click(); });
    await act(async () => { screen.getByText('logout').click(); });

    expect(localStorage.getItem('ss_token')).toBeNull();
    expect(localStorage.getItem('ss_user')).toBeNull();
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('updateUser merges into the existing user rather than replacing it', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { screen.getByText('login').click(); });
    await act(async () => { screen.getByText('update').click(); });

    const stored = JSON.parse(localStorage.getItem('ss_user'));
    expect(stored).toEqual({ id: 'u1', role: 'admin', name: 'Updated' });
  });

  it('useAuth throws outside of AuthProvider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/useAuth must be used within AuthProvider/);
    consoleError.mockRestore();
  });
});
