// 仮の商品カタログ。URL は架空（example.com）。
// products テーブルにジャンル・サイズが入ったら、ここは DB からの変換に置き換える。
import type { CatalogItem } from './types.ts';

const url = (id: string) => `https://example.com/products/${id}`;

export const MOCK_CATALOG: CatalogItem[] = [
  // 学習延長型
  { id: 'crystal-kit', name: '結晶づくり実験セット', priceJpy: 980, productUrl: url('crystal-kit'), genre: 'learning', size: 'small', tags: ['science'] },
  { id: 'origami-book', name: '立体おりがみブック', priceJpy: 880, productUrl: url('origami-book'), genre: 'learning', size: 'small', tags: ['craft', 'art'] },
  { id: 'microscope', name: 'こども顕微鏡キット', priceJpy: 2800, productUrl: url('microscope'), genre: 'learning', size: 'medium', tags: ['science', 'animals'] },
  { id: 'robot-kit', name: 'ミニロボット工作キット', priceJpy: 2980, productUrl: url('robot-kit'), genre: 'learning', size: 'medium', tags: ['robot', 'craft'] },
  { id: 'insect-zukan', name: '昆虫図鑑', priceJpy: 2200, productUrl: url('insect-zukan'), genre: 'learning', size: 'medium', tags: ['animals', 'reading'] },

  // 体験型
  { id: 'factory-tour', name: 'お菓子工場見学', priceJpy: 500, productUrl: url('factory-tour'), genre: 'experience', size: 'small', tags: ['science'] },
  { id: 'movie', name: '映画チケット', priceJpy: 1000, productUrl: url('movie'), genre: 'experience', size: 'small', tags: ['reading'] },
  { id: 'aquarium', name: '水族館チケット', priceJpy: 2500, productUrl: url('aquarium'), genre: 'experience', size: 'medium', tags: ['animals'] },
  { id: 'science-museum', name: '科学館ワークショップ', priceJpy: 2000, productUrl: url('science-museum'), genre: 'experience', size: 'medium', tags: ['science', 'robot'] },

  // 消耗・コレクション型
  { id: 'sticker', name: 'キラキラシールセット', priceJpy: 400, productUrl: url('sticker'), genre: 'collectible', size: 'small', tags: ['art'] },
  { id: 'card-pack', name: 'カードパック', priceJpy: 330, productUrl: url('card-pack'), genre: 'collectible', size: 'small', tags: ['game'] },
  { id: 'color-pen', name: 'カラーペン12色', priceJpy: 700, productUrl: url('color-pen'), genre: 'collectible', size: 'small', tags: ['art'] },

  // 本命型
  { id: 'telescope', name: '天体望遠鏡', priceJpy: 19800, productUrl: url('telescope'), genre: 'flagship', size: 'large', tags: ['science'] },
  { id: 'game-console', name: 'ゲーム機', priceJpy: 29800, productUrl: url('game-console'), genre: 'flagship', size: 'large', tags: ['game'] },
  { id: 'bicycle', name: '自転車', priceJpy: 25000, productUrl: url('bicycle'), genre: 'flagship', size: 'large', tags: ['sports'] },
];
