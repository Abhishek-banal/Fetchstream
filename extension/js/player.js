const params = new URLSearchParams(window.location.search);
const url = params.get('url');
const video = document.getElementById('video');
const errorEl = document.getElementById('error');

if (!url || !isSafeHttpUrl(url)) {
    errorEl.innerText = url ? "Invalid or blocked URL." : "No URL provided";
    errorEl.style.display = 'block';
} else {
    document.title = "Playing: " + url.split('/').pop();
    const isAudioOnly = params.get('audioOnly') === 'true';
    if (isAudioOnly) {
        video.style.height = '60px';
        video.style.background = '#111';
        document.body.style.display = 'flex';
        document.body.style.alignItems = 'center';
    }
    
    if (url.includes('.m3u8')) {
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({ maxMaxBufferLength: 60 });
            
            const variantUrl = params.get('variant');
            const safeVariant = variantUrl && isSafeHttpUrl(variantUrl) ? variantUrl : null;

            if (safeVariant) {
                hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
                    if (data.levels) {
                        const targetUrlStr = safeVariant.split('?')[0];
                        const matchIdx = data.levels.findIndex(l => {
                            const levelUrl = (Array.isArray(l.url) ? l.url[0] : l.url) || "";
                            return levelUrl === safeVariant || levelUrl.split('?')[0] === targetUrlStr;
                        });
                        if (matchIdx !== -1) {
                            hls.currentLevel = matchIdx;
                            hls.loadLevel = matchIdx;
                        }
                    }
                });
            }

            if (isAudioOnly && safeVariant) {
                hls.loadSource(safeVariant);
            } else {
                hls.loadSource(url);
            }
            hls.attachMedia(video);
            hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            hls.recoverMediaError();
                            break;
                        default:
                            hls.destroy();
                            break;
                    }
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
        } else {
            errorEl.innerText = "HLS is not supported in this browser.";
            errorEl.style.display = 'block';
        }
    } else {
        video.src = url;
    }
}
