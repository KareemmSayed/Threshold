import { Config } from '@remotion/cli/config';

// Lossless frames: the ASCII canvases and hairlines smear under JPEG.
Config.setVideoImageFormat('png');
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setColorSpace('bt709');
Config.setCrf(14);
Config.setX264Preset('slow');
Config.setMuted(true);
Config.setChromiumOpenGlRenderer('angle');
Config.setConcurrency(6);
