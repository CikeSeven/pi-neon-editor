/**
 * neon-editor
 *
 * Animated flowing neon border and optional keyword glow for the pi input editor.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Rgb = [number, number, number];
type NeonMode = "flow" | "pulse" | "static" | "swing";
type NeonWorkingStyle = "comet" | "surge";
type NeonGlyph = "light" | "heavy" | "double" | "dashed" | "dotted" | "mixed";
type NeonCaps = "none" | "block" | "diamond" | "angle";
type NeonBg = "none" | "tint" | "solid" | "gradient";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface NeonFx {
	typing: boolean;
	send: boolean;
	done: boolean;
	working: boolean;
}

interface NeonConfig {
	enabled: boolean;
	preset: string;
	mode: NeonMode;
	intervalMs: number;
	glow: number;
	keyword: string;
	thickness: number;
	padY: number;
	glyph: NeonGlyph;
	frame: boolean;
	caps: NeonCaps;
	margin: number;
	bg: NeonBg;
	bgColor: Rgb | null;
	bgStrength: number;
	fx: NeonFx;
	workingStyle: NeonWorkingStyle;
	/**
	 * Typing quiet window in ms: while the user is typing (and for this long
	 * after the last keystroke), the animation timer skips repaints. Every
	 * repaint rewrites the whole editor block (both borders change every frame,
	 * so the diff range spans all text rows), which races the terminal's IME
	 * composition rendering — on Windows Terminal the composition text drawn
	 * over the grid flickers. 0 disables the guard (animation always runs).
	 */
	typingPauseMs: number;
	/** User-defined presets from the config file; merged over the built-ins. */
	presets: Record<string, Preset>;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "neon-editor.json");
const SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Matches ANY ANSI escape sequence (CSI with any final byte, OSC, APC) or one
 * visible code point. Tokenizing with this keeps non-SGR sequences (hyperlinks,
 * APC markers) atomic, so we never splice styling codes into their middle.
 */
const ANSI_TOKEN_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|./gsu;

function tokenizeLine(line: string): string[] {
	return line.match(ANSI_TOKEN_RE) ?? [];
}

function isEscapeToken(token: string): boolean {
	return token.startsWith("\x1b");
}
const NEON_FACTORY = Symbol.for("neon-editor.factory");
const MODES: NeonMode[] = ["flow", "pulse", "static", "swing"];
const WORKING_STYLES: NeonWorkingStyle[] = ["comet", "surge"];
interface GlyphSet {
	/** Horizontal border pattern, cycled per column. */
	h: string[];
	/** Vertical side pattern (frame mode), cycled per row. */
	v: string[];
	tl: string;
	tr: string;
	bl: string;
	br: string;
}

const GLYPHS: Record<NeonGlyph, GlyphSet> = {
	light: { h: ["─"], v: ["│"], tl: "╭", tr: "╮", bl: "╰", br: "╯" },
	heavy: { h: ["━"], v: ["┃"], tl: "┏", tr: "┓", bl: "┗", br: "┛" },
	double: { h: ["═"], v: ["║"], tl: "╔", tr: "╗", bl: "╚", br: "╝" },
	dashed: { h: ["┄"], v: ["┆"], tl: "╭", tr: "╮", bl: "╰", br: "╯" },
	dotted: { h: ["┈"], v: ["┊"], tl: "╭", tr: "╮", bl: "╰", br: "╯" },
	mixed: { h: ["─", "═"], v: ["│", "║"], tl: "┏", tr: "┓", bl: "┗", br: "┛" },
};

const CAPS: NeonCaps[] = ["none", "block", "diamond", "angle"];
const BG_MODES: NeonBg[] = ["none", "tint", "solid", "gradient"];

function capChar(caps: NeonCaps, edge: "top" | "bottom", side: "left" | "right"): string {
	switch (caps) {
		case "block":
			return edge === "top" ? (side === "left" ? "◢" : "◣") : side === "left" ? "◥" : "◤";
		case "diamond":
			return "◆";
		case "angle":
			return side === "left" ? "⟨" : "⟩";
		default:
			return "─";
	}
}

interface Preset {
	/** Gradient colors along the border. */
	colors: Rgb[];
	/** Highlight color: glow spot, typing ripple, send flash, done pulse, working comet. */
	accent: Rgb;
}

const PRESETS: Record<string, Preset> = {
	neon: {
		colors: [
			[255, 95, 109],
			[255, 195, 113],
			[166, 227, 161],
			[137, 220, 235],
			[122, 162, 247],
			[187, 154, 247],
			[245, 194, 231],
		],
		accent: [255, 179, 222],
	},
	ocean: {
		colors: [
			[41, 98, 255],
			[0, 180, 216],
			[72, 202, 228],
			[144, 224, 239],
			[173, 232, 244],
			[202, 240, 248],
		],
		accent: [224, 247, 250],
	},
	sunset: {
		colors: [
			[255, 0, 110],
			[255, 89, 94],
			[255, 153, 102],
			[255, 195, 113],
			[250, 163, 7],
			[202, 103, 2],
		],
		accent: [255, 214, 165],
	},
	matrix: {
		colors: [
			[0, 59, 0],
			[0, 117, 0],
			[0, 176, 31],
			[65, 226, 91],
			[154, 255, 154],
		],
		accent: [190, 255, 190],
	},
	ember: {
		colors: [
			[255, 69, 0],
			[255, 111, 54],
			[255, 149, 5],
			[255, 183, 3],
			[255, 215, 64],
		],
		accent: [255, 236, 179],
	},
	violet: {
		colors: [
			[90, 24, 154],
			[123, 44, 191],
			[157, 78, 221],
			[199, 125, 255],
			[224, 170, 255],
		],
		accent: [234, 204, 255],
	},
};

const DEFAULT_CONFIG: NeonConfig = {
	enabled: true,
	preset: "neon",
	mode: "flow",
	intervalMs: 70,
	glow: 70,
	keyword: "",
	thickness: 1,
	padY: 0,
	glyph: "light",
	frame: false,
	caps: "none",
	margin: 2,
	bg: "none",
	bgColor: null,
	bgStrength: 15,
	fx: { typing: true, send: true, done: true, working: true },
	workingStyle: "comet",
	typingPauseMs: 0,
	presets: {},
};

function freshDefaults(): NeonConfig {
	return { ...DEFAULT_CONFIG, fx: { ...DEFAULT_CONFIG.fx }, presets: {} };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const num = Number(value);
	return Number.isFinite(num) ? clamp(Math.round(num), min, max) : fallback;
}

function parseRgb(value: unknown): Rgb | undefined {
	if (!Array.isArray(value) || value.length !== 3) return undefined;
	const nums = value.map(Number);
	if (nums.some((n) => !Number.isFinite(n))) return undefined;
	return [clamp(Math.round(nums[0]!), 0, 255), clamp(Math.round(nums[1]!), 0, 255), clamp(Math.round(nums[2]!), 0, 255)];
}

function brightest(colors: Rgb[]): Rgb {
	let best = colors[0]!;
	for (const color of colors) {
		if (color[0] + color[1] + color[2] > best[0] + best[1] + best[2]) best = color;
	}
	return best;
}

/** Parse a user-defined preset. accent is optional: defaults to the brightest color. */
function parsePreset(value: unknown): Preset | undefined {
	const raw = value as Partial<Preset> | undefined;
	if (!raw || !Array.isArray(raw.colors)) return undefined;
	const colors = raw.colors.map(parseRgb).filter((c): c is Rgb => Boolean(c));
	if (colors.length === 0) return undefined;
	return { colors, accent: parseRgb(raw.accent) ?? brightest(colors) };
}

const PRESET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/i;

function normalizeConfig(input: unknown): NeonConfig {
	const raw = (input ?? {}) as Partial<NeonConfig>;
	const mode = typeof raw.mode === "string" && MODES.includes(raw.mode as NeonMode) ? (raw.mode as NeonMode) : DEFAULT_CONFIG.mode;

	const presets: Record<string, Preset> = {};
	if (raw.presets && typeof raw.presets === "object") {
		for (const [name, value] of Object.entries(raw.presets)) {
			if (!PRESET_NAME_RE.test(name)) continue;
			const parsed = parsePreset(value);
			if (parsed) presets[name.toLowerCase()] = parsed;
		}
	}

	const presetNames = { ...PRESETS, ...presets };
	// Preset keys are lowercase (custom names are lowercased on load), so
	// match the configured name case-insensitively.
	const presetName = typeof raw.preset === "string" ? raw.preset.toLowerCase() : DEFAULT_CONFIG.preset;
	const preset = presetName in presetNames ? presetName : DEFAULT_CONFIG.preset;

	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		preset,
		mode,
		intervalMs: clampNumber(raw.intervalMs, 40, 300, DEFAULT_CONFIG.intervalMs),
		glow: clampNumber(raw.glow, 0, 100, DEFAULT_CONFIG.glow),
		keyword: typeof raw.keyword === "string" ? raw.keyword : DEFAULT_CONFIG.keyword,
		thickness: clampNumber(raw.thickness, 1, 4, DEFAULT_CONFIG.thickness),
		padY: clampNumber(raw.padY, 0, 3, DEFAULT_CONFIG.padY),
		glyph: typeof raw.glyph === "string" && raw.glyph in GLYPHS ? (raw.glyph as NeonGlyph) : DEFAULT_CONFIG.glyph,
		frame: typeof raw.frame === "boolean" ? raw.frame : DEFAULT_CONFIG.frame,
		caps: typeof raw.caps === "string" && CAPS.includes(raw.caps as NeonCaps) ? (raw.caps as NeonCaps) : DEFAULT_CONFIG.caps,
		margin: clamp(Math.round(Number(raw.margin) || DEFAULT_CONFIG.margin), 1, 4),
		bg: typeof raw.bg === "string" && BG_MODES.includes(raw.bg as NeonBg) ? (raw.bg as NeonBg) : DEFAULT_CONFIG.bg,
		bgColor:
			Array.isArray(raw.bgColor) && raw.bgColor.length === 3 && raw.bgColor.every((v: unknown) => Number.isFinite(v))
				? (raw.bgColor.map((v: unknown) => clamp(Math.round(Number(v)), 0, 255)) as Rgb)
				: DEFAULT_CONFIG.bgColor,
		bgStrength: clamp(Math.round(Number(raw.bgStrength) || DEFAULT_CONFIG.bgStrength), 5, 60),
		workingStyle: WORKING_STYLES.includes(raw.workingStyle as NeonWorkingStyle)
			? (raw.workingStyle as NeonWorkingStyle)
			: DEFAULT_CONFIG.workingStyle,
		typingPauseMs: clampNumber(raw.typingPauseMs, 0, 5000, DEFAULT_CONFIG.typingPauseMs),
		fx: {
			typing: typeof raw.fx?.typing === "boolean" ? raw.fx.typing : DEFAULT_CONFIG.fx.typing,
			send: typeof raw.fx?.send === "boolean" ? raw.fx.send : DEFAULT_CONFIG.fx.send,
			done: typeof raw.fx?.done === "boolean" ? raw.fx.done : DEFAULT_CONFIG.fx.done,
			working: typeof raw.fx?.working === "boolean" ? raw.fx.working : DEFAULT_CONFIG.fx.working,
		},
		presets,
	};
}

function loadConfig(): NeonConfig {
	try {
		return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		return freshDefaults();
	}
}

function saveConfig(): void {
	try {
		fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// Config persistence is best-effort; the editor should keep working without it.
	}
}

let config = loadConfig();

const state = {
	frame: 0,
	timer: undefined as ReturnType<typeof setInterval> | undefined,
	tui: undefined as TUI | undefined,
	previousFactory: undefined as EditorFactory | undefined,
	capturedPrevious: false,
	/** True while our editor factory is the installed one. */
	applied: false,
	ripples: [] as Array<{ col: number; frame: number }>,
	sendFlash: -1,
	donePulse: -1,
	working: false,
	/** Timestamp of the last keystroke routed through the editor. */
	lastInputAt: 0,
};

function stripSgr(value: string): string {
	return value.replace(SGR_RE, "");
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	const k = clamp(t, 0, 1);
	return [
		Math.round(a[0] + (b[0] - a[0]) * k),
		Math.round(a[1] + (b[1] - a[1]) * k),
		Math.round(a[2] + (b[2] - a[2]) * k),
	];
}

function fg(rgb: Rgb): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function allPresets(): Record<string, Preset> {
	// User presets merge over (and may override) the built-ins.
	return { ...PRESETS, ...config.presets };
}

function palette(): Rgb[] {
	return (allPresets()[config.preset] ?? PRESETS.neon!).colors;
}

function accent(): Rgb {
	return (allPresets()[config.preset] ?? PRESETS.neon!).accent;
}

function isBorderLine(plain: string, width: number): boolean {
	// Editor borders are full-width lines of ─, optionally carrying one scroll
	// hint ("─── ↑ 3 more ───"). Match the hint shape explicitly so a full-width
	// line of user text made of dashes/spaces is never mistaken for a border.
	return visibleWidth(plain) === width && (/^─+$/.test(plain) || /^─{3,}\s[↑↓]\s\d+\smore\s─*$/.test(plain));
}

function reactiveBoost(index: number, width: number, frame: number): number {
	let boost = 0;

	// Typing ripples: a bright core at the cursor column, then an expanding
	// wavefront ring that travels outward along the border. Lives ~18 frames.
	if (config.fx.typing) {
		for (const ripple of state.ripples) {
			const age = frame - ripple.frame;
			if (age < 0 || age > 18) continue;
			const fade = 1 - age / 19;
			const dist = Math.abs(index - ripple.col);
			// Expanding ring: peak brightness sits on a wavefront moving outward.
			const ring = Math.max(0, 1 - Math.abs(dist - age * 1.6) / 3.5);
			// Bright core at the impact point, strong for the first few frames.
			const core = Math.max(0, 1 - dist / (6 + age)) * Math.max(0, 1 - age / 6);
			boost = Math.max(boost, Math.max(ring * 0.9, core) * fade);
		}
	}

	// Send flash: the whole border flashes bright, then fades over ~12 frames.
	if (config.fx.send && state.sendFlash >= 0) {
		const age = frame - state.sendFlash;
		if (age >= 0 && age < 12) boost = Math.max(boost, (1 - age / 12) * 0.9);
	}

	// Done pulse: three sine pulses decaying over ~36 frames.
	if (config.fx.done && state.donePulse >= 0) {
		const age = frame - state.donePulse;
		if (age >= 0 && age < 36) boost = Math.max(boost, Math.abs(Math.sin(age * 0.5)) * (1 - age / 36) * 0.85);
	}

	// Working bounce: while the agent is generating, a bright comet with a
	// fading trail ping-pongs fast between the two ends of the border.
	// ("surge" style has no accent highlight; it oscillates the gradient
	// inside colorAt instead.)
	if (config.fx.working && state.working && config.workingStyle === "comet") {
		const span = width + 28;
		const t = (frame * 9) % (span * 2);
		const forward = t < span;
		const center = (forward ? t : span * 2 - t) - 14;
		const radius = 4 + (config.glow / 100) * 8;
		boost = Math.max(boost, Math.max(0, 1 - Math.abs(index - center) / radius));
		// Comet trail: fades out behind the direction of travel.
		const behind = forward ? index < center : index > center;
		const trailDist = Math.abs(index - center);
		if (behind && trailDist < 14) {
			boost = Math.max(boost, (1 - trailDist / 14) * 0.6);
		}
	}

	return boost;
}

function colorAt(index: number, width: number, frame: number): Rgb {
	const colors = palette();
	const glowStrength = config.glow / 100;
	const workingSurge = config.fx.working && state.working && config.workingStyle === "surge";
	let wave = (index / Math.max(1, width - 1)) * colors.length;
	if (workingSurge) {
		// Working "surge" style: the raw gradient sloshes left-right at the
		// comet's pace (9 columns/frame, converted to gradient cycles).
		const step = (9 * colors.length) / Math.max(1, width - 1);
		const span = colors.length * 2;
		const t = (frame * step) % span;
		wave += t < colors.length ? t : span - t;
	} else if (config.mode === "flow") {
		wave += frame * 0.16;
	} else if (config.mode === "swing") {
		// Gradient phase ping-pongs back and forth instead of cycling.
		const span = colors.length * 2;
		const t = (frame * 0.12) % span;
		wave += t < colors.length ? t : span - t;
	}

	const baseIndex = ((Math.floor(wave) % colors.length) + colors.length) % colors.length;
	const nextIndex = (baseIndex + 1) % colors.length;
	let color = mix(colors[baseIndex]!, colors[nextIndex]!, wave - Math.floor(wave));

	let boost = 0;
	if (config.mode === "pulse") {
		boost = (0.5 + 0.5 * Math.sin(frame * 0.32)) * glowStrength * 0.85;
	} else {
		const span = width + 28;
		let center: number;
		if (config.mode === "static") {
			center = width / 2;
		} else if (config.mode === "swing") {
			// Triangle wave: the glow highlight bounces between the two ends.
			const t = (frame * 1.8) % (span * 2);
			center = (t < span ? t : span * 2 - t) - 14;
		} else {
			center = ((frame * 1.8) % span) - 14;
		}
		const radius = 4 + glowStrength * 14;
		boost = Math.max(0, 1 - Math.abs(index - center) / radius) * glowStrength * 0.8;
	}
	boost = Math.max(boost, reactiveBoost(index, width, frame));

	return mix(color, accent(), boost);
}

function renderBorder(plain: string, width: number, edge: "top" | "bottom", corners: boolean): string {
	let out = "";
	const chars = [...plain];
	const set = GLYPHS[config.glyph] ?? GLYPHS.light;

	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!;
		if (ch === " ") {
			out += ch;
			continue;
		}
		let glyph = set.h[i % set.h.length]!;
		if (config.frame) {
			// Full frame: corners replace the first/last border characters, but
			// only on the band row adjacent to the content — multi-row (thick)
			// borders would otherwise stack duplicate corners.
			if (corners) {
				if (i === 0) glyph = edge === "top" ? set.tl : set.bl;
				else if (i === chars.length - 1) glyph = edge === "top" ? set.tr : set.br;
			}
		} else if (config.caps !== "none" && (i === 0 || i === chars.length - 1)) {
			glyph = capChar(config.caps, edge, i === 0 ? "left" : "right");
		}
		out += `${fg(colorAt(i, width, state.frame))}${ch === "─" ? glyph : ch}`;
	}

	return `${out}\x1b[0m`;
}

/** Left/right side glyphs for one content row, colored from the animated gradient. */
function sideDecor(width: number, row: number): { left: string; right: string } {
	const set = GLYPHS[config.glyph] ?? GLYPHS.light;
	const v = set.v[row % set.v.length]!;
	const shift = (row * 4) % Math.max(1, width);
	const left = `${fg(colorAt(shift, width, state.frame))}${v}\x1b[0m`;
	const right = `${fg(colorAt(Math.max(0, width - 1 - shift), width, state.frame))}${v}\x1b[0m`;
	return { left, right };
}

/**
 * Iterate the effective codes of an SGR (CSI ... m) sequence, skipping the
 * argument payloads of extended colors (38/48/58) so a color component like
 * "48" inside an fg sequence is never misread as a standalone bg code.
 */
function scanSgrCodes(tok: string, fn: (n: number) => void): void {
	const parts = tok.slice(2, -1).split(";");
	for (let i = 0; i < parts.length; i++) {
		const n = Number(parts[i]);
		fn(n);
		if (n === 38 || n === 48 || n === 58) {
			const mode = Number(parts[i + 1]);
			i += mode === 2 ? 4 : mode === 5 ? 2 : 0;
		}
	}
}

/** Replace the first/last visible column of a full-width line with side glyphs. */
function wrapSides(line: string, width: number, row: number): string {
	if (visibleWidth(line) !== width) return line;
	const tokens = tokenizeLine(line);
	const visible: number[] = [];
	const inverse = new Set<number>();
	let inverted = false;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		if (isEscapeToken(tok)) {
			// Track inverse-video state (SGR 7/27/0) so the editor's cursor cell
			// is never mistaken for a replaceable edge column.
			if (tok.startsWith("\x1b[") && tok.endsWith("m")) {
				scanSgrCodes(tok, (n) => {
					if (n === 7) inverted = true;
					else if (n === 0 || n === 27) inverted = false;
				});
			}
			continue;
		}
		if (inverted) inverse.add(i);
		visible.push(i);
	}
	if (visible.length < 2) return line;
	const first = visible[0]!;
	const last = visible[visible.length - 1]!;
	// Never replace the inverse-video cursor cell (it would destroy the
	// cursor), and only swap single-cell characters so the line width and
	// right-edge alignment survive (wide CJK/emoji would shrink the line).
	if (inverse.has(first) || inverse.has(last)) return line;
	if (visibleWidth(tokens[first]!) !== 1 || visibleWidth(tokens[last]!) !== 1) return line;
	const { left, right } = sideDecor(width, row);
	tokens[first] = left;
	tokens[last] = right;
	return tokens.join("");
}

function bgCode(rgb: Rgb): string {
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

const BG_RESET = "\x1b[49m";

/**
 * Paint a background behind one rendered line, preserving inner SGR styling.
 * Every visible char gets a bg prefix (so mid-line resets can't kill it),
 * except regions the editor styled with its own bg/inverse (cursor, selection).
 */
function applyBackground(line: string, width: number): string {
	if (config.bg === "none") return line;
	const s = config.bgStrength / 100;
	const solid = config.bg === "solid" && config.bgColor ? config.bgColor : null;
	const tint = config.bg === "tint" || (config.bg === "solid" && !solid) ? mix([0, 0, 0], accent(), s) : null;
	const bgFor = (col: number): string => {
		if (solid) return bgCode(solid);
		if (tint) return bgCode(tint);
		// Gradient: a dark, slowly flowing copy of the border gradient. It uses
		// colorAt, so ripples/flashes shimmer through the backdrop too.
		return bgCode(mix([0, 0, 0], colorAt(col, width, state.frame), s));
	};

	const tokens = tokenizeLine(line);
	let out = "";
	let col = 0;
	let innerBg = false;
	for (const tok of tokens) {
		if (isEscapeToken(tok)) {
			// Only SGR (CSI ... m) affects the inner-bg state; OSC/APC pass through.
			if (tok.startsWith("\x1b[") && tok.endsWith("m")) {
				scanSgrCodes(tok, (n) => {
					if (n === 48) innerBg = true;
					else if (n === 0 || n === 27 || n === 49) innerBg = false;
					else if (n === 7) innerBg = true;
				});
			}
			out += tok;
			continue;
		}
		out += innerBg ? tok : bgFor(col) + tok;
		// Advance by display cells, not code points, so wide glyphs (CJK,
		// emoji) don't skew the gradient backdrop position.
		col += visibleWidth(tok);
	}
	return `${out}${BG_RESET}`;
}

/** Blank pad row that keeps the frame's sides continuous. */
function sidePadLine(width: number, row: number): string {
	const { left, right } = sideDecor(width, row);
	return `${left}${" ".repeat(Math.max(0, width - 2))}${right}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapPlainSegments(line: string, fn: (segment: string) => string): string {
	// tokenizeLine yields ONE code point per visible token — group adjacent
	// visible tokens into whole text runs first, or fn would see single
	// characters and multi-character keywords could never match.
	let out = "";
	let segment = "";
	const flush = () => {
		if (segment) {
			out += fn(segment);
			segment = "";
		}
	};
	for (const token of tokenizeLine(line)) {
		if (isEscapeToken(token)) {
			flush();
			out += token;
		} else {
			segment += token;
		}
	}
	flush();
	return out;
}

function glowKeyword(segment: string, keyword: string, frame: number): string {
	if (!keyword) return segment;
	const re = new RegExp(escapeRegExp(keyword), "gi");
	const colors = palette();

	return segment.replace(re, (match) => {
		const chars = [...match];
		const shinePos = (frame % (chars.length + 6)) - 3;
		let out = "";

		for (let i = 0; i < chars.length; i++) {
			const dist = Math.abs(i - shinePos);
			const boost = dist === 0 ? 0.8 : dist === 1 ? 0.42 : dist === 2 ? 0.18 : 0;
			out += `${fg(mix(colors[i % colors.length]!, accent(), boost))}${chars[i]}`;
		}

		return `${out}\x1b[0m`;
	});
}

function isNeonFactory(factory: EditorFactory | undefined): boolean {
	return Boolean(factory && (factory as unknown as Record<PropertyKey, unknown>)[NEON_FACTORY]);
}

function markNeonFactory(factory: EditorFactory): EditorFactory {
	(factory as unknown as Record<PropertyKey, unknown>)[NEON_FACTORY] = true;
	return factory;
}

class NeonEditor extends CustomEditor {
	/** True when we auto-raised paddingX for frame mode (so we can restore it). */
	private autoPad = false;
	/** paddingX captured before frame mode raised it; restored when frame turns off. */
	private savedPad: number | null = null;
	/** Width of the last render pass, used to map the cursor for typing ripples. */
	private lastRenderWidth = 0;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		state.tui = tui;
	}

	/**
	 * Map the logical cursor position onto the visual column it occupies on
	 * screen. getCursor() reports a code-unit offset inside its LOGICAL line,
	 * while the editor word-wraps every logical line independently at
	 * layoutWidth — so the raw col is wrong (and often off-screen) for wrapped
	 * or later lines. The visual column is the cursor's offset inside its
	 * current wrapped chunk; a modulo of the pre-cursor width approximates it
	 * (word-boundary wraps can shift it by a few columns).
	 */
	private visualCursorCol(width: number): number {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		const cursor = this.getCursor();
		if (!cursor) return paddingX;
		const logical = this.getLines()[cursor.line] ?? "";
		const before = logical.slice(0, clamp(cursor.col, 0, logical.length));
		return paddingX + (visibleWidth(before) % layoutWidth);
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		// Track input activity for the typing-quiet paint guard. This also
		// fires for IME commits (they arrive as text input), which is exactly
		// when the composition layer is most likely on screen.
		state.lastInputAt = Date.now();
		if (config.enabled && config.fx.typing && state.tui && this.lastRenderWidth > 0) {
			// Map the cursor onto border coordinates: padding + visual column.
			state.ripples.push({ col: this.visualCursorCol(this.lastRenderWidth), frame: state.frame });
			if (state.ripples.length > 12) state.ripples.shift();
		}
	}

	override render(width: number): string[] {
		this.lastRenderWidth = width;
		// Frame mode needs a horizontal margin so text never touches the sides.
		// Adjust BEFORE super.render so this frame's layout is already correct.
		const wantPad = Math.max(1, config.margin);
		if (config.enabled && config.frame && this.getPaddingX() !== wantPad) {
			// Only capture the pre-frame padding once; margin changes while frame
			// stays on must not overwrite it with our own auto value.
			if (!this.autoPad) this.savedPad = this.getPaddingX();
			this.setPaddingX(wantPad);
			this.autoPad = true;
		} else if (this.autoPad && (!config.enabled || !config.frame)) {
			this.setPaddingX(this.savedPad ?? 0);
			this.savedPad = null;
			this.autoPad = false;
		}

		const lines = super.render(width);
		if (!config.enabled) return lines;

		const borderFlags = lines.map((line) => isBorderLine(stripSgr(line), width));
		let lastBorderIndex = -1;
		for (let i = 0; i < borderFlags.length; i++) {
			if (borderFlags[i]) lastBorderIndex = i;
		}

		const topIsBorder = Boolean(borderFlags[0]);
		const bottomIsBorder = lastBorderIndex > 0;
		let sideRow = 0;
		const padLines = () =>
			Array.from({ length: config.padY }, () =>
				config.frame ? sidePadLine(width, sideRow++) : config.bg !== "none" ? " ".repeat(width) : "",
			);
		const borderRows = (plain: string, edge: "top" | "bottom") =>
			Array.from({ length: config.thickness }, (_, i) =>
				// Frame corners go on the band row adjacent to the content, where
				// the side borders connect (top band: last row; bottom band: first).
				renderBorder(plain, width, edge, edge === "top" ? i === config.thickness - 1 : i === 0),
			);

		const out: string[] = [];
		if (topIsBorder) {
			out.push(...borderRows(stripSgr(lines[0]!), "top"), ...padLines());
		}

		for (let i = topIsBorder ? 1 : 0; i < lines.length; i++) {
			let line = lines[i]!;
			if (bottomIsBorder && i === lastBorderIndex) {
				out.push(...padLines(), ...borderRows(stripSgr(line), "bottom"));
				continue;
			}
			if (config.keyword && !borderFlags[i]) {
				line = mapPlainSegments(line, (segment) => glowKeyword(segment, config.keyword, state.frame));
			}
			// Frame sides: only rows inside the box (autocomplete below the box is skipped).
			if (config.frame && !borderFlags[i] && (!bottomIsBorder || i < lastBorderIndex)) {
				line = wrapSides(line, width, sideRow);
				sideRow++;
			}
			out.push(line);
		}

		// Background panel: paint every line inside the box; leave the
		// autocomplete dropdown below the bottom border untouched.
		if (config.bg !== "none") {
			const autoLines = bottomIsBorder ? lines.length - 1 - lastBorderIndex : 0;
			const boxLines = out.length - Math.max(0, autoLines);
			for (let i = 0; i < boxLines; i++) {
				out[i] = applyBackground(out[i]!, width);
			}
		}

		return out;
	}
}

function stopTimer(): void {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
}

function startTimer(): void {
	stopTimer();
	state.timer = setInterval(() => {
		state.frame++;
		// Drop expired ripples so the array stays small.
		if (state.ripples.length > 0) {
			state.ripples = state.ripples.filter((ripple) => state.frame - ripple.frame <= 18);
		}
		// Typing-quiet guard: don't repaint while the user is (or was very
		// recently) typing. Both borders change every frame, so each repaint
		// rewrites the entire editor block and races the terminal's IME
		// composition overlay (visible as flicker on Windows Terminal). The
		// editor's own input path repaints typed text independently, so the
		// only thing frozen here is the border animation.
		if (config.typingPauseMs > 0 && Date.now() - state.lastInputAt < config.typingPauseMs) return;
		state.tui?.requestRender();
	}, config.intervalMs);
}

function requestRender(): void {
	state.tui?.requestRender();
}

function createFactory(): EditorFactory {
	return markNeonFactory((tui, theme, keybindings) => new NeonEditor(tui, theme, keybindings));
}

function applyEditor(ctx: ExtensionContext, enabled: boolean, notifyUser = true): void {
	if (ctx.mode !== "tui") {
		if (notifyUser) ctx.ui.notify("neon-editor requires the interactive TUI", "warning");
		return;
	}

	if (enabled) {
		if (state.applied) {
			// Already active: re-creating the editor would needlessly discard its
			// undo stack, paste state and autocomplete session.
			config.enabled = true;
			saveConfig();
			if (notifyUser) ctx.ui.notify(`neon-editor already on · ${config.preset}/${config.mode} · ${config.intervalMs}ms`, "info");
			return;
		}
		if (!state.capturedPrevious) {
			const current = ctx.ui.getEditorComponent();
			state.previousFactory = isNeonFactory(current) ? undefined : current;
			state.capturedPrevious = true;
		}

		ctx.ui.setEditorComponent(createFactory());
		state.applied = true;
		config.enabled = true;
		saveConfig();
		startTimer();
		if (notifyUser) ctx.ui.notify(`neon-editor on · ${config.preset}/${config.mode} · ${config.intervalMs}ms`, "info");
		return;
	}

	config.enabled = false;
	saveConfig();
	stopTimer();
	// Only touch the editor component when neon is actually the installed
	// editor — otherwise /neon off would wipe another extension's editor.
	if (state.applied) {
		ctx.ui.setEditorComponent(state.capturedPrevious ? state.previousFactory : undefined);
		state.applied = false;
	}
	if (notifyUser) ctx.ui.notify("neon-editor off", "info");
}

function usage(ctx: ExtensionContext): void {
	ctx.ui.notify(
		"usage: /neon [on|off|status|preset <name>|mode <flow|pulse|static|swing>|working <comet|surge>|speed <40-300>|glow <0-100>|thickness <1-4>|pad <0-3>|glyph <light|heavy|double|dashed|dotted|mixed>|frame <on|off>|margin <1-4>|caps <none|block|diamond|angle>|bg <none|tint|solid|gradient>|bgboost <5-60>|typingpause <0-5000>|fx <typing|send|done|working> <on|off>|keyword [word]|reset]",
		"warning",
	);
}

function fxLabel(): string {
	const parts: string[] = [];
	if (config.fx.typing) parts.push("typing");
	if (config.fx.send) parts.push("send");
	if (config.fx.done) parts.push("done");
	if (config.fx.working) parts.push("working");
	return parts.length > 0 ? parts.join("+") : "off";
}

function notifyStatus(ctx: ExtensionContext): void {
	ctx.ui.notify(
		`neon: ${config.enabled ? "on" : "off"} · preset ${config.preset} · mode ${config.mode} · speed ${config.intervalMs}ms · glow ${config.glow} · thickness ${config.thickness} · pad ${config.padY} · glyph ${config.glyph} · frame ${config.frame ? `on/${config.margin}` : "off"} · caps ${config.caps} · bg ${config.bg} · fx ${fxLabel()} · working-style ${config.workingStyle} · typing-pause ${config.typingPauseMs}ms · keyword ${config.keyword || "-"}`,
		"info",
	);
}

async function pickNumber(
	ctx: ExtensionContext,
	title: string,
	current: number,
	min: number,
	max: number,
	onPick: (value: number) => void,
): Promise<void> {
	const next = await ctx.ui.input(`${title} (${min}-${max})`, String(current));
	if (next === undefined || next.trim() === "") return;
	const num = Number(next);
	if (!Number.isFinite(num)) {
		ctx.ui.notify("invalid number", "warning");
		return;
	}
	onPick(clamp(Math.round(num), min, max));
	saveConfig();
	requestRender();
}

async function neonMenu(ctx: ExtensionContext): Promise<void> {
	while (true) {
		const entries: Array<[string, string]> = [
			["toggle", config.enabled ? "Turn off" : "Turn on"],
			["preset", `Preset — ${config.preset}`],
			["mode", `Mode — ${config.mode}`],
			["speed", `Speed — ${config.intervalMs}ms`],
			["glow", `Glow — ${config.glow}`],
			["thickness", `Thickness — ${config.thickness}`],
			["pad", `Pad — ${config.padY}`],
			["glyph", `Glyph — ${config.glyph}`],
			["frame", `Frame (sides+corners) — ${config.frame ? "on" : "off"}`],
			["margin", `Frame margin — ${config.margin}`],
			["caps", `End caps — ${config.caps}`],
			["bg", `Background — ${config.bg}${config.bg === "none" ? "" : ` (${config.bgStrength}%)`}`],
			["bgboost", `Background strength — ${config.bgStrength}%`],
			["keyword", `Keyword — ${config.keyword || "-"}`],
			["fx", `Effects — ${fxLabel()}`],
			["workingStyle", `Working style — ${config.workingStyle}`],
			["typingPause", `Typing pause (IME guard) — ${config.typingPauseMs === 0 ? "off" : `${config.typingPauseMs}ms`}`],
			["reset", "Reset to defaults"],
		];
		const labels = entries.map(([, label]) => label);
		const picked = await ctx.ui.select("neon-editor · enter to edit, esc to close", labels);
		if (picked === undefined) return;
		const action = entries[labels.indexOf(picked)]?.[0];

		switch (action) {
			case "toggle":
				applyEditor(ctx, !config.enabled);
				break;
			case "preset": {
				const next = await ctx.ui.select(`Preset (current: ${config.preset})`, Object.keys(allPresets()));
				if (next) {
					config.preset = next;
					saveConfig();
					requestRender();
				}
				break;
			}
			case "mode": {
				const next = await ctx.ui.select(`Mode (current: ${config.mode})`, MODES);
				if (next) {
					config.mode = next as NeonMode;
					saveConfig();
					requestRender();
				}
				break;
			}
			case "speed":
				await pickNumber(ctx, "Frame interval ms", config.intervalMs, 40, 300, (ms) => {
					config.intervalMs = ms;
					if (config.enabled) startTimer();
				});
				break;
			case "glow":
				await pickNumber(ctx, "Glow strength", config.glow, 0, 100, (glow) => {
					config.glow = glow;
				});
				break;
			case "thickness": {
				const next = await ctx.ui.select(`Thickness (current: ${config.thickness})`, ["1", "2", "3", "4"]);
				if (next) {
					config.thickness = Number(next);
					saveConfig();
					requestRender();
				}
				break;
			}
			case "pad": {
				const next = await ctx.ui.select(`Pad (current: ${config.padY})`, ["0", "1", "2", "3"]);
				if (next) {
					config.padY = Number(next);
					saveConfig();
					requestRender();
				}
				break;
			}
			case "glyph": {
				const next = await ctx.ui.select(`Glyph (current: ${config.glyph})`, Object.keys(GLYPHS));
				if (next) {
					config.glyph = next as NeonGlyph;
					saveConfig();
					requestRender();
				}
				break;
			}
			case "frame":
				config.frame = !config.frame;
				saveConfig();
				requestRender();
				break;
			case "margin": {
				const next = await ctx.ui.select(`Frame margin (current: ${config.margin})`, ["1", "2", "3", "4"]);
				if (next) {
					config.margin = Number(next);
					saveConfig();
					requestRender();
				}
				break;
			}
			case "caps": {
				const next = await ctx.ui.select(`End caps (current: ${config.caps})`, CAPS);
				if (next) {
					config.caps = next as NeonCaps;
					saveConfig();
					requestRender();
				}
				break;
			}
			case "bg": {
				const next = await ctx.ui.select(`Background (current: ${config.bg})`, BG_MODES);
				if (next) {
					config.bg = next as NeonBg;
					saveConfig();
					requestRender();
				}
				break;
			}
			case "bgboost": {
				const next = await ctx.ui.input("Background strength % (5-60)", String(config.bgStrength));
				if (next) {
					const boost = Number(next.trim());
					if (Number.isInteger(boost) && boost >= 5 && boost <= 60) {
						config.bgStrength = boost;
						saveConfig();
						requestRender();
					} else {
						ctx.ui.notify("background strength must be an integer 5-60", "warning");
					}
				}
				break;
			}
			case "keyword": {
				const next = await ctx.ui.input("Keyword to highlight (empty clears)", config.keyword);
				if (next !== undefined) {
					config.keyword = next.trim();
					saveConfig();
					requestRender();
				}
				break;
			}
			case "fx": {
				const fxEntries: Array<[keyof NeonFx, string]> = [
					["typing", `${config.fx.typing ? "✓" : "✗"} typing ripple`],
					["send", `${config.fx.send ? "✓" : "✗"} send flash`],
					["done", `${config.fx.done ? "✓" : "✗"} done pulse`],
					["working", `${config.fx.working ? "✓" : "✗"} working bounce`],
				];
				const next = await ctx.ui.select(
					"Toggle reactive effect",
					fxEntries.map(([, label]) => label),
				);
				if (next !== undefined) {
					const key = fxEntries.find(([, label]) => label === next)?.[0];
					if (key) {
						config.fx[key] = !config.fx[key];
						saveConfig();
						requestRender();
					}
				}
				break;
			}
			case "typingPause":
				await pickNumber(ctx, "Typing quiet window ms (0 = off)", config.typingPauseMs, 0, 5000, (ms) => {
					config.typingPauseMs = ms;
				});
				break;
			case "reset":
				config = freshDefaults();
				saveConfig();
				applyEditor(ctx, true, false);
				ctx.ui.notify("neon-editor reset to defaults", "info");
				break;
			case "workingStyle": {				const next = await ctx.ui.select(`Working style (current: ${config.workingStyle})`, WORKING_STYLES);
				if (next) {
					config.workingStyle = next as NeonWorkingStyle;
					saveConfig();
					requestRender();
				}
				break;
			}
		}
	}
}

export default function neonEditor(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		state.capturedPrevious = false;
		state.previousFactory = undefined;
		state.applied = false;
		state.frame = 0;
		state.ripples = [];
		state.sendFlash = -1;
		state.donePulse = -1;
		state.working = false;
		state.lastInputAt = 0;
		config = loadConfig();

		if (ctx.mode === "tui" && config.enabled) {
			applyEditor(ctx, true, false);
		}
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		state.tui = undefined;
		state.previousFactory = undefined;
		state.capturedPrevious = false;
		state.applied = false;
		state.ripples = [];
		state.sendFlash = -1;
		state.donePulse = -1;
		state.working = false;
		state.lastInputAt = 0;
	});

	// Reactive effects: flash the border when the user submits input,
	// pulse it when the agent finishes generating.
	pi.on("input", () => {
		if (config.enabled && config.fx.send && state.tui) {
			state.sendFlash = state.frame;
		}
	});

	pi.on("agent_start", () => {
		state.working = true;
	});

	pi.on("agent_end", () => {
		state.working = false;
		if (config.enabled && config.fx.done && state.tui) {
			state.donePulse = state.frame;
		}
	});

	pi.registerCommand("neon", {
		description: "Control the neon-editor input border animation",
		getArgumentCompletions: (prefix) => {
			const words = ["on", "off", "status", "preset", "mode", "working", "speed", "glow", "keyword", "thickness", "pad", "glyph", "frame", "margin", "caps", "bg", "bgboost", "typingpause", "fx", "reset"];
			const filtered = words.filter((word) => word.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((word) => ({ value: word, label: word })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = parts[0];
			const value = parts.slice(1).join(" ").trim();

			if (!action) {
				if (ctx.mode === "tui") await neonMenu(ctx);
				else notifyStatus(ctx);
				return;
			}

			switch (action) {
				case "on":
					applyEditor(ctx, true);
					return;
				case "off":
					applyEditor(ctx, false);
					return;
				case "preset": {
					const name = value.toLowerCase();
					if (!name || !(name in allPresets())) {
						ctx.ui.notify(`usage: /neon preset <${Object.keys(allPresets()).join("|")}>`, "warning");
						return;
					}
					config.preset = name;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon preset: ${name}`, "info");
					return;
				}
				case "mode":
					if (!MODES.includes(value as NeonMode)) {
						ctx.ui.notify("usage: /neon mode <flow|pulse|static|swing>", "warning");
						return;
					}
					config.mode = value as NeonMode;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon mode: ${value}`, "info");
					return;
				case "speed": {
					const ms = Number(value);
					if (!Number.isFinite(ms)) {
						ctx.ui.notify("usage: /neon speed <40-300>", "warning");
						return;
					}
					config.intervalMs = clamp(Math.round(ms), 40, 300);
					saveConfig();
					if (config.enabled) startTimer();
					ctx.ui.notify(`neon speed: ${config.intervalMs}ms`, "info");
					return;
				}
				case "glow": {
					const glow = Number(value);
					if (!Number.isFinite(glow)) {
						ctx.ui.notify("usage: /neon glow <0-100>", "warning");
						return;
					}
					config.glow = clamp(Math.round(glow), 0, 100);
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon glow: ${config.glow}`, "info");
					return;
				}
				case "keyword":
					config.keyword = value;
					saveConfig();
					requestRender();
					ctx.ui.notify(config.keyword ? `neon keyword: ${config.keyword}` : "neon keyword cleared", "info");
					return;
				case "frame":
					if (value !== "on" && value !== "off") {
						ctx.ui.notify("usage: /neon frame <on|off>", "warning");
						return;
					}
					config.frame = value === "on";
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon frame: ${value}`, "info");
					return;
				case "margin": {
					const margin = Number(value);
					if (!Number.isInteger(margin) || margin < 1 || margin > 4) {
						ctx.ui.notify("usage: /neon margin <1-4>", "warning");
						return;
					}
					config.margin = margin;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon margin: ${margin}`, "info");
					return;
				}
				case "caps":
					if (!CAPS.includes(value as NeonCaps)) {
						ctx.ui.notify(`usage: /neon caps <${CAPS.join("|")}>`, "warning");
						return;
					}
					config.caps = value as NeonCaps;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon caps: ${value}`, "info");
					return;
				case "bg":
					if (!BG_MODES.includes(value as NeonBg)) {
						ctx.ui.notify(`usage: /neon bg <${BG_MODES.join("|")}>`, "warning");
						return;
					}
					config.bg = value as NeonBg;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon background: ${value}`, "info");
					return;
				case "bgboost": {
					const boost = Number(value);
					if (!Number.isInteger(boost) || boost < 5 || boost > 60) {
						ctx.ui.notify("usage: /neon bgboost <5-60>", "warning");
						return;
					}
					config.bgStrength = boost;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon background strength: ${boost}`, "info");
					return;
				}
				case "fx": {
					const [name, toggle] = value.split(/\s+/).filter(Boolean);
					if (!name || !(name in config.fx) || (toggle !== "on" && toggle !== "off")) {
						ctx.ui.notify("usage: /neon fx <typing|send|done|working> <on|off>", "warning");
						return;
					}
					config.fx[name as keyof NeonFx] = toggle === "on";
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon fx ${name}: ${toggle}`, "info");
					return;
				}
				case "working":
					if (!WORKING_STYLES.includes(value as NeonWorkingStyle)) {
						ctx.ui.notify("usage: /neon working <comet|surge>", "warning");
						return;
					}
					config.workingStyle = value as NeonWorkingStyle;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon working style: ${value}`, "info");
					return;
				case "thickness": {
					const n = Number(value);
					if (!Number.isFinite(n)) {
						ctx.ui.notify("usage: /neon thickness <1-4>", "warning");
						return;
					}
					config.thickness = clamp(Math.round(n), 1, 4);
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon thickness: ${config.thickness}`, "info");
					return;
				}
				case "pad": {
					const n = Number(value);
					if (!Number.isFinite(n)) {
						ctx.ui.notify("usage: /neon pad <0-3>", "warning");
						return;
					}
					config.padY = clamp(Math.round(n), 0, 3);
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon pad: ${config.padY}`, "info");
					return;
				}
				case "glyph":
					if (!value || !(value in GLYPHS)) {
						ctx.ui.notify(`usage: /neon glyph <${Object.keys(GLYPHS).join("|")}>`, "warning");
						return;
					}
					config.glyph = value as NeonGlyph;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon glyph: ${value}`, "info");
					return;
				case "typingpause": {
					const ms = Number(value);
					if (!Number.isFinite(ms)) {
						ctx.ui.notify("usage: /neon typingpause <0-5000>  (0 = off; freezes the border while you type to avoid IME composition flicker)", "warning");
						return;
					}
					config.typingPauseMs = clamp(Math.round(ms), 0, 5000);
					saveConfig();
					ctx.ui.notify(config.typingPauseMs === 0 ? "neon typing pause: off" : `neon typing pause: ${config.typingPauseMs}ms`, "info");
					return;
				}
				case "reset":
					config = freshDefaults();
					saveConfig();
					if (ctx.mode === "tui") applyEditor(ctx, true, false);
					ctx.ui.notify("neon-editor reset to defaults", "info");
					return;
				case "status":
					notifyStatus(ctx);
					return;
				default:
					usage(ctx);
			}
		},
	});
}
