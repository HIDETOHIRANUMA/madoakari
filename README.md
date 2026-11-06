# まどあかり

国勢調査と3D都市モデル（PLATEAU）を組み合わせて、建物ごとの世帯を推計し、1世帯を1つの窓あかりとして描くWebアプリです。

- **夜景**：灯り1つ＝1世帯（推計）。街のどこに、どれだけの暮らしがあるかが見えます。
- **見守り**：65歳以上の単独世帯（推計）を琥珀色で示します。民生委員や地域包括支援センターの見守り計画の検討に。
- **浸水**：想定最大規模の洪水で浸水する階に住む世帯と、その中の65歳以上の単独世帯を示します。個別避難計画の優先づけや訓練の想定に。

建物ごとの数はすべて推計値で、実際の居住状況を示すものではありません。小さな建物（世帯数10未満）の世帯の種類は、建物ごとには出さず、街区・町丁目・表示範囲のどれかで3棟以上・10世帯以上にまとめた数を、灯りの色にランダムに割りふっています。

## 動かし方

静的なファイルだけで動きます。

```
python -m http.server 8000
```

ブラウザで http://localhost:8000/ を開きます。CesiumJS とフォントは `vendor/` に同梱しているので、インターネットにつながっていなくても動きます。

URLパラメータ：`?mode=watch`（見守り）、`?mode=flood`（浸水）、`?tour`（自動ツアー）、`?data=data-dev/`（合成データでの確認用。下の「テスト」を参照）。

## データの作り方

1. PLATEAU 板橋区（2025年度）の建物 LOD1 の 3D Tiles（b3dm）から、建物の形と属性を取り出します。最後の引数が取り出す範囲（データ範囲）です。

   ```
   npm i draco3d@1.5.7
   node tools/extract_b3dm.js <tilesのフォルダ> takashimadaira_buildings.json 139.630,35.775,139.680,35.800
   ```

2. e-Stat の令和2年国勢調査のファイルをそろえます。
   - 境界データ：基本単位区 `r2kb13119.shp`、小地域 `r2ka13119.shp`（`.shx`・`.dbf` と同じフォルダに置きます。ダウンロードした zip のまま渡してもかまいません）
   - 小地域集計：`tblT001083C13.zip`（世帯人員）、`tblT001084C13.zip`（65歳以上世帯員のいる世帯など）、`tblT001082C13.zip`（男女・年齢別人口）。zip のまま渡します。
   - 区全体の65歳以上の単独世帯数（人口等基本集計、板橋区 37,998世帯）を `--ward-elderly-single` に渡します。

3. 推計して、アプリ用のデータを書き出します（Python 3.8以上、標準ライブラリのみ）。

   ```
   python tools/estimate.py --buildings takashimadaira_buildings.json \
     --blocks r2kb13119.shp --areas r2ka13119.shp \
     --t083 tblT001083C13.zip --t084 tblT001084C13.zip --t082 tblT001082C13.zip \
     --ward-elderly-single 37998 --city 13119 --city-name 板橋区 \
     --extent 139.630,35.775,139.680,35.800 --bbox 139.6335,35.7777,139.6765,35.7973 \
     --name 高島平とその周辺 --out data
   ```

   - `--extent`：建物データがそろっている範囲（手順1の範囲）。省略すると `buildings.json` に書かれた範囲（書かれていなければ建物の中心の範囲）を使います。
   - `--bbox`：画面に描く範囲（表示範囲）。データ範囲の300mほど内側にすると、表示範囲の端の街区の世帯もデータ範囲の建物に正しく配れます。
   - `--name`：表示範囲の名前（必須）。画面とツアーに「板橋区・高島平とその周辺」のように出ます。
   - `data/` に `area.json`・`area.bin`（アプリが読むデータ）と `report.json`（件数・警告・検証の集計）ができます。警告は画面（標準エラー出力）にも出ます。

推計の方法と検証は [docs/method.md](docs/method.md) にまとめています。

## テスト

```
python tools/test/test_estimate.py
```

合成データ（`tools/test/make_synth.py`）で街を作って推計し、灯りと数の一致、小さな建物の扱い、範囲で切れる街区、集計表の読み方などを確かめます。アプリの確認用の `data-dev/` は、合成データから次のように作ります（`data-dev/` は git に入れません）。

```
python tools/test/make_synth.py synth
python tools/estimate.py --buildings synth/buildings.json --blocks synth/blocks.shp --areas synth/areas.shp \
  --t083 synth/t083.txt --t084 synth/t084.txt --t082 synth/t082.txt --ward-elderly-single 7200 \
  --extent 139.630000,35.775000,139.676503,35.799426 --bbox 139.631661,35.776357,139.674843,35.798069 \
  --name 高島平とその周辺 --out data-dev
```

## 出典

- 「3D都市モデル（Project PLATEAU）板橋区（2025年度）」（国土交通省）を加工して作成
- 「令和2年国勢調査」（総務省統計局）を加工して作成
- 出典：政府統計の総合窓口(e-Stat)（https://www.e-stat.go.jp/）

## ライセンス

- プログラム：MIT License（[LICENSE](LICENSE)）
- `data/` の推計データ：上記の出典の利用条件に従います（出典の表示と、加工したことの表示が必要です）。
- CesiumJS：Apache License 2.0（`vendor/cesium/LICENSE.md`）
- Noto Sans JP、しっぽり明朝：SIL Open Font License 1.1（`vendor/fonts/`）

企画・プログラム・文章の作成に生成AI（Claude）を利用しています。
