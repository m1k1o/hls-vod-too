'use strict';

const clientId = Math.random().toString(16).substr(2, 6) + '-' + (Date.now() % (2 ** 24)).toString(16);

window.addEventListener('beforeunload', () => fetch(`/hls.${clientId}`, { method: 'DELETE' }));

let lastFetchedMetadata = null;

const fetchMediaFileMetadata = file => {
    if (lastFetchedMetadata && (lastFetchedMetadata[0] === file)) {
        return lastFetchedMetadata[1];
    }
    lastFetchedMetadata = [file, fetch(`/media/${encodeURIComponent('/' + file)}`).then(res => res.json())];
    return lastFetchedMetadata[1];
};

Tonic.add(class HlsVodToo extends Tonic {
    render() {
        const pathSectors = this.props.path.split('/');
        if (pathSectors.length === 2) {
            const legalPath = decodeURIComponent(pathSectors[1]);
            switch (pathSectors[0]) {
                case 'media':
                    return this.html`<hls-vod-media path="${legalPath}"></hls-vod-media>`;
                case 'directory':
                    return this.html`<hls-vod-browse path="${legalPath}"></hls-vod-browse>`;
            }
        }
        location.hash = '#directory/';
        return '';
    }

    connected() {
        window.addEventListener('hashchange', this.hashChange);
    }

    disconnected() {
        window.removeEventListener('hashchange', this.hashChange);
    }

    constructor() {
        super();
        this.props.path = location.hash.substr(1);
        this.hashChange = () => {
            const path = location.hash.substr(1);
            if (path !== this.props.path) {
                this.reRender(() => ({ path }));
            }
        };
    }
});

Tonic.add(class HlsVodMedia extends Tonic {
    async * render() {
        yield this.html`<div class="alert alert-info">Loading metadata for ${this.props.path}...</div>`;
        const response = await fetchMediaFileMetadata(this.props.path);
        if (response.type === 'video') {
            return this.html`<hls-vod-video path="${this.props.path}" native="${response.maybeNativelySupported}" buffer-length="${response.bufferLength}"></hls-vod-video>`;
        } else if (response.type === 'audio') {
            return this.html`<hls-vod-audio path="${this.props.path}" native="${response.maybeNativelySupported}" buffer-length="${response.bufferLength}"></hls-vod-audio>`;
        }
        return this.html`<div class="alert alert-warning">The file cannot be parsed as a media. You may want to <a href="${'/raw/' + encodeURIComponent(this.props.path)}">download</a> it directly.</div>`;
    }
});

class Pipe2Jpeg {
    constructor() {
        this.buffer = null;
        this.imageStartPos = -1;
        this.parseHead = -1;
    }

    close() {
        if (this.buffer) {
            console.warn('Extra trailing data.');
        }
        this.buffer = null;
    }

    read(input) {
        const outputs = [];

        let buffer;
        if (this.buffer) {
            buffer = new Uint8Array(this.buffer.length + input.length);
            buffer.set(this.buffer);
            buffer.set(input, this.buffer.length);
            this.buffer = null;
        } else {
            buffer = input;
        }

        let finishedAt = 0;
        let index = this.parseHead;
        while ((index = buffer.indexOf(0xff, index + 1)) >= 0) {
            if (index === buffer.length - 1) {
                break;
            }
            const next = buffer[index + 1];
            if (next === 0x00 || next === 0x01 || (next >= 0xD0 && next <= 0xD7)) {
                // Do nothing.
            } else if (next === 0xD8) {
                if (index !== finishedAt) {
                    console.warn('Extra data between JPEGs.');
                }
                if (buffer.length <= index + 4) {
                    break;
                }
                if (this.imageStartPos >= 0) { throw new Error('Image already started.'); }
                this.imageStartPos = index;
                if (buffer[index + 2] !== 0xff) {
                    console.warn('JPEG not started by a block.');
                }
            } else if (next === 0xD9) {
                if (this.imageStartPos < 0) { throw new Error('Image not started.'); }
                outputs.push(buffer.subarray(this.imageStartPos, index + 2));
                finishedAt = index + 2;
                this.imageStartPos = -1;
            } else {
                if (buffer.length <= index + 4) {
                    break;
                }
                const targetIndex = index + (buffer[index + 2] * 256 + buffer[index + 3]) + 2;
                if (targetIndex >= buffer.length) {
                    break;
                } else {
                    index = targetIndex;
                }
            }
        }

        if (index < 0) { // Finished reading `buffer`.
            index = buffer.length;
        } // Else coming from "break".

        if (buffer.length > finishedAt) {
            this.buffer = buffer.subarray(finishedAt);
            this.imageStartPos -= finishedAt;
            this.parseHead = index - finishedAt - 1;
        } else {
            // this.imageStartPos should already be -1.
            // this.buffer should already be null.
            this.parseHead = -1;
        }
        return outputs.map(arr => new Blob([arr], { type: 'image/jpeg' }));
    }
}

const HlsVodThumbnailImpl_thumbnailPresets = [[2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [4, 6]];

const HlsVodThumbnail_loadingPlaceholder = URL.createObjectURL(new Blob([ // [ldio] generated by https://loading.io/
    `<?xml version="1.0" encoding="utf-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="margin: auto; background: rgb(241, 242, 243); display: block; shape-rendering: auto;" width="240px" height="240px" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid">
        <path fill="none" stroke="#93dbe9" stroke-width="10" stroke-dasharray="128.29446411132812 128.29446411132812" d="M24.3 30C11.4 30 5 43.3 5 50s6.4 20 19.3 20c19.3 0 32.1-40 51.4-40 C88.6 30 95 43.3 95 50s-6.4 20-19.3 20C56.4 70 43.6 30 24.3 30z" stroke-linecap="round" style="transform:scale(0.2);transform-origin:50px 50px">
            <animate attributeName="stroke-dashoffset" repeatCount="indefinite" dur="2s" keyTimes="0;1" values="0;256.58892822265625"></animate>
        </path>
    </svg>`
], { 'type': 'image/svg+xml' }));

Tonic.add(class HlsVodThumbnailImpl extends Tonic {
    renderTable(x, y) {
        const tds = new Array(y);
        for (let i = 0; i < y; i++) {
            tds[i] = new Array(x);
            for (let j = 0; j < x; j++) {
                tds[i][j] = this.props.urls[i * x + j] || HlsVodThumbnail_loadingPlaceholder;
            }
        }
        return tds.map(tr => this.html`<tr>${tr.map(td => this.html`<td><img src="${td}" /></td>`)}</tr>`);
    }

    renderSingle(className) {
        return this.html`<tr><td><img class="${className}" src="${this.props.urls[0]}" /></td></tr>`;
    }

    updated() {
        const image = this.querySelector('img.blink');
        if (!image) { return; }
        let i = 0;
        this.interval = setInterval(() => {
            i++;
            if (i >= this.props.urls.length) { i = 0; }
            image.src = this.props.urls[i];
        }, 1000);
    }

    disconnected() {
        if (this.interval) { clearInterval(this.interval); }
    }

    render() {
        if (this.interval) { clearInterval(this.interval); }
        const isFallback = !!this.props.one;
        const x = this.props.x;
        const y = this.props.y;
        const disabled = isFallback || (x * y > this.props.urls.length);
        const useBlink = !!this.props.blink && !disabled;
        return this.html`
            <table class="table table-bordered mt-4">
                <tbody>
                    ${isFallback ? this.renderSingle('fallback') : (useBlink ? this.renderSingle('blink') : this.renderTable(x, y))}
                    <tr><td colspan="${(isFallback || useBlink) ? '1' : String(this.props.x)}">
                        Num. of images: <div class="btn-group btn-group-toggle">
                            ${HlsVodThumbnailImpl_thumbnailPresets.map((level, index) => {
                                const checked = (level[0] === x) && (level[1] === y);
                                return this.html`
                                    <label class="${'btn btn-secondary' + (checked ? ' active' : '')}">
                                        <input type="radio" name="numbers" ...${{
                                            checked
                                        }} value="${String(index)}" />${String(level[0] * level[1])}
                                    </label>
                                `;
                            })}
                        </div>
                        <div class="btn-group btn-group-toggle ml-2">
                            <label class="${'btn btn-secondary' + (!useBlink ? ' active' : '')}">
                                <input type="radio" name="mode" ...${{
                                    checked: !useBlink
                                }} value="grid" />Grid
                            </label>
                            <label class="${'btn btn-secondary' + (useBlink ? ' active' : '') + (disabled ? ' disabled' : '')}">
                                <input type="radio" name="mode" ...${{
                                    checked: useBlink,
                                    disabled
                                }} value="blink" />Blink
                            </label>
                            <label class="${'btn btn-secondary' + (isFallback ? ' active' : '')}">
                                <input type="radio" name="mode" ...${{
                                    checked: isFallback
                                }} value="fallback" />Fallback
                            </label>
                        </div>
                        <button class="btn btn-primary ml-2" data-action="close">Close</button>
                    </td></tr>
                </tbody>
            </table>
        `;
    }

    input(e) {
        if (e.target.name === 'numbers') {
            const config = HlsVodThumbnailImpl_thumbnailPresets[parseInt(e.target.value)];
            this.parentNode.reRender(props => ({ ...props, x: config[0], y: config[1] }));
        } else if (e.target.name === 'mode') {
            const one = e.target.value === 'fallback';
            if (one !== (!!this.props.one)) {
                this.parentNode.reRender(props => ({ ...props, one }));
            } else {
                this.reRender(props => ({ ...props, blink: e.target.value === 'blink' }));
            }
        }
    }

    click(e) {
        const actionTarget = Tonic.match(e.target, '[data-action]');
        if (!actionTarget) { return; }
        e.preventDefault();
        if (actionTarget.dataset.action === 'close') {
            this.parentNode.parentNode.removeChild(this.parentNode);
        }
    }
});

Tonic.add(class HlsVodThumbnail extends Tonic {
    disconnected() {
        if (this.urls) {
            this.urls.forEach(url => URL.revokeObjectURL(url));
            this.urls = null;
        }
    }

    async * render() {
        if (this.urls) {
            this.urls.forEach(url => URL.revokeObjectURL(url));
            delete this.urls;
        }

        const path = this.parentNode.dataset.path;
        const x = this.props.x || 2;
        const y = this.props.y || 2;
        const width = 1280 / x;

        let template = this.html`<div class="alert alert-info mt-4">Loading thumbnails...</div>`;
        yield template;

        const one = this.props.one;

        const params = new URLSearchParams();
        params.append('x', x);
        params.append('y', y);
        params.append('width', width);
        params.append('one', one ? 1 : 0);
        const httpUrl = `/thumbnail/${encodeURIComponent(path)}?${params.toString()}`;

        if (!one) {
            const response = await fetch(httpUrl);
            const reader = response.body.getReader();

            this.urls = [];
            this.init(reader);
        }
        return this.html`<hls-vod-thumbnail-impl urls="${one ? [httpUrl] : this.urls}" x="${x}" y="${y}" one="${one}"></hls-vod-thumbnail-impl>`;
    }

    async init(reader) {
        const urls = this.urls;
        const splitter = new Pipe2Jpeg();
        while (true) {
            const result = await reader.read();
            if (urls !== this.urls) {
                reader.cancel();
                return;
            }
            if (result.done) {
                splitter.close();
                break;
            }

            const value = result.value;
            if (!value instanceof Uint8Array) {
                throw new TypeError('Response body of unexpected stream type.');
            }

            let updated = false;
            for (const blob of splitter.read(value)) {
                const src = URL.createObjectURL(blob);
                urls.push(src);
                updated = true;
            }

            if (updated) {
                this.querySelector('hls-vod-thumbnail-impl').reRender(props => ({ ...props, urls }));
            }
        }
    }
});

Tonic.add(class HlsVodMediaPre extends Tonic {
    render() {
        return this.html`<hls-vod-media path="${this.parentNode.dataset.path}"></hls-vod-media>`;
    }
});

const HlsVodBrowse_icons = {
    'directory': 'folder',
    'video': 'movie',
    'audio': 'audiotrack',
    'file': 'insert_drive_file'
};

Tonic.add(class HlsVodBrowse extends Tonic {
    async * render() {
        yield this.html`<div class="alert alert-info">Loading directory ${this.props.path}...</div>`;
        let list;
        try {
            list = await (await fetch(`/browse/${encodeURIComponent('/' + this.props.path)}`)).json();
        } catch (e) {
            return this.html`<div class="alert alert-danger">Failed to load directory content: ${e}</div>`;
        }
        const sections = this.props.path.split('/');
        const pathPrefix = this.props.path ? (this.props.path + '/') : '';
        return this.html`
            <nav>
                <ol class="breadcrumb">
                    <li class="${'breadcrumb-item' + (this.props.path.length ? '' : ' active')}"><a href="#directory/">Home</a></li>
                    ${sections.map((section, index) =>
                        this.html`<li class="${'breadcrumb-item' + ((index === sections.length - 1) ? ' active' : '')}"><a href="${'#directory/' + encodeURIComponent(sections.slice(0, index + 1).join('/'))}">${section}</a></li>`
                    )}
                </ol>
            </nav>
            <main>
                <ul class="list-group">
                    ${list.map(file =>
                        this.html`<li class="list-group-item" data-path="${pathPrefix + file.name}">
                            <div class="d-flex justify-content-between align-items-center">
                                <a href="${`${file.type ? ((file.type === 'directory') ? '#directory' : '#media') : 'raw'}/${encodeURIComponent(pathPrefix + file.name)}`}">
                                    <span class="material-icons">${HlsVodBrowse_icons[file.type || 'file']}</span>
                                    ${file.name}
                                </a>
                                <span>
                                    ${(file.type && (file.type !== 'directory')) ? this.html`<span class="badge badge-secondary" data-action="hls-vod-media-pre">Play</span>`: ''}
                                    ${(file.type === 'video') ? this.html`<span class="badge badge-secondary ml-1" data-action="hls-vod-thumbnail">Preview</span>`: ''}
                                </span>
                            </div>
                        </li>`)}
                </ul>
            </main>
        `;
    }

    clearExpandables() {
        const existingThumbnail = this.querySelector('hls-vod-thumbnail');
        if (existingThumbnail) {
            existingThumbnail.parentNode.removeChild(existingThumbnail);
        }

        const existingPre = this.querySelector('hls-vod-media-pre');
        if (existingPre) {
            existingPre.parentNode.removeChild(existingPre);
        }
    }

    click(e) {
        const actionTarget = Tonic.match(e.target, '[data-action]');
        if (actionTarget) {
            e.preventDefault();
            this.clearExpandables();
            actionTarget.parentNode.parentNode.parentNode.appendChild(document.createElement(actionTarget.dataset.action));
        }
    }
});

class HlsVodMediaBase extends Tonic {
    connected() { this.maybeReinit(); }

    updated() { this.maybeReinit(); }

    disconnected() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    render() {
        const tagType = this.isVideo ? 'video' : 'audio';
        if (this.props.native) {
            return this.html`
                <div class="alert alert-info">
                    This browser is directly playing the ${tagType} file. <a href="#" data-action="switch-to-hls">Switch to HLS</a> if the ${tagType} cannot be played.
                    <button type="button" class="close" data-action="dismiss">
                        <span>&times;</span>
                    </button>
                </div>
                <${tagType} controls src="${'/raw/' + encodeURIComponent(this.props.path)}"></${tagType}>
            `;
        } else {
            return this.html`
                <div class="${tagType}-wrap">
                    <${tagType} class="hls" controls></${tagType}>
                </div>
                ${(this.isVideo ? this.html`<hls-vod-ctrl></hls-vod-ctrl>` : '')}
            `;
        }
    }

    click(e) {
        const actionTarget = Tonic.match(e.target, '[data-action]');
        if (!actionTarget) { return; }
        e.preventDefault();
        if (actionTarget.dataset.action === 'switch-to-hls') {
            this.reRender(props => ({ ...props, native: false }));
        } else if (actionTarget.dataset.action === 'dismiss') {
            actionTarget.parentNode.parentNode.removeChild(actionTarget.parentNode);
        }
    }

    maybeReinit() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        const tagType = this.isVideo ? 'video' : 'audio';
        const element = this.querySelector(tagType + '.hls');
        if (!element) { return; }
        const hls = new Hls({
            maxLength: 10,
            maxMaxBufferLength: this.props.bufferLength
        });
        hls.loadSource(`/${tagType}.${clientId}/${encodeURIComponent(this.props.path)}/master.m3u8`);
        hls.attachMedia(element);

        const ctrl = this.isVideo ? this.querySelector('hls-vod-ctrl') : null;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            element.play();
            if (ctrl) {
                ctrl.reRender(props => ({
                    ...props,
                    levels: hls.levels.map(level => level.name),
                    levelAuto: hls.autoLevelEnabled,
                    level: hls.startLevel
                }));
            }
        });
        if (ctrl) {
            hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
                ctrl.reRender(props => ({
                    ...props,
                    levelAuto: hls.autoLevelEnabled,
                    level: data.level,
                    pending: false
                }));
            });
        }

        hls.on(Hls.Events.ERROR, (_, data) => console.error(data));
        this.hls = hls;
    }
}

Tonic.add(class HlsVodAudio extends HlsVodMediaBase {
    constructor() {
        super();
        this.isVideo = false;
    }
});

Tonic.add(class HlsVodVideo extends HlsVodMediaBase {
    constructor() {
        super();
        this.isVideo = true;
    }

    maybeReinit() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        const element = this.querySelector('video.hls');
        const ctrl = this.querySelector('hls-vod-ctrl');
        if (!element) { return; }
        const hls = new Hls({
            maxLength: 10,
            maxMaxBufferLength: this.props.bufferLength
        });
        hls.loadSource(`/video.${clientId}/${encodeURIComponent(this.props.path)}/master.m3u8`);
        hls.attachMedia(element);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            element.play();
            ctrl.reRender(props => ({
                ...props,
                levels: hls.levels.map(level => level.name),
                levelAuto: hls.autoLevelEnabled,
                level: hls.startLevel
            }));
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
            ctrl.reRender(props => ({
                ...props,
                levelAuto: hls.autoLevelEnabled,
                level: data.level,
                pending: false
            }));
        });
        hls.on(Hls.Events.ERROR, (_, data) => console.error(data));
        this.hls = hls;
    }
});

Tonic.add(class HlsVodCtrl extends Tonic {
    render() {
        const levels = this.props.levels || [];
        const activeLevel = this.props.level; // might be undefined which is okay.
        const disabled = !!this.props.pending;
        const auto = !!this.props.levelAuto;
        return this.html`
            <form class="text-center">
                <div class="btn-group btn-group-toggle">
                    ${levels.map((level, index) => {
                        const checked = (activeLevel === index) && !auto;
                        return this.html`
                            <label class="${'btn btn-secondary' + (checked ? ' active' : '') + (disabled ? ' disabled' : '')}">
                                <input type="radio" name="quality" ...${{
                                    disabled,
                                    checked
                                }} value="${String(index)}" />${level}
                            </label>
                        `;
                    })}
                    <label class="${'btn btn-secondary' + (auto ? ' active' : '') + (disabled ? ' disabled' : '')}">
                        <input type="radio" name="quality" ...${{
                            disabled,
                            checked: auto
                        }} value="-1" />Auto ${auto ? ' (' + levels[activeLevel] + ')' : ''}
                    </label>
                </div>
            </form>
        `;
    }

    input(e) {
        if (e.target.name !== 'quality') { return; }
        const level = parseInt(e.target.value);
        this.reRender((props) => ({ ...props, pending: true }));
        this.parentNode.hls.nextLevel = level;
    }
});