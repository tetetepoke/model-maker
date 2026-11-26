// 種類ごとの初期値と、素材の質感プリセット。
// ゲーム側の置き場所は既存の約束（public/assets/items/ ＋ materials.ts の visual.model）に合わせる。
export type Mode = 'humanoid' | 'inflate' | 'extrude';

export interface Category {
  id: string;
  label: string;
  mode: Mode; // キャラクター・人型モンスターは humanoid（アイテムとは別アルゴリズム）
  heightM: number; // 書き出し時の高さ（メートル）
  thickness: number;
  roundness: number;
  dir: string; // 置き場所（public/ からの相対）
  maxTris: number; // iPhone 向けの目安
  detail: number; // 細かさの初期値
}

export const CATEGORIES: Category[] = [
  { id: 'item', label: 'アイテム', mode: 'inflate', heightM: 0.3, thickness: 0.35, roundness: 0.7, dir: 'assets/items/', maxTris: 5000, detail: 44 },
  { id: 'material', label: '素材', mode: 'inflate', heightM: 0.25, thickness: 0.55, roundness: 0.85, dir: 'assets/items/', maxTris: 5000, detail: 44 },
  { id: 'element', label: '元素', mode: 'inflate', heightM: 0.3, thickness: 0.6, roundness: 0.9, dir: 'assets/items/', maxTris: 5000, detail: 44 },
  { id: 'tool', label: '武器・道具', mode: 'extrude', heightM: 0.8, thickness: 0.08, roundness: 0.35, dir: 'assets/items/', maxTris: 4000, detail: 60 },
  { id: 'nature', label: '木・岩・植物', mode: 'inflate', heightM: 1.5, thickness: 0.6, roundness: 0.8, dir: 'assets/models/', maxTris: 8000, detail: 56 },
  { id: 'character', label: 'キャラクター', mode: 'humanoid', heightM: 1.4, thickness: 0.35, roundness: 0.9, dir: 'assets/models/', maxTris: 15000, detail: 80 },
  { id: 'monster', label: 'モンスター', mode: 'humanoid', heightM: 1.2, thickness: 0.45, roundness: 0.9, dir: 'assets/models/', maxTris: 12000, detail: 72 },
  { id: 'building', label: '建物・設備', mode: 'extrude', heightM: 3.0, thickness: 0.6, roundness: 0.1, dir: 'assets/models/', maxTris: 15000, detail: 72 },
];

export interface Look {
  id: string;
  label: string;
  metalness: number;
  roughness: number;
  tint: string; // 画像の色にかける色（#ffffff = そのまま）
  opacity: number;
  roundness?: number;
  bump?: number;
}

// 見た目のプリセット（質感だけ。科学的な性質はゲーム本体の materials.ts が正）
export const LOOKS: Look[] = [
  { id: 'image', label: '画像のまま', metalness: 0, roughness: 0.75, tint: '#ffffff', opacity: 1 },
  { id: 'stone', label: '石', metalness: 0, roughness: 0.95, tint: '#ffffff', opacity: 1, roundness: 0.8, bump: 0.5 },
  { id: 'iron', label: '鉄', metalness: 0.85, roughness: 0.45, tint: '#d8dce2', opacity: 1, bump: 0.2 },
  { id: 'copper', label: '銅', metalness: 0.9, roughness: 0.35, tint: '#f2b48a', opacity: 1, bump: 0.15 },
  { id: 'wood', label: '木材', metalness: 0, roughness: 0.85, tint: '#ffffff', opacity: 1, bump: 0.35 },
  { id: 'glass', label: 'ガラス', metalness: 0, roughness: 0.08, tint: '#e8f6ff', opacity: 0.55, bump: 0 },
  { id: 'silica', label: 'シリカ', metalness: 0, roughness: 0.25, tint: '#f4f0ff', opacity: 0.85, bump: 0.1 },
  { id: 'ore', label: '鉱石', metalness: 0.35, roughness: 0.7, tint: '#ffffff', opacity: 1, roundness: 0.6, bump: 0.7 },
  { id: 'crystal', label: '結晶', metalness: 0.1, roughness: 0.12, tint: '#ffffff', opacity: 0.8, roundness: 0.15, bump: 0.05 },
];

/** ファイル名・アイテムIDに使える形へ（英小文字・数字・_） */
export function toId(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'model';
}
