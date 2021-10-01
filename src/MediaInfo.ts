import { Context } from './Context';
import { MediaBackend } from './MediaBackend';

import path = require('path');
import crypto = require('crypto');
import fsExtra = require('fs-extra');

export abstract class MediaInfo {
    constructor(
        readonly context: Context,
        readonly relPath: string,
        readonly outDir: string,
    ) {}

    static async createOutDir(context: Context, relPath: string): Promise<string> {
        const pathHash = crypto.createHash('md5').update(context.toDiskPath(relPath)).digest('hex');
        const outDir = path.join(context.outputPath, pathHash);
        await fsExtra.mkdirs(outDir);
        return outDir
    }

    log(...params: any): void {
        if (this.context.debug) {
            console.log(`[${this.relPath}]`, ...params);
        }
    }

    abstract getBackendByQualityLevel(level: string): MediaBackend;
    abstract getMasterManifest(): string;
    abstract destruct(): Promise<void>;

    /**
     * Calculate the timestamps to segment the video at.
     * Returns all segments endpoints, including video starting time (0) and end time.
     *
     * - Use keyframes (i.e. I-frame) as much as possible.
     * - For each key frame, if it's over 4.75 seconds since the last keyframe, insert a breakpoint between them in an evenly, such that the breakpoint distance is <= 3.5 seconds (per https://bitmovin.com/mpeg-dash-hls-segment-length/).
     *   Example: key frame at 20.00 and 31.00, split at 22.75, 25.5, 28.25.
     * - If the duration between two key frames is smaller than 2.25 seconds, ignore the existance of the second key frame.
     *
     * This guarantees that all segments are between the duration 2.33 s and 4.75 s.
     */
    protected static convertToSegments(rawTimeList: Float64Array, duration: number): Float64Array {
        const timeList = [...rawTimeList, duration];
        const segmentStartTimes = [0];
        let lastTime = 0;
        for (const time of timeList) {
            if (time - lastTime < 2.25) {
                // Skip it regardless.
            } else if (time - lastTime < 4.75) {
                // Use it as-is.
                lastTime = time;
                segmentStartTimes.push(lastTime);
            } else {
                const numOfSegmentsNeeded = Math.ceil((time - lastTime) / 3.5);
                const durationOfEach = (time - lastTime) / numOfSegmentsNeeded;
                for (let i = 1; i < numOfSegmentsNeeded; i++) {
                    lastTime += durationOfEach;
                    segmentStartTimes.push(lastTime);
                }
                lastTime = time; // Use time directly instead of setting in the loop so we won't lose accuracy due to float point precision limit.
                segmentStartTimes.push(time);
            }
        }

        if (segmentStartTimes.length > 1) {
            segmentStartTimes.pop(); // Would be equal to duration unless the skip branch is executed for the last segment, which is fixed below.
            const lastSegmentLength = duration - segmentStartTimes[segmentStartTimes.length - 1];
            if (lastSegmentLength > 4.75) {
                segmentStartTimes.push(duration - lastSegmentLength / 2);
            }
        }

        segmentStartTimes.push(duration);
        return Float64Array.from(segmentStartTimes);
    }
}
