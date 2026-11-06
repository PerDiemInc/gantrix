import { Component, type ReactNode } from 'react';

/** A crash in one page shows what broke and a way out, instead of a blank screen. */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card" role="alert">
        <h2>This page hit an error</h2>
        <pre className="output">{this.state.error.message}</pre>
        <button type="button" className="primary" onClick={() => location.reload()}>
          Reload
        </button>
      </section>
    );
  }
}
