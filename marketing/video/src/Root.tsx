import { Composition, Still } from "remotion";
import "./fonts";
import { T } from "./launch/timeline";
import { Launch } from "./launch/Launch";
import { Poster } from "./launch/Poster";
import { DURATION, FPS } from "./theme";
import { Video } from "./Video";

export const Root = () => (
  <>
    <Composition id="Wide" component={Video} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
    <Composition id="Square" component={Video} durationInFrames={DURATION} fps={FPS} width={1080} height={1080} />
    <Composition id="LaunchWide" component={Launch} durationInFrames={T.total} fps={FPS} width={1920} height={1080} />
    <Composition id="LaunchSquare" component={Launch} durationInFrames={T.total} fps={FPS} width={1080} height={1080} />
    {/* The website's poster for both cuts; scripts/publish-media.ts renders it. */}
    <Still id="LaunchPoster" component={Poster} width={1080} height={1080} />
  </>
);
