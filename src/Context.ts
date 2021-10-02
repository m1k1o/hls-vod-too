import { SubProcessInvocation } from './Utils';

import os = require('os');
import path = require('path');

export const ffprobeTimeout = 30 * 1000; // millisecs.
export const processCleanupTimeout = 6 * 60 * 60 * 1000; // millisecs.

/**
 * Main entry point for a program instance. You can run multiple instances as long as they use different ports and output paths.
 *
 * Returns an async function to clean up.
 */
export class Context {
    readonly listenPort: number;
    readonly rootPath: string;
    readonly ffmpegBinaryDir: string;
    readonly outputPath: string;
    readonly debug: boolean;
    readonly noShortCircuit: boolean;
    readonly videoMinBufferLength: number;
    readonly videoMaxBufferLength: number;
    readonly maxClientNumber: number;

    readonly allSubProcesses: Set<SubProcessInvocation> = new Set();

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
        this.allSubProcesses.add(handle);

        const started = Date.now();
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

    private termination: Promise<any> | null = null;

    public async cleanup() {
        if (this.termination == null) {
            this.termination = Promise.all([
                Promise.all(Array.from(this.allSubProcesses).map(process => process.kill())),
            ]);
        }

        return this.termination;
    }
}
