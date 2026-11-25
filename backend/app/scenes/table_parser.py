"""xlsx / csv → SceneTable + SceneTableRow。

三条设计约束：

1. **只读流式解析**。用 openpyxl 的 ``read_only`` 迭代器而不是建 DataFrame——
   需求只是「读几千行做条件筛选」，全量 DataFrame 是十倍以上的内存与依赖成本。
2. **原值与归一化值都存**。原值用来展示「表里到底写了什么」（用户会来对账），
   归一化值用来匹配。只存归一化值会导致无法回答「为什么这行没命中」。
3. **质量问题必须上报，不能静默修**。用户传上来的表可能是合并单元格、
   列里混着「面议」、数字被存成文本。静默跳过会让用户以为表里没这些数据。
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from typing import Any

from app.scenes.normalize import normalize
from app.scenes.schema import SceneColumn, SceneQualityIssue

__all__ = ["SUPPORTED_TABLE_EXTENSIONS", "ParsedTable", "guess_column_type", "parse_table"]

SUPPORTED_TABLE_EXTENSIONS = {".xlsx", ".xlsm", ".csv"}

# 表头关键词 → 列类型推测。只做「猜一个默认值」，最终由用户在导入弹窗里确认。
_UNIT_HINTS = {
    "人": "人", "人数": "人", "位": "人", "成团人数": "人",
    "天": "天", "天数": "天", "晚": "天", "行程天数": "天",
    "价": "元", "价格": "元", "预算": "元", "费用": "元", "金额": "元", "报价": "元",
}
_URL_HINTS = ("url", "链接", "地址", "下载", "详情")


@dataclass
class ParsedTable:
    columns: list[SceneColumn] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)
    quality: list[SceneQualityIssue] = field(default_factory=list)

    @property
    def row_count(self) -> int:
        return len(self.rows)


def guess_column_type(header: str, samples: list[Any]) -> tuple[str, str]:
    """猜列的 (type, unit)。

    先看表头关键词（人的命名比数据更可靠：「预算」列就算全是数字，
    语义也是金额），再看样本。
    """
    h = (header or "").strip()
    for hint, unit in _UNIT_HINTS.items():
        if hint in h:
            return "number", unit
    if any(k in h.lower() for k in _URL_HINTS):
        return "url", ""

    # 表头没线索，看数据：多数样本能归一化成数字就按 number
    parsed = 0
    total = 0
    for value in samples:
        if value in (None, ""):
            continue
        total += 1
        if normalize(value) is not None:
            parsed += 1
    if total and parsed / total >= 0.8:
        return "number", ""
    return "text", ""


def _detect_quality(
    columns: list[SceneColumn],
    rows: list[dict[str, Any]],
) -> list[SceneQualityIssue]:
    """导入时检出质量问题。每一条都要在界面上明确告知用户。"""
    issues: list[SceneQualityIssue] = []

    for col in columns:
        if col.type != "number":
            continue
        bad = 0
        wrong_unit = 0
        for row in rows:
            value = row.get(col.key)
            if value in (None, ""):
                continue
            n = normalize(value)
            if n is None:
                bad += 1
                continue
            # 列里带了不该有的单位 → 列映射可能错位（把天数列指给了人数）
            if col.unit and n.unit and n.unit != col.unit:
                wrong_unit += 1
        if bad:
            issues.append(
                SceneQualityIssue(
                    level="warning" if bad < len(rows) * 0.3 else "error",
                    code="unparsable_values",
                    message=f"「{col.label or col.key}」有 {bad} 行无法解析为数字，匹配时会跳过这些行",
                    column=col.key,
                    row_count=bad,
                )
            )
        if wrong_unit:
            issues.append(
                SceneQualityIssue(
                    level="error",
                    code="unit_mismatch",
                    message=(
                        f"「{col.label or col.key}」有 {wrong_unit} 行带了不符的单位"
                        f"（该列应为「{col.unit}」），可能是列映射错位"
                    ),
                    column=col.key,
                    row_count=wrong_unit,
                )
            )

    if not rows:
        issues.append(
            SceneQualityIssue(
                level="error", code="empty_table", message="表里没有数据行"
            )
        )
    return issues


def _read_xlsx(data: bytes) -> tuple[list[str], list[list[Any]]]:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        ws = wb[wb.sheetnames[0]]
        iterator = ws.iter_rows(values_only=True)
        header_row = next(iterator, None)
        if header_row is None:
            return [], []
        headers = [str(c).strip() if c is not None else "" for c in header_row]
        rows: list[list[Any]] = []
        for raw in iterator:
            # 整行全空视为空行跳过（Excel 尾部常有大量空行）
            if all(c is None or str(c).strip() == "" for c in raw):
                continue
            rows.append(list(raw))
        return headers, rows
    finally:
        wb.close()


def _read_csv(data: bytes) -> tuple[list[str], list[list[Any]]]:
    # 编码嗅探：Excel 导出的中文 CSV 大量是 GBK，直接按 utf-8 读会整表乱码
    text: str | None = None
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ValueError("无法识别 CSV 编码")

    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text), dialect)
    header_row = next(reader, None)
    if header_row is None:
        return [], []
    headers = [str(c).strip() for c in header_row]
    rows: list[list[Any]] = []
    for raw in reader:
        if all(str(c).strip() == "" for c in raw):
            continue
        rows.append(list(raw))
    return headers, rows


def parse_table(filename: str, data: bytes) -> ParsedTable:
    """解析上传的表。filename 的扩展名决定走 xlsx 还是 csv。"""
    lower = (filename or "").lower()
    ext = "." + lower.rsplit(".", 1)[-1] if "." in lower else ""
    if ext not in SUPPORTED_TABLE_EXTENSIONS:
        raise ValueError(f"不支持的文件类型：{ext or '未知'}")

    headers, raw_rows = _read_xlsx(data) if ext != ".csv" else _read_csv(data)

    # 表头去空、去重、给缺名的列补占位名。
    # 重名很常见（两个「价格」列），不去重会让后一列覆盖前一列的数据。
    seen: dict[str, int] = {}
    cleaned: list[str] = []
    for i, h in enumerate(headers):
        name = (h or "").strip() or f"第{i + 1}列"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        cleaned.append(name)

    columns: list[SceneColumn] = []
    for i, label in enumerate(cleaned):
        samples = [r[i] if i < len(r) else None for r in raw_rows[:50]]
        col_type, unit = guess_column_type(label, samples)
        columns.append(
            SceneColumn(
                key=label,
                label=label,
                type=col_type,
                unit=unit,
                order=i,
                filterable=col_type == "number",
            )
        )

    rows: list[dict[str, Any]] = []
    for r in raw_rows:
        row: dict[str, Any] = {}
        for i, key in enumerate(cleaned):
            value = r[i] if i < len(r) else None
            # 原值统一转字符串：Excel 的 datetime/Decimal 直接进 JSON 会炸
            if value is None:
                row[key] = ""
            elif isinstance(value, str):
                row[key] = value.strip()
            elif isinstance(value, bool):
                row[key] = "是" if value else "否"
            elif isinstance(value, float) and value == int(value):
                row[key] = str(int(value))
            else:
                row[key] = str(value)
        rows.append(row)

    return ParsedTable(columns=columns, rows=rows, quality=_detect_quality(columns, rows))