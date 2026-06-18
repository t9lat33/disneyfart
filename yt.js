// yt.js - YouTube scraper with direct video URL extraction
const yt = {
    apis: [
        'https://invidious.snopyta.org/api/v1',
        'https://invidious.kavin.rocks/api/v1',
        'https://invidious.tiekoetter.com/api/v1',
        'https://vid.puffyan.us/api/v1',
        'https://yt.funami.tech/api/v1',
        'https://inv.riverside.rocks/api/v1',
    ],
    
    currentApi: 0,
    
    async search(query, maxResults = 20) {
        for (let i = 0; i < this.apis.length; i++) {
            try {
                const api = this.apis[(this.currentApi + i) % this.apis.length];
                const response = await fetch(
                    `${api}/search?q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}`
                );
                
                if (!response.ok) continue;
                
                const data = await response.json();
                this.currentApi = (this.currentApi + i) % this.apis.length;
                
                return data.map(item => ({
                    id: item.videoId,
                    title: item.title,
                    thumbnail: item.videoThumbnails?.[item.videoThumbnails.length - 1]?.url || 
                              `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
                    duration: this.formatDuration(item.lengthSeconds),
                    views: this.formatViews(item.viewCount),
                    channel: item.author,
                    channelId: item.authorId,
                    published: item.publishedText,
                    description: item.description
                }));
                
            } catch (error) {
                console.warn(`API ${api} failed:`, error);
            }
        }
        
        return await this.scrapeYouTube(query, maxResults);
    },
    
    async scrapeYouTube(query, maxResults = 20) {
        try {
            const response = await fetch(
                `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
                {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            );
            
            const html = await response.text();
            const match = html.match(/var ytInitialData = (.+?);<\/script>/);
            if (!match) return [];
            
            const data = JSON.parse(match[1]);
            const videos = [];
            
            const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
            if (!contents) return [];
            
            for (const section of contents) {
                const items = section?.itemSectionRenderer?.contents;
                if (!items) continue;
                
                for (const item of items) {
                    const video = item?.videoRenderer;
                    if (!video || videos.length >= maxResults) continue;
                    
                    videos.push({
                        id: video.videoId,
                        title: video.title?.runs?.[0]?.text || 'Unknown',
                        thumbnail: video.thumbnail?.thumbnails?.slice(-1)[0]?.url || 
                                  `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
                        duration: video.lengthText?.simpleText || '',
                        views: video.viewCountText?.simpleText || '',
                        channel: video.ownerText?.runs?.[0]?.text || 'Unknown',
                        channelId: video.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
                        published: video.publishedTimeText?.simpleText || '',
                    });
                }
            }
            
            return videos;
            
        } catch (error) {
            console.error('YouTube scraping failed:', error);
            return [];
        }
    },
    
    // Get direct video URLs using yt-dlp method
    async getVideoUrls(videoId) {
        try {
            // Use the youtubei.googleapis.com endpoint
            const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: 'ANDROID_VR',
                            clientVersion: '1.53.0',
                            androidSdkVersion: 31,
                            hl: 'en',
                            gl: 'US',
                            utcOffsetMinutes: 0
                        }
                    },
                    videoId: videoId
                })
            });
            
            const data = await response.json();
            
            if (data.playabilityStatus?.status !== 'OK') {
                throw new Error('Video not playable');
            }
            
            // Extract video formats
            const formats = data.streamingData?.formats || [];
            const adaptiveFormats = data.streamingData?.adaptiveFormats || [];
            const allFormats = [...formats, ...adaptiveFormats];
            
            // Get the best quality URLs
            const videoDetails = {
                id: videoId,
                title: data.videoDetails?.title || '',
                duration: parseInt(data.videoDetails?.lengthSeconds) || 0,
                thumbnail: data.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url ||
                          `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
                formats: allFormats.map(format => ({
                    itag: format.itag,
                    quality: format.qualityLabel || format.quality || 'audio',
                    mimeType: format.mimeType,
                    url: format.url,
                    bitrate: format.bitrate,
                    width: format.width,
                    height: format.height,
                    contentLength: format.contentLength
                })),
                // Extract direct streaming URLs
                directUrls: {
                    best: allFormats.find(f => f.qualityLabel === '720p')?.url ||
                          allFormats.find(f => f.qualityLabel === '360p')?.url ||
                          formats[formats.length - 1]?.url,
                    audio: adaptiveFormats.find(f => f.mimeType?.startsWith('audio/'))?.url,
                    video: adaptiveFormats.find(f => f.mimeType?.startsWith('video/') && !f.mimeType?.includes('audio'))?.url
                }
            };
            
            return videoDetails;
            
        } catch (error) {
            console.error('Failed to get video URLs:', error);
            return null;
        }
    },
    
    // Create HTML5 video player with direct URL
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
        
        // Load video
        this.loadVideo(videoId).then(url => {
            const video = playerDiv.querySelector('video');
            if (video && url) {
                video.src = url;
                video.load();
                playerDiv.querySelector('.loading').style.display = 'none';
            }
        });
        
        return playerDiv;
    },
    
    async loadVideo(videoId) {
        const details = await this.getVideoUrls(videoId);
        if (details?.directUrls) {
            // Prefer combined format, then video+audio
            return details.directUrls.best || details.directUrls.video;
        }
        return null;
    },
    
    // Alternative: Use public proxy services
    getProxyUrl(videoId, quality = '720p') {
        // These are example proxy services - some may be blocked
        const proxies = [
            `https://inv.nadeko.net/latest_version?id=${videoId}&itag=22`,
            `https://invidious.snopyta.org/latest_version?id=${videoId}&itag=22`,
            `https://vid.puffyan.us/latest_version?id=${videoId}&itag=22`,
        ];
        
        // Return proxy URL for direct streaming
        return proxies[0];
    },
    
    async getVideoDetails(videoId) {
        for (let i = 0; i < this.apis.length; i++) {
            try {
                const api = this.apis[(this.currentApi + i) % this.apis.length];
                const response = await fetch(`${api}/videos/${videoId}`);
                
                if (!response.ok) continue;
                
                const data = await response.json();
                this.currentApi = (this.currentApi + i) % this.apis.length;
                
                return {
                    id: data.videoId,
                    title: data.title,
                    thumbnail: data.videoThumbnails?.slice(-1)[0]?.url ||
                              `https://i.ytimg.com/vi/${data.videoId}/maxresdefault.jpg`,
                    duration: this.formatDuration(data.lengthSeconds),
                    views: this.formatViews(data.viewCount),
                    likes: this.formatViews(data.likeCount),
                    channel: data.author,
                    channelId: data.authorId,
                    description: data.description,
                    published: data.publishedText,
                };
                
            } catch (error) {
                console.warn(`Failed to get video details`);
            }
        }
        
        return null;
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
    
    // Method 1: Direct URL playback
    yt.createPlayer(playerContainer, videoId);
    
    // Method 2: Get just the URL and create your own player
    const url = await yt.loadVideo(videoId);
    if (url) {
        console.log('Direct video URL:', url);
        // You can use this URL in your own <video> element
    }
    
    // Method 3: Use Invidious proxy
    const proxyUrl = yt.getProxyUrl(videoId);
    console.log('Proxy URL:', proxyUrl);
}

// Search and display results with playback
async function searchAndPlay(query) {
    const results = await yt.search(query);
    
    if (results.length > 0) {
        console.log('Found videos:', results);
        
        // Auto-play first result
        const firstVideo = results[0];
        playVideo(firstVideo.id);
    }
}