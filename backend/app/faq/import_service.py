"""FAQ 批量导入：Excel → 模型归并 QA 对 → 触发关键词。

三条约束：

1. **模型只做整理，不做创作**。表格里没有的事实一律不许出现在答案里；
   prompt 明确要求「答案只能来自表格内容」，导入结果仍是「人确认后才落库」。
2. **模型不可用不等于功能不可用**。按列推断（问题列 / 答案列）兜底，
   并回一条 warning 让用户知道「这批是本地推断的，请重点核对」。
3. **关键词至少 2 个**。模型给少了用本地 `suggest_keywords` 补齐
   （jieba 词典分词，毫秒级、零模型依赖）；补不齐的条目标 warning，
   前端在预览里能筛出来手工处理。
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any

from sqlmodel import Session

from app.faq.service import FaqService, normalize_text, suggest_keywords

__all__ = [
    "MAX_FILE_BYTES",
    "MAX_ROWS",
    "ImportCandidate",
    "ImportParseResult",
    "build_import_candidates",
    "read_workbook",
]

MAX_FILE_BYTES = 10 * 1024 * 1024
#: 表格最多读这么多行（Excel 里常有几千行运营流水，不是 FAQ）。
MAX_ROWS = 200
#: 送模型的行数上限：4 批 × 40 行。再多就分批导入。
MAX_MODEL_ROWS = 160
BATCH_SIZE = 40
#: 单条答案长度上限（FAQ 直答会整段贴进对话，太长的不是 FAQ 该干的事）。
MAX_ANSWER_CHARS = 8000
MAX_QUESTION_CHARS = 500
MIN_KEYWORDS = 2
MAX_KEYWORDS = 6

_QUESTION_HEADER_HINTS = ("问题", "提问", "问法", "用户问", "问句", "question", "query")
_ANSWER_HEADER_HINTS = ("答案", "回答", "回复", "答", "answer", "reply", "content")
_HEADER_HINTS = _QUESTION_HEADER_HINTS + _ANSWER_HEADER_HINTS + ("faq", "qa", "问答")

_QA_INLINE_RE = re.compile(
    r"(?:^|\n)\s*(?:问|Q|q)\s*[:：]\s*(?P<q>.+?)\s*(?:\n|\s{2,}|\s)(?:答|A|a)\s*[:：]\s*(?P<a>.+)",
    re.S,
)

SYSTEM_PROMPT = """你是企业客服 FAQ 的整理助手。输入是一张从 Excel 读出来的表格，
可能列名不规范、单元格里塞了多行、同一问题被拆成好几行。

你的任务：把表格内容整理成一条条「用户会怎么问」+「标准答案」的 FAQ。

硬性要求：
1. 答案只能来自表格内容。允许合并同一问题的多行、去掉排版噪音，
   但**禁止**补充表格里没有的事实、数字、链接、流程步骤。
2. question 必须写成用户的口语化问法（例如「发票丢了还能报销吗」），
   不要直接搬列标题，也不要用「XX问题的解答」这种书面标题。
3. 每一条至少给 2 个、最多 5 个触发关键词。关键词必须短（2~8 个字）、
   是业务核心词（如「报销」「发票」「密码重置」），
   不要用「怎么」「什么」「怎么办」「流程」这类泛词，也不要用整句。
4. 同一问题在多行里重复出现时合并成一条，rows 里写上来源行号。
5. 一行的答案里包含多个独立问题时拆成多条，各自成对。
6. 有问无答（答案为空或只有占位符，如「待补充」「/」「-」）的行直接丢弃。

只输出 JSON，不要输出解释文字，格式：
{"items":[{"question":"...","answer":"...","keywords":["...","..."],"rows":[2],"note":""}]}
note 用一句话说明合并/拆分的原因，没有就留空字符串。"""


@dataclass
class SheetRow:
    row_number: int
    values: dict[str, str]


@dataclass
class SheetTable:
    sheet_name: str
    headers: list[str]
    rows: list[SheetRow]
    rows_total: int
    truncated: bool


@dataclass
class ImportCandidate:
    question: str
    answer: str
    keywords: list[str] = field(default_factory=list)
    rows: list[int] = field(default_factory=list)
    note: str = ""
    warning: str = ""


@dataclass
class ImportParseResult:
    sheet_name: str
    rows_total: int
    rows_used: int
    truncated: bool
    candidates: list[ImportCandidate]
    warnings: list[str]
    model_name: str | None = None


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value).strip()


def _clean_headers(raw: list[Any]) -> list[str]:
    headers: list[str] = []
    seen: dict[str, int] = {}
    for index, value in enumerate(raw):
        name = _cell_text(value) or f"第{index + 1}列"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        headers.append(name)
    return headers


def _looks_like_header(values: list[str]) -> bool:
    joined = " ".join(values).lower()
    if not joined.strip():
        return False
    return any(hint in joined for hint in _HEADER_HINTS)


def read_workbook(data: bytes) -> SheetTable:
    """读第一个有内容的 sheet，返回表头 + 行（单元格已转字符串）。"""

    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        target = None
        for name in wb.sheetnames:
            ws = wb[name]
            for row in ws.iter_rows(values_only=True):
                if any(_cell_text(cell) for cell in row):
                    target = ws
                    break
            if target is not None:
                break
        if target is None:
            raise ValueError("表格是空的，没有可导入的内容")

        iterator = target.iter_rows(values_only=True)
        header_row = next(iterator, None)
        if header_row is None:
            raise ValueError("表格是空的，没有可导入的内容")
        first_values = [_cell_text(c) for c in header_row]
        has_header = _looks_like_header(first_values)

        # 带上真实行号：用户在预览里看到「第 7 行」要去 Excel 里核对，
        # 用过滤空行后的序号指路是对不上的。
        records: list[tuple[int, list[str]]] = []
        truncated = False
        for excel_row, raw in enumerate(iterator, start=2):
            cells = [_cell_text(c) for c in raw]
            if not any(cells):
                continue
            if len(records) >= MAX_ROWS:
                truncated = True
                break
            records.append((excel_row, cells))

        if not has_header:
            # 没有表头时把第一行当数据：列名用占位符，别让用户白丢第一条。
            records.insert(0, (1, first_values))
            width = max(len(first_values), max((len(cells) for _, cells in records), default=0))
            headers = _clean_headers([f"第{i + 1}列" for i in range(width)])
        else:
            headers = _clean_headers(first_values)
        records = [(row_no, cells + [""] * (len(headers) - len(cells))) for row_no, cells in records]

        rows: list[SheetRow] = []
        for row_no, cells in records:
            if not any(cells):
                continue
            rows.append(
                SheetRow(
                    row_number=row_no,
                    values={headers[i]: cells[i] if i < len(cells) else "" for i in range(len(headers))},
                )
            )
        return SheetTable(
            sheet_name=target.title,
            headers=headers,
            rows=rows,
            rows_total=len(rows),
            truncated=truncated,
        )
    finally:
        wb.close()


def _column_index(headers: list[str], hints: tuple[str, ...], *, exclude: tuple[str, ...] = ()) -> int | None:
    normalized = [normalize_text(h) for h in headers]
    for index, text in enumerate(normalized):
        if not text:
            continue
        if any(token in text for token in (normalize_text(h) for h in exclude)):
            continue
        if any(text == normalize_text(hint) for hint in hints):
            return index
    for index, text in enumerate(normalized):
        if not text:
            continue
        if any(token in text for token in (normalize_text(h) for h in exclude)):
            continue
        if any(normalize_text(hint) in text for hint in hints):
            return index
    return None


def _truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


#: 提词时要丢掉的泛词：挂在词表里会在无关提问上误命中（FAQ 匹配是「命中任意
#: 一个即答」）。和 `faq.service._STOP_GRAMS` 同源，这里只补几个答案里高频的。
_GENERIC_KEYWORDS = {
    "怎么", "什么", "如何", "可以", "请问", "一下", "你们", "这个", "那个",
    "是不", "不是", "为什", "需要", "应该", "提交", "申请", "说明", "相关",
    "情况", "问题", "内容", "信息",
}

_ASCII_WITH_DIGIT_RE = re.compile(r"^[a-z0-9]*\d[a-z0-9]*$")


def _keyword_ok(kw: str) -> bool:
    """关键词是否可用：长度够、不是泛词、不是「t3」这类带数字的代号。"""

    if len(kw) < 2 or kw in _GENERIC_KEYWORDS:
        return False
    if _ASCII_WITH_DIGIT_RE.match(kw):
        # 答案里的「T+3」「2026」提出来会变成 t3 / 2026，在无关提问上乱命中
        return False
    return True


def ensure_keywords(question: str, answer: str, keywords: list[str]) -> tuple[list[str], bool]:
    """归一化关键词并保证至少 2 个。

    补齐顺序：问题 → 答案。答案只在问题提不出第二个词时才用（「发票丢了怎么办」
    jieba 只给「发票」），且丢掉带数字的代号与「提交/说明」这类泛词。
    """

    picked: list[str] = []
    seen: set[str] = set()
    for raw in keywords:
        kw = re.sub(r"[\s，,、;；/|]+", "", str(raw or ""))
        if kw in seen or not _keyword_ok(kw):
            continue
        seen.add(kw)
        picked.append(kw)
        if len(picked) >= MAX_KEYWORDS:
            break
    if len(picked) >= MIN_KEYWORDS:
        return picked, True
    # 问题提词优先；问题提不出第二个词时才看答案（「发票丢了怎么办」只有「发票」）
    for source in (question, answer):
        for kw in suggest_keywords(source, limit=8):
            if kw in seen or not _keyword_ok(kw):
                continue
            seen.add(kw)
            picked.append(kw)
            if len(picked) >= MIN_KEYWORDS:
                return picked, True
    return picked, len(picked) >= MIN_KEYWORDS


def pair_rows_locally(table: SheetTable) -> list[ImportCandidate]:
    """不依赖模型的兜底：按列名/列序把问题列和答案列配起来。"""

    q_index = _column_index(table.headers, _QUESTION_HEADER_HINTS)
    a_index = _column_index(
        table.headers,
        _ANSWER_HEADER_HINTS,
        exclude=_QUESTION_HEADER_HINTS,
    )
    if q_index is not None and a_index is not None and q_index == a_index:
        a_index = None

    if q_index is None and a_index is None:
        if len(table.headers) >= 2:
            q_index, a_index = 0, 1
        elif len(table.headers) == 1:
            return _pair_inline_cells(table, table.headers[0])
        else:
            return []

    if a_index is None:
        if len(table.headers) >= 2:
            a_index = 1 if q_index == 0 else 0
        else:
            return []
    if q_index is None:
        q_index = 0 if a_index != 0 else 1

    q_key = table.headers[q_index]
    a_key = table.headers[a_index]
    candidates: list[ImportCandidate] = []
    for row in table.rows:
        question = _truncate(row.values.get(q_key, ""), MAX_QUESTION_CHARS)
        answer = _truncate(row.values.get(a_key, ""), MAX_ANSWER_CHARS)
        if not question or not answer:
            continue
        keywords, enough = ensure_keywords(question, answer, [])
        candidates.append(
            ImportCandidate(
                question=question,
                answer=answer,
                keywords=keywords,
                rows=[row.row_number],
                warning="" if enough else "关键词不足 2 个，请手工补充",
            )
        )
    return candidates


def _pair_inline_cells(table: SheetTable, key: str) -> list[ImportCandidate]:
    """单列表格：单元格里写着「问：… 答：…」时按内联格式拆。"""

    candidates: list[ImportCandidate] = []
    for row in table.rows:
        text = row.values.get(key, "")
        match = _QA_INLINE_RE.search(text)
        if not match:
            continue
        question = _truncate(match.group("q"), MAX_QUESTION_CHARS)
        answer = _truncate(match.group("a"), MAX_ANSWER_CHARS)
        if not question or not answer:
            continue
        keywords, enough = ensure_keywords(question, answer, [])
        candidates.append(
            ImportCandidate(
                question=question,
                answer=answer,
                keywords=keywords,
                rows=[row.row_number],
                warning="" if enough else "关键词不足 2 个，请手工补充",
            )
        )
    return candidates


def _as_items(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        for key in ("items", "qa_pairs", "pairs", "data"):
            value = raw.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        # 单条 QA 也见过模型直接回平铺对象
        if "question" in raw or "答案" in raw:
            return [raw]
    return []


def _pick(item: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in item and item[key] not in (None, ""):
            return item[key]
    return None


def sanitize_model_items(raw: Any) -> list[ImportCandidate]:
    """把模型输出收敛成候选条目：字段兼容、去噪、补齐关键词。"""

    candidates: list[ImportCandidate] = []
    for item in _as_items(raw):
        question = _truncate(str(_pick(item, "question", "问题", "问法", "q") or ""), MAX_QUESTION_CHARS)
        answer = _truncate(str(_pick(item, "answer", "答案", "回答", "a") or ""), MAX_ANSWER_CHARS)
        if not question or not answer:
            continue
        raw_keywords = _pick(item, "keywords", "关键词", "trigger_keywords") or []
        if isinstance(raw_keywords, str):
            raw_keywords = re.split(r"[,，、;；/\s]+", raw_keywords)
        if not isinstance(raw_keywords, list):
            raw_keywords = []
        keywords, enough = ensure_keywords(question, answer, [str(k) for k in raw_keywords])
        raw_rows = _pick(item, "rows", "行号", "row_numbers") or []
        if isinstance(raw_rows, (int, str)):
            raw_rows = [raw_rows]
        rows: list[int] = []
        if isinstance(raw_rows, list):
            for value in raw_rows:
                try:
                    rows.append(int(value))
                except (TypeError, ValueError):
                    continue
        candidates.append(
            ImportCandidate(
                question=question,
                answer=answer,
                keywords=keywords,
                rows=rows,
                note=str(_pick(item, "note", "备注") or "").strip()[:200],
                warning="" if enough else "关键词不足 2 个，请手工补充",
            )
        )
    return candidates


def _dedupe(candidates: list[ImportCandidate]) -> list[ImportCandidate]:
    seen: set[str] = set()
    unique: list[ImportCandidate] = []
    for candidate in candidates:
        digest = normalize_text(candidate.question)
        if not digest or digest in seen:
            continue
        seen.add(digest)
        unique.append(candidate)
    return unique


def _batch_payload(table: SheetTable, rows: list[SheetRow]) -> dict[str, Any]:
    return {
        "表格": {
            "sheet": table.sheet_name,
            "表头": table.headers,
            "行": [
                {"行号": row.row_number, "内容": row.values}
                for row in rows
            ],
        },
        "任务": "整理成 FAQ 条目，每条的答案只能来自上面的行，关键词至少 2 个。",
    }


def _call_model(model_config: Any, table: SheetTable, rows: list[SheetRow]) -> list[ImportCandidate]:
    from app.llm import LLMClient
    from app.observability.spans import llm_operation

    with llm_operation("faq.import_match"):
        raw = LLMClient(model_config).generate_json(SYSTEM_PROMPT, _batch_payload(table, rows))
    return sanitize_model_items(raw)


def build_import_candidates(
    db: Session,
    tenant_id: str,
    agent_id: str,
    *,
    data: bytes,
    model_config: Any | None = None,
) -> ImportParseResult:
    """解析 + 模型归并 + 与现有 FAQ 去重标注，产出可直接预览的候选列表。"""

    table = read_workbook(data)
    warnings: list[str] = []
    candidates: list[ImportCandidate] = []
    model_rows = table.rows[:MAX_MODEL_ROWS]
    model_name = None

    if model_config is not None:
        model_name = str(getattr(model_config, "model", "") or "") or None
        batches = [model_rows[i : i + BATCH_SIZE] for i in range(0, len(model_rows), BATCH_SIZE)]
        failed_batches = 0
        for batch in batches:
            try:
                candidates.extend(_call_model(model_config, table, batch))
            except Exception:  # noqa: BLE001 - 单批失败不该毁掉整次导入
                failed_batches += 1
                candidates.extend(pair_rows_locally(SheetTable(
                    sheet_name=table.sheet_name,
                    headers=table.headers,
                    rows=batch,
                    rows_total=len(batch),
                    truncated=False,
                )))
        if failed_batches:
            warnings.append(
                f"有 {failed_batches} 批内容模型匹配失败，已按列推断兜底，请重点核对这些条目。"
            )
        if not candidates:
            warnings.append("模型没有从这张表里识别出完整的问答对，已改为按列推断。")
            candidates = pair_rows_locally(table)
    else:
        warnings.append("没有可用模型，已按列推断生成问答对；建议核对后再保存。")
        candidates = pair_rows_locally(table)

    if table.truncated:
        warnings.append(
            f"表格超过 {MAX_ROWS} 行，本次只读取前 {table.rows_total} 行，剩余内容请拆分后再导入。"
        )
    if len(table.rows) > MAX_MODEL_ROWS:
        warnings.append(
            f"本次只把前 {MAX_MODEL_ROWS} 行交给模型匹配，其余 {len(table.rows) - MAX_MODEL_ROWS} 行未处理。"
        )

    candidates = _dedupe(candidates)

    existing: dict[str, str] = {}
    for row in FaqService(db).list_items(tenant_id, agent_id):
        digest = normalize_text(row.question)
        if digest:
            existing.setdefault(digest, row.id)
    for candidate in candidates:
        if normalize_text(candidate.question) in existing:
            candidate.note = (candidate.note + " · 已存在同问题 FAQ").strip(" ·")
            candidate.warning = candidate.warning or "与现有 FAQ 问题重复，保存时会跳过"

    return ImportParseResult(
        sheet_name=table.sheet_name,
        rows_total=table.rows_total,
        rows_used=len(model_rows),
        truncated=table.truncated,
        candidates=candidates,
        warnings=warnings,
        model_name=model_name,
    )