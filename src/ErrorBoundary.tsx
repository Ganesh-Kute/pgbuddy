import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadForNewBuild } from "@/lib/staleBuild";

interface Props {
  children: ReactNode;
  /** Reloads into the newest build; returns false when it should not (see staleBuild.ts). */
  reloadForNewBuild?: () => boolean;
}

interface State {
  error: Error | null;
  /** A reload into the new build is under way. */
  updating: boolean;
}

// Inline styles with fallbacks: this screen must work even when the app's stylesheet did not load.
const screen: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  boxSizing: "border-box",
  background: "hsl(var(--background, 0 0% 100%))",
  color: "hsl(var(--foreground, 222 47% 11%))",
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};
const card: CSSProperties = { maxWidth: 420, width: "100%", textAlign: "center" };
const button: CSSProperties = {
  minHeight: 44,
  padding: "0 20px",
  borderRadius: 8,
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  fontWeight: 600,
  background: "hsl(var(--primary, 221 83% 53%))",
  color: "hsl(var(--primary-foreground, 0 0% 100%))",
};
const link: CSSProperties = { display: "inline-block", marginTop: 12, color: "inherit", opacity: 0.8 };

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { error: null, updating: false };

  public static getDerivedStateFromError(error: Error): State {
    // Optimistic: a missing page file almost always means a new version is out; componentDidCatch
    // falls back to the error screen if the reload is not allowed.
    return { error, updating: isChunkLoadError(error) };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[app] crashed:", error, info.componentStack);
    if (this.state.updating && !(this.props.reloadForNewBuild ?? reloadForNewBuild)()) {
      this.setState({ updating: false });
    }
  }

  public render() {
    const { error, updating } = this.state;
    if (!error) return this.props.children;

    if (updating) {
      return (
        <div style={screen} role="status">
          <p style={{ fontSize: 16 }}>Updating to the latest version…</p>
        </div>
      );
    }

    const pageMissing = isChunkLoadError(error);
    return (
      <div style={screen} role="alert">
        <div style={card}>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>
            {pageMissing ? "This page could not load" : "Something went wrong"}
          </h1>
          <p style={{ margin: "0 0 20px", lineHeight: 1.5, opacity: 0.8 }}>
            {pageMissing
              ? "Please check your internet connection, then reload."
              : "Please reload the page. If this keeps happening, contact support."}
          </p>
          <button type="button" style={button} onClick={() => window.location.reload()}>
            Reload
          </button>
          <br />
          <a href="/" style={link}>
            Go to home
          </a>
          <details style={{ marginTop: 24, textAlign: "left", fontSize: 12, opacity: 0.7 }}>
            <summary style={{ cursor: "pointer" }}>Technical details</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ""}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
