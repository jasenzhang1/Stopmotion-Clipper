import { Component, ReactNode } from "react";

/** A crash in one screen shows a message and a way back, instead of blanking the whole app. */
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); // another tab
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="home">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Something went wrong on this screen</h2>
          <p className="error" style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error.message || this.state.error)}</p>
          <div className="row">
            <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
            <button onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
