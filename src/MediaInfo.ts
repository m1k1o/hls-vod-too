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
     * - For each key frame, if it's over (maxSegmentLength) seconds since the last keyframe, insert a breakpoint between them in an evenly,
     *   such that the breakpoint distance is <= (segmentLength) seconds (per https://bitmovin.com/mpeg-dash-hls-segment-length/).
     *   Example:
     *    segmentLength = 3.5
     *    key frame at 20.00 and 31.00, split at 22.75, 25.5, 28.25.
     * - If the duration between two key frames is smaller than (minSegmentLength) seconds, ignore the existance of the second key frame.
     *
     * This guarantees that all segments are between the duration (minSegmentLength) seconds and (maxSegmentLength) seconds.
     */
    static convertToSegments(rawTimeList: Float64Array, duration: number, segmentLength = 3.5, segmentOffset = 1.25): Float64Array {
        const minSegmentLength = segmentLength - segmentOffset;
        const maxSegmentLength = segmentLength + segmentOffset;

        const timeList = [...rawTimeList, duration];
        const segmentStartTimes = [0];

        let lastTime = 0;
        for (const time of timeList) {
            if (time - lastTime < minSegmentLength) {
                // Skip it regardless.
            } else if (time - lastTime < maxSegmentLength) {
                // Use it as-is.
                lastTime = time;
                segmentStartTimes.push(lastTime);
            } else {
                const numOfSegmentsNeeded = Math.ceil((time - lastTime) / segmentLength);
                const durationOfEach = (time - lastTime) / numOfSegmentsNeeded;
                for (let i = 1; i < numOfSegmentsNeeded; i++) {
                    lastTime += durationOfEach;
                    segmentStartTimes.push(lastTime);
                }

                // Use time directly instead of setting in the loop so we won't lose accuracy due to float point precision limit.
                lastTime = time;
                segmentStartTimes.push(lastTime);
            }
        }

        if (segmentStartTimes.length > 1) {
            // Would be equal to duration unless the skip branch is executed for the last segment, which is fixed below.
            segmentStartTimes.pop();

            const lastSegmentLength = duration - segmentStartTimes[segmentStartTimes.length - 1];
            if (lastSegmentLength > maxSegmentLength) {
                segmentStartTimes.push(duration - lastSegmentLength / 2);
            }
        }

        segmentStartTimes.push(duration);
        return Float64Array.from(segmentStartTimes);
    }
}
