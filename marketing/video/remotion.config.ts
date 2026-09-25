import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("png");
Config.setCodec("h264");
// Near-lossless: LinkedIn and Reddit re-encode everything, so give them clean source.
Config.setCrf(14);
Config.setPixelFormat("yuv420p");
