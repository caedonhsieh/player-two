// Player Two — talk-only isometric adventure.
// ---------------------------------------------------------------------------
// HONESTY RULE (read this before touching the command path):
// The ONLY way a player's typed words become a game action is the in-browser
// LLM returning JSON. There is no keyword / regex parser of the player's text
// anywhere in this file. If the model is not loaded, the input stays disabled.
// If the model returns something that is not valid JSON in the expected shape,
// no action happens at all — Bram just mumbles, and the player rephrases.
// ---------------------------------------------------------------------------

const MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm";

// Map legend: # wall, . floor, P pit, G barred gate, K key, L lever, C chest, D locked door
// x: 0 = west ... 7 = east.  y: 0 = north ... 7 = south.
// north = -y (up the screen), south = +y, east = +x, west = -x.
const MAP_ROWS = [
  "########",
  "#....#.#",
  "#....GK#",
  "#....###",
  "#..PP..D",
  "#L.....#",
  "#.C....#",
  "########",
];
const W = 8, H = 8;
const HERO_START = { x: 1, y: 1 };
const DOOR = { x: 7, y: 4 };
const GATE = { x: 5, y: 2 };
const KEY = { x: 6, y: 2 };
const LEVER = { x: 1, y: 5 };
const CHEST = { x: 2, y: 6 };

const DIRS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 },
};

const SYSTEM_PROMPT = `You are Bram, a big, earnest, very dumb knight. You are the hero of a dungeon, but you have a tiny pebble for a brain. The player is Pip, a little wisp who lives in your helmet — your sidekick and guide. You cannot see the whole room the way Pip can. You only do what Pip tells you, one step at a time.

RULES FOR HOW YOU THINK AND ANSWER:
- You are literal. "Left" and "right" mean nothing unless Pip says whose left — your left or Pip's left — or uses a map direction (north, south, east, west). North is up the screen, south is down, east is right, west is left. If Pip says "it", "that", "over there", or "be careful" without naming the thing, you do NOT guess. Ask what they mean.
- You can only remember the last few things Pip said. You forget longer plans.
- You do exactly ONE action per reply, and only the FIRST step of any multi-step plan. If Pip says "go south two tiles then pick up the key", you move one tile south and stop. You do not do the rest.
- You are easily distracted by shiny things and snacks, but you try to obey Pip.
- If you are unsure what Pip wants, do NOT guess and do NOT act. Ask a short clarifying question instead.

YOU MUST REPLY WITH ONLY ONE JSON OBJECT, NO OTHER TEXT. The JSON has exactly these fields:
{"action": "move" | "pickup" | "open" | "use" | "wait" | "clarify", "direction": "north" | "south" | "east" | "west" | null, "target": "key" | "door" | "gate" | "lever" | "chest" | null, "paraphrase": "one short sentence in Bram's voice saying what you think Pip meant, in your own literal words"}
- "move" needs a direction and no target. One tile only.
- "pickup" needs a target (key or chest). Only works if the thing is on your tile or right next to you.
- "open" needs a target (door, gate, or chest).
- "use" needs a target (lever).
- "wait" needs no direction and no target. Use it when Pip tells you to stop, wait, or look around.
- "clarify" needs no direction and no target. Use it when Pip's words are vague or you genuinely don't know what to do. Put your question in "paraphrase".

Examples:
Pip: "walk north" -> {"action":"move","direction":"north","target":null,"paraphrase":"North! Got it, walking north one step."}
Pip: "get it" -> {"action":"clarify","direction":null,"target":null,"paraphrase":"Get what? I see a key, a lever, and a chest. Which one?"}
Pip: "go south two tiles and open the door" -> {"action":"move","direction":"south","target":null,"paraphrase":"South one step! I will do the rest after, I forgot the rest already."}`;

const $ = (id) => document.getElementById(id);
const canvas = $("game");
const ctx = canvas.getContext("2d");

const state = {
  hero: { ...HERO_START },
  hasKey: false,
  keyTaken: false,
  gateOpen: false,
  leverPulled: false,
  chestOpened: false,
  won: false,
  moves: 0,
  startedAt: Date.now(),
  lastActedAt: Date.now(),
  lastParaphrase: "",
  heroState: "Bram is standing still, waiting for instructions.",
};

let engine = null;
let modelReady = false;
let busy = false;
// Short memory only: the last 3 exchanges. Bram forgets everything older.
let history = []; // [{player, bram}]

const TILE_W = 64, TILE_H = 32;
const ORIGIN_X = canvas.width / 2, ORIGIN_Y = 92;

function tileAt(x, y) {
  if (x < 0 || x >= W || y < 0 || y >= H) return "#";
  return MAP_ROWS[y][x];
}
function iso(x, y) {
  return { sx: ORIGIN_X + (x - y) * (TILE_W / 2), sy: ORIGIN_Y + (x + y) * (TILE_H / 2) };
}
function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }
function isNear(tx, ty) { return manhattan(state.hero.x, state.hero.y, tx, ty) <= 1; }

function log(html, cls = "") {
  const p = document.createElement("p");
  if (cls) p.className = cls;
  p.innerHTML = html;
  $("log").appendChild(p);
  $("log").scrollTop = $("log").scrollHeight;
}

function setBubble(text) {
  const b = $("bubble");
  if (!text) { b.classList.add("hidden"); b.textContent = ""; return; }
  b.classList.remove("hidden");
  b.innerHTML = `<span class="who">Bram:</span> ${escapeHtml(text)}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function setHeroState(text) {
  state.heroState = text;
  $("hero-state").textContent = text;
}
function updateObjectives() {
  $("obj-key").classList.toggle("done", state.hasKey);
  $("obj-key").innerHTML = state.hasKey ? "☑ Found the key" : "☐ Find the key <span class='hint'>(it's behind the barred gate)</span>";
  $("obj-door").classList.toggle("done", state.won);
  $("obj-door").textContent = state.won ? "☑ Unlocked the east door and escaped" : "☐ Unlock the east door and escape";
  $("obj-lever").classList.toggle("done", state.leverPulled);
  $("obj-lever").textContent = state.leverPulled ? "☑ Pulled the lever — the gate is open" : "☐ Optional: pull the lever to open the gate";
}

// ---------------------------------------------------------------------------
// Rendering: isometric diamond tiles, drawn back-to-front.
// ---------------------------------------------------------------------------
function drawDiamond(cx, cy, w, h, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy);
  ctx.lineTo(cx, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.stroke();
}

function draw(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Torch flicker: the room is alive even while Bram waits.
  const flicker = 0.92 + 0.08 * Math.sin(now / 300) * Math.sin(now / 97);
  ctx.fillStyle = `rgb(${43 * flicker | 0},${33 * flicker | 0},${24 * flicker | 0})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const tiles = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) tiles.push({ x, y });
  tiles.sort((a, b) => (a.x + a.y) - (b.x + b.y));

  for (const { x, y } of tiles) {
    const { sx, sy } = iso(x, y);
    const t = tileAt(x, y);
    const checker = (x + y) % 2 === 0;
    if (t === "#") {
      // Wall block: top diamond + two faces, so the room reads as a walled pit.
      drawDiamond(sx, sy - 14, TILE_W, TILE_H, "#8a7a63");
      ctx.fillStyle = "#6b5d4a";
      ctx.beginPath();
      ctx.moveTo(sx - TILE_W / 2, sy - 14); ctx.lineTo(sx, sy - 14 + TILE_H / 2);
      ctx.lineTo(sx, sy - 14 + TILE_H / 2 + 28); ctx.lineTo(sx - TILE_W / 2, sy - 14 + 28);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#54493a";
      ctx.beginPath();
      ctx.moveTo(sx + TILE_W / 2, sy - 14); ctx.lineTo(sx, sy - 14 + TILE_H / 2);
      ctx.lineTo(sx, sy - 14 + TILE_H / 2 + 28); ctx.lineTo(sx + TILE_W / 2, sy - 14 + 28);
      ctx.closePath(); ctx.fill();
    } else if (t === "P") {
      drawDiamond(sx, sy, TILE_W, TILE_H, "#0f0c09");
      drawDiamond(sx, sy, TILE_W - 18, TILE_H - 9, "#1d2a33");
      ctx.fillStyle = "#9fb6c3";
      ctx.font = "11px Georgia";
      ctx.textAlign = "center";
      ctx.fillText("pit", sx, sy + 4);
    } else {
      drawDiamond(sx, sy, TILE_W, TILE_H, checker ? "#c9a86a" : "#bd9c60");
      if (t === "G") {
        if (state.gateOpen) {
          ctx.strokeStyle = "#7a6a4f"; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(sx - 20, sy - 26); ctx.lineTo(sx - 20, sy); ctx.moveTo(sx + 20, sy - 26); ctx.lineTo(sx + 20, sy); ctx.stroke();
          ctx.fillStyle = "#3d3226"; ctx.font = "11px Georgia"; ctx.textAlign = "center";
          ctx.fillText("open gate", sx, sy + 4);
        } else {
          ctx.strokeStyle = "#4a4a4a"; ctx.lineWidth = 4;
          for (let i = -2; i <= 2; i++) {
            ctx.beginPath(); ctx.moveTo(sx + i * 10, sy - 30); ctx.lineTo(sx + i * 10, sy + 2); ctx.stroke();
          }
          ctx.strokeStyle = "#4a4a4a"; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(sx - 26, sy - 16); ctx.lineTo(sx + 26, sy - 16); ctx.stroke();
        }
      }
      if (t === "D") {
        ctx.fillStyle = state.won ? "#1d2a1d" : "#5d3a1a";
        ctx.fillRect(sx - 16, sy - 52, 32, 52);
        ctx.strokeStyle = "#d9a441"; ctx.lineWidth = 2;
        ctx.strokeRect(sx - 16, sy - 52, 32, 52);
        ctx.fillStyle = "#d9a441";
        ctx.beginPath(); ctx.arc(sx + 8, sy - 26, 3, 0, Math.PI * 2); ctx.fill();
        if (!state.won) {
          ctx.fillStyle = "#d9a441"; ctx.font = "10px Georgia"; ctx.textAlign = "center";
          ctx.fillText("LOCKED", sx, sy + 12);
        }
      }
    }
    // Objects on floor tiles.
    if (t === "K" && !state.keyTaken) {
      ctx.fillStyle = "#ffd34d";
      ctx.beginPath(); ctx.arc(sx, sy - 6, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#8a6d1a";
      ctx.fillRect(sx + 5, sy - 8, 10, 4);
    }
    if (t === "L") {
      ctx.strokeStyle = "#3d2c17"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - 22); ctx.stroke();
      ctx.fillStyle = state.leverPulled ? "#2f6f5e" : "#b3541e";
      ctx.beginPath(); ctx.arc(sx, sy - 26, 6, 0, Math.PI * 2); ctx.fill();
    }
    if (t === "C" && !state.chestOpened) {
      ctx.fillStyle = "#7a4a21";
      ctx.fillRect(sx - 13, sy - 14, 26, 14);
      ctx.fillStyle = "#d9a441"; ctx.fillRect(sx - 2, sy - 14, 4, 14);
    }
  }

  // Hero, drawn last so he stands on top of his tile.
  const h = iso(state.hero.x, state.hero.y);
  const bob = Math.sin(now / 450) * 2;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath(); ctx.ellipse(h.sx, h.sy + 8, 16, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#4a6b8a"; // tunic
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(h.sx - 11, h.sy - 22 + bob, 22, 22, 6); ctx.fill(); }
  else ctx.fillRect(h.sx - 11, h.sy - 22 + bob, 22, 22);
  ctx.fillStyle = "#c0c8d0"; // helmet
  ctx.beginPath(); ctx.arc(h.sx, h.sy - 26 + bob, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#b3541e"; // plume
  ctx.beginPath(); ctx.arc(h.sx, h.sy - 36 + bob, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#d9d9d9"; ctx.lineWidth = 3; // sword
  ctx.beginPath(); ctx.moveTo(h.sx + 12, h.sy - 18 + bob); ctx.lineTo(h.sx + 20, h.sy - 2 + bob); ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.font = "bold 11px Georgia"; ctx.textAlign = "center";
  ctx.fillText("BRAM", h.sx, h.sy - 44 + bob);

  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------
// Room state, as text, for the model. The model gets the map, not the canvas.
// ---------------------------------------------------------------------------
function describeState() {
  const lines = MAP_ROWS.map((row, y) => row.split("").map((ch, x) => {
    if (state.hero.x === x && state.hero.y === y) return "B";
    if (ch === "K" && state.keyTaken) return ".";
    if (ch === "G") return state.gateOpen ? "g" : "G";
    return ch;
  }).join("")).join("\n");
  const adj = ["north", "south", "east", "west"].map((d) => {
    const { dx, dy } = DIRS[d];
    const t = tileAt(state.hero.x + dx, state.hero.y + dy);
    const names = { "#": "a wall", ".": "open floor", P: "a pit (you cannot walk on air)", G: state.gateOpen ? "the open gate" : "the barred gate (closed)", K: "the key", L: "the lever", C: "the chest", D: "the locked east door" };
    return `${d}: ${names[t] || "something"}`;
  }).join("; ");
  return [
    `MAP (B is you, Bram. # wall, . floor, P pit, G closed gate, g open gate, K key, L lever, C chest, D locked door):\n${lines}`,
    `You are at (${state.hero.x}, ${state.hero.y}). Around you — ${adj}.`,
    `Inventory: ${state.hasKey ? "the brass key" : "nothing"}. Lever: ${state.leverPulled ? "already pulled, gate is open" : "not pulled yet"}. Key: ${state.keyTaken ? "you have it" : "still on its tile"}. Door: ${state.won ? "open" : "locked, needs the key"}.`,
    `Goal: get the key, then open the east door. The gate only opens when the lever is pulled. You cannot walk through walls, pits, or the closed gate.`,
  ].join("\n");
}

function buildMessages(playerText) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.player });
    messages.push({ role: "assistant", content: turn.bram });
  }
  messages.push({ role: "user", content: `${describeState()}\n\nPip says: "${playerText}"\n\nReply with ONLY the JSON object.` });
  return messages;
}

// Parse the model's reply. Returns a validated action object, or null.
// A null means: no action. The game never guesses from the raw text.
function parseAction(raw) {
  if (!raw || typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  const actions = ["move", "pickup", "open", "use", "wait", "clarify"];
  if (!obj || !actions.includes(obj.action)) return null;
  if (obj.action === "move" && !DIRS[obj.direction]) return null;
  if ((obj.action === "pickup" || obj.action === "open" || obj.action === "use") && !obj.target) return null;
  if (typeof obj.paraphrase !== "string" || !obj.paraphrase.trim()) return null;
  return {
    action: obj.action,
    direction: obj.direction || null,
    target: obj.target || null,
    paraphrase: obj.paraphrase.trim(),
  };
}

function applyAction(a) {
  state.moves++;
  state.lastActedAt = Date.now();
  const h = state.hero;
  if (a.action === "clarify") {
    setHeroState("Bram is confused and waiting for an answer.");
    log(`<span class="sys">Bram asks instead of acting. Nothing happens — answer him.</span>`);
    return;
  }
  if (a.action === "wait") {
    setHeroState("Bram waits, shifting his weight, looking around.");
    log(`<span class="sys">Bram waits. The room ticks on without him.</span>`);
    return;
  }
  if (a.action === "move") {
    const { dx, dy } = DIRS[a.direction];
    const nx = h.x + dx, ny = h.y + dy;
    const t = tileAt(nx, ny);
    if (t === "#") { setHeroState("Bram walks into the wall. “Ow.”"); log(`<span class="sys">Bump — that's a wall. Bram stays where he is.</span>`); return; }
    if (t === "P") { setHeroState("Bram stops at the edge of the pit. “Nope. Not walking on air.”"); log(`<span class="sys">That's a pit. Bram refuses to step into it.</span>`); return; }
    if (t === "G" && !state.gateOpen) { setHeroState("Bram rattles the barred gate. It doesn't budge."); log(`<span class="sys">The gate is barred shut. Something has to open it first — maybe that lever?</span>`); return; }
    if (t === "D") { setHeroState("Bram bumps into the locked door."); log(`<span class="sys">The door is right there, but it's locked. He needs the key first.</span>`); return; }
    h.x = nx; h.y = ny;
    setHeroState(`Bram steps ${a.direction}. He is now at (${h.x}, ${h.y}).`);
    return;
  }
  if (a.action === "pickup") {
    if (a.target === "key") {
      if (!state.keyTaken && isNear(KEY.x, KEY.y)) {
        state.keyTaken = true; state.hasKey = true;
        setHeroState("Bram picks up the brass key and holds it up proudly. “I got it! I got the shiny!”");
        log(`<span class="sys">Key acquired. Now: the east door.</span>`);
      } else {
        setHeroState("Bram pats his pockets and looks around for a key. There isn't one here.");
        log(`<span class="sys">No key within reach. It's on its tile in the gated chamber — Bram has to be next to it.</span>`);
      }
      return;
    }
    if (a.target === "chest") {
      if (!state.chestOpened && isNear(CHEST.x, CHEST.y)) {
        state.chestOpened = true;
        setHeroState("Bram opens the chest. Inside: one (1) snack. He eats it immediately. “For strength.”");
        log(`<span class="sys">It was a snack. Of course it was a snack.</span>`);
      } else {
        setHeroState("Bram looks for a chest. “I don't see a chest. Is it behind me?”");
      }
      return;
    }
    setHeroState("Bram tries to pick that up. There is nothing to pick up here.");
    return;
  }
  if (a.action === "open") {
    if (a.target === "door") {
      if (!isNear(DOOR.x, DOOR.y)) { setHeroState("Bram looks for a door. “Which door? I see a wall.”"); return; }
      if (!state.hasKey) { setHeroState("Bram rattles the locked door. “Locked! I need a key. A key, Pip. A KEY.”"); log(`<span class="sys">Locked. Bram needs the brass key first.</span>`); return; }
      state.won = true;
      setHeroState("Bram turns the key. The east door swings open!");
      $("win").classList.remove("hidden");
      $("game-ui").classList.add("hidden");
      log(`<span class="sys">The door is open. You escaped in ${state.moves} orders.</span>`);
      return;
    }
    if (a.target === "gate") {
      setHeroState(state.gateOpen ? "Bram gestures at the open gate. “Already open! I did that. Well, the lever did that.”" : "Bram pulls at the barred gate. It won't budge. “There must be a lever somewhere.”");
      return;
    }
    if (a.target === "chest") {
      if (!state.chestOpened && isNear(CHEST.x, CHEST.y)) {
        state.chestOpened = true;
        setHeroState("Bram opens the chest. Inside: one (1) snack. He eats it immediately.");
      } else {
        setHeroState("Bram looks for a chest to open. Nothing here.");
      }
      return;
    }
    setHeroState("Bram tries to open that. Nothing happens.");
    return;
  }
  if (a.action === "use") {
    if (a.target === "lever") {
      if (!isNear(LEVER.x, LEVER.y)) { setHeroState("Bram reaches for a lever. “I don't see a lever. Is it behind the wall?”"); return; }
      if (state.leverPulled) { setHeroState("Bram yanks the lever again. Nothing new happens. The gate is already open."); return; }
      state.leverPulled = true; state.gateOpen = true;
      setHeroState("Bram pulls the lever. Somewhere, a gate groans open!");
      log(`<span class="sys">The barred gate is open. The key chamber is reachable.</span>`);
      return;
    }
    setHeroState("Bram tries to use that. He is not sure how.");
    return;
  }
}

async function sendCommand(text) {
  if (!modelReady || busy || state.won) return;
  busy = true;
  $("send-btn").disabled = true;
  $("chat-input").disabled = true;
  $("thinking").classList.remove("hidden");
  log(`<span class="you">You:</span> ${escapeHtml(text)}`, "you");
  try {
    const reply = await engine.chat.completions.create({
      messages: buildMessages(text),
      temperature: 0.3,
      max_tokens: 200,
    });
    const raw = reply?.choices?.[0]?.message?.content ?? "";
    const action = parseAction(raw);
    if (!action) {
      setBubble("Um. I said something weird just now, didn't I?");
      setHeroState("Bram mumbles something nobody can understand. He does nothing.");
      log(`<span class="sys">Bram's reply wasn't usable JSON, so nothing happened. Try rephrasing — short and specific.</span>`);
      log(`<span class="raw">${escapeHtml(raw.slice(0, 400))}</span>`);
      history.push({ player: text, bram: "(unusable reply)" });
      if (history.length > 3) history.shift();
      return;
    }
    setBubble(action.paraphrase);
    log(`<span class="bram">Bram:</span> ${escapeHtml(action.paraphrase)}`, "bram");
    history.push({ player: text, bram: action.paraphrase });
    if (history.length > 3) history.shift();
    applyAction(action);
    updateObjectives();
  } catch (err) {
    setHeroState("Bram's brain stutters. Something went wrong thinking that one through.");
    log(`<span class="sys">Model error — no action taken. ${escapeHtml(err?.message || err)}</span>`);
  } finally {
    busy = false;
    $("thinking").classList.add("hidden");
    $("send-btn").disabled = false;
    $("chat-input").disabled = false;
    $("chat-input").focus();
  }
}

// ---------------------------------------------------------------------------
// Model loading. Real WebLLM only. Any failure = honest error, game never starts.
// ---------------------------------------------------------------------------
async function loadModel() {
  const loadBtn = $("load-btn"), retryBtn = $("retry-btn"), errEl = $("load-error");
  errEl.classList.add("hidden");
  retryBtn.classList.add("hidden");
  loadBtn.disabled = true;
  $("progress-wrap").classList.remove("hidden");

  const setProgress = (text, pct) => {
    $("progress-text").textContent = text;
    if (typeof pct === "number") $("progress-fill").style.width = `${Math.min(100, Math.max(0, pct * 100))}%`;
  };

  try {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU is not available in this browser. Player Two needs WebGPU — try desktop Chrome or Edge (and make sure hardware acceleration is on).");
    }
    setProgress("Loading the WebLLM library…", 0.02);
    const { CreateMLCEngine } = await import(WEBLLM_URL);
    setProgress("Downloading Bram's brain (Qwen2.5-1.5B, ~1 GB, first load only)…", 0.03);
    engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report) => {
        setProgress(report.text || "Downloading…", report.progress ?? 0);
      },
    });
    modelReady = true;
    $("loader").classList.add("hidden");
    $("game-ui").classList.remove("hidden");
    $("chat-input").disabled = false;
    $("send-btn").disabled = false;
    $("chat-input").focus();
    setHeroState("Bram's brain is awake. He is standing still, waiting for instructions.");
    log(`<span class="sys">Bram is awake. He's at (1, 1), in the northwest corner. The key is behind the barred gate to the east, and the locked door is on the east wall. Tell him what to do — one step at a time.</span>`);
    log(`<span class="sys">Try: “walk south” — then see what he does with it.</span>`);
  } catch (err) {
    console.error(err);
    errEl.textContent = `Bram's brain failed to load: ${err?.message || err}. The game did not start — there is no fake hero behind this. Check your connection / WebGPU support and try again.`;
    errEl.classList.remove("hidden");
    retryBtn.classList.remove("hidden");
    loadBtn.disabled = false;
    setProgress("Load failed.", 0);
  }
}

function resetRoom() {
  Object.assign(state, {
    hero: { ...HERO_START },
    hasKey: false, keyTaken: false, gateOpen: false, leverPulled: false,
    chestOpened: false, won: false, moves: 0, startedAt: Date.now(), lastActedAt: Date.now(), lastParaphrase: "",
  });
  history = [];
  $("log").innerHTML = "";
  $("win").classList.add("hidden");
  if (modelReady) $("game-ui").classList.remove("hidden");
  setBubble("");
  setHeroState("Bram is standing still, waiting for instructions.");
  updateObjectives();
  log(`<span class="sys">Room reset. Bram is back at (1, 1). The key, the gate, the lever, and the locked door are all where they were.</span>`);
}

// Idle clock: the world doesn't pause for typing — Bram just waits in it.
setInterval(() => {
  if (!modelReady || state.won) return;
  const idleSecs = Math.floor((Date.now() - state.lastActedAt) / 1000);
  if (!busy && !document.hidden) {
    $("hero-state").textContent = `${state.heroState} (Bram has been waiting ${idleSecs}s. The room ticks on.)`;
  }
}, 1000);

$("load-btn").addEventListener("click", loadModel);
$("retry-btn").addEventListener("click", loadModel);
$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  $("chat-input").value = "";
  sendCommand(text);
});
$("restart-btn").addEventListener("click", resetRoom);
$("play-again-btn").addEventListener("click", resetRoom);

// WebGPU pre-check, shown before the player even tries.
if (!("gpu" in navigator)) {
  $("gpu-note").textContent = "This browser reports no WebGPU. You'll need desktop Chrome or Edge to wake Bram up.";
} else {
  $("gpu-note").textContent = "WebGPU detected. First load downloads ~1 GB — after that it's cached in your browser.";
}

updateObjectives();
requestAnimationFrame(draw);
