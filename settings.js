// Shared by the content script and the settings popup.
const DEFAULT_SETTINGS = {
  fontScale: 1,
  backgroundOpacity: 0.6,
  // Keep a sentence on screen through the pause until the next one starts.
  holdBetweenSentences: true,
  // Where the subtitles were dragged, as { x, y } fractions of the player
  // (center and bottom edge); null keeps them centered above the controls.
  boxPosition: null,
};
