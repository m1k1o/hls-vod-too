import { Context, ffprobeTimeout } from './Context';
import { MediaInfo } from './MediaInfo';
import { MediaBackend, QualityLevelPreset } from './MediaBackend';

import assert = require('assert');
import fsExtra = require('fs-extra');

export const audioPreset: QualityLevelPreset = { name: 'audio', resolution: NaN, videoBitrate: 0, audioBitrate: 320 };

export class AudioInfo extends MediaInfo {
    readonly backend: MediaBackend;

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

        this.log(`Audio information initialized. Using output directory ${this.outDir}.`);

        // initialize new media backend
        this.backend = new MediaBackend(
            this.context,
            {  width: 0, height: 0, preset: audioPreset, backend: null },
            MediaInfo.convertToSegments(Float64Array.of(), duration),
            this.relPath, this.outDir,
        );
    }

    getBackendByQualityLevel(level: string): MediaBackend {
        let backend: MediaBackend
        if (audioPreset.name == level) {
            backend = this.backend
        }

        return backend!
    }

    getMasterManifest(): string {
        return this.backend.getVariantManifest();
    }

    static async getInstance(
        context: Context,
        relPath: string
    ): Promise<AudioInfo> {
        const ffprobeOutput = await (context.exec('ffprobe', [
            '-v', 'error', // Hide debug information
            '-show_entries', 'stream=duration,bit_rate',
            '-select_streams', 'a', // Audio stream only, we're not interested in video
            '-of', 'json',
            context.toDiskPath(relPath)
        ], { timeout: ffprobeTimeout })).result();

        const outDir = await MediaInfo.createOutDir(context, relPath)
        return new AudioInfo(context, relPath, outDir, ffprobeOutput);
    }

    async destruct() {
        await this.backend.destruct();
        await fsExtra.remove(this.outDir);
    }
}
