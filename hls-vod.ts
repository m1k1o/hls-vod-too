#!/usr/bin/env ts-node-script

import assert = require('assert');
import childProcess = require('child_process');
import http = require('http');
import path = require('path');
import os = require('os');
import readline = require('readline');
import crypto = require('crypto');
import fs = require('fs');
import events = require('events');
import util = require('util');

// 3rd party
import fsExtra = require('fs-extra');
import express = require('express');
import parseArgs = require('minimist');

if (typeof require('fs').Dirent !== 'function') {
    throw new Error(`The Node.js version is too old for ${__filename} to run.`);
}

const videoExtensions = ['.mp4', '.3gp2', '.3gp', '.3gpp', '.3gp2', '.amv', '.asf', '.avs', '.dat', '.dv', '.dvr-ms', '.f4v', '.m1v', '.m2p', '.m2ts', '.m2v', '.m4v', '.mkv', '.mod', '.mp4', '.mpe', '.mpeg1', '.mpeg2', '.divx', '.mpeg4', '.mpv', '.mts', '.mxf', '.nsv', '.ogg', '.ogm', '.mov', '.qt', '.rv', '.tod', '.trp', '.tp', '.vob', '.vro', '.wmv', '.web,', '.rmvb', '.rm', '.ogv', '.mpg', '.avi', '.mkv', '.wmv', '.asf', '.m4v', '.flv', '.mpg', '.mpeg', '.mov', '.vob', '.ts', '.webm'];
const audioExtensions = ['.mp3', '.aac', '.m4a', '.wma', '.ape', '.flac', '.ra', '.wav'];

type QualityLevelPreset = { name: string; resolution: number; videoBitrate: number; audioBitrate: number; };
const qualityLevelPresets: QualityLevelPreset[] = [
    { name: '1080p-extra', resolution: 1080, videoBitrate: 14400, audioBitrate: 320 },
    { name: '1080p', resolution: 1080, videoBitrate: 9600,  audioBitrate: 224 },
    { name: '720p', resolution: 720, videoBitrate: 4800,  audioBitrate: 160 },
    { name: '480p', resolution: 480, videoBitrate: 2400,  audioBitrate: 128 },
    { name: '360p', resolution: 360, videoBitrate: 1200,  audioBitrate: 112 }
].sort((a, b) => (b.resolution - a.resolution) || (b.videoBitrate - a.videoBitrate));

const audioPreset: QualityLevelPreset = { name: 'audio', resolution: NaN, videoBitrate: 0, audioBitrate: 320 };

const ffprobeTimeout = 30 * 1000; // millisecs.
const processCleanupTimeout = 6 * 60 * 60 * 1000; // millisecs.

// Those formats can be supported by the browser natively: transcoding may not be needed for them.
// As listed in https://www.chromium.org/audio-video, and translated into ffmpeg codecs/formats identifiers.
// Change accordingly if you are mainly targeting an old or strange browser (i.e. if you are targeting Apple platforms, you want want to only keep the first entry in each list).
const nativeSupportedFormats = {
    videoCodec: ['h264','vp8', 'vp9',' theora'],
    audioCodec: ['aac', 'mp3', 'vorbis', 'opus', 'pcm_u8', 'pcm_s16le', 'pcm_f32le', 'flac'],
    videoContainer: ['mov', 'mp4', 'webm', 'ogg'],
    audioContainer: ['mp3', 'flac', 'ogg']
};

class SubProcessInvocation {
    public readonly promise: Promise<number>;
    public readonly stdout: NonNullable<childProcess.ChildProcess['stdout']>;
    private readonly process: childProcess.ChildProcess;

    constructor(
        command: string, 
        args: string[],
        cwd: string,
        timeout: number
    ) {
        const processHandle = childProcess.spawn(
            command,
            args,
            { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] }
        );
        this.process = processHandle;
        this.stdout = processHandle.stdout;

        this.promise = new Promise((res, rej) => {
            let timeoutRef: ReturnType<typeof setTimeout>;
            const onFinish = (code: number) => {
                clearTimeout(timeoutRef);
                res(code);
            };
            processHandle.on('exit', onFinish);
            timeoutRef = setTimeout(async () => {
                processHandle.removeListener('exit', onFinish);
                await SubProcessInvocation.killProcess(processHandle);
                rej(new Error('Child process timeout.'));
            }, timeout);
        });
    }

    async result(): Promise<string> {
        let stdoutBuf = '';
        this.stdout.on('data', data => { 
            stdoutBuf += data;
        });
        const code = await this.promise;
        if (code != 0) { throw new Error(`Process ${this.process.pid} exited w/ status ${code}.`); }
        return stdoutBuf;
    };

    get pid(): number { return this.process.pid; }

    kill(): Promise<number> { return SubProcessInvocation.killProcess(this.process); }

    private static killProcess(processToKill: childProcess.ChildProcess): Promise<number> {
        return new Promise(res => {
            processToKill.on('exit', res);
            processToKill.kill();
            setTimeout(() => processToKill.kill('SIGKILL'), 5000);
        });
    }
}

/**
 * Debounce an async function, such that:
 * - When a previous call is still pending (unfinished), no calls will go through (so it's not reentrant).
 * - All calls within the pending period will be collapsed into one, and fired after the pending one gets finished.
 */
const asyncDebounce = <T> (method: () => Promise<T>): (() => Promise<T>) => {
    let inProgress: Promise<T> | null = null;
    let nextCall: Promise<T> | null = null;
    const debounced: (() => Promise<T>) = () => {
        if (!inProgress) {
            return inProgress = method().finally(() => { 
                inProgress = null;
                nextCall = null;
            });
        }
        if (!nextCall) {
            nextCall = inProgress.then(debounced);
        }
        return nextCall;
    };
    return debounced;
};

type QualityLevel = {
    preset: QualityLevelPreset;
    width: number;
    height: number;
    backend: MediaBackend | null;
};

type TranscoderStatus = {
    head: number;
    id: number;
};

type ClientStatus = {
    head: number;
    transcoder?: SubProcessInvocation;
    deleted?: boolean;
}

const EMPTY = 0; // 1 reserved.
const DONE = 255; // 254 reserved.

// A media with a specific quality level.
class MediaBackend {
    private readonly segmentStatus: Uint8Array;
    private readonly encoderHeads: Map<SubProcessInvocation, TranscoderStatus> = new Map();
    private readonly clients: Map<string, ClientStatus> = new Map();
    private readonly encodingDoneEmitter: events.EventEmitter = new events.EventEmitter();

    private lastAssignedId: number = 1;

    constructor(readonly parent: MediaInfo, readonly config: QualityLevel) {
        assert.strictEqual(config.backend, null, 'Backend already exists.');
        config.backend = this;
        this.segmentStatus = new Uint8Array(parent.breakpoints.length - 1); // Defaults to EMPTY.
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
        assert((startAt >= 0) && (startAt < this.parent.breakpoints.length - 1), 'Starting point wrong.');
        assert.strictEqual(this.segmentStatus[startAt], EMPTY, `Segment ${startAt} already being encoded (${this.segmentStatus[startAt]}).`);

        let endAt = Math.min(this.parent.breakpoints.length - 1, startAt + 512); // By default, encode the entire video. However, clamp if there are too many (> 512), just to prevent the command from going overwhelmingly long.

        for (let i = startAt + 1; i < this.parent.breakpoints.length - 1; i++) {
            if (this.segmentStatus[i] !== EMPTY) {
                endAt = i;
                break;
            }
        }

        const commaSeparatedTimes = [].map.call(
            this.parent.breakpoints.subarray(startAt + 1, endAt), 
            (num: number) => num.toFixed(6) // AV_TIME_BASE is 1000000, so 6 decimal digits will match.
        ).join(',');

        const transcoder = this.parent.parent.exec('ffmpeg', [
            '-loglevel', 'warning',
            ...(startAt ? ['-ss', `${this.parent.breakpoints[startAt]}`] : []), // Seek to start point. Note there is a bug(?) in ffmpeg: https://github.com/FFmpeg/FFmpeg/blob/fe964d80fec17f043763405f5804f397279d6b27/fftools/ffmpeg_opt.c#L1240 can possible set `seek_timestamp` to a negative value, which will cause `avformat_seek_file` to reject the input timestamp. To prevent this, the first break point, which we know will be zero, will not be fed to `-ss`.
            '-i', this.parent.parent.toDiskPath(this.parent.relPath), // Input file
            '-to', `${this.parent.breakpoints[endAt]}`,
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
        ], { cwd: this.parent.outDir });

        const encoderId = this.findNextAvailableId();
        const status: TranscoderStatus = { head: startAt, id: encoderId };

        this.segmentStatus[startAt] = encoderId;
        this.encoderHeads.set(transcoder, status);

        transcoder.promise.then(code => {
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
                    const bufferedLength = this.parent.breakpoints[index + 1] - this.parent.breakpoints[playhead]; // Safe to assume all segments in between are encoded as long as the client is attached to this transcoder.
                    if (bufferedLength < this.parent.parent.videoMaxBufferLength) {
                        needToContinue = true;
                    } else {
                        this.log(`We've buffered to ${index}(${this.parent.breakpoints[index + 1]}), while the playhead is at ${playhead}(${this.parent.breakpoints[playhead]})`);
                    }
                })

                if (needToContinue) {
                    status.head = index + 1;
                } else {
                    this.parent.log('Stopping encoder as we have buffered enough.');
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
            const startTime = this.parent.breakpoints[segmentIndex];
            let shouldStartFromSegment = -1;
            for (let i = segmentIndex; (i < this.parent.breakpoints.length - 1) && (this.parent.breakpoints[i] - startTime < this.parent.parent.videoMinBufferLength); i++) {
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
        const breakpoints = this.parent.breakpoints;
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

    getSegment(clientId: string, segmentNumber: string, request: express.Request, response: express.Response): void {
        let clientInfo = this.clients.get(clientId);
        if (!clientInfo) {
            clientInfo = { head: -1 };
            this.clients.set(clientId, clientInfo);
        } else if (clientInfo.deleted) {
            response.sendStatus(409);
            return;
        }

        const segmentIndex = parseInt(segmentNumber, 16) - 1;
        assert(!isNaN(segmentIndex) && (segmentIndex >= 0) && (segmentIndex < this.parent.breakpoints.length - 1), `Segment index out of range.`);

        const fileReady = this.segmentStatus[segmentIndex] === DONE;
        this.onGetSegment(clientInfo, segmentIndex);

        if (fileReady) {
            const fileName = `${this.config.preset.name}-${((segmentIndex + 1e5) % 1e6).toString().substr(1)}.ts`;
            const filePath = path.join(this.parent.outDir, fileName);
            response.sendFile(filePath);
            return;
        }

        const callback = (errorInfo: string, fileName: string) => (errorInfo ? response.status(500).send(errorInfo) : response.sendFile(path.join(this.parent.outDir, fileName)));
        this.encodingDoneEmitter.once(`${segmentIndex}`, callback);
        request.on('close', () => this.encodingDoneEmitter.removeListener(`${segmentIndex}`, callback));
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
        this.parent.parent.noticeDestructOfBackend(this, Array.from(this.clients.keys()));
        for (const name of this.encodingDoneEmitter.eventNames()) {
            this.encodingDoneEmitter.emit(name, 'Encoder being evicted.', null);
        }
        for (const subProcess of this.encoderHeads.keys()) {
            await subProcess.kill();
        }
    }

    log(...params: any): void {
        this.parent.log(`[${this.config.preset.name}]`, ...params);
    }
}

abstract class MediaInfo {
    readonly outDir: string;
    private outDirPromise?: Promise<void>;

    constructor(readonly parent: HlsVod, readonly relPath: string, readonly breakpoints: Float64Array) {
		const pathHash = crypto.createHash('md5').update(parent.toDiskPath(relPath)).digest('hex');
        this.outDir = path.join(parent.outputPath, pathHash);
        this.outDirPromise = fsExtra.mkdirs(this.outDir);
    }

    static async getInstance(parent: HlsVod, key: string): Promise<MediaInfo> {
        const type = key.charAt(0);
        const path = key.substr(1);
        let instance;
        if (type === 'V') {
            instance = await VideoInfo.getInstance(parent, path);
        } else if (type === 'A') {
            instance = await AudioInfo.getInstance(parent, path);
        } else {
            throw new RangeError('Bad media type.');
        }
        await instance.outDirPromise!;
        delete instance.outDirPromise;
        return instance;
    }
 
    log(...params: any): void {
        if (this.parent.debug) {
            console.log(`[${this.relPath}]`, ...params);
        }
    }
    
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

class VideoInfo extends MediaInfo {
    private readonly qualityLevels: Map<string, QualityLevel>;

    private constructor(
        parent: HlsVod, 
        relPath: string,
        ffProbeResult: string
    ) { 
        const ffprobeOutput = JSON.parse(ffProbeResult);

        const duration = parseFloat(ffprobeOutput['streams'][0]['duration']) || parseFloat(ffprobeOutput['format']['duration']);
        assert(duration > 0.5, 'Video too short.');
		
        const { width, height } = ffprobeOutput['streams'][0];
		const resolution = Math.min(width, height);
        const rawIFrames = Float64Array.from(ffprobeOutput['frames'].map((frame: Record<string, string>) => parseFloat(frame['pkt_pts_time'])).filter((time: number) => !isNaN(time)));
        
        super(parent, relPath, MediaInfo.convertToSegments(rawIFrames, duration));
        
        const presets = qualityLevelPresets.filter(preset => preset.resolution <= resolution);
        this.qualityLevels = new Map((presets.length ? presets : [qualityLevelPresets[qualityLevelPresets.length - 1]]).map(preset => 
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
        parent: HlsVod, 
        relPath: string
    ): Promise<VideoInfo> {
        const ffprobeOutput = await (parent.exec('ffprobe', [
			'-v', 'error', // Hide debug information
            '-skip_frame', 'nokey', '-show_entries', 'frame=pkt_pts_time', // List all I frames
            '-show_entries', 'format=duration',
            '-show_entries', 'stream=duration,width,height',
			'-select_streams', 'v', // Video stream only, we're not interested in audio
            '-of', 'json',
            parent.toDiskPath(relPath)
        ], { timeout: ffprobeTimeout })).result();

        return new VideoInfo(parent, relPath, ffprobeOutput);
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
    
    level(qualityLevel: string): MediaBackend {
        const level = this.qualityLevels.get(qualityLevel);
        assert(level, 'Quality level not exists.');
        if (!level.backend) { new MediaBackend(this, level); }
        return level.backend!;
    }

    async destruct() {
        // Caller should ensure that the instance is already initialized.
        for (const level of this.qualityLevels.values()) {
            await level.backend?.destruct();
        }
        await fsExtra.remove(this.outDir);
    }
}

class AudioInfo extends MediaInfo {
    readonly backend: MediaBackend;

    private constructor(
        parent: HlsVod, 
        relPath: string,
        ffProbeResult: string
    ) { 
        const ffprobeOutput = JSON.parse(ffProbeResult);

        const duration = parseFloat(ffprobeOutput['streams'][0]['duration']) || parseFloat(ffprobeOutput['format']['duration']);
        assert(duration > 0.5, 'Video too short.');
        
        super(parent, relPath, MediaInfo.convertToSegments(Float64Array.of(), duration));

        this.log(`Audio information initialized. Using output directory ${this.outDir}.`);
        
        this.backend = new MediaBackend(this, {
            width: 0, height: 0, preset: audioPreset, backend: null
        });
    }

    getMasterManifest(): string {
        return this.backend.getVariantManifest();
    }

    static async getInstance(
        parent: HlsVod, 
        relPath: string
    ): Promise<AudioInfo> {
        const ffprobeOutput = await (parent.exec('ffprobe', [
			'-v', 'error', // Hide debug information
            '-show_entries', 'stream=duration,bit_rate',
			'-select_streams', 'a', // Video stream only, we're not interested in audio
            '-of', 'json',
            parent.toDiskPath(relPath)
        ], { timeout: ffprobeTimeout })).result();
    
        return new AudioInfo(parent, relPath, ffprobeOutput);
    }

    async destruct() {
        await this.backend.destruct();
        await fsExtra.remove(this.outDir);
    }
}

/**
 * LRU cache map that handles async constructing/destructing:
 * - If constructing/destructing is already in progress, not firing once again.
 * - Ensures a previous cached value of the same key is properly destructed before constructing it again (to prevent external race conditions).
 */
class LruCacheMapForAsync<K, V, D = unknown> {
    private readonly cache: Map<K, Promise<V>> = new Map();
    private readonly destructions: Map<K, Promise<D>> = new Map();

    constructor(
        private readonly cacheSize: number,
        private readonly asyncConstructor: (key: K) => Promise<V>,
        private readonly asyncDestructor: (instance: V, key: K) => Promise<D>
    ) {}

    private set(key: K, info: Promise<V>): void {
        if (this.cache.size >= this.cacheSize) { // Evict the first entry from the cache.
            this.delete(this.cache.keys().next().value); // No need to wait for it to finish. We can afford some temporary extra memory.
        }
        this.cache.set(key, info);
    }

    delete(key: K): Promise<D> | undefined {
        const info = this.cache.get(key);
        if (!info) {
            return this.destructions.get(key);
        }
        const destruction = info.then((info) => this.asyncDestructor(info, key));
        // It must NOT be in [this.destructions] yet, since it's in [this.cache].
        this.cache.delete(key);
        this.destructions.set(key, destruction);
        return destruction;
    }
    
    get(key: K): Promise<V> {
        let info = this.cache.get(key);
        if (!info) {
            const destruction = this.destructions.get(key);
            const ctor = () => this.asyncConstructor(key);
            info = destruction ? destruction.then(ctor, ctor) : ctor();
            this.set(key, info);
            info.catch(() => {
                if (this.cache.get(key) === info) { // This check is necessary as the item can be removed and re-added before info resolves.
                    this.cache.delete(key);
                }
            });
        } else {
            this.cache.delete(key); // Remove it from the original position in the cache and let the "set()" below put it to the end. This is needed as we want the cache to be an LRU one.
        }
        this.cache.set(key, info);
        return info;
    }

}

type FileEntry = { type?: 'video' | 'audio' | 'directory'; name: string; };

/**
 * Main entry point for a program instance. You can run multiple instances as long as they use different ports and output paths.
 * 
 * Returns an async function to clean up.
 */
class HlsVod {

    readonly ffmpegBinaryDir: string;
    readonly outputPath: string;
    readonly debug: boolean;
    readonly noShortCircuit: boolean;
    readonly videoMinBufferLength: number;
    readonly videoMaxBufferLength: number;
    readonly server: http.Server;
    readonly allSubProcesses: Set<SubProcessInvocation> = new Set();
    
    private readonly listenPort: number;
    private readonly rootPath: string;
    private readonly maxClientNumber: number;
    private readonly cachedMedia = new LruCacheMapForAsync<string, MediaInfo>(
        Math.max(20), 
        typeAndPath => MediaInfo.getInstance(this, typeAndPath),
        info => info.destruct()
    );
    private readonly clientTracker: Map<string, Promise<MediaBackend>> = new Map();

    constructor(params: { [s: string]: any; }) {
        this.listenPort = parseInt(params['port']) || 4040;
        this.rootPath = path.resolve(params['root-path'] || '.');
        this.ffmpegBinaryDir = params['ffmpeg-binary-dir'] ? (params['ffmpeg-binary-dir'] + path.sep) : '';
        this.outputPath = path.resolve(params['cache-path'] || path.join(os.tmpdir(), 'hls-vod-cache'));
        this.debug = !!params['debug'];
        this.noShortCircuit = !!params['no-short-circuit'];
        this.videoMinBufferLength = parseInt(params['buffer-length']) || 30;
        this.videoMaxBufferLength = this.videoMinBufferLength * 2;
        this.maxClientNumber = parseInt(params['max-client-number']) || 5;

        this.server = this.initExpress();
    }

    public exec(
        command: string, 
        args: string[],
        { timeout, cwd } : { timeout?: number, cwd?: string } = {}
    ): SubProcessInvocation {
        if (this.debug) {
            console.log(`Running ${command} ${args.join(' ')}`);
        }
        const handle = new SubProcessInvocation(this.ffmpegBinaryDir + command, args, cwd || this.outputPath, timeout || processCleanupTimeout);
        const started = Date.now();
        this.allSubProcesses.add(handle);
        handle.promise.finally(() => {
            this.allSubProcesses.delete(handle);
            if (this.debug) {
                console.log(`Subprocess ${handle.pid} took ${(Date.now() - started)} ms.`);
            }
        });
        return handle;
    }

    public toDiskPath(relPath: string): string {
        return path.join(this.rootPath, path.join('/', relPath));
    }

    public async noticeDestructOfBackend(variant: MediaBackend, clients: string[]): Promise<unknown> {
        // The is highly unlikely to be called. It will only happen when a [MediaInfo] is evicted from [cachedMedia], but its client is still in [clientTracker]. Usually [cachedMedia] should have a size larger than [maxClientNumber].
        return Promise.all(clients.map(async client => {
            const current = await this.clientTracker.get(client);
            assert.strictEqual(current, variant, 'Backend mismatch.');
            this.clientTracker.delete(client); // The backend is already going away. No need to call its [removeClient].
        }));
    }

    private getBackend(clientId: string, type: string, file: string, qualityLevel: string): Promise<MediaBackend> {
        const existing = this.clientTracker.get(clientId);
        this.clientTracker.delete(clientId);
        if (!existing) { // New client.
            if (this.clientTracker.size > this.maxClientNumber) {
                const [victimKey, victimValue] = this.clientTracker.entries().next().value;
                this.clientTracker.delete(victimKey);
                victimValue.removeClient(clientId);
            }
        } else {
            existing.then(backend => {
                if (backend.config.preset.name !== qualityLevel || backend.parent.relPath !== file) {
                    backend.removeClient(clientId);
                }
            });
        }
        const newLookupPromise = this.cachedMedia.get(type + file).then(instance => 
            (qualityLevel === audioPreset.name) ? (instance as AudioInfo).backend : ((instance as VideoInfo).level(qualityLevel))
        );
        this.clientTracker.set(clientId, newLookupPromise);
        return newLookupPromise;
    }

    private async removeClient(clientId: string): Promise<void> {
        if (this.debug) {
            console.log(`Client ${clientId} unregistering...`);
        }
        const existing = this.clientTracker.get(clientId);
        if (!existing) { return; }
        existing.then(backend => backend.removeClient(clientId));
        this.clientTracker.delete(clientId);
    }
    
    private async browseDir(browsePath: string): Promise<FileEntry[]> {
        const diskPath = this.toDiskPath(browsePath);

        const files = await fs.promises.readdir(diskPath, { withFileTypes: true });
        const fileList = files.map(dirent => {
            const fileObj: FileEntry = { name: dirent.name };
            if (dirent.isFile()) {
                const extName = path.extname(dirent.name).toLowerCase();
                if (videoExtensions.includes(extName)) {
                    fileObj.type = 'video';
                } else if (audioExtensions.includes(extName)) {
                    fileObj.type = 'audio';
                }
            } else if (dirent.isDirectory()) {
                fileObj.type = 'directory';
            }
            return fileObj;
        });
        return fileList;
    }

    private async handleThumbnailRequest(file: string, xCount: number, yCount: number, singleWidth: number, onePiece: boolean, request: express.Request, response: express.Response) { // Caller should ensure the counts are integers.
        const fsPath = this.toDiskPath(file);

        assert(xCount >= 1 && xCount <= 8);
        assert(yCount >= 1 && yCount <= 8);
        assert(singleWidth >= 20 && (singleWidth * xCount) < 4800);
        const numOfFrames = xCount * yCount;

        const probeResult = JSON.parse(await (this.exec('ffprobe', [
            '-v', 'error', // Hide debug information
            '-show_entries', 'stream=duration', // Show duration
            '-show_entries', 'format=duration', // Show duration
            '-select_streams', 'v', // Video stream only, we're not interested in audio
            '-of', 'json',
            fsPath
        ], { timeout: ffprobeTimeout })).result());

        const duration = parseFloat(probeResult['streams'][0]['duration']) || parseFloat(probeResult['format']['duration']);
        assert(!isNaN(duration));

        const vf = `fps=1/${(duration / numOfFrames)}`;

        const encoderChild = this.exec('ffmpeg', ['-i', fsPath, '-vf', `${vf},scale=${singleWidth}:-2${onePiece ? `,tile=${xCount}x${yCount}` : ''}'`, '-f', 'image2pipe', ...(onePiece ? ['-vframes', '1'] : ''), '-'], {
            timeout: 60 * 1000
		});

		encoderChild.stdout.pipe(response);
		response.setHeader('Content-Type', 'image/jpeg');
        request.on('close', encoderChild.kill);
    }

    // An album art in a MP3 may be identified as a video stream. We need to exclude that to prevent MP3s being identified as videos.
    private static isId3Image(stream: { disposition?: Record<string, number> }): boolean {
        return !!(stream.disposition?.attached_pic);
    }

    private async handleInitializationRequest(filePath: string): Promise<{ error: string } | { maybeNativelySupported: boolean, type: 'video' | 'audio', bufferLength: number }> {
        try {
            const probeResult = JSON.parse(await (this.exec('ffprobe', [
                '-v', 'error', // Hide debug information
                '-show_format', // Show container information
                '-show_streams', // Show codec information
                '-of', 'json',
                this.toDiskPath(filePath)
            ], { timeout: ffprobeTimeout })).result());
            const format = probeResult['format']['format_name'].split(',')[0];
            const audioStream = probeResult['streams'].find((stream: Record<string, string>) => stream['codec_type'] === 'audio');
            const videoStream = probeResult['streams'].find((stream: Record<string, string>) => stream['codec_type'] === 'video' && !HlsVod.isId3Image(stream));
            const duration = (videoStream ? parseFloat(videoStream['duration']) : 0) || (audioStream ? parseFloat(audioStream['duration']) : 0) || parseFloat(probeResult['format']['duration']);

            const isVideo = !!videoStream && (duration > 0.5);
            if (!isVideo) { assert(!!audioStream, 'Neither video or audio stream is found.'); }
            return {
                type: isVideo ? 'video' : 'audio',
                maybeNativelySupported: 
                    !this.noShortCircuit
                    && ((isVideo ? nativeSupportedFormats.videoContainer : nativeSupportedFormats.audioContainer).includes(format))
                    && (!audioStream || nativeSupportedFormats.audioCodec.includes(audioStream['codec_name'])) 
                    && (!videoStream || nativeSupportedFormats.videoCodec.includes(videoStream['codec_name'])),
                bufferLength: this.videoMinBufferLength
            };
        } catch (e) {
            return {
                error: e.toString()
            };
        }
    }

    private initExpress(): http.Server {
        const defaultCatch = (response: express.Response) => (error: Error) => response.status(500).send(error.stack || error.toString());

        const respond = (response: express.Response, promise: Promise<string | Buffer | Object>): Promise<unknown> => promise.then(result => (((typeof result === 'string') || Buffer.isBuffer(result)) ? response.send(result) : response.json(result))).catch(defaultCatch(response));

        const ensureType = (typeStr: string) => (typeStr === 'video') ? 'V' : (assert.strictEqual(typeStr, 'audio'), 'A');
        
        const app = express();
        app.set('query parser', 'simple');

        const server = http.createServer(app);

        app.use('/', express.static(path.join(__dirname, 'static')));

        app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

        app.get('/media/:file', (request, response) => {
            respond(response, this.handleInitializationRequest(request.params['file']));
        });

        // m3u8 file has to be under the same path as the TS-files, so they can be linked relatively in the m3u8 file
        app.get('/:type.:client/:file/master.m3u8', (request, response) => {
            respond(response, this.cachedMedia.get(ensureType(request.params['type']) + request.params['file']).then(media => media.getMasterManifest()));
		});
		
        app.get('/:type.:client/:file/quality-:quality.m3u8', (request, response) => {
            respond(response, this.getBackend(request.params['client'], ensureType(request.params['type']), request.params['file'], request.params['quality']).then(backend => backend.getVariantManifest()));
		});

        app.get('/:type.:client/:file/:quality.:segment.ts', (request, response) => {
            this.getBackend(request.params['client'], ensureType(request.params['type']), request.params['file'], request.params['quality']).then(media => 
                media.getSegment(request.params['client'], request.params['segment'], request, response)
            ).catch(defaultCatch);
        });
        
        app.delete('/hls.:client/', (request, response) => {
            this.removeClient(request.params['client']);
            response.sendStatus(200);
        });

        app.get('/browse/:file', (request, response) => {
            respond(response, this.browseDir(request.params['file']));
        });

        app.use('/raw/', express.static(this.rootPath));

        app.get('/thumbnail/:file', (request, response) => {
            const x = parseInt(request.query['x'] as string);
            const y = parseInt(request.query['y'] as string);
            const singleWidth = parseInt(request.query['width'] as string);
            const onePiece = !!parseInt(request.query['one'] as string);
            assert(!isNaN(x) && !isNaN(y));
            this.handleThumbnailRequest(request.params['file'], x, y, singleWidth, onePiece, request, response);
        });

        return server;
    }

    async init(): Promise<void> {
        await fsExtra.mkdirs(this.outputPath);

        console.log('Serving ' + this.rootPath);
        console.log('Created directory ' + this.outputPath);

        this.server.listen(this.listenPort);
        console.log('Listening to port', this.listenPort);
    }

    private termination: Promise<unknown> | null = null;

    async cleanup() {
        if (this.termination == null) {
			this.termination = Promise.all([
                Promise.all(Array.from(this.allSubProcesses).map(process => process.kill())),
				util.promisify(this.server.close).call(this.server), // Stop the server.
				fsExtra.remove(this.outputPath) // Remove all cache files.
			]);
		}
		return this.termination;
    }
}

if (require.main === module) {
    const exitWithUsage = (argv: string[]) => {
        console.log(
            'Usage: ' + argv[0] + ' ' + argv[1]
            + ' --root-path PATH'
            + ' [--port PORT]'
            + ' [--cache-path PATH]'
			+ ' [--ffmpeg-binary-dir PATH]'
            + ' [--buffer-length SECONDS]'
            + ' [--max-client-number NUMBER]'
            + ' [--debug]'
            + ' [--no-short-circuit]'
        );
        process.exit();
    }

    const server = new HlsVod(parseArgs(process.argv.slice(2), {
        string: ['port', 'root-path', 'ffmpeg-binary-dir', 'cache-path', 'buffer-length', 'max-client-number'],
        boolean: ['debug', 'no-short-circuit'],
        unknown: () => exitWithUsage(process.argv)
    }));

    server.init();

    process.on('SIGINT', () => server.cleanup());
    process.on('SIGTERM', () => server.cleanup());
}