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
	fx: NeonFx;
	workingStyle: NeonWorkingStyle;
	/** User-defined presets from the config file; merged over the built-ins. */
	presets: Record<string, Preset>;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "neon-editor.json");
const SGR_RE = /\x1b\[[0-9;]*m/g;
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
	fx: { typing: true, send: true, done: true, working: true },
	workingStyle: "comet",
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
	const preset = typeof raw.preset === "string" && raw.preset in presetNames ? raw.preset : DEFAULT_CONFIG.preset;

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
		workingStyle: WORKING_STYLES.includes(raw.workingStyle as NeonWorkingStyle)
			? (raw.workingStyle as NeonWorkingStyle)
			: DEFAULT_CONFIG.workingStyle,
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
	ripples: [] as Array<{ col: number; frame: number }>,
	sendFlash: -1,
	donePulse: -1,
	working: false,
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
	// Editor borders are full-width lines made from ─ plus optional scroll hints.
	return visibleWidth(plain) === width && /─{3,}/.test(plain) && /^[─\s↑↓0-9more]+$/.test(plain);
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

function renderBorder(plain: string, width: number, edge: "top" | "bottom"): string {
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
			// Full frame: corners replace the first/last border characters.
			if (i === 0) glyph = edge === "top" ? set.tl : set.bl;
			else if (i === chars.length - 1) glyph = edge === "top" ? set.tr : set.br;
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

/** Replace the first/last visible column of a full-width line with side glyphs. */
function wrapSides(line: string, width: number, row: number): string {
	if (visibleWidth(stripSgr(line)) !== width) return line;
	const tokens = line.match(/\x1b\[[0-9;]*m|./gsu) ?? [];
	const visible: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (!tokens[i]!.startsWith("\x1b[")) visible.push(i);
	}
	if (visible.length < 2) return line;
	const { left, right } = sideDecor(width, row);
	tokens[visible[0]!] = left;
	tokens[visible[visible.length - 1]!] = right;
	return tokens.join("");
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
	let out = "";
	let last = 0;
	const re = new RegExp(SGR_RE.source, "g");

	for (const match of line.matchAll(re)) {
		out += fn(line.slice(last, match.index));
		out += match[0];
		last = match.index + match[0].length;
	}

	out += fn(line.slice(last));
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

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		state.tui = tui;
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		if (config.enabled && config.fx.typing && state.tui) {
			// Map the cursor onto border coordinates: paddingX + visual column.
			const cursor = this.getCursor();
			const col = this.getPaddingX() + (cursor?.col ?? 0);
			state.ripples.push({ col, frame: state.frame });
			if (state.ripples.length > 12) state.ripples.shift();
		}
	}

	override render(width: number): string[] {
		// Frame mode needs a horizontal margin so text never touches the sides.
		// Adjust BEFORE super.render so this frame's layout is already correct.
		const wantPad = Math.max(1, config.margin);
		if (config.enabled && config.frame && this.getPaddingX() !== wantPad) {
			this.setPaddingX(wantPad);
			this.autoPad = true;
		} else if (this.autoPad && (!config.enabled || !config.frame)) {
			this.setPaddingX(0);
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
		const padLines = () => Array.from({ length: config.padY }, () => (config.frame ? sidePadLine(width, sideRow++) : ""));
		const borderRows = (plain: string, edge: "top" | "bottom") =>
			Array.from({ length: config.thickness }, () => renderBorder(plain, width, edge));

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
		if (!state.capturedPrevious) {
			const current = ctx.ui.getEditorComponent();
			state.previousFactory = isNeonFactory(current) ? undefined : current;
			state.capturedPrevious = true;
		}

		ctx.ui.setEditorComponent(createFactory());
		config.enabled = true;
		saveConfig();
		startTimer();
		if (notifyUser) ctx.ui.notify(`neon-editor on · ${config.preset}/${config.mode} · ${config.intervalMs}ms`, "info");
		return;
	}

	config.enabled = false;
	saveConfig();
	stopTimer();
	ctx.ui.setEditorComponent(state.capturedPrevious ? state.previousFactory : undefined);
	if (notifyUser) ctx.ui.notify("neon-editor off", "info");
}

function usage(ctx: ExtensionContext): void {
	ctx.ui.notify(
		"usage: /neon [on|off|status|preset <name>|mode <flow|pulse|static|swing>|working <comet|surge>|speed <40-300>|glow <0-100>|thickness <1-4>|pad <0-3>|glyph <light|heavy|double|dashed|dotted|mixed>|frame <on|off>|margin <1-4>|caps <none|block|diamond|angle>|fx <typing|send|done|working> <on|off>|keyword [word]|reset]",
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
		`neon: ${config.enabled ? "on" : "off"} · preset ${config.preset} · mode ${config.mode} · speed ${config.intervalMs}ms · glow ${config.glow} · thickness ${config.thickness} · pad ${config.padY} · glyph ${config.glyph} · frame ${config.frame ? `on/${config.margin}` : "off"} · caps ${config.caps} · fx ${fxLabel()} · working-style ${config.workingStyle} · keyword ${config.keyword || "-"}`,
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
			["keyword", `Keyword — ${config.keyword || "-"}`],
			["fx", `Effects — ${fxLabel()}`],
			["workingStyle", `Working style — ${config.workingStyle}`],
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
					}
				}
				break;
			}
			case "reset":
				config = freshDefaults();
				saveConfig();
				applyEditor(ctx, true, false);
				ctx.ui.notify("neon-editor reset to defaults", "info");
				break;
			case "workingStyle": {
				const next = await ctx.ui.select(`Working style (current: ${config.workingStyle})`, WORKING_STYLES);
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
		state.frame = 0;
		state.ripples = [];
		state.sendFlash = -1;
		state.donePulse = -1;
		state.working = false;
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
		state.ripples = [];
		state.sendFlash = -1;
		state.donePulse = -1;
		state.working = false;
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
			const words = ["on", "off", "status", "preset", "mode", "working", "speed", "glow", "keyword", "thickness", "pad", "glyph", "frame", "margin", "caps", "fx", "reset"];
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
				case "preset":
					if (!value || !(value in allPresets())) {
						ctx.ui.notify(`usage: /neon preset <${Object.keys(allPresets()).join("|")}>`, "warning");
						return;
					}
					config.preset = value;
					saveConfig();
					requestRender();
					ctx.ui.notify(`neon preset: ${value}`, "info");
					return;
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
				case "fx": {
					const [name, toggle] = value.split(/\s+/).filter(Boolean);
					if (!name || !(name in config.fx) || (toggle !== "on" && toggle !== "off")) {
						ctx.ui.notify("usage: /neon fx <typing|send|done|working> <on|off>", "warning");
						return;
					}
					config.fx[name as keyof NeonFx] = toggle === "on";
					saveConfig();
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
