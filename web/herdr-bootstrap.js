const e = new URL(window.__HERDR_ENTRY__ || "/builds/0.25.0-494-b39d49192af4a84d/index.html", location);
  e.search = location.search;
  e.hash = location.hash;
  location.replace(e);
