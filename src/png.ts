// Names this plugin's PNG exports, so a later export knows which files it may overwrite.
const SOFTWARE = "xNotes Viewer";
const MARK = new TextEncoder().encode(`Software\0${SOFTWARE}`);
// The 8-byte signature plus the IHDR chunk, which must come first.
const IHDR_END = 33;

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// Insert a tEXt "Software" chunk naming this plugin right after IHDR.
export function tagPng(png: Uint8Array): Uint8Array {
	const body = new Uint8Array(4 + MARK.length);
	body.set([0x74, 0x45, 0x58, 0x74]); // "tEXt"
	body.set(MARK, 4);
	const chunk = new Uint8Array(8 + MARK.length + 4);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, MARK.length);
	chunk.set(body, 4);
	view.setUint32(chunk.length - 4, crc32(body));

	const out = new Uint8Array(png.length + chunk.length);
	out.set(png.subarray(0, IHDR_END));
	out.set(chunk, IHDR_END);
	out.set(png.subarray(IHDR_END), IHDR_END + chunk.length);
	return out;
}

// Whether a PNG carries the chunk tagPng writes.
export function isOwnPng(data: ArrayBuffer): boolean {
	const head = new Uint8Array(data, 0, Math.min(data.byteLength, 128));
	return new TextDecoder("latin1").decode(head).includes(`tEXt${new TextDecoder("latin1").decode(MARK)}`);
}
