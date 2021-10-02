#!/usr/bin/env ts-node-script

import { HlsVod } from './src/HlsVod';

import parseArgs = require('minimist');

if (typeof require('fs').Dirent !== 'function') {
    throw new Error(`The Node.js version is too old for ${__filename} to run.`);
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

    const args = parseArgs(process.argv.slice(2), {
        string: ['port', 'root-path', 'ffmpeg-binary-dir', 'cache-path', 'buffer-length', 'max-client-number'],
        boolean: ['debug', 'no-short-circuit'],
        unknown: () => exitWithUsage(process.argv)
    });

    const server = new HlsVod(args);
    server.init();

    process.on('SIGINT', () => server.cleanup());
    process.on('SIGTERM', () => server.cleanup());
}
