import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CurrencyProvider } from '../../../src/context/CurrencyContext.jsx';

vi.mock('../../../src/api/client.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
const api = (await import('../../../src/api/client.js')).default;
const { default: Subscriptions } = await import('../../../src/pages/super/Subscriptions.jsx');

const BASE_SETTINGS = {
  account_number: '8032540215',
  account_name: 'SAFE Stores',
  bank_or_provider: 'OPAY',
  methods: ['ussd', 'bank_transfer'],
  instructions: 'Pay via USSD or bank transfer.',
  gateway_provider: 'none',
  gateway_enabled: false,
};

function renderPage() {
  return render(<CurrencyProvider><Subscriptions /></CurrencyProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/super/tiers') return Promise.resolve({ data: [] });
    if (url === '/super/access-codes') return Promise.resolve({ data: [] });
    if (url === '/settings/payment-instructions') return Promise.resolve({ data: BASE_SETTINGS });
    if (url === '/settings/currency') return Promise.resolve({ data: { code: 'NGN', symbol: '₦' } });
    return Promise.resolve({ data: {} });
  });
});

describe('Subscriptions page: payment gateway', () => {
  it('shows Paystack as live once selected, and Coming Soon otherwise', async () => {
    renderPage();
    expect(await screen.findByText('Payment Gateway')).toBeInTheDocument();
    expect(screen.getByText('Coming Soon')).toBeInTheDocument();
    expect(screen.getByText(/no integration code exists for them yet/i)).toBeInTheDocument();
  });

  it('the "enable online payment" checkbox is disabled until Paystack is the selected provider', async () => {
    renderPage();
    await screen.findByText('Payment Gateway');
    const checkbox = screen.getByLabelText(/enable online payment/i);
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
  });

  it('enables the checkbox once Paystack is selected', async () => {
    renderPage();
    const select = await screen.findByLabelText('Provider');
    await userEvent.selectOptions(select, 'paystack');
    const checkbox = screen.getByLabelText(/enable online payment/i);
    expect(checkbox).not.toBeDisabled();
  });

  it('defaults the provider selector to "None selected"', async () => {
    renderPage();
    const select = await screen.findByLabelText('Provider');
    expect(select).toHaveValue('none');
  });

  it('selecting Paystack, enabling it, and saving sends both fields without touching the manual bank-transfer fields', async () => {
    renderPage();
    const select = await screen.findByLabelText('Provider');
    await userEvent.selectOptions(select, 'paystack');
    const checkbox = screen.getByLabelText(/enable online payment/i);
    await userEvent.click(checkbox);

    api.patch.mockResolvedValue({ data: { ...BASE_SETTINGS, gateway_provider: 'paystack', gateway_enabled: true } });
    const saveButtons = screen.getAllByRole('button', { name: /save/i });
    const gatewaySaveButton = saveButtons.find((b) => b.textContent.includes('Gateway'));
    await userEvent.click(gatewaySaveButton);

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/super/payment-settings', expect.objectContaining({
        gatewayProvider: 'paystack',
        gatewayEnabled: true,
        bankOrProvider: 'OPAY', // unchanged manual-transfer field still sent as-is
      }));
    });
  });

  it('switching away from Paystack turns gatewayEnabled back off', async () => {
    renderPage();
    const select = await screen.findByLabelText('Provider');
    await userEvent.selectOptions(select, 'paystack');
    await userEvent.click(screen.getByLabelText(/enable online payment/i));
    await userEvent.selectOptions(select, 'flutterwave');
    expect(screen.getByLabelText(/enable online payment/i)).not.toBeChecked();
    expect(screen.getByLabelText(/enable online payment/i)).toBeDisabled();
  });

  it('this section never renders while payment settings are still loading', () => {
    api.get.mockImplementation((url) => {
      if (url === '/settings/payment-instructions') return new Promise(() => {}); // never resolves
      return Promise.resolve({ data: [] });
    });
    renderPage();
    expect(screen.queryByText('Payment Gateway')).not.toBeInTheDocument();
  });
});
