document.addEventListener('DOMContentLoaded', () => {

  const mainNavContainer = document.getElementById("nav-items");
  const extrasNavContainer = document.getElementById("nav-items-extras");
  const nestNavContainer = document.getElementById("nav-items-nest");
  const whatsNewBtn = document.querySelector(".whatsnew-btn");
  const settingsBtn = document.querySelector(".settings-btn");
  const extrasBtn = document.querySelector(".extras-btn");
  const frame = document.getElementById("frame");

  // credits to gn-math!!!
  const htmlURL = "https://cdn.jsdelivr.net/gh/gn-math/html@main";
  const coverURL = "https://cdn.jsdelivr.net/gh/gn-math/covers@main";

  let activeNestParent = null;
  let lastSelectedNestUrl = null;
  const allPanels = [mainNavContainer, extrasNavContainer, nestNavContainer];

  let allZonesCache = [];
  let allPlaylineGamesCache = [];
  let allGamesSorted = [];
  let playlineCachePromise = null;

  // devs: increment this version number if you update the playline.json at all.
  const PLAYLINE_DB_VERSION = 1.1;

  const PLAYLINE_DB_NAME = 'PlaylineGamesDB';
  const PLAYLINE_STORE_NAME = 'games';
  const PLAYLINE_VERSION_KEY = 'playline_db_version';

  function debounce(func, delay) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), delay);
    };
  }

  allPanels.forEach(panel => {
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'nav-scroll-container';
    const itemList = document.createElement('div');
    itemList.className = 'nav-item-list';
    while (panel.firstChild) { itemList.appendChild(panel.firstChild); }
    scrollContainer.appendChild(itemList);
    panel.appendChild(scrollContainer);
  });

  function handleBottomMask(scrollContainer) {
    const el = scrollContainer;
    const isScrollable = el.scrollHeight > el.clientHeight;
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 5;
    el.classList.toggle('mask-bottom', isScrollable && !isAtBottom);
  }
  document.querySelectorAll('.nav-scroll-container').forEach(sc => {
    sc.addEventListener('scroll', () => handleBottomMask(sc));
    new ResizeObserver(() => handleBottomMask(sc)).observe(sc);
    new MutationObserver(() => handleBottomMask(sc)).observe(sc.parentElement, { attributes: true, attributeFilter: ['class']});
  });

  const MAX_RECENTLY_PLAYED = 45;

  function getFromStorage(key) { try { const i = localStorage.getItem(key); return i ? JSON.parse(i) : []; } catch (e) { console.error(`Failed to parse ${key}`, e); return []; } }
  function saveToStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.error(`Failed to save ${key}`, e); } }
  function toggleFavorite(gameName) { let f = getFromStorage('favoriteGames'); if (f.includes(gameName)) { f = f.filter(n => n !== gameName); } else { f.push(gameName); } saveToStorage('favoriteGames', f); }
  function addRecentlyPlayed(game) { let r = getFromStorage('recentlyPlayed'); r = r.filter(i => i.name !== game.name); r.unshift(game); if (r.length > MAX_RECENTLY_PLAYED) { r = r.slice(0, MAX_RECENTLY_PLAYED); } saveToStorage('recentlyPlayed', r); }

  async function precacheZones() {
    try {
      const response = await fetch('/_a/zones.json');
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const zones = await response.json();
      allZonesCache = zones.map(zone => ({...zone, source: 'zones'}));
      console.log(`successflly precaches ${allZonesCache.length} zones.`);
    } catch (error) {
      console.error("failed to precache zones:", error);
      allZonesCache = null;
    }
  }

  function precachePlaylineGames() {
      if (playlineCachePromise) {
          return playlineCachePromise;
      }

      playlineCachePromise = (async () => {
          const storedVersion = localStorage.getItem(PLAYLINE_VERSION_KEY);
          if (storedVersion && parseInt(storedVersion) === PLAYLINE_DB_VERSION) {
              try {
                  const db = await openPlaylineDB();
                  const games = await db.transaction(PLAYLINE_STORE_NAME).objectStore(PLAYLINE_STORE_NAME).getAll();
                  if (games && games.length > 0) {
                      allPlaylineGamesCache = games;
                      console.log(`done loading ${games.length} playline games from indexeddb`);
                      return;
                  }
              } catch (e) {
                  console.error("failed to load playline games from DB. fetching from network", e);
              }
          }

          console.log("playline cache is old/empty. fetcing from network");
          try {
              const response = await fetch('/_a/playline.json');
              if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
              
              const totalSize = +response.headers.get('Content-Length');
              const reader = response.body.getReader();
              let loaded = 0;
              let chunks = [];
              
              while(true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  chunks.push(value);
                  loaded += value.length;
                  
                  if (totalSize) {
                      const progress = Math.round((loaded / totalSize) * 100);
                      const progressBar = document.getElementById('playline-progress-bar');
                      if (progressBar) {
                          progressBar.style.width = progress + '%';
                      }
                  }
              }
              
              let chunksAll = new Uint8Array(loaded);
              let position = 0;
              for(let chunk of chunks) {
                  chunksAll.set(chunk, position);
                  position += chunk.length;
              }
              
              const resultText = new TextDecoder("utf-8").decode(chunksAll);
              const games = JSON.parse(resultText);

              allPlaylineGamesCache = games.map(game => ({
                name: game.Title.trim(),
                Md5: game.Md5,
                url: `/api/resonance/rvvASMiM/${game.Md5}/?gd_sdk_referrer_url=yjgames.gamedistribution.com`,
                source: 'playline'
            }));            
              console.log(`successflly fetched ${allPlaylineGamesCache.length} playline games. caching`);

              const db = await openPlaylineDB();
              const tx = db.transaction(PLAYLINE_STORE_NAME, 'readwrite');
              const store = tx.objectStore(PLAYLINE_STORE_NAME);
              await store.clear();
              for (const game of allPlaylineGamesCache) {
                  store.add(game);
              }
              await tx.done;
              localStorage.setItem(PLAYLINE_VERSION_KEY, PLAYLINE_DB_VERSION.toString());
              console.log("playline has been loaded.");
          } catch (error) {
              console.error("failed to fetch/cache playline:", error);
              allPlaylineGamesCache = null;
          } finally {
              if (nestNavContainer.classList.contains('active') && activeNestParent && activeNestParent.textContent.includes('Playline')) {
                  showGamePanel('playline');
              }
          }
      })();
      return playlineCachePromise;
  }

  function openPlaylineDB() {
      return new Promise((resolve, reject) => {
          const request = indexedDB.open(PLAYLINE_DB_NAME, PLAYLINE_DB_VERSION);
          request.onupgradeneeded = event => {
              const db = event.target.result;
              if (!db.objectStoreNames.contains(PLAYLINE_STORE_NAME)) {
                  db.createObjectStore(PLAYLINE_STORE_NAME, { keyPath: 'name' });
              }
          };
          request.onsuccess = event => resolve(event.target.result);
          request.onerror = event => reject(event.target.error);
      });
  }

  const VIRTUAL_ITEM_HEIGHT = 40;
  const VIRTUAL_BUFFER = 5;

  function setupVirtualScroll(gameListContainer, sortedGames) {
      const scrollContainer = nestNavContainer.querySelector('.nav-scroll-container');
      gameListContainer.innerHTML = '';
      const sizer = document.createElement('div');
      sizer.className = 'virtual-scroll-sizer';
      sizer.style.height = `${sortedGames.length * VIRTUAL_ITEM_HEIGHT}px`;
      const visibleItemsContainer = document.createElement('div');
      visibleItemsContainer.className = 'virtual-scroll-list';
      sizer.appendChild(visibleItemsContainer);
      gameListContainer.appendChild(sizer);
      let lastRenderedStart = -1;
      function renderVisibleItems() {
          const scrollTop = scrollContainer.scrollTop;
          const viewportHeight = scrollContainer.clientHeight;
          const startIndex = Math.max(0, Math.floor(scrollTop / VIRTUAL_ITEM_HEIGHT) - VIRTUAL_BUFFER);
          const endIndex = Math.min(sortedGames.length, Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ITEM_HEIGHT) + VIRTUAL_BUFFER);
          if (startIndex === lastRenderedStart) return;
          lastRenderedStart = startIndex;
          const fragment = document.createDocumentFragment();
          for (let i = startIndex; i < endIndex; i++) {
              fragment.appendChild(createGameItemElement(sortedGames[i]));
          }
          visibleItemsContainer.innerHTML = '';
          visibleItemsContainer.appendChild(fragment);
          visibleItemsContainer.style.transform = `translateY(${startIndex * VIRTUAL_ITEM_HEIGHT}px)`;
      }
      scrollContainer.onscroll = debounce(renderVisibleItems, 10);
      renderVisibleItems();
  }

  function createGameItemElement(game) {
      const navLink = document.createElement('a');
      navLink.className = 'nav-item';
      navLink.href = '#';
      let isFavorited = false;
      let iconContainerHTML = `<i class="fa-regular fa-gamepad game-icon-default"></i>`;
      if (game.source === 'zones') {
          const favorites = getFromStorage('favoriteGames');
          isFavorited = favorites.includes(game.name);
          if (isFavorited) navLink.classList.add('nav-item-favorited');
          iconContainerHTML += `<i class="game-icon-star ${isFavorited ? 'fa-solid' : 'fa-regular'} fa-star"></i>`;
      }
      navLink.innerHTML = `<div class="icon-container">${iconContainerHTML}</div><span class="nav-text">${game.name}</span>`;
      if (game.source === 'zones') {
          const iconContainer = navLink.querySelector('.icon-container');
          iconContainer.onclick = (e) => {
              e.preventDefault(); e.stopPropagation();
              toggleFavorite(game.name);
              updateAndRenderGames(document.querySelector('.game-search-input').value, 'games');
          };
      }
      navLink.onclick = (e) => {
        e.preventDefault();
        if (game.blank === true) return;
        addRecentlyPlayed(game);
    
        let targetFrameUrl;
    
        if (game.source === 'playline') {
            targetFrameUrl = game.url;
        } else {
            if (game.redirect === true) {
                window.open(game.url.startsWith('http') ? game.url : game.url.replace("{HTML_URL}", htmlURL), '_blank');
                return;
            }
            targetFrameUrl = `/api/resonance/rvvASMiM/${game.Md5}/?gd_sdk_referrer_url=yjgames.gamedistribution.com`;
        }
    
        frame.src = targetFrameUrl;
        lastSelectedNestUrl = targetFrameUrl;
        updateActiveStates(navLink);
    };
    
      return navLink;
  }

  function updateAndRenderGames(query = '', sourceType) {
      const gameListContainer = document.querySelector('.game-list-dynamic-container');
      const noResultsMessage = document.querySelector('.no-results-message');
      if (!gameListContainer) return;
      const lowerCaseQuery = query.toLowerCase();
      const sourceData = sourceType === 'playline' ? allPlaylineGamesCache : allZonesCache;
      let sourceGames = lowerCaseQuery
          ? sourceData.filter(game => game.name.toLowerCase().includes(lowerCaseQuery))
          : [...sourceData];
      if (sourceType === 'games') {
          const favorites = getFromStorage('favoriteGames');
          const recentlyPlayed = getFromStorage('recentlyPlayed');
          const recentNames = recentlyPlayed.map(g => g.name);
          const displayRecent = localStorage.getItem('displayRecentGames') !== 'false';
          const favoritedGames = sourceGames.filter(zone => favorites.includes(zone.name));
          if (displayRecent) {
              const recentGames = sourceGames.filter(zone => recentNames.includes(zone.name) && !favorites.includes(zone.name));
              const regularGames = sourceGames
                  .filter(zone => !favorites.includes(zone.name) && !recentNames.includes(zone.name))
                  .sort((a, b) => a.name.localeCompare(b.name));
              allGamesSorted = [...favoritedGames, ...recentGames, ...regularGames];
          } else {
              const otherGames = sourceGames
                  .filter(zone => !favorites.includes(zone.name))
                  .sort((a, b) => a.name.localeCompare(b.name));
              allGamesSorted = [...favoritedGames, ...otherGames];
          }
      } else {
          allGamesSorted = sourceGames.sort((a, b) => a.name.localeCompare(b.name));
      }
      noResultsMessage.style.display = (allGamesSorted.length === 0 && lowerCaseQuery) ? 'flex' : 'none';
      setupVirtualScroll(gameListContainer, allGamesSorted);
  }

  function showGamePanel(sourceType) {
    const itemList = nestNavContainer.querySelector('.nav-item-list');
    itemList.innerHTML = '';
    nestNavContainer.querySelector('.nav-scroll-container').onscroll = null;
    const backLink = document.createElement("a");
    backLink.className = "nav-item";
    backLink.innerHTML = `<div class="icon-container"><i class="fa-regular fa-chevron-left"></i></div><span class="nav-text">Back</span>`;
    backLink.href = "#";
    backLink.onclick = (e) => { e.preventDefault(); mainNavContainer.classList.remove('nest-active'); nestNavContainer.classList.remove('active'); updateActiveStates(activeNestParent); };
    const searchContainer = document.createElement('div');
    searchContainer.className = 'game-search-container';
    searchContainer.innerHTML = `<i class="fa-regular fa-search game-search-icon"></i><input type="text" placeholder="Filter games..." class="game-search-input">`;
    const searchInput = searchContainer.querySelector('input');
    const noResultsMessage = document.createElement('a');
    noResultsMessage.className = 'nav-item no-results-message';
    noResultsMessage.innerHTML = `<span class="nav-text" style="opacity:1;">No matching games found.</span>`;
    noResultsMessage.style.display = 'none';
    const divider1 = document.createElement('div');
    divider1.className = 'nav-divider';
    const gameListContainer = document.createElement('div');
    gameListContainer.className = 'game-list-dynamic-container';
    itemList.append(backLink, searchContainer, divider1, gameListContainer, noResultsMessage);
    const dataSource = sourceType === 'playline' ? allPlaylineGamesCache : allZonesCache;
    if (dataSource === null) {
      gameListContainer.innerHTML = '<a class="nav-item"><span class="nav-text" style="opacity:1; color: #ff8a8a;">Error loading games.</span></a>';
      return;
    }
    updateAndRenderGames('', sourceType);
    searchInput.addEventListener('input', debounce(() => updateAndRenderGames(searchInput.value, sourceType), 500));
  }

  function showNestPanel(nestKey, parentElement) {
    activeNestParent = parentElement;
    mainNavContainer.classList.add('nest-active');
    nestNavContainer.classList.add('active');
    extrasNavContainer.classList.remove('active');
    extrasBtn.classList.remove('active');

    if (nestKey === 'games') {
      showGamePanel('games');
    } else if (nestKey === 'playline') {
      if (!allPlaylineGamesCache || allPlaylineGamesCache.length === 0) {
          const itemList = nestNavContainer.querySelector('.nav-item-list');
          itemList.innerHTML = '';
          nestNavContainer.querySelector('.nav-scroll-container').onscroll = null;
          const backLink = document.createElement("a");
          backLink.className = "nav-item";
          backLink.innerHTML = `<div class="icon-container"><i class="fa-regular fa-chevron-left"></i></div><span class="nav-text">Back</span>`;
          backLink.href = "#";
          backLink.onclick = (e) => { e.preventDefault(); mainNavContainer.classList.remove('nest-active'); nestNavContainer.classList.remove('active'); updateActiveStates(activeNestParent); };
          const loadingMessage = document.createElement('a');
          loadingMessage.className = 'nav-item';
          loadingMessage.innerHTML = `<span class="nav-text" style="opacity: 0.6; font-style: italic; font-size: 0.9em;">loading gamelist...</span>`;
          

          // was lazy and asked AI to make me a cool style and it worked so :shrug:
          const progressContainer = document.createElement('div');
          progressContainer.className = 'nav-item';
          progressContainer.style.padding = '0px 15px';
          const progressBarOuter = document.createElement('div');
          progressBarOuter.style.width = '100%';
          progressBarOuter.style.height = '6px';
          progressBarOuter.style.backgroundColor = 'rgba(0, 0, 0, 0.3)';
          progressBarOuter.style.borderRadius = '3px';
          progressBarOuter.style.overflow = 'hidden';
          const progressBarInner = document.createElement('div');
          progressBarInner.id = 'playline-progress-bar';
          progressBarInner.style.width = '0%';
          progressBarInner.style.height = '100%';
          progressBarInner.style.backgroundColor = '#fafafa';
          progressBarInner.style.borderRadius = '3px';
          progressBarInner.style.transition = 'width 0.2s ease-out';
          progressBarOuter.appendChild(progressBarInner);
          progressContainer.appendChild(progressBarOuter);

          itemList.append(backLink, loadingMessage, progressContainer);
      } else {
          showGamePanel('playline');
      }
    } else {
      nestNavContainer.querySelector('.nav-scroll-container').onscroll = null;
      const items = navData[nestKey];
      if (!items) { console.error(`Nest data for '${nestKey}' not found.`); return; }
      const itemList = nestNavContainer.querySelector('.nav-item-list');
      itemList.innerHTML = '';
      const backLink = document.createElement("a");
      backLink.className = "nav-item";
      backLink.innerHTML = `<div class="icon-container"><i class="fa-regular fa-chevron-left"></i></div><span class="nav-text">Back</span>`;
      backLink.href = "#";
      backLink.onclick = (e) => { e.preventDefault(); mainNavContainer.classList.remove('nest-active'); nestNavContainer.classList.remove('active'); updateActiveStates(activeNestParent); };
      itemList.appendChild(backLink);
      itemList.appendChild(document.createElement("div")).className = "nav-divider";
      populateNav(itemList, items, false);
    }
  }

  function updateActiveStates(activeElement) {
    document.querySelectorAll(".nav-item, .quick-action-btn").forEach(el => el.classList.remove("active"));
    if (activeElement) {
      activeElement.classList.add("active");
      if (extrasNavContainer.contains(activeElement)) extrasBtn.classList.add("active");
    }
    if (activeNestParent) activeNestParent.classList.add("active");
  }

  function createNavItem(item, container, isInitialLoad) {
    if (item.type === "divider") {
      container.appendChild(document.createElement("div")).className = "nav-divider";
      return;
    }
    const navLink = document.createElement("a");
    navLink.className = "nav-item";
    const title = item.title;
    let iconHtml;
    if (item.icon) {
      let iconClasses = item.icon;
      if (!/fa-(solid|regular|brands)/.test(iconClasses)) {
          iconClasses = `fa-regular ${iconClasses}`;
      }
      iconHtml = `<i class="${iconClasses}"></i>`;
    } else {
      iconHtml = `<i class="fa-regular fa-question-circle"></i>`;
    }
    const nestChevron = item.nest ? `<i class="fa-regular fa-chevron-right nav-chevron"></i>` : '';
    navLink.innerHTML = `<div class="icon-container">${iconHtml}</div><span class="nav-text">${title}${nestChevron}</span>`;
    navLink.href = "#";
    if (isInitialLoad && item.title === "Home") {
      navLink.classList.add("active");
      frame.src = item.url;
    }
    if (container.parentElement.parentElement === nestNavContainer && item.url === lastSelectedNestUrl) {
      navLink.classList.add('active');
    }
    navLink.onclick = (e) => {
      e.preventDefault();
      if (item.nest) {
        showNestPanel(item.nest, navLink);
      } else if (item.url) {
        if (item.direct === true) {
          window.open(item.url, '_blank');
          return;
        }
        frame.src = item.url;
        if (nestNavContainer.contains(container)) {
          lastSelectedNestUrl = item.url;
        } else {
          lastSelectedNestUrl = null; activeNestParent = null;
          mainNavContainer.classList.remove('nest-active', 'extras-active');
          nestNavContainer.classList.remove('active');
          extrasNavContainer.classList.remove('active');
          extrasBtn.classList.remove('active');
        }
      }
      updateActiveStates(navLink);
    };
    container.appendChild(navLink);
  }

  whatsNewBtn.onclick = () => {
    showModal();
  };
  extrasBtn.onclick = () => {
    const isActive = extrasNavContainer.classList.contains('active');
    mainNavContainer.classList.toggle('extras-active', !isActive);
    extrasNavContainer.classList.toggle('active', !isActive);
    extrasBtn.classList.toggle('active', !isActive);
    mainNavContainer.classList.remove('nest-active');
    nestNavContainer.classList.remove('active');
    settingsBtn.classList.remove('active');
  };
  settingsBtn.onclick = () => {
    frame.src = "page/options.html";
    mainNavContainer.classList.remove('nest-active', 'extras-active');
    nestNavContainer.classList.remove('active');
    extrasNavContainer.classList.remove('active');
    extrasBtn.classList.remove('active');
    updateActiveStates(settingsBtn);
  };

  document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'r') {
          e.preventDefault();
          const gamesNavItem = [...document.querySelectorAll('.nav-item .nav-text')].find(el => el.textContent.trim() === 'Games')?.parentElement;
          if (gamesNavItem) { gamesNavItem.classList.add('flash-feedback'); setTimeout(() => gamesNavItem.classList.remove('flash-feedback'), 400); }
          await precacheZones();
          if (nestNavContainer.classList.contains('active') && activeNestParent && activeNestParent.textContent.includes('Games')) showGamePanel('games');
      }
  });

  function populateNav(container, items, isInitial) {
    if (isInitial) container.innerHTML = "";
    items.forEach((item) => createNavItem(item, container, isInitial));
  }

  populateNav(mainNavContainer.querySelector('.nav-item-list'), navItems, true);
  populateNav(extrasNavContainer.querySelector('.nav-item-list'), extraNavItems, true);
  precacheZones();
  precachePlaylineGames();

  window.addEventListener('load', () => {
    document.querySelectorAll('.nav-scroll-container').forEach(sc => setTimeout(() => handleBottomMask(sc), 150));
  });

});