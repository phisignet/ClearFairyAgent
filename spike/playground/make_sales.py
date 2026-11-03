"""架空のカフェチェーンの売上明細（sales_2026.csv）を作る。思考発話の練習用の題材。

sales.csv（12 行）では分析することが無くなったので、同じ列に販路と割引を足した 7 か月分の明細を作る。
乱数の種を固定しているので、何度実行しても同じファイルになる。

列:
    date: 売上日（YYYY-MM-DD）
    store: 店舗名
    item: 商品名
    channel: 販路（店内 / テイクアウト）
    price: 定価（店舗ごとに違う）
    discount: 1 個あたりの割引額（キャンペーン中だけ。それ以外は 0）
    quantity: 数量。欠損していることがある

このデータの事情（分析しながら自分で見つけたいなら、ここから下は読まない）:
    - 店舗ごとに仕入れ価格が違うので、同じ商品でも定価が違う（池袋は高め、吉祥寺は安め）
    - 9/1 からコーヒーとカフェラテを 30 円値上げした
    - 欠損はレジでの手入力の漏れで、数は少ない
    - 返品・取り消しは、数量がマイナスの行として入っている
    - 池袋は 7/14〜7/27 に改装で休業した
    - 吉祥寺は 8/1 に開店した（最初の数週間は客が少ない）
    - 新宿はオフィス街なので平日に多く、テイクアウトが多い。渋谷と吉祥寺は土日に多い
    - アイスコーヒーは 6〜9 月だけの販売
    - 9/15〜9/30 はケーキの 100 円引きキャンペーン
    - 5 月の池袋の一部の行は、店舗名が手入力で「池袋店」になっている
    - 6/10 の新宿は、レジの再送で同じ行が 2 回ずつ入っている
"""

import csv
import random
from datetime import date, timedelta

random.seed(20261103)

START = date(2026, 4, 1)
END = date(2026, 10, 31)

# 店舗の客の多さと、定価の上げ下げ（仕入れ価格の違い）
STORES = {
    "渋谷": {"scale": 1.2, "price": 0, "weekend": 1.3, "takeout": 0.4},
    "新宿": {"scale": 1.5, "price": 0, "weekend": 0.7, "takeout": 0.6},
    "池袋": {"scale": 0.9, "price": 30, "weekend": 1.1, "takeout": 0.4},
    "吉祥寺": {"scale": 0.8, "price": -20, "weekend": 1.4, "takeout": 0.3},
}
ITEMS = {
    "コーヒー": {"base": 18, "price": 450},
    "カフェラテ": {"base": 13, "price": 520},
    "アイスコーヒー": {"base": 14, "price": 480},
    "サンド": {"base": 8, "price": 520},
    "ケーキ": {"base": 5, "price": 600},
    "スコーン": {"base": 4, "price": 380},
}
PRICE_UP = date(2026, 9, 1)
CAMPAIGN = (date(2026, 9, 15), date(2026, 9, 30))
CLOSED = (date(2026, 7, 14), date(2026, 7, 27))
OPENED = date(2026, 8, 1)
DUPLICATED = (date(2026, 6, 10), "新宿")


def is_open(store: str, d: date) -> bool:
    if store == "池袋" and CLOSED[0] <= d <= CLOSED[1]:
        return False
    return not (store == "吉祥寺" and d < OPENED)


def on_sale(item: str, d: date) -> bool:
    return item != "アイスコーヒー" or 6 <= d.month <= 9


def price_of(store: str, item: str, d: date) -> int:
    p = ITEMS[item]["price"] + STORES[store]["price"]
    if item in ("コーヒー", "カフェラテ") and d >= PRICE_UP:
        p += 30
    return p


def demand(store: str, item: str, d: date) -> float:
    s = STORES[store]
    n = ITEMS[item]["base"] * s["scale"]
    if d.weekday() >= 5:
        n *= s["weekend"]
    if store == "吉祥寺":
        n *= min(1.0, 0.4 + (d - OPENED).days / 40)
    if item == "ケーキ" and CAMPAIGN[0] <= d <= CAMPAIGN[1]:
        n *= 1.8
    if item == "アイスコーヒー":
        n *= 1.4 if d.month in (7, 8) else 0.8
    return n


rows = []
d = START
while d <= END:
    for store, s in STORES.items():
        if not is_open(store, d):
            continue
        day_rows = []
        for item in ITEMS:
            if not on_sale(item, d):
                continue
            total = demand(store, item, d)
            for channel, share in (("店内", 1 - s["takeout"]), ("テイクアウト", s["takeout"])):
                q = round(random.gauss(total * share, (total * share) ** 0.5))
                if q <= 0:
                    continue
                price = price_of(store, item, d)
                discount = 100 if item == "ケーキ" and CAMPAIGN[0] <= d <= CAMPAIGN[1] else 0
                name = "池袋店" if store == "池袋" and d.month == 5 and random.random() < 0.15 else store
                row = {"date": d.isoformat(), "store": name, "item": item, "channel": channel, "price": price, "discount": discount, "quantity": q}
                if random.random() < 0.003:
                    row["quantity"] = ""
                elif random.random() < 0.001:
                    row["price"] = ""
                day_rows.append(row)
                # 返品・取り消し
                if item in ("サンド", "ケーキ") and random.random() < 0.004:
                    day_rows.append({**row, "quantity": -random.randint(1, 2)})
        if (d, store) == DUPLICATED:
            day_rows = [r for r in day_rows for _ in range(2)]
        rows.extend(day_rows)
    d += timedelta(days=1)

with open("sales_2026.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["date", "store", "item", "channel", "price", "discount", "quantity"])
    w.writeheader()
    w.writerows(rows)
print(f"{len(rows)} 行を sales_2026.csv に書いた")
