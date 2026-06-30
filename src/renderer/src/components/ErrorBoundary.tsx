import React from "react";

interface Props {
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("Renderer error boundary caught:", error, info);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "24px",
            margin: "16px",
            border: "1px solid var(--danger, #f38ba8)",
            borderRadius: "8px",
            color: "var(--text, #cdd6f4)",
            fontFamily: "var(--font-mono, monospace)",
            overflow: "auto",
          }}
        >
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error.message}</pre>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button type="button" onClick={() => this.setState({ error: null })}>
              Dismiss
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
