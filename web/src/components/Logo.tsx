import { brandMark, brandWordmark } from "@shahi/shared/brand";

export function Wordmark({ height = 40 }: { height?: number }) {
  return <svg width={height * brandWordmark.width / brandWordmark.height} height={height} viewBox={brandWordmark.viewBox} role="img" aria-label="shahi">
    <g transform={`translate(${brandWordmark.translateX} 0)`}>
      <path d={brandWordmark.path} fill="none" stroke="currentColor" strokeWidth={brandWordmark.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <rect {...brandWordmark.dot} fill="currentColor" />
    </g>
  </svg>;
}

export function Logo({ size = 32 }: { size?: number }) {
  return <svg className="brand-mark" data-brand-welcome width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
    <rect {...brandMark.cursor} fill="currentColor" />
    <path d={brandMark.glass} fill="none" stroke="currentColor" strokeWidth={8} strokeLinejoin="round" />
  </svg>;
}
