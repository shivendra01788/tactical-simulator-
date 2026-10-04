// Radio audio for the simulator. Runs fully offline in the browser:
// - voice = the browser's built-in speech synthesis
// - squelch beeps and static = generated with the Web Audio API
// Jammed messages are spoken in pieces, with bursts of static where words were lost.

let ctx = null;
let noiseBuf = null;
let muted = false;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

// Call from a click handler (browsers block audio until the user interacts with the page).
export function initRadio() {
  if (typeof window === 'undefined') return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC && !ctx) {
    ctx = new AC();
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
  if (hasSpeech()) window.speechSynthesis.getVoices();
}

export function setMuted(m) {
  muted = m;
  if (m && hasSpeech()) window.speechSynthesis.cancel();
}

function startStatic(level) {
  if (!ctx) return { stop() {} };
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1800;
  filter.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.value = level;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start();
  return {
    stop() {
      try {
        src.stop();
      } catch (e) {
        /* already stopped */
      }
    },
  };
}

function beep(freq, ms) {
  if (!ctx) return sleep(ms);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.value = 0.08;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + ms / 1000);
  return sleep(ms + 30);
}

function speak(text) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 1.05;
    u.pitch = 0.85;
    const voice = synth.getVoices().find((v) => /^en/i.test(v.lang));
    if (voice) u.voice = voice;
    const timer = setTimeout(resolve, text.length * 110 + 2500); // some browsers never fire onend
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  });
}

// report.segments = the pieces of the message that survived the link; report.clarity = 0..1
export function playTransmission(report) {
  if (!hasSpeech()) return;
  const clarity = typeof report.clarity === 'number' ? report.clarity : 1;
  const segments = report.segments || [];
  const jam = 1 - clarity;

  // Messages are queued so two transmissions never talk over each other.
  queue = queue
    .then(async () => {
      if (muted) return;
      await beep(1300, 70); // key-up squelch
      const bed = jam > 0.02 ? startStatic(0.03 + jam * 0.2) : null; // background hiss grows with jamming
      if (segments.length === 0) await sleep(1200); // nothing but static got through
      for (let i = 0; i < segments.length; i++) {
        if (muted) break;
        await speak(segments[i]);
        if (i < segments.length - 1) {
          const burst = startStatic(0.3); // a dropout where words were lost
          await sleep(250 + jam * 500);
          burst.stop();
        }
      }
      if (bed) bed.stop();
      await beep(900, 60); // key-down
    })
    .catch(() => {});
}