"""场景（Scene）：数据表驱动的结构化业务应答。

与知识库是两条独立链路——Excel/CSV 的解析结果不进 chunk 池，
用结构化条件匹配而不是词法/向量检索。设计见 docs/scenes/scene-design.md。
"""

from app.scenes.matcher import MatchAction, MatchResult, MatchRow, run_match
from app.scenes.normalize import Normalized, extract_slots, format_number, normalize, unit_conflict

__all__ = [
    "MatchAction",
    "MatchResult",
    "MatchRow",
    "Normalized",
    "extract_slots",
    "format_number",
    "normalize",
    "run_match",
    "unit_conflict",
]