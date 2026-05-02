/**
 * These are the actual navigation items
 */

const navItems = [
  { title: "Home", icon: "fa-home", url: "page/home.html", type: "item" },
  { type: "divider" },
  { title: "Dashboard", icon: "fa-table-columns", type: "item", url: "/page/dash.html" },
  { title: "Games", icon: "fa-gamepad", type: "item", nest: "games" },
  { title: "Playline", icon: "fa-trophy", type: "item", nest: "playline" },
  { type: "divider" },
  { title: "Chat", icon: "fa-comments-alt", url: "https://vtx.chat.cdn.cloudflare.net/embed/vapor", type: "item" },
  { title: "??? <span class='badge'>Coming Soon</span>", icon: "fa-desktop", url: "page/vm-priv.html", type: "item" },
  { title: "Browser", icon: "fa-search", url: "/scram.html", type: "item" },
  { type: "divider" },
  { title: "AI Chat <span class='badge'>New</span>", icon: "fa-robot", url: "page/app/ai.html", type: "item" },
  { title: "YouTube", icon: "fa-brands fa-youtube", url: "page/app/yt.html", type: "item" },
  { title: "Music", icon: "fa-music", url: "page/music.html", type: "item" },
];

const extraNavItems = [
    { title: "Discord", icon: "fa-brands fa-discord", url: "https://discord.gg/BHwm9rrK55", type: "item", direct: true },
    { title: "Partners", icon: "fa-handshake", url: "page/partners.html", type: "item", selectable: true },
    { title: "Privacy", icon: "fa-lock", url: "usage.html", type: "item", selectable: true },
    { title: "Repo (frontend)", icon: "fa-brands fa-gitlab", url: "https://gitlab.com/technonyte00/vapor", type: "item", direct: true },
];

var navData = {};