// A synthesized stand-in soundtrack for the 60 s film: 124 BPM electronic bed
// plus the sound effects on the picture's cues. Writes music.wav (48 kHz, 16-bit, stereo).
//   node music.js <out.wav>
const fs = require('fs');
const SR = 48000, DUR = 60, N = SR * DUR, BPM = 124, BEAT = 60 / BPM, BAR = BEAT * 4, TAU = Math.PI * 2;
const bus = { drums: [new Float32Array(N), new Float32Array(N)], music: [new Float32Array(N), new Float32Array(N)], fx: [new Float32Array(N), new Float32Array(N)] };
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const NOISE = new Float32Array(N + 8); for (let i = 0; i < N + 8; i++) NOISE[i] = rand();
const note = (n) => 440 * Math.pow(2, (n - 69) / 12); // midi → Hz
const saw = (x) => 2 * (x - Math.floor(x + .5));
const tri = (x) => 2 * Math.abs(2 * (x - Math.floor(x + .5))) - 1;
function add(b, t0, dur, fn, pan = 0, gain = 1) {
  const s0 = Math.max(0, Math.floor(t0 * SR)), s1 = Math.min(N, Math.ceil((t0 + dur) * SR)); if (s1 <= s0) return;
  const gl = gain * Math.min(1, 1 - pan), gr = gain * Math.min(1, 1 + pan); const [L, R] = bus[b];
  for (let i = s0; i < s1; i++) { const v = fn((i - s0) / SR, i); L[i] += v * gl; R[i] += v * gr; }
}
const env = (tt, a, d, s, r, dur) => Math.min(1, tt / a) * (tt < dur - r ? (s + (1 - s) * Math.exp(-tt / d)) : Math.max(0, (dur - tt) / r) * (s + (1 - s) * Math.exp(-tt / d)));

// ── instruments ──────────────────────────────────────────────────────────────
const kick = (t0, g = 1) => add('drums', t0, .42, (tt, i) => { const ph = TAU * (52 * tt + (130 / 38) * (1 - Math.exp(-38 * tt))); return Math.sin(ph) * Math.exp(-tt * 8.5) * Math.min(1, tt / .003) + NOISE[i] * Math.exp(-tt * 400) * .4; }, 0, .95 * g);
const clap = (t0, g = 1) => add('drums', t0, .22, (tt, i) => { const a = tt < .028 ? 1 : tt < .056 ? .75 : tt < .084 ? .55 : .5 * Math.exp(-(tt - .084) * 32); return (NOISE[i] - NOISE[i + 1]) * a * .9; }, .05, .32 * g);
const hat = (t0, open = false, pan = 0, g = 1) => add('drums', t0, open ? .25 : .06, (tt, i) => (NOISE[i] - NOISE[i + 1] * .9) * Math.exp(-tt * (open ? 18 : 95)), pan, .13 * g);
const rumble = (t0, dur, g = 1) => add('drums', t0, dur, (tt, i) => { let v = 0; for (let k = 0; k < 24; k++) v += NOISE[i - k]; return v / 24 * Math.min(1, tt / .5) * Math.min(1, (dur - tt) / .5); }, 0, .35 * g);
const bassN = (t0, dur, f, g = 1) => add('music', t0, dur, (tt) => (Math.sin(TAU * f * tt) * .8 + Math.sin(TAU * 2 * f * tt) * .18 + saw(f * tt) * .12) * env(tt, .004, .09, .55, .03, dur), 0, .5 * g);
const pad = (t0, dur, notes, g = 1, dark = false) => notes.forEach((n, k) => { const f = note(n); const H = dark ? 4 : 7; [[-.6, -.5], [.6, .5]].forEach(([det, pan]) => add('music', t0, dur, (tt) => { let v = 0; for (let h = 1; h <= H; h++) v += Math.sin(TAU * f * (1 + det / 600) * h * tt) / h; return v * env(tt, .35, 2, 1, .45, dur); }, pan, .09 * g / Math.sqrt(notes.length))); });
const arp = (t0, f, pan = 0, g = 1) => add('music', t0, .16, (tt) => tri(f * tt) * Math.exp(-tt * 14) * Math.min(1, tt / .003), pan, .11 * g);
// sfx
const pop = (t0, f = 600, g = 1) => add('fx', t0, .14, (tt) => Math.sin(TAU * (f * tt - (f * .5) * tt * tt / .14)) * Math.exp(-tt * 38), 0, .45 * g);
const ding = (t0, f = 990, g = 1, pan = 0) => add('fx', t0, .9, (tt) => (Math.sin(TAU * f * tt) * Math.exp(-tt * 5) + Math.sin(TAU * f * 2.76 * tt) * .35 * Math.exp(-tt * 9)) * Math.min(1, tt / .002), pan, .32 * g);
const chime = (t0, g = 1) => [880, 1108, 1318].forEach((f, k) => ding(t0 + k * .08, f, g * .8));
const whoosh = (t0, dur = .4, g = 1, pan = 0) => add('fx', t0, dur, (tt, i) => { const e = Math.pow(Math.sin(Math.PI * tt / dur), 2); return (NOISE[i] - NOISE[i + 2] * .7) * e; }, pan, .3 * g);
const rwhoosh = (t0, dur = .5, g = 1) => add('fx', t0, dur, (tt, i) => (NOISE[i] - NOISE[i + 2] * .7) * Math.pow(tt / dur, 2.2), 0, .38 * g);
const riser = (t0, dur, g = 1) => { add('fx', t0, dur, (tt, i) => { let v = 0; for (let k = 0; k < 4; k++) v += NOISE[i - k]; return (v / 4 + (NOISE[i] - NOISE[i + 1]) * (tt / dur)) * Math.pow(tt / dur, 2) * .9; }, 0, .45 * g); const f0 = 180, r = 10; add('fx', t0, dur, (tt) => Math.sin(TAU * f0 * dur / Math.log(r) * (Math.pow(r, tt / dur) - 1)) * Math.pow(tt / dur, 1.5) * .5, 0, .22 * g); };
const thud = (t0, g = 1) => add('fx', t0, .4, (tt, i) => Math.sin(TAU * (70 * tt + 40 * (1 - Math.exp(-20 * tt)))) * Math.exp(-tt * 7) + NOISE[i] * Math.exp(-tt * 60) * .5, 0, .7 * g);
const buzz = (t0, g = 1) => add('fx', t0, .22, (tt) => Math.sign(Math.sin(TAU * 165 * tt)) * (0.6 + 0.4 * Math.sign(Math.sin(TAU * 28 * tt))) * Math.exp(-tt * 9) * Math.min(1, tt / .003), 0, .22 * g);
const click = (t0, g = 1) => add('fx', t0, .02, (tt, i) => (NOISE[i] - NOISE[i + 1]) * Math.exp(-tt * 250), 0, .5 * g);
const tick = (t0, g = 1) => add('fx', t0, .05, (tt) => Math.sin(TAU * 2400 * tt) * Math.exp(-tt * 120), 0, .25 * g);
const alert = (t0, g = 1) => [0, .14].forEach((d) => add('fx', t0 + d, .09, (tt) => Math.sin(TAU * 1480 * tt) * Math.min(1, tt / .004) * Math.min(1, (.09 - tt) / .015), 0, .3 * g));
const hit = (t0) => { add('fx', t0, .6, (tt) => Math.sin(TAU * (38 * tt + (72 / 7) * (1 - Math.exp(-7 * tt)))) * Math.exp(-tt * 3.5), 0, 1); add('fx', t0, .5, (tt, i) => { let v = 0; for (let k = 0; k < 6; k++) v += NOISE[i - k]; return v / 6 * Math.exp(-tt * 22); }, 0, .9); add('fx', t0, 3.8, (tt) => Math.sin(TAU * 65.4 * tt) * Math.exp(-tt * .9), 0, .5); pad(t0, 3.2, [48, 52, 55, 60, 64], 2.2); chime(t0 + .05, 1.1); };

// ── the bed ──────────────────────────────────────────────────────────────────
const AM = [45, 48, 52, 57], AMT = [45, 48, 52, 56], Fc = [41, 45, 48, 53], Cc = [48, 52, 55, 60], Gc = [43, 47, 50, 55];
const CYC_A = [AM, Fc, Cc, Gc], CYC_C = [Cc, Fc, AM, Gc];
const ROOT = { 45: 33, 41: 29, 48: 36, 43: 31 }; // chord → bass note (an octave or two down)
const BASSPAT = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1];
const kicks = [];
for (let bar = 0; bar * BAR < 57; bar++) {
  const t0 = bar * BAR, tEnd = Math.min(t0 + BAR, 56.95), dur = tEnd - t0; if (dur <= .05) continue;
  const sec = t0 < 4 ? 'intro' : t0 < 10 ? 'tension' : t0 < 45 ? 'groove' : 'bright';
  const chord = sec === 'intro' ? AM : sec === 'tension' ? (bar % 2 ? AMT : AM) : sec === 'bright' ? CYC_C[(bar - 23) % 4] : CYC_A[(bar - 5) % 4];
  pad(t0, dur, chord, sec === 'intro' ? .8 : sec === 'tension' ? .9 : 1.1, sec === 'tension');
  if (sec === 'intro') { bassN(t0, dur, note(ROOT[chord[0]]), .5); continue; }
  if (sec === 'tension') { kick(t0, .8); kick(t0 + 2 * BEAT, .8); kicks.push(t0, t0 + 2 * BEAT); rumble(t0, dur, .8); for (let e = 0; e < 8; e++) hat(t0 + e * BEAT / 2, false, e % 2 ? .3 : -.3, .5); bassN(t0, dur, note(ROOT[chord[0]]), .55); continue; }
  for (let b = 0; b < 4; b++) { const tb = t0 + b * BEAT; if (tb >= tEnd) break; kick(tb); kicks.push(tb); if (b % 2) clap(tb); }
  for (let s = 0; s < 16; s++) { const ts = t0 + s * BEAT / 4; if (ts >= tEnd) break; hat(ts, s % 4 === 2, (s % 2 ? .35 : -.35), s % 4 === 0 ? 1 : .7); if (s === 15) tick(ts + BEAT / 8, .35); }
  for (let s = 0; s < 16; s++) { const ts = t0 + s * BEAT / 4; if (ts >= tEnd || !BASSPAT[s]) continue; bassN(ts, BEAT / 4 * .9, note(ROOT[chord[0]] + (s === 15 ? 12 : 0)), 1); }
  if (t0 >= 12) { const up = sec === 'bright' ? 24 : 12, order = [0, 1, 2, 1, 3, 2, 1, 0]; for (let s = 0; s < 16; s++) { const ts = t0 + s * BEAT / 4; if (ts >= tEnd) break; const n = chord[order[s % 8]] + up + (s % 8 === 7 && t0 >= 39 && t0 < 45 ? 12 : 0); arp(ts, note(n), Math.sin(s * .9) * .5, sec === 'bright' ? .9 : 1); } }
}
// the ending
hit(57.3);
for (let b = 0; b < 3; b++) { const tb = 57.3 + BEAT * (b + 1); if (tb >= 59.3) break; kick(tb, .9); kicks.push(tb); for (let s = 0; s < 4; s++) hat(tb + s * BEAT / 4, s === 2, s % 2 ? .3 : -.3, .8); }
pad(57.8, 2.2, [60, 64, 67, 72], .8);

// ── the cues (match stage.html) ──────────────────────────────────────────────
[0.3, 0.45, 0.6, 0.75].forEach((t, i) => pop(t, 520 + i * 90)); whoosh(1.15, .45); pop(1.8, 700, .6);
[4.1, 4.25, 4.4, 4.55].forEach((t) => pop(t, 380, .7)); whoosh(4.9, .5, .8);
thud(7.0); buzz(7.02, .8);
rwhoosh(9.35, .65, 1);
thud(10.0, .8); ding(10.0, 660, .8); ding(10.6, 880);
[740, 880, 990, 1175].forEach((f, i) => ding(11.5 + i * .45, f, .9, i < 2 ? -.4 : .4));
[0, 1, 2, 3].forEach((i) => pop(14.0 + i * .2, 700 + i * 60, .6));
[0, 1, 2, 3].forEach((i) => whoosh(17.3 + i * .3, .4, .8, -.3 + i * .2));
tick(19.5, .6); ding(21.4, 880, .7); ding(22.4, 990, .7); ding(22.9, 1108, .7); pop(23.0, 500, .6); ding(24.6, 1318, .8);
whoosh(25.3, .4, .5); tick(25.9, .8); whoosh(26.1, .4, .5); tick(26.75, .8); whoosh(27.3, .4, .5); alert(27.95); click(29.0); chime(29.02, .7); tick(29.3, .8); whoosh(30.0, .4, .5); thud(30.6, .9); buzz(30.62);
[0, 1, 2, 3].forEach((i) => { whoosh(32.3 + i * .3, .4, .6, -.4); pop(32.8 + i * .3, 640 + i * 40, .6); });
[0, 1, 2, 3].forEach((i) => ding(34.5 + i * .25, 880 + i * 110, .5, .3)); whoosh(36.6, .4, .6, -.4); buzz(37.0, .9); alert(37.02, .5);
[0, 1, 2, 3].forEach((i) => whoosh(38.3 + i * .5, .45, .7, -.3)); ding(38.9, 990, .8); ding(39.4, 1108, .8); ding(40.4, 1318, .8); buzz(39.9, .7); whoosh(40.0, .45, .6, .3); pop(41.0, 700, .6); whoosh(41.6, .45, .7, -.3); ding(42.3, 1480, .9);
chime(44.0, .8); chime(44.2, 1.2); [0, 1, 2, 3, 4, 5].forEach((i) => pop(44.25 + i * .05, 800 + i * 120, .35));
[0, 1, 2, 3, 4].forEach((i) => whoosh(45 + i * 1.4, .45, .9, .4));
whoosh(52.2, .5, .9, -.4); whoosh(52.5, .5, .9, .4);
for (let i = 0; i < 7; i++) { tick(53.0 + i * .22, .9); tick(53.3 + i * .22, .9); }
ding(55.0, 1318, .9, -.3); ding(55.2, 1318, .9, .3);
riser(54.0, 2.9); rwhoosh(56.45, .55, 1.1);
pop(58.0, 700, .8); pop(58.6, 820, .7); ding(59.0, 1046, .6);

// ── mix: sidechain the bed to the kicks, gate, fade, write ───────────────────
kicks.sort((a, b) => a - b);
const out = new Float32Array(N * 2); let kp = 0; let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR; while (kp < kicks.length - 1 && kicks[kp + 1] <= t) kp++;
  const since = kicks.length && kicks[kp] <= t ? t - kicks[kp] : 9;
  const sc = 1 - .68 * Math.max(0, 1 - since / .17) ** 1.4;
  let gate = 1; if (t > 56.95 && t < 57.3) gate = t < 56.97 ? (56.97 - t) / .02 : t > 57.28 ? (t - 57.28) / .02 : 0;
  if (t > 59.3) gate *= Math.max(0, (60 - t) / .7);
  for (let ch = 0; ch < 2; ch++) { let v = bus.drums[ch][i] + bus.music[ch][i] * sc + bus.fx[ch][i]; v = Math.tanh(v * 1.1) * gate; out[i * 2 + ch] = v; peak = Math.max(peak, Math.abs(v)); }
}
const g = .89 / peak, buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N * 2; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i] * g)) * 32767), 44 + i * 2);
fs.writeFileSync(process.argv[2] || 'music.wav', buf);
console.log('wrote', process.argv[2] || 'music.wav', 'peak', peak.toFixed(2));
