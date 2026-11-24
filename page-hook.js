// Runs in the page's own JavaScript world, not the extension's isolated one,
// to see the caption file YouTube's player downloads and pass it to
// content.js. YouTube serves these files only to its own player.

(() => {
  const TIMEDTEXT_MESSAGE = 'hys-timedtext';
  const originalOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(url).includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        if (this.responseType && this.responseType !== 'text') return;
        window.postMessage(
          { type: TIMEDTEXT_MESSAGE, url: String(url), body: this.responseText },
          location.origin,
        );
      });
    }
    return originalOpen.call(this, method, url, ...rest);
  };
})();
