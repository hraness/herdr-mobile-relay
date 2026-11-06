const e = new URL(window.__HERDR_ENTRY__ || "/builds/0.25.0-492-62f66fb57e57b477/index.html", location);
  e.search = location.search;
  e.hash = location.hash;
  location.replace(e);
