/**
 * What to do when a render throws.
 *
 * React unmounts the whole tree when a component throws during render, leaving
 * a blank page and no way back — which is exactly what "I have to refresh the
 * page a lot" looks like from the outside. The app had no boundary at all, so
 * every such fault was terminal, and the only recovery was the thing the owner
 * kept doing by hand.
 *
 * A boundary turns that into something recoverable, and — more usefully — into
 * something reportable: the message and the component stack go on screen, which
 * is the difference between "it broke again" and knowing what broke.
 *
 * It retries once by itself, because a good share of these are transient: a
 * frame that arrived half-written, a poll landing during a route change. If the
 * same thing throws twice, retrying a third time is just flicker, so it stops
 * and hands over to a person.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  where: string | null;
  retried: boolean;
}

export class Boundary extends Component<Props, State> {
  override state: State = { error: null, where: null, retried: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept for the screen rather than only the console: the owner reads this on
    // a phone, where there is no console to open.
    this.setState({ where: info.componentStack?.split("\n").slice(1, 4).join("\n") ?? null });

    if (!this.state.retried) {
      // One silent retry. If it was transient, nobody needs to know.
      setTimeout(() => this.setState({ error: null, where: null, retried: true }), 50);
    }
  }

  override render(): ReactNode {
    const { error, where } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app">
        <div className="empty">
          <span className="empty__mark">○</span>
          Something in the app broke while drawing this screen.
          <pre className="boundary__what">
            {error.message}
            {where ? `\n${where}` : ""}
          </pre>
          <button className="empty__action" onClick={() => location.reload()}>
            Reload
          </button>
          <button
            className="empty__action"
            onClick={() => {
              location.href = "/";
            }}
          >
            Back to agents
          </button>
        </div>
      </div>
    );
  }
}
