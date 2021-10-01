import childProcess = require('child_process');

export class SubProcessInvocation {
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
export const asyncDebounce = <T> (method: () => Promise<T>): (() => Promise<T>) => {
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

/**
 * LRU cache map that handles async constructing/destructing:
 * - If constructing/destructing is already in progress, not firing once again.
 * - Ensures a previous cached value of the same key is properly destructed before constructing it again (to prevent external race conditions).
 */
 export class LruCacheMapForAsync<K, V, D = unknown> {
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
