# neon-editor

Animated flowing neon border and optional keyword glow for the [pi](https://github.com/earendil-works/pi) input editor.

This package replaces the default editor component with a `CustomEditor` subclass that re-renders the editor border as an animated truecolor gradient. It also adds an optional keyword shine while you type.

## Features

- Flowing rainbow border with a moving glow highlight
- Border presets: `neon`, `ocean`, `sunset`, `matrix`, `ember`, `violet`
- Render modes: `flow`, `pulse`, `static`
- Adjustable animation speed and glow strength
- Adjustable border size: thickness (1-4 rows), inner padding, line glyph weight
- Optional keyword glow, e.g. make `ultrathink` shine while typing
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
/neon                    Show current status
/neon on                 Enable neon editor
/neon off                Disable and restore the previous editor
/neon preset ocean       Switch palette preset
/neon mode pulse         Switch render mode: flow | pulse | static
/neon speed 120          Set frame interval in ms, range 40-300
/neon glow 70            Set glow strength, range 0-100
/neon thickness 2        Border height in rows, range 1-4
/neon pad 1              Blank lines between border and text, range 0-3
/neon glyph heavy        Border line weight: light | heavy | double
/neon keyword ultrathink Highlight a keyword while typing
/neon keyword            Clear keyword highlight
/neon reset              Reset config to defaults
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
  "glyph": "light"
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
