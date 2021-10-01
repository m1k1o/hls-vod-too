hls-vod-too [![npm version](https://badge.fury.io/js/hls-vod-too.svg)](https://badge.fury.io/js/hls-vod-too)
=======

HTTP Live Streaming with on-the-fly encoding of any video file. Supports modern browsers through the use of [hls.js](https://github.com/video-dev/hls.js/).

Differences from the original [hls-vod](https://github.com/mifi/hls-vod)
-------------------------------------------------------------------------

This is like a re-write of the original hls-vod. I certainly borrowed the main idea and many code segments from it. But as the differences (listed below) are huge, I decided to name this as a new package instead of sending changes to the original hls-vod.

**Improvements compared to the original hls-vod:**

- On-demand transcoding.
  - Original hls-vod transcode the entire video from beginning to the end, as a whole and in the fixed order. hls-vod-too transcode the parts you're actually playing.
  - This allows seeking immediately after loading a video. With original hls-vod, the progress bar only shows the parts of the video that has finished transcoding. You'll have to wait for the transcoding before jumping to a later time in the video. With hls-vod-too, the progress bar immediately shows the full length of the video, so you can jump to any specific time of the video.
- Supports multiple quality levels (1080p, 720p, etc.).
  - Done by using a [master playlist](https://developer.apple.com/documentation/http_live_streaming/example_playlists_for_http_live_streaming/creating_a_master_playlist).
  - It allows video players to automatically switch between different qualities according to network conditions. Users can also switch between quality levels on-the-fly.
- Detects if a video format is likely to be directly playable in the browser. If so, offer the option to play the video file directly, instead of transcoding and serving through HLS.
  - Modern browsers are capable of playing video files directly, with pretty good performance and full seeking functionality. HLS is unnecessary in this case.
  - User can fallback to use HLS on the web UI. The whole feature can also be disabled by `--no-short-circuit`.
- Supports multiple players/transcodings at the same time.
  - The max number of concurrent users can be specified by `--max-client-number`.
  - When multiple users play the same file (at the same quality level), the file will only be transcoded once.
- Better thumbnailing (a.k.a. preview).
  - Take snapshots evenly throughout the video, instead of just near the beginning of the video.
  - Allow users to select the number of images in the thumbnail tile.
  - Loading frames one by one instead of loading the entire tile at once, so some frames can be rendered earlier.
- Play audio files through HLS too.
  - Audio files are now served through HLS instead of a single transcoded audio file. With this, you can seek to a later time in a long audio file easily.
  - Same as videos, files that can be played directly in browsers won't have to go through transcoding.

**Limitations compared to the original hls-vod**

- Not supporting VLC as backend. Only supports ffmpeg.
- Legacy browsers won't be supported, as the UI code uses ES6 classes, web components, async generator functions, etc..

Requirements
------------
- [node.js](https://nodejs.org/en/) (>= v10.12)
- [ffmpeg](https://ffmpeg.org/) (Tested on 4.1, must be built with libx264).
- Tested on Linux only.

Installation
------------
```
npm i -g hls-vod-too
```

Running (with ffmpeg)
------------------------------
- Make sure you have node.js and ffmpeg in PATH
- `hls-vod-too --root-path /path/to/my/videos`
- Or: `hls-vod-too --transcoder-path /usr/bin --root-path /path/to/my/videos`
- Browse to http://localhost:4040/

Arguments
---------
```
--root-path DIR - Root path allowed to read files in. Defaults to current directory.

--cache-path DIR - Where to write transcoded video cache. Defaults to OS temp dir.

--ffmpeg-binary-dir DIR - The directory to look for ffmpeg and ffprobe binaries. Needed if they are not in $PATH.

--no-short-circuit - Always playback through HLS, even when the file is directly playable in browsers.
```

For more arguments run it without arguments: `hls-vod-too`
