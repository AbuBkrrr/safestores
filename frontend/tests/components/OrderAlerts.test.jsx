import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const handlers = {};
const fakeSocket = { on: (e, f) => { handlers[e] = f; }, off: vi.fn() };
vi.mock('../../src/context/SocketContext.jsx', () => ({ useSocket: () => ({ socket: fakeSocket }) }));
vi.mock('../../src/context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { storeId: 's1', role: 'cashier' } }) }));

const { default: OrderAlerts } = await import('../../src/components/OrderAlerts.jsx');

describe('OrderAlerts', () => {
  it('shows a banner (and rings) when a new online order arrives', () => {
    const vibrate = vi.fn(); navigator.vibrate = vibrate;
    render(<MemoryRouter><OrderAlerts /></MemoryRouter>);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => handlers['marketplace:order_placed']({ id: 'o1', total: 1000 }));
    expect(screen.getByRole('alert').textContent).toMatch(/1,000/);
    expect(vibrate).toHaveBeenCalled();
  });
});
