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
import { useLocation, useNavigate } from "react-router-dom";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  where: string | null;
  retried: boolean;
  /** The navigation the error happened on. */
  at: string | null;
}

/**
 * "Back to agents" routes inside the app rather than loading a page.
 *
 * It used to set `location.href = "/"`. On the hosted app that is the marketing
 * site, not the app at /pwa/, and any page load forgets a computer paired for
 * this session only, along with every unsent draft. Found in the pre-release
 * review. Everything the app keeps in memory lives outside this tree, so
 * clearing the error and drawing the new route loses none of it.
 *
 * The error clears when the route changes, not when the button is pressed: the
 * router applies a navigation as a transition, after an immediate reset would
 * already have drawn the broken screen again. Leaving by the browser's own
 * back button gets the same fresh attempt.
 */
export function Boundary({ children }: Props) {
  const navigate = useNavigate();
  const { key } = useLocation();
  return <Catch place={key} onHome={() => navigate("/")}>{children}</Catch>;
}

class Catch extends Component<Props & { place: string; onHome: () => void }, State> {
  override state: State = { error: null, where: null, retried: false, at: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept for the screen rather than only the console: the owner reads this on
    // a phone, where there is no console to open.
    this.setState({ where: info.componentStack?.split("\n").slice(1, 4).join("\n") ?? null, at: this.props.place });

    if (!this.state.retried) {
      // One silent retry. If it was transient, nobody needs to know.
      setTimeout(() => this.setState({ error: null, where: null, retried: true }), 50);
    }
  }

  override componentDidUpdate(): void {
    const { error, at } = this.state;
    if (error && at !== null && at !== this.props.place) this.setState({ error: null, where: null, retried: false, at: null });
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
            onClick={this.props.onHome}
          >
            Back to agents
          </button>
        </div>
      </div>
    );
  }
}
