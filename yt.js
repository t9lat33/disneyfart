// yt.js - client for the self-hosted t9-ytdlp backend (yt-dlp powered)
// Backend: server.js running via PM2 as "t9-ytdlp", proxied by nginx at /ytapi/
// No more public Invidious instances, no more YouTube HTML scraping,
// no more client-side InnerTube calls — all of that gets blocked/dies constantly.

const yt = {
    apiBase: '/ytapi',

    async search(query, maxResults = 20) {
        try {
            const res = await fetch(
                `${this.apiBase}/search?q=${encodeURIComponent(query)}&limit=${maxResults}`
            );
            if (!res.ok) throw new Error('search failed: ' + res.status);
            const data = await res.json();

            return (data.items || []).map(item => ({
                id: item.videoId,
                title: item.title,
                thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
                duration: this.formatDuration(item.lengthSeconds),
                views: this.formatViews(item.viewCount),
                channel: item.author,
                published: item.publishedText,
                description: item.description || ''
            }));
        } catch (error) {
            console.error('yt.search failed:', error);
            return [];
        }
    },

    // Resolves a video's metadata + direct playable stream URL(s) via yt-dlp on the backend
    async getVideoUrls(videoId) {
        try {
            const res = await fetch(`${this.apiBase}/stream/${encodeURIComponent(videoId)}`);
            if (!res.ok) throw new Error('stream request failed: ' + res.status);
            const data = await res.json();

            const formats = (data.formatStreams || []).map(f => ({
                quality: f.quality || (f.height ? `${f.height}p` : 'unknown'),
                mimeType: f.type || 'video/mp4',
                url: f.url,
                width: f.width,
                height: f.height
            }));

            const best = formats[0] || null;

            return {
                id: data.videoId,
                title: data.title || '',
                duration: data.lengthSeconds || 0,
                thumbnail: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                description: data.description || '',
                channel: data.author || '',
                viewCount: data.viewCount || 0,
                relatedVideoIds: data.relatedVideoIds || [],
                formats,
                directUrls: {
                    best: best ? best.url : null
                }
            };
        } catch (error) {
            console.error('yt.getVideoUrls failed:', error);
            return null;
        }
    },

    async getVideoDetails(videoId) {
        // Same backend call as getVideoUrls gives us everything we need
        const details = await this.getVideoUrls(videoId);
        if (!details) return null;
        return {
            id: details.id,
            title: details.title,
            thumbnail: details.thumbnail,
            duration: this.formatDuration(details.duration),
            views: this.formatViews(details.viewCount),
            channel: details.channel,
            description: details.description,
            published: ''
        };
    },

    // Create an HTML5 video player backed by the resolved direct URL
    createPlayer(container, videoId) {
        const playerDiv = document.createElement('div');
        playerDiv.innerHTML = `
            <div class="yt-player" style="position:relative;width:100%;max-width:720px;background:#000;border-radius:8px;overflow:hidden;">
                <video id="player-${videoId}"
                       controls
                       style="width:100%;height:auto;"
                       poster="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg"
                       playsinline>
                </video>
                <div class="loading" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;">
                    Loading video...
                </div>
            </div>
        `;

        if (container) {
            container.appendChild(playerDiv);
        }

        this.loadVideo(videoId).then(url => {
            const video = playerDiv.querySelector('video');
            const loadingEl = playerDiv.querySelector('.loading');
            if (video && url) {
                video.src = url;
                video.load();
                if (loadingEl) loadingEl.style.display = 'none';
            } else if (loadingEl) {
                loadingEl.textContent = 'Failed to load video.';
            }
        });

        return playerDiv;
    },

    async loadVideo(videoId) {
        const details = await this.getVideoUrls(videoId);
        return details?.directUrls?.best || null;
    },

    formatDuration(seconds) {
        if (!seconds) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    },

    formatViews(views) {
        if (!views) return '0 views';
        if (views >= 1000000) {
            return (views / 1000000).toFixed(1) + 'M views';
        }
        if (views >= 1000) {
            return (views / 1000).toFixed(1) + 'K views';
        }
        return views.toString() + ' views';
    },

    getWatchUrl(videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
    },

    getEmbedUrl(videoId) {
        return `https://www.youtube.com/embed/${videoId}`;
    }
};

// Usage example
async function playVideo(videoId) {
    const playerContainer = document.getElementById('video-container');
    yt.createPlayer(playerContainer, videoId);

    const url = await yt.loadVideo(videoId);
    if (url) {
        console.log('Direct video URL:', url);
    }
}

// Search and display results with playback
async function searchAndPlay(query) {
    const results = await yt.search(query);

    if (results.length > 0) {
        console.log('Found videos:', results);
        const firstVideo = results[0];
        playVideo(firstVideo.id);
    }
}