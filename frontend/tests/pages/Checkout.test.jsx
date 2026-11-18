import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../../src/context/AuthContext.jsx';

vi.mock('../../src/api/client.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../src/context/SocketContext.jsx', () => ({ useRealtimeEvents: vi.fn() }));
vi.mock('../../src/context/CurrencyContext.jsx', () => ({
  useCurrency: () => ({ currency: { code: 'NGN', symbol: '₦' }, formatCurrency: (n) => `₦${n}` }),
}));
// Checkout supports live barcode scanning via the camera, which jsdom has
// no real implementation of — irrelevant to the manual-search / payment
// flow these tests cover, and stubbing it avoids a getUserMedia crash the
// moment "Scan Barcode" is clicked (not clicked in any test here, but
// BrowserMultiFormatReader is constructed eagerly on import in some builds).
vi.mock('@zxing/browser', () => ({ BrowserMultiFormatReader: vi.fn(() => ({ decodeFromVideoElement: vi.fn(), reset: vi.fn() })) }));

const api = (await import('../../src/api/client.js')).default;
const { default: Checkout } = await import('../../src/pages/Checkout.jsx');

function renderCheckout(role = 'cashier') {
  localStorage.setItem('ss_user', JSON.stringify({ id: 'u1', role, storeId: 'store1' }));
  return render(<AuthProvider><Checkout /></AuthProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.get.mockImplementation((url) => {
    if (url.endsWith('/orders')) return Promise.resolve({ data: [] });
    if (url.endsWith('/products')) return Promise.resolve({ data: [{ id: 'p1', name: 'Rice 5kg', sku: 'RICE-5', shelf_qty: 10 }] });
    return Promise.resolve({ data: {} });
  });
});

describe('Checkout: starting and building an order', () => {
  it('starts a new order and shows the empty-items state', async () => {
    api.post.mockResolvedValue({ data: { id: 'o1', total: 0, items: [] } });
    renderCheckout('cashier');

    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    expect(await screen.findByText(/order in progress/i)).toBeInTheDocument();
    expect(screen.getByText(/no items yet/i)).toBeInTheDocument();
  });

  it('searching finds a product by name and adding it updates the order total', async () => {
    api.post.mockResolvedValueOnce({ data: { id: 'o1', total: 0, items: [] } }); // startOrder
    renderCheckout('cashier');
    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    api.post.mockResolvedValueOnce({
      data: { order: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } },
    });
    api.get.mockImplementation((url) => {
      if (url === `/stores/store1/orders/o1`) {
        return Promise.resolve({ data: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } });
      }
      return Promise.resolve({ data: [] });
    });

    await userEvent.type(screen.getByPlaceholderText(/start typing/i), 'Rice');
    await userEvent.click(await screen.findByText(/Rice 5kg \(RICE-5\)/));

    expect(api.post).toHaveBeenCalledWith('/stores/store1/orders/o1/items', { productId: 'p1', quantity: 1, addedVia: 'manual_search' });
    await waitFor(() => expect(screen.getAllByText('₦20').length).toBeGreaterThan(0));
  });

  it('shows a friendly error and does not crash when adding an item fails (e.g. out of stock)', async () => {
    api.post.mockResolvedValueOnce({ data: { id: 'o1', total: 0, items: [] } });
    renderCheckout('cashier');
    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    api.post.mockRejectedValueOnce({ response: { data: { error: 'Not enough stock on shelf' } } });
    await userEvent.type(screen.getByPlaceholderText(/start typing/i), 'Rice');
    await userEvent.click(await screen.findByText(/Rice 5kg \(RICE-5\)/));

    expect(await screen.findByText('Not enough stock on shelf')).toBeInTheDocument();
  });
});

describe('Checkout: role-gated payment', () => {
  it('selecting Credit shows a customer picker, and requires a customer before paying', async () => {
    api.post.mockResolvedValueOnce({ data: { id: 'o1', total: 0, items: [] } }); // startOrder
    renderCheckout('cashier');
    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    api.post.mockResolvedValueOnce({
      data: { order: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } },
    });
    api.get.mockImplementation((url) => {
      if (url === '/stores/store1/customers') return Promise.resolve({ data: [{ id: 'c1', name: 'Mama Chidi', phone: '0801' }] });
      if (url === '/stores/store1/orders/o1') {
        return Promise.resolve({ data: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } });
      }
      if (url.endsWith('/products')) return Promise.resolve({ data: [{ id: 'p1', name: 'Rice 5kg', sku: 'RICE-5', shelf_qty: 10 }] });
      return Promise.resolve({ data: [] });
    });
    await userEvent.type(screen.getByPlaceholderText(/start typing/i), 'Rice');
    await userEvent.click(await screen.findByText(/Rice 5kg \(RICE-5\)/));

    await userEvent.selectOptions(await screen.findByLabelText(/payment method/i), 'credit');
    expect(screen.getByLabelText(/customer/i)).toBeInTheDocument();
    expect(screen.getByText('Mama Chidi (0801)')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: /confirm payment/i }));
    // Distinct from the dropdown's own "Select a customer..." placeholder
    // option text, which is on screen regardless — this checks the real
    // validation message that appears only after a failed submit attempt.
    expect(await screen.findByText('Select a customer for a credit sale')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith('/stores/store1/orders/o1/pay', expect.anything());
  });

  it('a credit sale with a customer selected sends storeCustomerId to the pay endpoint', async () => {
    api.post.mockResolvedValueOnce({ data: { id: 'o1', total: 0, items: [] } }); // startOrder
    renderCheckout('cashier');
    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    // Add one item through the real search flow first — a freshly started
    // order always begins with items: [] regardless of the create response.
    api.post.mockResolvedValueOnce({
      data: { order: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } },
    });
    api.get.mockImplementation((url) => {
      if (url === '/stores/store1/customers') return Promise.resolve({ data: [{ id: 'c1', name: 'Mama Chidi' }] });
      if (url === '/stores/store1/orders/o1') {
        return Promise.resolve({ data: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } });
      }
      if (url.endsWith('/products')) return Promise.resolve({ data: [{ id: 'p1', name: 'Rice 5kg', sku: 'RICE-5', shelf_qty: 10 }] });
      return Promise.resolve({ data: [] });
    });
    await userEvent.type(screen.getByPlaceholderText(/start typing/i), 'Rice');
    await userEvent.click(await screen.findByText(/Rice 5kg \(RICE-5\)/));

    await userEvent.selectOptions(await screen.findByLabelText(/payment method/i), 'credit');
    await userEvent.selectOptions(await screen.findByLabelText(/customer/i), 'c1');

    api.post.mockResolvedValueOnce({ data: { id: 'o1' } }); // pay
    api.get.mockImplementation((url) => {
      if (url === '/stores/store1/customers') return Promise.resolve({ data: [{ id: 'c1', name: 'Mama Chidi' }] });
      if (url === '/stores/store1/orders/o1') {
        return Promise.resolve({ data: { id: 'o1', receipt_number: 'RCPT-1', total: 20, items: [], payment_method: 'credit', paid_at: new Date().toISOString() } });
      }
      return Promise.resolve({ data: [] });
    });
    await userEvent.click(await screen.findByRole('button', { name: /confirm payment/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/stores/store1/orders/o1/pay', { paymentMethod: 'credit', storeCustomerId: 'c1' });
    });
  });

  it('a cashier sees the payment form and can confirm payment', async () => {
    api.post.mockResolvedValueOnce({ data: { id: 'o1', total: 0, items: [] } }); // startOrder
    renderCheckout('cashier');
    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    // Add one item through the real search flow first — a freshly started
    // order always begins with items: [] regardless of what the create
    // response contains (see Checkout.jsx's startOrder).
    api.post.mockResolvedValueOnce({
      data: { order: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } },
    });
    api.get.mockImplementation((url) => {
      if (url === '/stores/store1/orders/o1') {
        return Promise.resolve({ data: { id: 'o1', total: 20, items: [{ id: 'i1', product_name: 'Rice 5kg', quantity: 1, line_total: 20 }] } });
      }
      return Promise.resolve({ data: [] });
    });
    await userEvent.type(screen.getByPlaceholderText(/start typing/i), 'Rice');
    await userEvent.click(await screen.findByText(/Rice 5kg \(RICE-5\)/));

    expect(await screen.findByRole('button', { name: /confirm payment/i })).toBeEnabled();

    api.post.mockResolvedValueOnce({ data: { id: 'o1' } }); // pay
    api.get.mockImplementation((url) => {
      if (url === '/stores/store1/orders/o1') {
        return Promise.resolve({ data: { id: 'o1', receipt_number: 'RCPT-1', total: 20, items: [], payment_method: 'cash', paid_at: new Date().toISOString() } });
      }
      return Promise.resolve({ data: [] });
    });

    await userEvent.click(screen.getByRole('button', { name: /confirm payment/i }));

    expect(await screen.findByText(/receipt #RCPT-1/i)).toBeInTheDocument();
  });

  it('a non-payment role (e.g. staff) cannot see a Confirm Payment button at all', async () => {
    api.post.mockResolvedValueOnce({ data: { id: 'o1', total: 0, items: [] } });
    renderCheckout('staff');
    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    expect(screen.queryByRole('button', { name: /confirm payment/i })).not.toBeInTheDocument();
    expect(screen.getByText(/a cashier will pick it up/i)).toBeInTheDocument();
  });

  it('the pay button is disabled with an empty order (no items yet)', async () => {
    api.post.mockResolvedValueOnce({ data: { id: 'o1', total: 0, items: [] } });
    renderCheckout('admin');
    await userEvent.click(await screen.findByRole('button', { name: /start new order/i }));

    expect(screen.getByRole('button', { name: /confirm payment/i })).toBeDisabled();
  });
});

describe('Checkout: pending orders list', () => {
  it('lists pending orders and picking one up opens it', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/orders')) return Promise.resolve({ data: [{ id: 'o5', total: 15, created_by_name: 'Amaka' }] });
      if (url.endsWith('/products')) return Promise.resolve({ data: [] });
      if (url === '/stores/store1/orders/o5') return Promise.resolve({ data: { id: 'o5', total: 15, items: [] } });
      return Promise.resolve({ data: {} });
    });
    renderCheckout('cashier');

    expect(await screen.findByText(/Amaka/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /open/i }));

    expect(await screen.findByText(/order in progress/i)).toBeInTheDocument();
  });
});
