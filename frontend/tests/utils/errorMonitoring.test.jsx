import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('errorMonitoring: init', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('is disabled and captureException is a safe no-op when VITE_SENTRY_DSN is not set', async () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const mod = await import('../../src/utils/errorMonitoring.js');
    mod.init();
    expect(mod.isEnabled()).toBe(false);
    expect(() => mod.captureException(new Error('test'))).not.toThrow();
  });
});

describe('errorMonitoring: ErrorBoundary', () => {
  function Bomb() {
    throw new Error('render boom');
  }

  it('catches a render crash and shows a friendly fallback instead of a blank screen', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ErrorBoundary } = await import('../../src/utils/errorMonitoring.js');

    function Fallback() {
      return <div>Something went wrong — friendly fallback</div>;
    }

    render(
      <ErrorBoundary fallback={Fallback}>
        <Bomb />
      </ErrorBoundary>
    );

    expect(await screen.findByText(/friendly fallback/i)).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('does not affect normal rendering when there is no error', async () => {
    const { ErrorBoundary } = await import('../../src/utils/errorMonitoring.js');
    render(
      <ErrorBoundary fallback={() => <div>Fallback</div>}>
        <div>Everything is fine</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('Everything is fine')).toBeInTheDocument();
  });
});
