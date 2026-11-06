# まどあかり

国勢調査と3D都市モデル（PLATEAU）を組み合わせて、建物ごとの世帯を推計し、1世帯を1つの窓あかりとして描くWebアプリです。

- **夜景**：灯り1つ＝1世帯（推計）。街のどこに、どれだけの暮らしがあるかが見えます。
- **見守り**：65歳以上の単独世帯（推計）を琥珀色で示します。民生委員や地域包括支援センターの見守り計画の検討に。
- **浸水**：想定最大規模の洪水で浸水する階に住む世帯と、その中の65歳以上の単独世帯を示します。個別避難計画の優先づけや訓練の想定に。

建物ごとの数はすべて推計値で、実際の居住状況を示すものではありません。小さな建物（世帯数10未満）の世帯の種類は、建物ごとではなく街区ごとにまとめて灯りの色に割りふっています。

## 動かし方

静的なファイルだけで動きます。

```
python -m http.server 8000
```

ブラウザで http://localhost:8000/ を開きます。CesiumJS とフォントは `vendor/` に同梱しているので、インターネットにつながっていなくても動きます。

URLパラメータ：`?mode=watch`（見守り）、`?mode=flood`（浸水）、`?tour`（自動ツアー）。

## データの作り方

1. PLATEAU の建物 3D Tiles（b3dm）から、建物の形と属性を取り出します。

   ```
   npm i draco3d@1.5.7
   node tools/extract_b3dm.js <tilesのフォルダ> buildings.json <経度1,緯度1,経度2,緯度2>
   ```

2. e-Stat の令和2年国勢調査（小地域・基本単位区の境界、小地域集計）と組み合わせて推計し、アプリ用のデータを書き出します（Python 標準ライブラリのみ）。

   ```
   python tools/estimate.py --buildings buildings.json \
     --blocks r2kb13119.shp --areas r2ka13119.shp \
     --t083 tblT001083H13.txt --t084 tblT001084H13.txt --t082 tblT001082H13.txt \
     --ward-elderly-single 37998 --bbox 139.630,35.775,139.680,35.800 --out data
   ```

推計の方法と検証は [docs/method.md](docs/method.md) にまとめています。

## 出典

- 3D都市モデル（Project PLATEAU）板橋区（国土交通省）を加工して作成
- 「令和2年国勢調査」小地域集計・境界データ（総務省統計局、e-Stat）を加工して作成

## ライセンス

- プログラム：MIT License（[LICENSE](LICENSE)）
- `data/` の推計データ：上記の出典の利用条件に従います（出典の表示と、加工したことの表示が必要です）。
- CesiumJS：Apache License 2.0（`vendor/cesium/LICENSE.md`）
- Noto Sans JP、しっぽり明朝：SIL Open Font License 1.1（`vendor/fonts/`）

企画・プログラム・文章の作成に生成AI（Claude）を利用しています。
