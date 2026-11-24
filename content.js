// Shows YouTube captions as plain text that can be selected. Whole sentences
// are built from the caption file the player downloads (see page-hook.js);
// without that file the native captions are mirrored as they appear.
// The native caption windows stay in the DOM but are hidden.

const PLAYER = '#movie_player';
const CAPTION_LINE = '.caption-visual-line';
const CAPTIONS_BUTTON = '.ytp-subtitles-button';
// The progress bar's hover area reaches above the control bar itself.
const CONTROLS = '.ytp-chrome-bottom, .ytp-progress-bar-padding';
const CONTROLS_GAP_PX = 8;

const TIMEDTEXT_MESSAGE = 'hys-timedtext';
// About two subtitle lines; longer sentences are cut into pieces.
const MAX_CUE_CHARS = 80;
// A pause this long is the preferred place to cut a long sentence.
const LONG_PAUSE_MS = 1500;
// Unless "hold" is on, a sentence goes away this long after its last word starts.
const LINGER_MS = 1500;
// A held phrase stops the video this long before the next one, so none of it is heard.
const PAUSE_LEAD_MS = 100;
const SENTENCE_END = /[.?!…]["'”»)]*$/;
const CLAUSE_END = /[,;:]$/;
const SPEAKER_CHANGE = '>>';
const MAX_STORED_TRACKS = 20;

const layer = document.createElement('div');
layer.className = 'hys-layer';
const box = document.createElement('div');
box.className = 'hys-box';
box.hidden = true;
// Its look comes from content.css, so the handle adds no text to a selection.
const handle = document.createElement('div');
handle.className = 'hys-handle';
handle.title = 'Drag to move subtitles. Double-click to reset position.';
const phrase = document.createElement('div');
box.append(handle, phrase);
layer.append(box);

let player = null;
let settings = { ...DEFAULT_SETTINGS };
let lastText = '';
let hovering = false;
let pausedByUs = false;
// Set when the user plays or seeks while a phrase is held: the next change goes through.
let holdReleased = false;
let drag = null;

// Cues by video id. Thumbnail previews download captions of other videos,
// so those must not replace the cues of the video being watched.
const cuesByVideo = new Map();

function joinWords(words) {
  return words.map((word) => word.text).join(' ');
}

// Auto-generated captions give every word with its start time.
function readWords(events) {
  const words = [];
  for (const event of events) {
    if (!event.segs || event.aAppend) continue;
    for (const seg of event.segs) {
      const text = seg.utf8.trim();
      if (text) words.push({ text, start: event.tStartMs + (seg.tOffsetMs ?? 0) });
    }
  }
  return words;
}

// Cut a sentence that does not fit two lines: at a long pause if there is one,
// otherwise at the comma nearest the middle, otherwise at the longest pause.
function splitLong(words) {
  if (words.length < 2 || joinWords(words).length <= MAX_CUE_CHARS) return [words];
  const cuts = words.slice(1).map((word, i) => ({
    at: i + 1,
    pause: word.start - words[i].start,
    clause: CLAUSE_END.test(words[i].text),
    imbalance: Math.abs(joinWords(words.slice(0, i + 1)).length - joinWords(words.slice(i + 1)).length),
  }));
  const longestPause = cuts.reduce((best, cut) => (cut.pause > best.pause ? cut : best));
  const middleClause = cuts
    .filter((cut) => cut.clause)
    .reduce((best, cut) => (!best || cut.imbalance < best.imbalance ? cut : best), null);
  const cut = longestPause.pause >= LONG_PAUSE_MS || !middleClause ? longestPause : middleClause;
  return [...splitLong(words.slice(0, cut.at)), ...splitLong(words.slice(cut.at))];
}

function buildSentenceCues(events) {
  const pieces = [];
  let sentence = [];
  const endSentence = () => {
    if (sentence.length) pieces.push(...splitLong(sentence));
    sentence = [];
  };
  for (const word of readWords(events)) {
    // ">>" marks a change of speaker, which starts a new sentence too.
    if (word.text.startsWith(SPEAKER_CHANGE)) endSentence();
    sentence.push(word);
    if (SENTENCE_END.test(word.text)) endSentence();
  }
  endSentence();
  return pieces.map((words, i) => ({
    start: words[0].start,
    end: Math.min(words.at(-1).start + LINGER_MS, pieces[i + 1]?.[0].start ?? Infinity),
    text: joinWords(words),
  }));
}

// Captions uploaded by the author are already split into phrases; keep them.
function buildAuthorCues(events) {
  return events
    .filter((event) => event.segs)
    .map((event) => ({
      start: event.tStartMs,
      end: event.tStartMs + (event.dDurationMs ?? 0),
      text: event.segs.map((seg) => seg.utf8).join('').trim(),
    }))
    .filter((cue) => cue.text);
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== TIMEDTEXT_MESSAGE) return;
  const params = new URL(event.data.url, location.href).searchParams;
  const videoId = params.get('v');
  cuesByVideo.delete(videoId);
  try {
    const { events } = JSON.parse(event.data.body);
    // Translated auto-captions have no per-word timing, so they are kept as phrases.
    const wordTimed = params.get('kind') === 'asr' && !params.get('tlang');
    cuesByVideo.set(videoId, wordTimed ? buildSentenceCues(events) : buildAuthorCues(events));
  } catch {
    // Not a caption file we can read: the native captions get mirrored instead.
  }
  if (cuesByVideo.size > MAX_STORED_TRACKS) cuesByVideo.delete(cuesByVideo.keys().next().value);
});

function getVideo() {
  return player?.querySelector('video');
}

function captionsOn() {
  return player.querySelector(CAPTIONS_BUTTON)?.getAttribute('aria-pressed') === 'true';
}

// Cues of the video being watched, unless an ad is playing or captions are off.
function currentCues() {
  if (player.classList.contains('ad-showing') || !captionsOn()) return null;
  return cuesByVideo.get(new URLSearchParams(location.search).get('v')) ?? null;
}

function cueLines(cues, time) {
  const current = cues.findLast((cue) => cue.start <= time);
  if (!current || (!settings.holdBetweenSentences && time >= current.end)) return [];
  return current.text.split('\n');
}

function nativeLines() {
  return [...player.querySelectorAll(CAPTION_LINE)]
    .map((line) => line.textContent)
    .filter((text) => text.trim());
}

// The phrase on screen is held while the user points at it. A box that went
// empty can leave `hovering` set until the mouse moves.
function isHolding() {
  return hovering && lastText !== '';
}

// Instead of replacing a held phrase, stop the video where the next one begins.
function pauseForHold() {
  const video = getVideo();
  if (video && !video.paused) {
    video.pause();
    pausedByUs = true;
  }
}

// How far up from the player's bottom the control bar reaches. The bar keeps
// its size while hidden, so the subtitles stay put when it appears or hides.
function controlsHeight(playerRect) {
  const controlsTop = Math.min(
    ...[...player.querySelectorAll(CONTROLS)]
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.height)
      .map((rect) => rect.top),
  );
  return Number.isFinite(controlsTop) ? playerRect.bottom - controlsTop : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Put the box where the user dragged it (kept as fractions of the player size,
// so it survives resizes and fullscreen), or by default centered just above
// the control bar. A dragged box may cover the controls but always stays
// inside the video. Returns the position actually used.
function placeBox() {
  const playerRect = player.getBoundingClientRect();
  const { width, height } = playerRect;
  const defaultBottom = controlsHeight(playerRect) + CONTROLS_GAP_PX;
  const position = settings.boxPosition;
  const halfWidth = box.offsetWidth / 2;
  const left = clamp((position?.x ?? 0.5) * width, halfWidth + handle.offsetWidth, width - halfWidth);
  const bottom = clamp(position ? position.y * height : defaultBottom, 0, height - box.offsetHeight);
  box.style.left = `${Math.round(left)}px`;
  box.style.bottom = `${Math.round(bottom)}px`;
  return { x: left / width, y: bottom / height };
}

function render() {
  if (!player) return;
  const cues = currentCues();
  const time = (getVideo()?.currentTime ?? 0) * 1000;
  const lines = cues ? cueLines(cues, time) : nativeLines();
  // With a caption file the native captions are not needed at all. Without one
  // they are hidden only while mirrored, so they stay visible if YouTube
  // changes its markup and nothing can be read.
  player.classList.toggle('hys-active', !!cues || lines.length > 0);
  // A caption file lets us look a moment ahead; mirrored captions only show a
  // change after it has happened.
  const upcoming = cues ? cueLines(cues, time + PAUSE_LEAD_MS) : lines;
  if (upcoming.join('\n') !== lastText && isHolding() && !holdReleased) {
    pauseForHold();
    if (pausedByUs) return;
  }
  const text = lines.join('\n');
  if (text === lastText) return;
  lastText = text;
  holdReleased = false;
  box.hidden = lines.length === 0;
  phrase.replaceChildren(
    ...lines.map((line) => {
      const div = document.createElement('div');
      div.dir = 'auto';
      div.textContent = line;
      return div;
    }),
  );
  placeBox();
}

function renderEveryFrame() {
  render();
  requestAnimationFrame(renderEveryFrame);
}

box.addEventListener('mouseenter', () => {
  hovering = true;
});

// Moving the mouse off the subtitles always lets the video go on.
box.addEventListener('mouseleave', () => {
  hovering = false;
  if (pausedByUs) {
    pausedByUs = false;
    getVideo()?.play();
  }
  render();
});

// YouTube opens its own menu on right click; stopping the event here lets the
// browser menu (with other extensions' items) appear instead.
box.addEventListener('contextmenu', (event) => event.stopPropagation());

handle.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const boxRect = box.getBoundingClientRect();
  drag = {
    playerRect: player.getBoundingClientRect(),
    // Where in the box it was grabbed, so the box does not jump to the pointer.
    offsetX: event.clientX - (boxRect.left + boxRect.width / 2),
    offsetY: boxRect.bottom - event.clientY,
    moved: false,
  };
  handle.classList.add('hys-dragging');
});

handle.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const { playerRect, offsetX, offsetY } = drag;
  settings.boxPosition = {
    x: (event.clientX - offsetX - playerRect.left) / playerRect.width,
    y: (playerRect.bottom - event.clientY - offsetY) / playerRect.height,
  };
  settings.boxPosition = placeBox();
  drag.moved = true;
});

// Fires after pointerup and also when the drag is cancelled.
handle.addEventListener('lostpointercapture', () => {
  if (drag?.moved) chrome.storage.local.set({ boxPosition: settings.boxPosition });
  drag = null;
  handle.classList.remove('hys-dragging');
});

handle.addEventListener('dblclick', () => {
  chrome.storage.local.set({ boxPosition: null });
});

// Playback started by the user (space, play button) takes over from our pause;
// resuming from a hold lets the phrase move on. Our own resume never happens
// during a hold.
document.addEventListener('play', () => {
  if (pausedByUs && isHolding()) holdReleased = true;
  pausedByUs = false;
}, true);

// Seeking while a phrase is held shows the phrase at the new position.
document.addEventListener('seeking', () => {
  if (isHolding()) holdReleased = true;
}, true);

function applySettings(values) {
  settings = values;
  layer.style.setProperty('--hys-font-scale', values.fontScale);
  layer.style.setProperty('--hys-background-opacity', values.backgroundOpacity);
  if (player) placeBox();
}

chrome.storage.local.get(DEFAULT_SETTINGS).then(applySettings);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') chrome.storage.local.get(DEFAULT_SETTINGS).then(applySettings);
});

// YouTube is a single-page app that may create or replace the player at any
// time; the periodic check also follows player resizes.
function attach() {
  player = document.querySelector(PLAYER);
  if (!player) return;
  if (layer.parentElement !== player) player.append(layer);
  if (!drag) placeBox();
}

setInterval(attach, 1000);
attach();
renderEveryFrame();
