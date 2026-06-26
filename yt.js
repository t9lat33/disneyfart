const state = {
  currentResults: []
};

const els = {
  searchInput: document.querySelector(".video-search"),
  resultsGrid: document.querySelector(".video-grid"),
  playerFrame: document.querySelector(".player-frame"),
  playerContainer: document.querySelector(".player-container")
};

// Fetch search results from your VPS backend
async function fetchQuery(q) {
  const res = await fetch("/api/search?query=" + encodeURIComponent(q));
  const data = await res.json();
  return data.results || [];
}

// Create a video card element
function createCard(video, index) {
  const card = document.createElement("div");
  card.className = "video-card";
  
  const title = video.title || "Untitled";
  
  card.innerHTML = `
    <div class="video-img">
      <img src="${video.thumbnail}" alt="${title}">
    </div>
    <div class="video-info">
      <div class="video-title">${title}</div>
    </div>
  `;
  
  card.onclick = function () {
    openWatch(index);
  };
  
  return card;
}

// Render the grid of videos
function render(list) {
  els.resultsGrid.innerHTML = "";
  state.currentResults = list;
  
  if (list.length === 0) {
    els.resultsGrid.innerHTML = "<p style='color: #aaa; text-align: center;'>No videos found. Try another search.</p>";
    return;
  }
  
  for (let i = 0; i < list.length; i++) {
    els.resultsGrid.appendChild(createCard(list[i], i));
  }
}

// Perform the search
async function performSearch() {
  const q = els.searchInput.value.trim();
  if (!q) return;
  
  els.resultsGrid.innerHTML = '<div class="spinner"></div>';
  
  try {
    const res = await fetchQuery(q);
    render(res);
  } catch (error) {
    els.resultsGrid.innerHTML = "<p style='color: #aaa; text-align: center;'>Error loading videos.</p>";
  }
}

// Open the video player
async function openWatch(index) {
  if (!state.currentResults[index]) return;
  const video = state.currentResults[index];

  // Hide grid, show player
  els.resultsGrid.style.display = "none";
  els.playerContainer.style.display = "block";
  els.playerFrame.src = "about:blank"; // Reset frame

  try {
    // 1. Fetch the direct media URL from your VPS backend
    const fetchRes = await fetch("/api/fetch?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + video.id));
    const fetchData = await fetchRes.json();
    
    const media = fetchData.medias && fetchData.medias[0];
    if (!media || !media.url) {
      alert("Failed to load video stream. YouTube might be blocking the server.");
      closePlayer();
      return;
    }

    // 2. Proxy it through the /api/encode endpoint to bypass CORS
    els.playerFrame.src = "/api/encode?url=" + encodeURIComponent(media.url);

  } catch (e) {
    alert("Error playing video.");
    closePlayer();
  }
}

// Close the video player
function closePlayer() {
  els.playerFrame.src = "about:blank";
  els.playerContainer.style.display = "none";
  els.resultsGrid.style.display = "grid";
}

// Allow pressing "Enter" to search
els.searchInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    performSearch();
  }
});