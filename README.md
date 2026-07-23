# neon-editor

Animated flowing neon border and optional keyword glow for the [pi](https://github.com/earendil-works/pi) input editor.

This package replaces the default editor component with a `CustomEditor` subclass that re-renders the editor border as an animated truecolor gradient. It also adds an optional keyword shine while you type.

## Features

- Flowing rainbow border with a moving glow highlight
- Border presets: `neon`, `ocean`, `sunset`, `matrix`, `ember`, `violet` — each defines gradient colors plus an `accent` color used by every glow/highlight effect (no hard-coded white)
- Render modes: `flow`, `pulse`, `static`, `swing`
- Adjustable animation speed and glow strength
- Adjustable border size: thickness (1-4 rows), inner padding, line glyph weight
- Optional keyword glow, e.g. make `ultrathink` shine while typing
- Reactive effects linked to your workflow: typing ripples, send flash, done pulse
- Persistent user config at `~/.pi/agent/neon-editor.json`
- Restores the previous editor component when disabled

## Usage

This repository is already placed in pi's global extension directory:

```text
~/.pi/agent/extensions/neon-editor/
```

Reload pi or restart it:

```text
/reload
```

Then control it with:

```text
/neon                    Open the interactive settings menu (TUI mode)
/neon status             Show current status as a notification
/neon on                 Enable neon editor
/neon off                Disable and restore the previous editor
/neon preset ocean       Switch palette preset
/neon mode pulse         Switch render mode: flow | pulse | static | swing
/neon speed 120          Set frame interval in ms, range 40-300
/neon glow 70            Set glow strength, range 0-100
/neon thickness 2        Border height in rows, range 1-4
/neon pad 1              Blank lines between border and text, range 0-3
/neon glyph heavy        Border line weight: light | heavy | double
/neon fx send off        Toggle a reactive effect: typing | send | done | working
/neon keyword ultrathink Highlight a keyword while typing
/neon keyword            Clear keyword highlight
/neon reset              Reset config to defaults
```

## Interactive menu

Running `/neon` with no arguments opens a settings menu built from pi's
dialog components. Every entry shows its current value; press Enter to
change it and Esc to close the menu:

```text
neon-editor · enter to edit, esc to close
  Turn off
  Preset — neon          → picker: neon / ocean / sunset / matrix / ember / violet
  Mode — flow            → picker: flow / pulse / static / swing
  Speed — 70ms           → number input (40-300)
  Glow — 70              → number input (0-100)
  Thickness — 1          → picker: 1-4
  Pad — 0                → picker: 0-3
  Glyph — light          → picker: light / heavy / double
  Keyword — -            → text input (empty clears)
  Effects — typing+send+done → toggle each reactive effect
  Reset to defaults
```

Changes apply immediately and are persisted to the config file. All
subcommands (`/neon preset ocean` etc.) remain available for scripting and
quick edits; `/neon status` prints a one-line summary.

## Presets

Each preset bundles two parameters:

| Preset | Gradient `colors` | `accent` (glow spot + all reactive effects) |
| --- | --- | --- |
| `neon` | rainbow | bright pink `[255,179,222]` |
| `ocean` | blues | bright cyan `[224,247,250]` |
| `sunset` | reds/oranges | bright peach `[255,214,165]` |
| `matrix` | greens | bright green `[190,255,190]` |
| `ember` | fiery oranges | bright amber `[255,236,179]` |
| `violet` | purples | bright lavender `[234,204,255]` |

The flow/pulse/static/swing glow spot, the typing ripple, the send flash,
the done pulse, and the working comet all brighten **toward the preset's
`accent`**, never toward a fixed white. Switching presets recolors every
effect consistently. To tune a preset, edit `PRESETS` in `index.ts`.

## Render modes

| Mode | Look |
| --- | --- |
| `flow` | The gradient streams along the border in one direction, with a glow highlight sweeping through. |
| `pulse` | The gradient stays put while the whole border breathes in brightness. |
| `static` | Frozen gradient with a fixed glow highlight at the center. No motion. |
| `swing` | The glow highlight oscillates left-right between the two ends (triangle wave), and the gradient phase ping-pongs with it. |

## Reactive effects

The border reacts to what is happening in the session. Each effect can be
toggled independently with `/neon fx <typing|send|done> <on|off>` or from
the interactive menu (`Effects — ...` entry):

| Effect | Trigger | What it looks like |
| --- | --- | --- |
| `typing` | Every keystroke in the editor (via the editor's `handleInput`) | A bright core flashes on the border at the cursor's column, then a wavefront ring expands outward along the border, fading over ~18 frames (~1.3s at the default 70ms interval). |
| `send` | pi's `input` event (you submit a prompt) | The whole border flashes bright once, fading over ~12 frames. |
| `done` | pi's `agent_end` event (the agent finishes generating) | The border pulses three times, decaying over ~36 frames — a subtle "I'm done" signal. |
| `working` | Between pi's `agent_start` and `agent_end` events | While the agent is generating, a bright comet with a fading trail ping-pongs fast between the two ends of the border (9 columns per frame), like a "thinking" indicator inside the frame. Stops the moment the agent finishes. |

Effects only fire while neon-editor is enabled and rendering in TUI mode.
They are layered on top of the current render mode (`flow`/`pulse`/`static`/`swing`)
via `Math.max` blending, so they never fight the base animation.

## Border size

Terminals cannot make a single line physically taller, so "border size" is
controlled by three independent settings:

```text
┌─ thickness ─┐  ┌─ pad ─┐

───────────────  ┐
───────────────  ┘ thickness 2: N border rows, directly adjacent
                 ┐
 (blank line)    ┘ pad 1: blank rows between border and text
 your text here
 (blank line)    ┐
                 ┘ pad applied again above the bottom border
───────────────  ┐
───────────────  ┘ bottom border rows
```

| Setting | Command | Range | Default | What it controls |
| --- | --- | --- | --- | --- |
| `thickness` | `/neon thickness <1-4>` | 1-4 rows | 1 | Border height. The rows are rendered **directly adjacent** to each other, forming one solid thick border. There is no gap between them. |
| `padY` | `/neon pad <0-3>` | 0-3 rows | 0 | Inner padding: blank rows inserted **between the border and the text** (like CSS padding). Applied to both top and bottom. `0` means the text touches the border rows directly. |
| `glyph` | `/neon glyph <light\|heavy\|double>` | 3 styles | light | Line weight of the border characters: `light` = `─`, `heavy` = `━`, `double` = `═`. Purely visual; takes no extra rows. |

Example — a visibly chunky, roomy frame:

```text
/neon thickness 2
/neon pad 1
/neon glyph heavy
```

Back to a slim single-line frame:

```text
/neon thickness 1
/neon pad 0
/neon glyph light
```

## Config

Runtime settings are stored in:

```text
~/.pi/agent/neon-editor.json
```

Example:

```json
{
  "enabled": true,
  "preset": "neon",
  "mode": "flow",
  "intervalMs": 70,
  "glow": 70,
  "keyword": "",
  "thickness": 1,
  "padY": 0,
  "glyph": "light",
  "fx": { "typing": true, "send": true, "done": true, "working": true }
}
```

## Install as a pi package

If you move this directory out of `~/.pi/agent/extensions`, install it explicitly:

```bash
pi install /absolute/path/to/neon-editor
```

Do not install the same directory while it still lives under `~/.pi/agent/extensions`, or pi may load it twice.

## Development

Quick syntax/load check:

```bash
pi -e ~/.pi/agent/extensions/neon-editor --version
```

Run pi with a temporary PTY to inspect the animated border:

```bash
script -qec "pi -e ~/.pi/agent/extensions/neon-editor" /tmp/neon-editor.log
```

## Notes

- The glow is simulated with ANSI truecolor brightness; terminals cannot render real blur/bloom.
- Animation works by calling `tui.requestRender()` on a timer. Lower `speed` values look smoother but redraw more often.
- If another extension also replaces the editor component, load order matters. `/neon off` restores the editor factory that was active before neon-editor was enabled.
