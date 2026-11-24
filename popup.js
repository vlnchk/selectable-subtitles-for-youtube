// Settings popup. Values go to storage; open YouTube tabs pick them up at once.

const SLIDERS = ['fontScale', 'backgroundOpacity'];
const CHECKBOXES = ['holdBetweenSentences'];

function showPercent(name, value) {
  document.getElementById(`${name}Value`).textContent = `${Math.round(value * 100)}%`;
}

function show(settings) {
  for (const name of SLIDERS) {
    document.getElementById(name).value = settings[name];
    showPercent(name, settings[name]);
  }
  for (const name of CHECKBOXES) {
    document.getElementById(name).checked = settings[name];
  }
}

for (const name of SLIDERS) {
  document.getElementById(name).addEventListener('input', (event) => {
    const value = Number(event.target.value);
    showPercent(name, value);
    chrome.storage.local.set({ [name]: value });
  });
}

for (const name of CHECKBOXES) {
  document.getElementById(name).addEventListener('change', (event) => {
    chrome.storage.local.set({ [name]: event.target.checked });
  });
}

document.getElementById('resetPosition').addEventListener('click', () => {
  chrome.storage.local.set({ boxPosition: null });
});

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.local.set(DEFAULT_SETTINGS);
  show(DEFAULT_SETTINGS);
});

chrome.storage.local.get(DEFAULT_SETTINGS).then(show);
