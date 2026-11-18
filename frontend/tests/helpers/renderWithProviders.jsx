import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { AuthProvider } from '../../src/context/AuthContext.jsx';

// Wraps a component the way the real app does (Router + AuthProvider),
// without pulling in every other context (Currency/Socket/Offline) unless
// a test actually needs them — keeps failures pointing at the component
// under test, not unrelated provider setup.
export function renderWithProviders(ui, { route = '/', ...renderOptions } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
    renderOptions
  );
}
