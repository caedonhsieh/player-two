# Player Two

**You are not the hero. You are Player Two.**

A talk-only isometric adventure webgame. There are no controls — no WASD, no buttons to move. You play the sidekick: a little wisp living in the knight's helmet. The knight, Bram, is a big, earnest, very dumb hero controlled by a small LLM. He stands still and does nothing until you talk to him.

The twist: the game opens like Bram is the playable character. Then you realise *you* are the sidekick, and he's useless without you.

## How to play

1. Open the game (see below). Click **Wake Bram up** — his brain is a real LLM that downloads into your browser (~1 GB, first load only).
2. Read the room. Bram can only see what's right in front of him; you can see the whole isometric grid.
3. Type orders in plain language. Short and specific wins:
   - `walk south`
   - `pull the lever`
   - `pick up the key`
   - `open the door`
4. Bram tells you what he *thinks* you meant — his literal paraphrase appears in a speech bubble — then he does one thing. One tile. One action. Then he forgets the rest of your plan.
5. Vague words are dangerous. "Get it", "go left", and "be careful" confuse him. If he's unsure, he asks instead of guessing. Answer him.

## The room

Room 1 — **The Gate Room**, an 8×8 isometric grid:

- **Goal:** find the brass key, unlock the east door, escape.
- **The catch:** the key is behind a barred gate. The gate only opens when the lever (southwest corner) is pulled.
- **Hazards:** a two-tile pit cuts across the middle — Bram will not walk on air. Walls, obviously.
- **Distraction:** a chest in the south corner. It contains one (1) snack. He will eat it immediately.
- No combat. Adventure first — exploration, routing, and learning to speak so a pebble-brained knight can't misread you.

## The hero's brain

Real in-browser LLM only: **Qwen2.5-1.5B-Instruct via WebLLM** (`@mlc-ai/web-llm` 0.2.79) on WebGPU. The model runs entirely on your machine — no server, no API key, nothing you type leaves the browser.

Bram's dumbness is deliberate and lives in the system prompt plus a short memory: the model only sees the last 3 exchanges and the current room state. It is instructed to be literal, to do only the first step of any plan, to get confused by vague words, and to ask for clarification instead of guessing.

There is **no simulated / rule-based fallback**. If WebGPU is unavailable or the model fails to load, the game shows an honest error with a retry button and does not start. If the model returns something that isn't valid JSON in the expected shape, no action happens.

The model must reply with only one JSON object:

```json
{"action": "move|pickup|open|use|wait|clarify", "direction": "north|south|east|west"|null, "target": "key|door|gate|lever|chest"|null, "paraphrase": "what Bram thinks you meant, in his voice"}
```

## Run it

Play it live: **https://caedonhsieh.github.io/player-two/**

Or locally:

```bash
git clone https://github.com/caedonhsieh/player-two.git
cd player-two
python3 -m http.server 8000
# open http://localhost:8000 in desktop Chrome or Edge (WebGPU required)
```

No build step. `index.html` + `style.css` + `game.js`, served as static files.

## Requirements

- A WebGPU browser — desktop Chrome or Edge work best, hardware acceleration on.
- Internet on first load (model weights, ~1 GB, then cached in the browser).
- Patience. Bram is very literal. That's the game.
