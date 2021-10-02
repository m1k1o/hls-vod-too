import { Context, ffprobeTimeout } from './Context';
import { MediaInfo } from './MediaInfo';
import { MediaBackend, QualityLevelPreset, QualityLevel } from './MediaBackend';

import os = require('os');
import assert = require('assert');
import fsExtra = require('fs-extra');

export const qualityLevelPresets: QualityLevelPreset[] = [
    { name: '1080p-extra', resolution: 1080, videoBitrate: 14400, audioBitrate: 320 },
    { name: '1080p', resolution: 1080, videoBitrate: 9600,  audioBitrate: 224 },
    { name: '720p', resolution: 720, videoBitrate: 4800,  audioBitrate: 160 },
    { name: '480p', resolution: 480, videoBitrate: 2400,  audioBitrate: 128 },
    { name: '360p', resolution: 360, videoBitrate: 1200,  audioBitrate: 112 }
].sort((a, b) => (b.resolution - a.resolution) || (b.videoBitrate - a.videoBitrate));

export class VideoInfo extends MediaInfo {
    private readonly qualityLevels: Map<string, QualityLevel>;
    private readonly breakpoints: Float64Array;

    private constructor(
        context: Context,
        relPath: string,
        outDir: string,
        ffProbeResult: string
    ) {
        super(context, relPath, outDir);

        // parse ffprobe output
        const ffprobeOutput = JSON.parse(ffProbeResult);

        // get video duration
        const duration = parseFloat(ffprobeOutput['streams'][0]['duration']) || parseFloat(ffprobeOutput['format']['duration']);
        assert(duration > 0.5, 'Video too short.');

        // get video resolution
        const { width, height } = ffprobeOutput['streams'][0];
        const resolution = Math.min(width, height);

        // get video Iframes
        const rawIFrames = Float64Array.from(ffprobeOutput['frames'].map((frame: Record<string, string>) =>
            parseFloat(frame['pkt_pts_time'])).filter((time: number) => !isNaN(time)));

        // set breakpoints
        this.breakpoints = MediaInfo.convertToSegments(rawIFrames, duration);

        // get quality presets available for current video
        let presets = qualityLevelPresets.filter(preset => preset.resolution <= resolution);

        // if there is no existing quality preset, use last one
        if (presets.length == 0) {
            presets = [qualityLevelPresets[qualityLevelPresets.length - 1]]
        }

        // prepare qualtiy levels
        this.qualityLevels = new Map(presets.map(preset =>
            [preset.name, {
                preset,
                width: Math.round(width / resolution * preset.resolution),
                height: Math.round(height / resolution * preset.resolution),
                backend: null
            }]
        ));

        this.log(`Video information initialized. Using output directory ${this.outDir}.`);
    }

    static async getInstance(
        context: Context,
        relPath: string
    ): Promise<VideoInfo> {
        const ffprobeOutput = await (context.exec('ffprobe', [
            '-v', 'error', // Hide debug information
            '-skip_frame', 'nokey', '-show_entries', 'frame=pkt_pts_time', // List all I frames
            '-show_entries', 'format=duration',
            '-show_entries', 'stream=duration,width,height',
            '-select_streams', 'v', // Video stream only, we're not interested in audio
            '-of', 'json',
            context.toDiskPath(relPath)
        ], { timeout: ffprobeTimeout })).result();

        const outDir = await MediaInfo.createOutDir(context, relPath)
        return new VideoInfo(context, relPath, outDir, ffprobeOutput);
    }

    getBackendByQualityLevel(qualityLevel: string): MediaBackend {
        const level = this.qualityLevels.get(qualityLevel);
        assert(level, 'Quality level not exists.');

        if (!level.backend) {
            new MediaBackend(this.context, level, this.breakpoints, this.relPath, this.outDir);
        }

        return level.backend!;
    }

    getMasterManifest(): string {
        return ['#EXTM3U'].concat(
            ...Array.from(this.qualityLevels.entries()).map(([levelName, { width, height, preset }]) => [
                `#EXT-X-STREAM-INF:BANDWIDTH=${
                    Math.ceil((preset.videoBitrate + preset.audioBitrate) * 1.05) // 5% estimated container overhead.
                },RESOLUTION=${width}x${height},NAME=${levelName}`,
                `quality-${levelName}.m3u8`
            ])
        ).join(os.EOL)
    }

    async destruct() {
        // caller should ensure that the instance is already initialized
        for (const level of this.qualityLevels.values()) {
            await level.backend?.destruct();
        }

        await fsExtra.remove(this.outDir);
    }
}
