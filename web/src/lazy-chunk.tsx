/**
 * A lazily loaded part of a screen that can outlive the release it came from.
 *
 * The terminal and the PDF viewer are separate chunks, fetched the first time
 * they are opened. A page left open across a deploy asks for chunk names the
 * new release does not have: the site answers 404, a computer's sidecar answers
 * with its HTML, and a rejected `React.lazy` stays rejected. The error boundary
 * then replaced the whole app, and both of its ways out were full page loads
 * that forget a computer paired for this session only. Found in the
 * pre-release review.
 *
 * Now a failed load draws a notice in place of that part alone, with a retry
 * for a dropped connection, and asks the server whether a new release is the
 * reason — if it is, the app shows its update banner, which knows how to warn
 * before a reload forgets anything.
 */
import { createContext, lazy, useCallback, useContext, useReducer, type ComponentType } from "react";
import { newerBundleDeployed, UPDATE_AVAILABLE } from "./version";

const Retry = createContext<() => void>(() => {});

function Unavailable() {
  const retry = useContext(Retry);
  return (
    <div className="empty" role="alert">
      <span className="empty__mark">○</span>
      This part of Shahi could not be loaded. You may be offline, or Shahi may have been updated.
      <button className="empty__action" onClick={retry}>Try again</button>
    </div>
  );
}

export function lazyChunk<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  const attempt = () => lazy(async (): Promise<{ default: ComponentType<P> }> => {
    try {
      return await load();
    } catch {
      void newerBundleDeployed().then((newer) => { if (newer) window.dispatchEvent(new Event(UPDATE_AVAILABLE)); });
      return { default: Unavailable as ComponentType<P> };
    }
  });
  let Loaded = attempt();
  return function Chunk(props: P) {
    const [, rerender] = useReducer((count: number) => count + 1, 0);
    const retry = useCallback(() => { Loaded = attempt(); rerender(); }, []);
    return <Retry.Provider value={retry}><Loaded {...props} /></Retry.Provider>;
  };
}
