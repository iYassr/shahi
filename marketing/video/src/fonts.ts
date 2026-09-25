import { continueRender, delayRender, staticFile } from "remotion";

// The site's own IBM Plex subsets, loaded before the first frame renders so no
// frame is drawn in a fallback face.
const faces: [string, string, string][] = [
  ["IBM Plex Sans", "400", "IBMPlexSans-Regular-Latin1.woff2"],
  ["IBM Plex Sans", "400", "IBMPlexSans-Regular-Pi.woff2"],
  ["IBM Plex Sans", "500", "IBMPlexSans-Medium-Latin1.woff2"],
  ["IBM Plex Sans", "500", "IBMPlexSans-Medium-Pi.woff2"],
  ["IBM Plex Sans", "600", "IBMPlexSans-SemiBold-Latin1.woff2"],
  ["IBM Plex Sans", "600", "IBMPlexSans-SemiBold-Pi.woff2"],
  ["IBM Plex Mono", "400", "IBMPlexMono-Regular-Latin1.woff2"],
];

const handle = delayRender("fonts");
Promise.all(
  faces.map(([family, weight, file]) => {
    const face = new FontFace(family, `url(${staticFile(`fonts/${file}`)})`, { weight });
    document.fonts.add(face);
    return face.load();
  }),
).then(() => continueRender(handle));
