import { LruCacheMapForAsync } from './Utils';
import { Context, ffprobeTimeout } from './Context';

import { MediaInfo } from './MediaInfo';
import { VideoInfo } from './VideoInfo';
import { AudioInfo } from './AudioInfo';
import { MediaBackend } from './MediaBackend';

import fs = require('fs');
import util = require('util');
import http = require('http');
import path = require('path');
import assert = require('assert');
import express = require('express');
import fsExtra = require('fs-extra');

const videoExtensions = ['.mp4', '.3gp2', '.3gp', '.3gpp', '.3gp2', '.amv', '.asf', '.avs', '.dat', '.dv', '.dvr-ms', '.f4v', '.m1v', '.m2p', '.m2ts', '.m2v', '.m4v', '.mkv', '.mod', '.mp4', '.mpe', '.mpeg1', '.mpeg2', '.divx', '.mpeg4', '.mpv', '.mts', '.mxf', '.nsv', '.ogg', '.ogm', '.mov', '.qt', '.rv', '.tod', '.trp', '.tp', '.vob', '.vro', '.wmv', '.web,', '.rmvb', '.rm', '.ogv', '.mpg', '.avi', '.mkv', '.wmv', '.asf', '.m4v', '.flv', '.mpg', '.mpeg', '.mov', '.vob', '.ts', '.webm'];
const audioExtensions = ['.mp3', '.aac', '.m4a', '.wma', '.ape', '.flac', '.ra', '.wav'];

// Those formats can be supported by the browser natively: transcoding may not be needed for them.
// As listed in https://www.chromium.org/audio-video, and translated into ffmpeg codecs/formats identifiers.
// Change accordingly if you are mainly targeting an old or strange browser (i.e. if you are targeting Apple platforms, you want want to only keep the first entry in each list).
const nativeSupportedFormats = {
    videoCodec: ['h264','vp8', 'vp9',' theora'],
    audioCodec: ['aac', 'mp3', 'vorbis', 'opus', 'pcm_u8', 'pcm_s16le', 'pcm_f32le', 'flac'],
    videoContainer: ['mov', 'mp4', 'webm', 'ogg'],
    audioContainer: ['mp3', 'flac', 'ogg']
};

type FileEntry = {
    type?: 'video' | 'audio' | 'directory';
    name: string;
};

/**
 * Main entry point for a program instance. You can run multiple instances as long as they use different ports and output paths.
 *
 * Returns an async function to clean up.
 */
export class HlsVod {
    readonly context: Context
    readonly server: http.Server;

    private readonly cachedMedia = new LruCacheMapForAsync<string, MediaInfo>(
        Math.max(20),
        async (key) => {
            const type = key.charAt(0);
            const path = key.substr(1);

            let instance;
            if (type === 'V') {
                instance = await VideoInfo.getInstance(this.context, path);
            } else if (type === 'A') {
                instance = await AudioInfo.getInstance(this.context, path);
            } else {
                throw new RangeError('Bad media type.');
            }

            return instance;
        },
        info => info.destruct()
    );

    private readonly clientTracker: Map<string, Promise<MediaBackend>> = new Map();

    constructor(params: { [s: string]: any; }) {
        this.context = new Context(params)
        this.server = this.initExpress();
    }

    // TODO: Refactor.
    //public async noticeDestructOfBackend(variant: MediaBackend, clients: string[]): Promise<unknown> {
    //    // The is highly unlikely to be called. It will only happen when a [MediaInfo] is evicted from [cachedMedia], but its client is still in [clientTracker]. Usually [cachedMedia] should have a size larger than [maxClientNumber].
    //    return Promise.all(clients.map(async client => {
    //        const current = await this.clientTracker.get(client);
    //        assert.strictEqual(current, variant, 'Backend mismatch.');
    //        this.clientTracker.delete(client); // The backend is already going away. No need to call its [removeClient].
    //    }));
    //}

    private getBackend(clientId: string, type: string, file: string, qualityLevel: string): Promise<MediaBackend> {
        const existing = this.clientTracker.get(clientId);
        this.clientTracker.delete(clientId);

        if (!existing) { // New client.
            if (this.clientTracker.size > this.context.maxClientNumber) {
                const [victimKey, victimValue] = this.clientTracker.entries().next().value;
                this.clientTracker.delete(victimKey);
                victimValue.removeClient(clientId);
            }
        } else {
            existing.then(backend => {
                if (backend.config.preset.name !== qualityLevel || backend.relPath !== file) {
                    backend.removeClient(clientId);
                }
            });
        }

        const newLookupPromise = this.cachedMedia.get(type + file).then(mediaInfo => mediaInfo.getBackendByQualityLevel(qualityLevel))
        this.clientTracker.set(clientId, newLookupPromise);
        return newLookupPromise;
    }

    private async removeClient(clientId: string): Promise<void> {
        if (this.context.debug) {
            console.log(`Client ${clientId} unregistering...`);
        }

        const backend = await this.clientTracker.get(clientId);
        if (!backend) {
            return;
        }

        backend.removeClient(clientId);
        this.clientTracker.delete(clientId);
    }

    private async browseDir(browsePath: string): Promise<FileEntry[]> {
        const diskPath = this.context.toDiskPath(browsePath);

        const files = await fs.promises.readdir(diskPath, { withFileTypes: true });
        const fileList = files.map((dirent: any) => {
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
        const fsPath = this.context.toDiskPath(file);

        assert(xCount >= 1 && xCount <= 8);
        assert(yCount >= 1 && yCount <= 8);
        assert(singleWidth >= 20 && (singleWidth * xCount) < 4800);
        const numOfFrames = xCount * yCount;

        const probeResult = JSON.parse(await (this.context.exec('ffprobe', [
            '-v', 'error', // Hide debug information
            '-show_entries', 'stream=duration', // Show duration
            '-show_entries', 'format=duration', // Show duration
            '-select_streams', 'v', // Video stream only, we're not interested in audio
            '-of', 'json',
            fsPath
        ], { timeout: ffprobeTimeout })).result());

        const duration = parseFloat(probeResult['streams'][0]['duration']) || parseFloat(probeResult['format']['duration']);
        assert(!isNaN(duration));

        const encoderChild = this.context.exec('ffmpeg', [
            '-loglevel', 'warning',
            '-i', fsPath,
            '-vf', `fps=1/${(duration / numOfFrames)},scale=${singleWidth}:-2${onePiece ? `,tile=${xCount}x${yCount}` : ''}'`,
            '-f', 'image2pipe',
            ...(onePiece ? ['-vframes', '1'] : ''),
            '-'
        ], { timeout: 60 * 1000 });

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
            const probeResult = JSON.parse(await (this.context.exec('ffprobe', [
                '-v', 'error', // Hide debug information
                '-show_format', // Show container information
                '-show_streams', // Show codec information
                '-of', 'json',
                this.context.toDiskPath(filePath)
            ], { timeout: ffprobeTimeout })).result());

            const format = probeResult['format']['format_name'].split(',')[0];
            const audioStream = probeResult['streams'].find((stream: Record<string, string>) => stream['codec_type'] === 'audio');
            const videoStream = probeResult['streams'].find((stream: Record<string, string>) => stream['codec_type'] === 'video' && !HlsVod.isId3Image(stream));
            const duration = (videoStream ? parseFloat(videoStream['duration']) : 0) || (audioStream ? parseFloat(audioStream['duration']) : 0) || parseFloat(probeResult['format']['duration']);

            const isVideo = !!videoStream && (duration > 0.5);
            if (!isVideo) {
                assert(!!audioStream, 'Neither video or audio stream is found.');
            }

            return {
                type: isVideo ? 'video' : 'audio',
                maybeNativelySupported:
                    !this.context.noShortCircuit
                    && ((isVideo ? nativeSupportedFormats.videoContainer : nativeSupportedFormats.audioContainer).includes(format))
                    && (!audioStream || nativeSupportedFormats.audioCodec.includes(audioStream['codec_name']))
                    && (!videoStream || nativeSupportedFormats.videoCodec.includes(videoStream['codec_name'])),
                bufferLength: this.context.videoMinBufferLength
            };
        } catch (e: any) {
            return {
                error: e.toString()
            };
        }
    }

    private initExpress(): http.Server {
        const defaultCatch = (response: express.Response) => (error: Error) => response.status(500).send(error.stack || error.toString());

        const respond = (response: express.Response, promise: Promise<string | Buffer | Object>): Promise<unknown> =>
            promise.then(result => (((typeof result === 'string') || Buffer.isBuffer(result)) ? response.send(result) : response.json(result))).catch(defaultCatch(response));

        const ensureType = (typeStr: string) => (typeStr === 'video') ? 'V' : (assert.strictEqual(typeStr, 'audio'), 'A');

        const app = express();
        app.set('query parser', 'simple');

        const server = http.createServer(app);

        // TODO: Fix Dirname...
        app.use('/', express.static(path.join(__dirname, '../static')));

        // TODO: Fix Dirname...
        app.use('/node_modules', express.static(path.join(__dirname, '../node_modules')));

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

        app.get('/:type.:client/:file/:quality.:segment.ts', async (request, response) => {
            try {
                const media = await this.getBackend(request.params['client'], ensureType(request.params['type']), request.params['file'], request.params['quality'])
                await media.getSegment(request.params['client'], request.params['segment'], request, response)
            } catch (error: any) {
                response.status(500).send(error.stack || error.toString());
            }
        });

        app.delete('/hls.:client/', (request, response) => {
            this.removeClient(request.params['client']);
            response.sendStatus(200);
        });

        app.get('/browse/:file', (request, response) => {
            respond(response, this.browseDir(request.params['file']));
        });

        app.use('/raw/', express.static(this.context.rootPath));

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
        await fsExtra.mkdirs(this.context.outputPath);

        console.log('Serving ' + this.context.rootPath);
        console.log('Created directory ' + this.context.outputPath);

        this.server.listen(this.context.listenPort);
        console.log('Listening to port', this.context.listenPort);
    }

    private termination: Promise<unknown> | null = null;

    async cleanup() {
        this.context.cleanup()

        if (this.termination == null) {
            this.termination = Promise.all([
                util.promisify(this.server.close).call(this.server), // Stop the server.
                fsExtra.remove(this.context.outputPath) // Remove all cache files.
            ]);
        }

        return this.termination;
    }
}
