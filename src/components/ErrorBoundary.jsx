import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[RealDac] Unhandled render error:', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  handleHome = () => {
    window.location.assign('/');
  };

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.state.error?.message || 'Something went wrong.';
    const isConvex = /CONVEX|convex/.test(message);

    return (
      <main className="rd-error-shell">
        <div className="rd-error-card">
          <div className="rd-error-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          </div>
          <h2>The console hit a snag</h2>
          <p>
            {isConvex
              ? 'The persistence backend returned an error. Realtime sync still works — refresh to retry the room.'
              : message}
          </p>
          <details className="rd-error-details">
            <summary>Technical detail</summary>
            <pre>{message}</pre>
          </details>
          <div className="rd-error-actions">
            <button type="button" className="rd-btn rd-btn--lg" onClick={this.handleReset}>
              Try again
            </button>
            <button type="button" className="rd-btn rd-btn--primary rd-btn--lg" onClick={this.handleHome}>
              Back to entry
            </button>
          </div>
        </div>
      </main>
    );
  }
}
