// A stand-in for CanvasRenderingContext2D that records what the page renderer draws as SVG, so a
// page exports as vectors through the same drawing code that paints it on screen. It covers the
// part of the canvas API the renderer uses; translucent and blurred ink comes in through layer().

// Names this plugin's SVG exports, so a later export knows which files it may overwrite.
export const SVG_GENERATOR = "<!-- Generator: xNotes Viewer -->";

type Matrix = [number, number, number, number, number, number]; // a b c d e f
type Seg = ["M" | "L", number, number] | ["C", number, number, number, number, number, number] | ["Z"] | ["O", number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const TAU = Math.PI * 2;

function apply(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Whether the matrix maps circles to circles (rotation, uniform scale, translation, mirroring).
function isSimilarity(m: Matrix): boolean {
	const eps = 1e-9;
	return (
		(Math.abs(m[0] - m[3]) < eps && Math.abs(m[1] + m[2]) < eps) ||
		(Math.abs(m[0] + m[3]) < eps && Math.abs(m[1] - m[2]) < eps)
	);
}

function fmt(n: number): string {
	return String(Math.round(n * 100) / 100);
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A CSS colour as SVG paint plus opacity: rgba() splits into rgb() and its alpha.
function paint(css: string, alpha: number): [string, number] {
	const m = /^rgba?\(([^)]*)\)$/.exec(css.trim());
	if (!m) return [css, alpha];
	const p = m[1].split(",").map((v) => v.trim());
	const a = p.length > 3 ? Number(p[3]) : 1;
	return [`rgb(${p[0]},${p[1]},${p[2]})`, alpha * (Number.isFinite(a) ? a : 1)];
}

// Path recorder in user space, standing in for Path2D; transformed when it is filled or stroked.
export class SvgPath {
	readonly ops: ((ctx: PathSink) => void)[] = [];

	moveTo(x: number, y: number): void {
		this.ops.push((s) => s.moveTo(x, y));
	}
	lineTo(x: number, y: number): void {
		this.ops.push((s) => s.lineTo(x, y));
	}
	bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
		this.ops.push((s) => s.bezierCurveTo(a, b, c, d, x, y));
	}
	closePath(): void {
		this.ops.push((s) => s.closePath());
	}
	rect(x: number, y: number, w: number, h: number): void {
		this.ops.push((s) => s.rect(x, y, w, h));
	}
	arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
		this.ops.push((s) => s.arc(x, y, r, a0, a1, ccw));
	}
	ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
		this.ops.push((s) => s.ellipse(x, y, rx, ry, rot, a0, a1, ccw));
	}
}

// Builds device-space segments from path calls under a fixed matrix.
class PathSink {
	readonly segs: Seg[] = [];
	private open = false;
	constructor(private readonly m: () => Matrix) {}

	moveTo(x: number, y: number): void {
		this.segs.push(["M", ...apply(this.m(), x, y)]);
		this.open = true;
	}
	lineTo(x: number, y: number): void {
		if (!this.open) return this.moveTo(x, y);
		this.segs.push(["L", ...apply(this.m(), x, y)]);
	}
	bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
		if (!this.open) this.moveTo(a, b);
		const m = this.m();
		this.segs.push(["C", ...apply(m, a, b), ...apply(m, c, d), ...apply(m, x, y)]);
	}
	closePath(): void {
		this.segs.push(["Z"]);
	}
	rect(x: number, y: number, w: number, h: number): void {
		this.moveTo(x, y);
		this.lineTo(x + w, y);
		this.lineTo(x + w, y + h);
		this.lineTo(x, y + h);
		this.closePath();
	}
	arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
		this.ellipse(x, y, r, r, 0, a0, a1, ccw);
	}
	ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
		const m = this.m();
		let sweep = a1 - a0;
		const full = Math.abs(sweep) >= TAU - 1e-9;
		// A whole circle on a fresh subpath stays a circle: two SVG arcs instead of four curves.
		if (full && rx === ry && !this.open && isSimilarity(m)) {
			const [cx, cy] = apply(m, x, y);
			this.segs.push(["O", cx, cy, rx * Math.hypot(m[0], m[1])]);
			return;
		}
		if (full) sweep = ccw ? -TAU : TAU;
		else if (!ccw) while (sweep < 0) sweep += TAU;
		else while (sweep > 0) sweep -= TAU;
		const cos = Math.cos(rot),
			sin = Math.sin(rot);
		const at = (t: number): [number, number] => {
			const px = rx * Math.cos(t),
				py = ry * Math.sin(t);
			return [x + px * cos - py * sin, y + px * sin + py * cos];
		};
		const tangent = (t: number): [number, number] => {
			const px = -rx * Math.sin(t),
				py = ry * Math.cos(t);
			return [px * cos - py * sin, px * sin + py * cos];
		};
		const start = at(a0);
		if (this.open) this.lineTo(...start);
		else this.moveTo(...start);
		const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
		const step = sweep / n;
		const k = (4 / 3) * Math.tan(step / 4);
		for (let i = 0; i < n; i++) {
			const t0 = a0 + i * step,
				t1 = t0 + step;
			const p0 = at(t0),
				p1 = at(t1),
				d0 = tangent(t0),
				d1 = tangent(t1);
			this.bezierCurveTo(p0[0] + k * d0[0], p0[1] + k * d0[1], p1[0] - k * d1[0], p1[1] - k * d1[1], p1[0], p1[1]);
		}
	}
}

function pathData(segs: Seg[]): string {
	let d = "";
	for (const s of segs) {
		if (s[0] === "Z") d += "Z";
		else if (s[0] === "O") {
			const [, cx, cy, r] = s;
			d += `M${fmt(cx + r)} ${fmt(cy)}A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx - r)} ${fmt(cy)}A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx + r)} ${fmt(cy)}Z`;
		} else d += s[0] + s.slice(1).map((v) => fmt(v as number)).join(" ");
	}
	return d;
}

interface State {
	m: Matrix;
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	dash: number[];
	font: string;
	textBaseline: CanvasTextBaseline;
	globalAlpha: number;
	globalCompositeOperation: GlobalCompositeOperation;
	shadowColor: string;
	shadowBlur: number;
}

const BASELINE: Partial<Record<CanvasTextBaseline, string>> = {
	top: "text-before-edge",
	hanging: "hanging",
	middle: "middle",
	ideographic: "ideographic",
	bottom: "text-after-edge",
};

export class SvgContext {
	// The size raster content (a PDF page under the note) is drawn at, as the renderer asks ctx.canvas.
	readonly canvas: { width: number; height: number };
	fillStyle = "#000";
	strokeStyle = "#000";
	lineWidth = 1;
	lineCap: CanvasLineCap = "butt";
	lineJoin: CanvasLineJoin = "miter";
	font = "10px sans-serif";
	textBaseline: CanvasTextBaseline = "alphabetic";
	globalAlpha = 1;
	globalCompositeOperation: GlobalCompositeOperation = "source-over";
	shadowColor = "rgba(0, 0, 0, 0)";
	shadowBlur = 0;

	private m: Matrix = [...IDENTITY];
	private dash: number[] = [];
	private stack: State[] = [];
	private path = new PathSink(() => this.m);
	private readonly body: string[] = [];
	private readonly classes = new Map<string, string>();
	private readonly filters = new Map<string, string>();
	private readonly images: CanvasImageSource[] = [];
	private measurer: OffscreenCanvasRenderingContext2D | null = null;

	constructor(
		readonly width: number,
		readonly height: number,
		rasterScale: number,
	) {
		this.canvas = { width: Math.round(width * rasterScale), height: Math.round(height * rasterScale) };
	}

	// ── state ──

	save(): void {
		this.stack.push({
			m: [...this.m],
			fillStyle: this.fillStyle,
			strokeStyle: this.strokeStyle,
			lineWidth: this.lineWidth,
			lineCap: this.lineCap,
			lineJoin: this.lineJoin,
			dash: [...this.dash],
			font: this.font,
			textBaseline: this.textBaseline,
			globalAlpha: this.globalAlpha,
			globalCompositeOperation: this.globalCompositeOperation,
			shadowColor: this.shadowColor,
			shadowBlur: this.shadowBlur,
		});
	}

	restore(): void {
		const s = this.stack.pop();
		if (!s) return;
		this.m = s.m;
		this.dash = s.dash;
		this.fillStyle = s.fillStyle;
		this.strokeStyle = s.strokeStyle;
		this.lineWidth = s.lineWidth;
		this.lineCap = s.lineCap;
		this.lineJoin = s.lineJoin;
		this.font = s.font;
		this.textBaseline = s.textBaseline;
		this.globalAlpha = s.globalAlpha;
		this.globalCompositeOperation = s.globalCompositeOperation;
		this.shadowColor = s.shadowColor;
		this.shadowBlur = s.shadowBlur;
	}

	setLineDash(d: number[]): void {
		this.dash = [...d];
	}

	getTransform(): DOMMatrix {
		return new DOMMatrix([...this.m]);
	}

	setTransform(a: number | DOMMatrix2DInit, b?: number, c?: number, d?: number, e?: number, f?: number): void {
		if (typeof a === "number") this.m = [a, b ?? 0, c ?? 0, d ?? 1, e ?? 0, f ?? 0];
		else this.m = [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0];
	}

	translate(x: number, y: number): void {
		const m = this.m;
		m[4] += m[0] * x + m[2] * y;
		m[5] += m[1] * x + m[3] * y;
	}

	scale(sx: number, sy: number): void {
		const m = this.m;
		m[0] *= sx;
		m[1] *= sx;
		m[2] *= sy;
		m[3] *= sy;
	}

	rotate(t: number): void {
		const [a, b, c, d] = this.m;
		const cos = Math.cos(t),
			sin = Math.sin(t);
		this.m[0] = a * cos + c * sin;
		this.m[1] = b * cos + d * sin;
		this.m[2] = c * cos - a * sin;
		this.m[3] = d * cos - b * sin;
	}

	// ── paths ──

	beginPath(): void {
		this.path = new PathSink(() => this.m);
	}
	moveTo(x: number, y: number): void {
		this.path.moveTo(x, y);
	}
	lineTo(x: number, y: number): void {
		this.path.lineTo(x, y);
	}
	bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
		this.path.bezierCurveTo(a, b, c, d, x, y);
	}
	closePath(): void {
		this.path.closePath();
	}
	rect(x: number, y: number, w: number, h: number): void {
		this.path.rect(x, y, w, h);
	}
	arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
		this.path.arc(x, y, r, a0, a1, ccw);
	}
	ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
		this.path.ellipse(x, y, rx, ry, rot, a0, a1, ccw);
	}

	fill(path?: unknown): void {
		const segs = this.segments(path);
		if (segs.length === 0) return;
		const [color, opacity] = paint(this.fillStyle, this.globalAlpha);
		this.emitPath(segs, `fill:${color};fill-opacity:${fmt(opacity)};stroke:none`);
	}

	stroke(path?: unknown): void {
		const segs = this.segments(path);
		if (segs.length === 0) return;
		const [color, opacity] = paint(this.strokeStyle, this.globalAlpha);
		// Canvas widths scale with the transform; device-space SVG carries the scaled width.
		const k = Math.sqrt(Math.abs(this.m[0] * this.m[3] - this.m[1] * this.m[2])) || 1;
		let style =
			`fill:none;stroke:${color};stroke-opacity:${fmt(opacity)};stroke-width:${fmt(this.lineWidth * k)};` +
			`stroke-linecap:${this.lineCap};stroke-linejoin:${this.lineJoin}`;
		if (this.dash.length) style += `;stroke-dasharray:${this.dash.map((v) => fmt(v * k)).join(" ")}`;
		this.emitPath(segs, style);
	}

	fillRect(x: number, y: number, w: number, h: number): void {
		const p = new SvgPath();
		p.rect(x, y, w, h);
		this.fill(p);
	}

	strokeRect(x: number, y: number, w: number, h: number): void {
		const p = new SvgPath();
		p.rect(x, y, w, h);
		this.stroke(p);
	}

	clearRect(): void {
		// The page background is drawn over the whole page right after; nothing to clear.
	}

	// ── text and images ──

	measureText(text: string): TextMetrics {
		this.measurer ??= new OffscreenCanvas(1, 1).getContext("2d");
		if (!this.measurer) throw new Error("2D canvas context unavailable");
		this.measurer.font = this.font;
		return this.measurer.measureText(text);
	}

	fillText(text: string, x: number, y: number): void {
		const [color, opacity] = paint(this.fillStyle, this.globalAlpha);
		const baseline = BASELINE[this.textBaseline];
		const style =
			`font:${this.font};fill:${color};fill-opacity:${fmt(opacity)};white-space:pre` +
			(baseline ? `;dominant-baseline:${baseline}` : "");
		this.body.push(
			`<text class="${this.classFor(style)}"${this.filterAttr()} transform="${this.matrixAttr()}" x="${fmt(x)}" y="${fmt(y)}">${esc(text)}</text>`,
		);
	}

	drawImage(img: CanvasImageSource, dx: number, dy: number, dw?: number, dh?: number): void {
		const size = img as { width: number; height: number };
		const w = dw ?? size.width,
			h = dh ?? size.height;
		this.images.push(img);
		const opacity = this.globalAlpha < 1 ? ` opacity="${fmt(this.globalAlpha)}"` : "";
		this.body.push(
			`<image transform="${this.matrixAttr()}" x="${fmt(dx)}" y="${fmt(dy)}" width="${fmt(w)}" height="${fmt(h)}"${opacity} preserveAspectRatio="none" href="\u0000img${this.images.length - 1}\u0000"/>`,
		);
	}

	// Translucent or blurred ink: what draw() paints is composited once as a group, so its overlaps
	// do not compound, the same as the renderer's offscreen layer.
	layer(alpha: number, op: GlobalCompositeOperation, blur: number, draw: () => void): void {
		const attrs = [`opacity="${fmt(alpha)}"`];
		if (op !== "source-over") attrs.push(`style="mix-blend-mode:${op}"`);
		if (blur > 0) attrs.push(`filter="url(#${this.filterFor(`b${fmt(blur)}`, `<feGaussianBlur stdDeviation="${fmt(blur)}"/>`)})"`);
		this.body.push(`<g ${attrs.join(" ")}>`);
		draw();
		this.body.push("</g>");
	}

	// Raw markup over everything drawn so far, e.g. the page's formulas.
	appendMarkup(markup: string): void {
		this.body.push(markup);
	}

	// The finished document. Async because image sources are inlined as data URLs.
	async serialize(): Promise<string> {
		const hrefs = await Promise.all(this.images.map(imageDataUrl));
		const styles = [...this.classes].map(([style, cls]) => `.${cls}{${style}}`).join("\n");
		const defs = [...this.filters.values()].join("");
		const body = this.body.join("\n").replace(/\u0000img(\d+)\u0000/g, (_, i: string) => esc(hrefs[Number(i)] ?? ""));
		return (
			`<?xml version="1.0" encoding="UTF-8"?>\n${SVG_GENERATOR}\n` +
			`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(this.width)}" height="${fmt(this.height)}" viewBox="0 0 ${fmt(this.width)} ${fmt(this.height)}">\n` +
			`<defs>${defs}</defs>\n<style>${styles}</style>\n${body}\n</svg>\n`
		);
	}

	// ── internals ──

	private segments(path: unknown): Seg[] {
		if (!(path instanceof SvgPath)) return this.path.segs;
		const sink = new PathSink(() => this.m);
		for (const op of path.ops) op(sink);
		return sink.segs;
	}

	private emitPath(segs: Seg[], style: string): void {
		this.body.push(`<path class="${this.classFor(style)}"${this.filterAttr()} d="${pathData(segs)}"/>`);
	}

	private classFor(style: string): string {
		let cls = this.classes.get(style);
		if (!cls) {
			cls = `s${this.classes.size}`;
			this.classes.set(style, cls);
		}
		return cls;
	}

	private filterFor(key: string, primitive: string): string {
		const id = `f${key.replace(/[^a-z0-9]/gi, "_")}`;
		if (!this.filters.has(id)) {
			this.filters.set(
				id,
				`<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${fmt(this.width)}" height="${fmt(this.height)}">${primitive}</filter>`,
			);
		}
		return id;
	}

	// Neon shapes glow through the canvas shadow; a drop shadow with no offset is the same glow.
	private filterAttr(): string {
		if (this.shadowBlur <= 0) return "";
		const [color, opacity] = paint(this.shadowColor, 1);
		if (opacity <= 0) return "";
		const sd = fmt(this.shadowBlur / 2);
		const id = this.filterFor(
			`s${sd}${color}${fmt(opacity)}`,
			// Spelled out rather than feDropShadow, which Inkscape and older viewers drop the element over.
			`<feGaussianBlur in="SourceAlpha" stdDeviation="${sd}" result="glow"/>` +
				`<feFlood flood-color="${color}" flood-opacity="${fmt(opacity)}"/>` +
				`<feComposite in2="glow" operator="in"/>` +
				`<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>`,
		);
		return ` filter="url(#${id})"`;
	}

	private matrixAttr(): string {
		return `matrix(${this.m.map(fmt).join(" ")})`;
	}
}

async function imageDataUrl(img: CanvasImageSource): Promise<string> {
	let blob: Blob | null = null;
	if (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas) {
		blob = await img.convertToBlob({ type: "image/png" });
	} else if (img instanceof HTMLCanvasElement) {
		blob = await new Promise<Blob | null>((resolve) => img.toBlob(resolve, "image/png"));
	} else if (img instanceof HTMLImageElement) {
		if (img.src.startsWith("data:")) return img.src;
		blob = await (await fetch(img.src)).blob();
	}
	if (!blob) return "";
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
}
