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
type NeonGlyph = "light" | "heavy" | "double";
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
	fx: NeonFx;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "neon-editor.json");
const SGR_RE = /\x1b\[[0-9;]*m/g;
const NEON_FACTORY = Symbol.for("neon-editor.factory");
const MODES: NeonMode[] = ["flow", "pulse", "static", "swing"];
const GLYPHS: Record<NeonGlyph, string> = { light: "─", heavy: "━", double: "═" };

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
	fx: { typing: true, send: true, done: true, working: true },
};

function freshDefaults(): NeonConfig {
	return { ...DEFAULT_CONFIG, fx: { ...DEFAULT_CONFIG.fx } };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const num = Number(value);
	return Number.isFinite(num) ? clamp(Math.round(num), min, max) : fallback;
}

function normalizeConfig(input: unknown): NeonConfig {
	const raw = (input ?? {}) as Partial<NeonConfig>;
	const preset = typeof raw.preset === "string" && raw.preset in PRESETS ? raw.preset : DEFAULT_CONFIG.preset;
	const mode = typeof raw.mode === "string" && MODES.includes(raw.mode as NeonMode) ? (raw.mode as NeonMode) : DEFAULT_CONFIG.mode;

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
		fx: {
			typing: typeof raw.fx?.typing === "boolean" ? raw.fx.typing : DEFAULT_CONFIG.fx.typing,
			send: typeof raw.fx?.send === "boolean" ? raw.fx.send : DEFAULT_CONFIG.fx.send,
			done: typeof raw.fx?.done === "boolean" ? raw.fx.done : DEFAULT_CONFIG.fx.done,
			working: typeof raw.fx?.working === "boolean" ? raw.fx.working : DEFAULT_CONFIG.fx.working,
		},
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

function palette(): Rgb[] {
	return (PRESETS[config.preset] ?? PRESETS.neon!).colors;
}

function accent(): Rgb {
	return (PRESETS[config.preset] ?? PRESETS.neon!).accent;
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
	if (config.fx.working && state.working) {
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
	let wave = (index / Math.max(1, width - 1)) * colors.length;
	if (config.mode === "flow") {
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

function renderBorder(plain: string, width: number): string {
	let out = "";
	const chars = [...plain];
	const glyph = GLYPHS[config.glyph] ?? GLYPHS.light;

	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!;
		if (ch === " ") {
			out += ch;
			continue;
		}
		out += `${fg(colorAt(i, width, state.frame))}${ch === "─" ? glyph : ch}`;
	}

	return `${out}\x1b[0m`;
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
		const lines = super.render(width);
		if (!config.enabled) return lines;

		const borderFlags = lines.map((line) => isBorderLine(stripSgr(line), width));
		let lastBorderIndex = -1;
		for (let i = 0; i < borderFlags.length; i++) {
			if (borderFlags[i]) lastBorderIndex = i;
		}

		const topIsBorder = Boolean(borderFlags[0]);
		const bottomIsBorder = lastBorderIndex > 0;
		const padLines = Array.from({ length: config.padY }, () => "");
		const borderRows = (plain: string) =>
			Array.from({ length: config.thickness }, () => renderBorder(plain, width));

		const out: string[] = [];
		if (topIsBorder) {
			out.push(...borderRows(stripSgr(lines[0]!)), ...padLines);
		}

		for (let i = topIsBorder ? 1 : 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (bottomIsBorder && i === lastBorderIndex) {
				out.push(...padLines, ...borderRows(stripSgr(line)));
				continue;
			}
			if (config.keyword && !borderFlags[i]) {
				out.push(mapPlainSegments(line, (segment) => glowKeyword(segment, config.keyword, state.frame)));
				continue;
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
		"usage: /neon [on|off|status|preset <name>|mode <flow|pulse|static|swing>|speed <40-300>|glow <0-100>|thickness <1-4>|pad <0-3>|glyph <light|heavy|double>|fx <typing|send|done|working> <on|off>|keyword [word]|reset]",
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
		`neon: ${config.enabled ? "on" : "off"} · preset ${config.preset} · mode ${config.mode} · speed ${config.intervalMs}ms · glow ${config.glow} · thickness ${config.thickness} · pad ${config.padY} · glyph ${config.glyph} · fx ${fxLabel()} · keyword ${config.keyword || "-"}`,
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
			["keyword", `Keyword — ${config.keyword || "-"}`],
			["fx", `Effects — ${fxLabel()}`],
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
				const next = await ctx.ui.select(`Preset (current: ${config.preset})`, Object.keys(PRESETS));
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
			const words = ["on", "off", "status", "preset", "mode", "speed", "glow", "keyword", "thickness", "pad", "glyph", "fx", "reset"];
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
					if (!value || !(value in PRESETS)) {
						ctx.ui.notify(`usage: /neon preset <${Object.keys(PRESETS).join("|")}>`, "warning");
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
