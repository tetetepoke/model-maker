// アイテムIDの候補（入力補助と、実寸の高さ合わせに使うだけ）。自由に編集してよい。
// ELEMENT 118 のアイテム（2026-11 時点）を参考に入れてある。ゲーム本体のデータとは連動しない。
export interface KnownItem { id: string; nameJa: string; length: number }
const list: KnownItem[] = [
  { id: 'stick', nameJa: '木の棒', length: 1.0 },
  { id: 'pipe', nameJa: '鉄パイプ', length: 1.2 },
  { id: 'sharp_stone', nameJa: 'とがった石', length: 0.16 },
  { id: 'heavy_stone', nameJa: '重い石', length: 0.26 },
  { id: 'blade', nameJa: '金属の刃', length: 0.32 },
  { id: 'fiber', nameJa: '菌糸のひも', length: 0.5 },
  { id: 'quartz', nameJa: '石英のかけら', length: 0.22 },
  { id: 'ore', nameJa: '鉄鉱石', length: 0.3 },
  { id: 'fungus_stem', nameJa: '菌の茎', length: 1.1 },
];
export const KNOWN_ITEMS: Record<string, KnownItem> = Object.fromEntries(list.map(i => [i.id, i]));
