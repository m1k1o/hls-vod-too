import { Context } from './Context';
import { SubProcessInvocation, asyncDebounce } from './Utils';

import os = require('os');
import path = require('path');
import assert = require('assert');
import events = require('events');
import express = require('express');
import readline = require('readline');

export type QualityLevelPreset = {
    name: string;
    resolution: number;
    videoBitrate: number;
    audioBitrate: number;
}

export type QualityLevel = {
    preset: QualityLevelPreset;
    width: number;
    height: number;
    backend: MediaBackend | null;
}

type TranscoderStatus = {
    head: number;
    id: number;
}

type ClientStatus = {
    head: number;
    transcoder?: SubProcessInvocation;
    deleted?: boolean;
}

const EMPTY = 0; // 1 reserved.
const DONE = 255; // 254 reserved.

// A media with a specific quality level.
export class MediaBackend {
    private readonly segmentStatus: Uint8Array;
    private readonly encoderHeads: Map<SubProcessInvocation, TranscoderStatus> = new Map();
    private readonly clients: Map<string, ClientStatus> = new Map();
    private readonly encodingDoneEmitter: events.EventEmitter = new events.EventEmitter();

    private lastAssignedId: number = 1;

    constructor(
        readonly context: Context,
        readonly config: QualityLevel,
        readonly breakpoints: Float64Array,
        readonly relPath: string,
        readonly outDir: string,
    ) {
        assert.strictEqual(config.backend, null, 'Backend already exists.');
        config.backend = this;

        this.segmentStatus = new Uint8Array(breakpoints.length - 1); // Defaults to EMPTY.
        this.segmentStatus.fill(EMPTY);
    }

    // Range between [2, 253].
    private findNextAvailableId(): number {
        // Find the first usable one.
        for (let i = -1; i <= 250; i++) {
            const attempt = ((this.lastAssignedId + i) % 252) + 2;
            if (this.segmentStatus.some(id => id === attempt)) {
                continue;
            }

            if (Array.from(this.encoderHeads.values()).some(encoder => encoder.id === attempt)) {
                continue;
            }

            return this.lastAssignedId = attempt;
        }

        throw new Error('No available Uint8 value.');
    }

    private startTranscode(startAt: number): SubProcessInvocation {
        assert((startAt >= 0) && (startAt < this.breakpoints.length - 1), 'Starting point wrong.');
        assert.strictEqual(this.segmentStatus[startAt], EMPTY, `Segment ${startAt} already being encoded (${this.segmentStatus[startAt]}).`);

        let endAt = Math.min(this.breakpoints.length - 1, startAt + 512); // By default, encode the entire video. However, clamp if there are too many (> 512), just to prevent the command from going overwhelmingly long.

        for (let i = startAt + 1; i < this.breakpoints.length - 1; i++) {
            if (this.segmentStatus[i] !== EMPTY) {
                endAt = i;
                break;
            }
        }

        const commaSeparatedTimes = [].map.call(
            this.breakpoints.subarray(startAt + 1, endAt),
            (num: number) => num.toFixed(6) // AV_TIME_BASE is 1000000, so 6 decimal digits will match.
        ).join(',');

        const transcoder = this.context.exec('ffmpeg', [
            '-loglevel', 'warning',
            '-ignore_chapters', '1',
            ...(startAt ? ['-ss', `${this.breakpoints[startAt]}`] : []), // Seek to start point. Note there is a bug(?) in ffmpeg: https://github.com/FFmpeg/FFmpeg/blob/fe964d80fec17f043763405f5804f397279d6b27/fftools/ffmpeg_opt.c#L1240 can possible set `seek_timestamp` to a negative value, which will cause `avformat_seek_file` to reject the input timestamp. To prevent this, the first break point, which we know will be zero, will not be fed to `-ss`.
            '-i', this.context.toDiskPath(this.relPath), // Input file
            '-to', `${this.breakpoints[endAt]}`,
            '-copyts', // So the "-to" refers to the original TS.
            '-force_key_frames', commaSeparatedTimes,
            '-sn', // No subtitles
            ...(this.config.preset.videoBitrate ? [
                '-vf', 'scale=' + ((this.config.width >= this.config.height) ? `-2:${this.config.height}` : `${this.config.width}:-2`), // Scaling
                '-preset', 'faster',
                // Video params:
                '-c:v', 'libx264',
                '-profile:v', 'high',
                '-level:v', '4.0',
                '-b:v', `${this.config.preset.videoBitrate}k`,
            ] : []),
            // Audio params:
            '-c:a', 'aac',
            '-b:a', `${this.config.preset.audioBitrate}k`,
            // Segmenting specs:
            '-f', 'segment',
            '-segment_time_delta', '0.2',
            '-segment_format', 'mpegts',
            '-segment_times', commaSeparatedTimes,
            '-segment_start_number', `${startAt}`,
            '-segment_list_type', 'flat',
            '-segment_list', 'pipe:1', // Output completed segments to stdout.
            `${this.config.preset.name}-%05d.ts`
        ], { cwd: this.outDir });

        const encoderId = this.findNextAvailableId();
        const status: TranscoderStatus = { head: startAt, id: encoderId };

        this.segmentStatus[startAt] = encoderId;
        this.encoderHeads.set(transcoder, status);

        transcoder.promise.then((code: any) => {
            if ((code !== 0 /* Success */ && code !== 255 /* Terminated by us, likely */)) {
                this.log(`FFmpeg process ${transcoder.pid} exited w/ status code ${code}.`);
            }
        }).finally(() => {
            if (this.segmentStatus[status.head] === encoderId) {
                this.segmentStatus[status.head] = EMPTY;
            }
            const deleted = this.encoderHeads.delete(transcoder);
            assert(deleted, 'Transcoder already detached.');
            this.recalculate();
        });

        readline.createInterface({
            input: transcoder.stdout,
        }).on('line', tsFileName => {
            assert(tsFileName.startsWith(this.config.preset.name + '-') && tsFileName.endsWith('.ts'), `Unexpected segment produced by ffmpeg: ${tsFileName}.`);
            const index = parseInt(tsFileName.substring(this.config.preset.name.length + 1, tsFileName.length - 3), 10);
            if (index !== status.head) {
                if (this.segmentStatus[status.head] === encoderId) {
                    this.segmentStatus[status.head] = EMPTY;
                }
                this.log(`Unexpected segment produced by ffmpeg: index was ${index} while head was ${status.head}.`);
            }
            this.segmentStatus[index] = DONE;
            this.encodingDoneEmitter.emit(`${index}`, null, tsFileName);
            if (index >= endAt - 1) {
                // Nothing specifically need to be done here. FFmpeg will exit automatically.
            } else if (this.segmentStatus[index + 1] !== EMPTY) {
                this.log(`Segment ${index} is not empty. Killing transcoder ${transcoder.pid}...`);
                transcoder.kill();
            } else {
                let needToContinue = false;

                this.clients.forEach(client => {
                    if (client.transcoder !== transcoder) { return; }
                    const playhead = client.head;
                    const bufferedLength = this.breakpoints[index + 1] - this.breakpoints[playhead]; // Safe to assume all segments in between are encoded as long as the client is attached to this transcoder.
                    if (bufferedLength < this.context.videoMaxBufferLength) {
                        needToContinue = true;
                    } else {
                        this.log(`We've buffered to ${index}(${this.breakpoints[index + 1]}), while the playhead is at ${playhead}(${this.breakpoints[playhead]})`);
                    }
                })

                if (needToContinue) {
                    status.head = index + 1;
                } else {
                    this.log('Stopping encoder as we have buffered enough.');
                    transcoder.kill();
                }
            }
        });

        return transcoder;
    }

    private readonly recalculate: (() => Promise<void>) = asyncDebounce(async () => {
        type EncoderHeadInfoTuple = { process: SubProcessInvocation, clients: string[] };
        type ClientHeadInfoTuple = { client: string; firstToEncode: number; bufferedLength: number; ref: ClientStatus; }

        const killOperations = [];

        // Map encoders from their heads.
        const encoders: Map<number, EncoderHeadInfoTuple> = new Map();
        for (const [process, { head: encoderHead }] of this.encoderHeads.entries()) {
            if (encoders.has(encoderHead)) {
                this.log(`Segment ${encoderHead} has two encoders (${process.pid} and ${encoders.get(encoderHead)!.process.pid}). This should never happen.`);
                killOperations.push(process.kill()); // Intentionally not awaited to prevent race conditions (i.e. two callers call this method stimutnously).
            } else {
                encoders.set(encoderHead, { process, clients: [] });
            }
        }

        // All playheads, sorted ascending.
        const unresolvedPlayheads = (Array.from(this.clients.entries()).map(([client, value]): (ClientHeadInfoTuple | null) => {
            if (value.deleted || value.head < 0) {
                return null;
            }
            const segmentIndex = value.head;
            // Traverse through all the segments within mandatory buffer range.
            const startTime = this.breakpoints[segmentIndex];
            let shouldStartFromSegment = -1;
            for (let i = segmentIndex; (i < this.breakpoints.length - 1) && (this.breakpoints[i] - startTime < this.context.videoMinBufferLength); i++) {
                if (this.segmentStatus[i] !== DONE) {
                    shouldStartFromSegment = i;
                    break;
                }
            }
            return (shouldStartFromSegment >= 0) ? {
                client,
                firstToEncode: shouldStartFromSegment,
                bufferedLength: shouldStartFromSegment - segmentIndex,
                ref: value
            } : null;
        }).filter(_ => _) as ClientHeadInfoTuple[]).filter(playHead => {
            const exactMatch = encoders.get(playHead.firstToEncode);
            if (exactMatch) {
                exactMatch.clients.push(playHead.client);
                playHead.ref.transcoder = exactMatch.process;
                return false;
            }
            const minusOneMatch = encoders.get(playHead.firstToEncode - 1);
            if (minusOneMatch) {
                minusOneMatch.clients.push(playHead.client);
                playHead.ref.transcoder = minusOneMatch.process;
                return false;
            }
            return true; // There isn't an existing encoder head for it yet!
        }).sort((a, b) => a.firstToEncode - b.firstToEncode);

        // Kill all encoder heads that are unused.
        for (const encoder of encoders.values()) {
            if (!encoder.clients.length) {
                killOperations.push(encoder.process.kill());
            }
        }

        await Promise.all(killOperations);

        let lastStartedProcess: { index: number, process: SubProcessInvocation } | null = null;
        for (let i = 0; i < unresolvedPlayheads.length; i++) {
            const current = unresolvedPlayheads[i];
            if (lastStartedProcess && ((lastStartedProcess.index === current.firstToEncode) || (lastStartedProcess.index === current.firstToEncode - 1))) {
                current.ref.transcoder = lastStartedProcess.process;
                continue;
            }
            const process = this.startTranscode(current.firstToEncode);
            current.ref.transcoder = process;
            lastStartedProcess = { index: current.firstToEncode, process };
        }
    });

    private async onGetSegment(clientInfo: ClientStatus, segmentIndex: number): Promise<void> {
        clientInfo.head = segmentIndex;

        await this.recalculate();
    }

    getVariantManifest(): string {
        const breakpoints = this.breakpoints;
        const qualityLevelName = this.config.preset.name;
        const segments = new Array((breakpoints.length - 1) * 2);

        for (let i = 1; i < breakpoints.length; i++) {
            segments[i * 2 - 2] = '#EXTINF:' + (breakpoints[i] - breakpoints[i - 1]).toFixed(3);
            segments[i * 2 - 1] = `${qualityLevelName}.${i.toString(16)}.ts`;
        }

        return [
            '#EXTM3U',
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-TARGETDURATION:4.75',
            '#EXT-X-VERSION:4',
            '#EXT-X-MEDIA-SEQUENCE:0', // I have no idea why this is needed.
            ...segments,
            '#EXT-X-ENDLIST'
        ].join(os.EOL);
    }

    async getSegment(clientId: string, segmentNumber: string, request: express.Request, response: express.Response): Promise<void> {
        let clientInfo = this.clients.get(clientId);
        if (!clientInfo) {
            clientInfo = { head: -1 };
            this.clients.set(clientId, clientInfo);
        } else if (clientInfo.deleted) {
            response.sendStatus(409);
            return;
        }

        const segmentIndex = parseInt(segmentNumber, 16) - 1;
        assert(!isNaN(segmentIndex) && (segmentIndex >= 0) && (segmentIndex < this.breakpoints.length - 1), `Segment index out of range.`);

        let fileName = `${this.config.preset.name}-${((segmentIndex + 1e5) % 1e6).toString().substr(1)}.ts`;
        const fileReady = this.segmentStatus[segmentIndex] === DONE;
        await this.onGetSegment(clientInfo, segmentIndex);

        if (!fileReady) {
            try {
                fileName = await new Promise((res, rej) => {
                    const callback = (errorInfo: string, fileName: string) => (errorInfo ? rej(errorInfo) : res(fileName));
                    this.encodingDoneEmitter.once(`${segmentIndex}`, callback);
                    request.on('close', () => this.encodingDoneEmitter.removeListener(`${segmentIndex}`, callback));
                })
            } catch (error: any) {
                response.status(500).send(error)
                return
            }
        }

        response.sendFile(path.join(this.outDir, fileName))
    }

    async removeClient(clientId: string) {
        this.log(`Removing client ${clientId}.`);
        const status = this.clients.get(clientId);
        if (status?.deleted) {
            return;
        }

        if (status) {
            status.deleted = true;
        } else {
            // Prevent race condition such that [removeClient()] is called right after another request grabs the backend but not started using it.
            this.clients.set(clientId, { head: -1, deleted: true });
        }

        await this.recalculate();

        setTimeout(() => {
            this.clients.delete(clientId); // The entry must not have been changed. A 1-seconds delay is enough to remove the possibility of race conditions.
        }, 1000);
    }

    async destruct(): Promise<void> {
        // TODO: Refactor.
        //this.context.noticeDestructOfBackend(this, Array.from(this.clients.keys()));

        for (const name of this.encodingDoneEmitter.eventNames()) {
            this.encodingDoneEmitter.emit(name, 'Encoder being evicted.', null);
        }

        for (const subProcess of this.encoderHeads.keys()) {
            await subProcess.kill();
        }
    }

    log(...params: any): void {
        if (this.context.debug) {
            console.log(`[${this.relPath}] [${this.config.preset.name}]`, ...params);
        }
    }
}
